"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw, CloudDownload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DocWithLabels } from "@/types";
import { broadcastChange } from "@/lib/cross-tab";

interface RefreshButtonProps {
  mode: "refresh" | "full-refresh" | "load";
  onRefresh: (docs: DocWithLabels[]) => void;
}

export function RefreshButton({ mode, onRefresh }: RefreshButtonProps) {
  const [loading, setLoading] = useState(false);

  const Icon = mode === "load" ? CloudDownload : RefreshCw;
  const label = mode === "refresh" ? "Refresh" : mode === "full-refresh" ? "Full Refresh" : "Load from Drive";
  const tooltip =
    mode === "refresh"
      ? "Sync docs modified since last refresh"
      : mode === "full-refresh"
      ? "Sync docs modified since last refresh, and all loaded docs"
      : "Add all docs modified in the last 30 days, and find deleted docs";

  async function handleClick() {
    setLoading(true);
    try {
      const syncRes = await fetch(`/api/docs?mode=${mode}`, { method: "POST" });
      if (!syncRes.ok) throw new Error("Sync failed");
      const data = await syncRes.json();

      const docsRes = await fetch("/api/docs?includeArchived=true");
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const docs: DocWithLabels[] = await docsRes.json();

      onRefresh(docs);
      broadcastChange({ type: "docs" });

      if (mode === "refresh" || mode === "full-refresh") {
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
    } catch {
      toast.error("Failed to sync with Google Drive");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleClick} disabled={loading} variant="outline" size="sm" title={tooltip} className="text-zinc-900">
      <Icon className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
      {label}
    </Button>
  );
}
