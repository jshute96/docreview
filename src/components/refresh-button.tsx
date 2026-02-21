"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function RefreshButton() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleRefresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/docs", { method: "POST" });
      if (!res.ok) throw new Error("Refresh failed");
      const data = await res.json();
      toast.success(`Sync complete — added ${data.added} new docs, updated ${data.updated}`);
      router.refresh();
    } catch {
      toast.error("Failed to sync with Google Drive");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleRefresh} disabled={loading} variant="outline" size="sm">
      {loading ? "Syncing…" : "Refresh from Drive"}
    </Button>
  );
}
