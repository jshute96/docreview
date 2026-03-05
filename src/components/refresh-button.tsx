"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DocWithLabels } from "@/types";
import { broadcastChange } from "@/lib/cross-tab";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";

interface RefreshButtonProps {
  onRefresh: (docs: DocWithLabels[]) => void;
  disabled?: boolean;
  onLoadingChange?: (loading: boolean) => void;
}

export function RefreshButton({ onRefresh, disabled, onLoadingChange }: RefreshButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    onLoadingChange?.(true);
    const contextId = generateContextId();
    try {
      const syncRes = await apiFetch("/api/docs/refresh", {
        method: "POST",
        contextId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: ["drive", "gmail"] }),
      });
      if (!syncRes.ok) throw new Error("Refresh failed");
      const data = await syncRes.json();

      const docsRes = await apiFetch("/api/docs?includeArchived=true", { contextId });
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const docs: DocWithLabels[] = await docsRes.json();

      onRefresh(docs);
      broadcastChange({ type: "docs" }, contextId);

      const parts = [
        data.added > 0 ? `${data.added} new` : "",
        data.updated > 0 ? `${data.updated} updated` : "",
        data.deleted > 0 ? `${data.deleted} deleted` : "",
        data.unarchived > 0 ? `${data.unarchived} unarchived` : "",
      ].filter(Boolean).join(", ");
      const errorSuffix = data.errorCount > 0 ? ` (${data.errorCount} errors)` : "";
      toast.success(`Refresh complete — ${parts || "no updates"}${errorSuffix}`, { duration: 8000 });
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to refresh");
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
  }

  return (
    <Button
      onClick={handleClick}
      disabled={loading || disabled}
      variant="outline"
      size="sm"
      title="Sync docs from Drive and Gmail"
    >
      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
      Refresh
    </Button>
  );
}
