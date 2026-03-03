"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw, CloudDownload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DocWithLabels } from "@/types";
import { broadcastChange } from "@/lib/cross-tab";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";

interface RefreshButtonProps {
  mode: "refresh" | "full-refresh" | "load" | "gmail-refresh";
  onRefresh: (docs: DocWithLabels[]) => void;
}

export function RefreshButton({ mode, onRefresh }: RefreshButtonProps) {
  const [loading, setLoading] = useState(false);

  const Icon = mode === "load" ? CloudDownload : RefreshCw;
  const label = mode === "refresh" ? "Refresh" : mode === "full-refresh" ? "Full Refresh" : mode === "gmail-refresh" ? "Refresh from Gmail" : "Load from Drive";
  const tooltip =
    mode === "refresh"
      ? "Sync docs modified since last refresh"
      : mode === "full-refresh"
      ? "Sync docs modified since last refresh, and all loaded docs"
      : mode === "gmail-refresh"
      ? "Check Gmail for doc notifications since last scan"
      : "Add all docs modified in the last 30 days, and find deleted docs";

  async function handleClick() {
    setLoading(true);
    const contextId = generateContextId();
    try {
      const url = mode === "gmail-refresh" ? "/api/docs/gmail-refresh" : `/api/docs?mode=${mode}`;
      const syncRes = await apiFetch(url, { method: "POST", contextId });
      if (!syncRes.ok) throw new Error("Sync failed");
      const data = await syncRes.json();

      const docsRes = await apiFetch("/api/docs?includeArchived=true", { contextId });
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const docs: DocWithLabels[] = await docsRes.json();

      onRefresh(docs);
      broadcastChange({ type: "docs" }, contextId);

      if (mode === "gmail-refresh") {
        const parts = [
          data.added > 0 ? `${data.added} new` : "",
          data.updated > 0 ? `${data.updated} updated` : "",
          data.deleted > 0 ? `${data.deleted} deleted` : "",
          data.unarchived > 0 ? `${data.unarchived} unarchived` : "",
        ].filter(Boolean).join(", ");
        const errorSuffix = data.errorCount > 0 ? ` (${data.errorCount} errors)` : "";
        toast.success(`Gmail refresh — ${parts || "no updates"}${errorSuffix}`, { duration: 8000 });
      } else if (mode === "refresh" || mode === "full-refresh") {
        const parts = [
          data.added > 0 ? `${data.added} new` : "",
          data.updated > 0 ? `${data.updated} updated` : "",
          data.deleted > 0 ? `${data.deleted} deleted` : "",
          data.unarchived > 0 ? `${data.unarchived} unarchived` : "",
        ].filter(Boolean).join(", ");
        const prefix = mode === "full-refresh" ? "Full refresh" : "Refresh";
        toast.success(`${prefix} complete — ${parts || "no updates"}`, { duration: 8000 });
      } else {
        const parts = [
          data.added > 0 ? `${data.added} new` : "",
          data.updated > 0 ? `${data.updated} updated` : "",
          data.deleted > 0 ? `${data.deleted} deleted` : "",
        ].filter(Boolean).join(", ");
        toast.success(`Sync complete — ${parts || "no updates"}`, { duration: 8000 });
      }
    } catch (err) {
      if (!isAuthError(err)) toast.error(mode === "gmail-refresh" ? "Failed to refresh from Gmail" : "Failed to sync with Google Drive");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleClick} disabled={loading} variant="outline" size="sm" title={tooltip}>
      <Icon className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
      {label}
    </Button>
  );
}
