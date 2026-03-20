"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DocWithLabels } from "@/types";
import { broadcastChange } from "@/lib/cross-tab";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";
import type { ProgressEvent } from "@/lib/progress-events";
import {
  fetchWithProgress,
  handleRefreshProgress,
  formatResultParts,
  dismissProgressToasts,
} from "@/lib/stream-progress";

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
      let fetchSeq = 0;
      const data = await fetchWithProgress<Record<string, number>>("/api/docs/refresh", {
        method: "POST",
        contextId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: ["drive", "gmail"] }),
      }, (event: ProgressEvent) => {
        if (event.phase === "docs-updated") {
          const seq = ++fetchSeq;
          apiFetch("/api/docs?includeArchived=true", { contextId }).then(async (res) => {
            if (res.ok && seq === fetchSeq) onRefresh(await res.json());
          }).catch(() => {});
          return;
        }
        handleRefreshProgress(event);
      });

      const docsRes = await apiFetch("/api/docs?includeArchived=true", { contextId });
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const docs: DocWithLabels[] = await docsRes.json();
      fetchSeq++;

      onRefresh(docs);
      broadcastChange({ type: "docs" }, contextId);

      dismissProgressToasts();
      const { summary, errorSuffix } = formatResultParts(data);
      toast.success(`Refresh complete — ${summary}${errorSuffix}`, { duration: 8000 });
    } catch (err) {
      dismissProgressToasts();
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
