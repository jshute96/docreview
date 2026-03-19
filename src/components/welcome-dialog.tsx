"use client";

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";

interface WelcomeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WelcomeDialog({ open, onOpenChange }: WelcomeDialogProps) {
  const [markedSeen, setMarkedSeen] = useState(false);

  const handleClose = useCallback(() => {
    if (!markedSeen) {
      setMarkedSeen(true);
      apiFetch("/api/help-seen", { method: "POST" }).catch(() => {});
    }
    onOpenChange(false);
  }, [markedSeen, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Enter") handleClose();
    }
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === "help-key" && (e.data.key === "Escape" || e.data.key === "Enter")) {
        handleClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("message", handleMessage);
    };
  }, [open, handleClose]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else onOpenChange(true); }}>
      <DialogContent className="sm:max-w-3xl focus:outline-none" hideClose>
        <DialogHeader className="pt-5 px-6 pb-0">
          <DialogTitle className="flex items-center gap-3 text-xl">
            <img src="/docreview.svg" alt="Docreview Logo" className="h-8 w-8 rounded-lg shadow-sm" />
            <span><span className="text-zinc-500">Welcome to</span> Docreview</span>
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 pt-4 flex-1 min-h-0">
          <iframe
            src="/help/viewer.html?page=quick-start"
            className="w-full border border-zinc-200 rounded-md bg-white"
            style={{ height: "60vh" }}
            title="Quick Start"
          />
        </div>

        <div className="px-6 pb-4 pt-3 flex items-center shrink-0">
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={handleClose}>
            OK
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
