"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { DocWithLabels } from "@/types";

interface RefreshButtonProps {
  onRefresh: (docs: DocWithLabels[]) => void;
}

export function RefreshButton({ onRefresh }: RefreshButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleRefresh() {
    setLoading(true);
    try {
      const syncRes = await fetch("/api/docs", { method: "POST" });
      if (!syncRes.ok) throw new Error("Refresh failed");
      const data = await syncRes.json();

      const docsRes = await fetch("/api/docs?includeArchived=true");
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const docs: DocWithLabels[] = await docsRes.json();

      onRefresh(docs);
      const parts = [
        data.added > 0 ? `${data.added} new` : "",
        data.updated > 0 ? `${data.updated} updated` : "",
      ].filter(Boolean).join(", ");
      toast.success(`Sync complete — ${parts || "no updates"}`, { duration: 8000 });
    } catch {
      toast.error("Failed to sync with Google Drive");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleRefresh} disabled={loading} variant="outline" size="sm">
      {loading ? "Refreshing…" : "Refresh"}
    </Button>
  );
}
