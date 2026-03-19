"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface HelpPage {
  slug: string;
  title: string;
}

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  const [pages, setPages] = useState<HelpPage[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    fetch("/help/pages.json")
      .then((res) => res.json())
      .then((data: HelpPage[]) => setPages(data))
      .catch(() => {});
  }, []);

  // Reset to first page when reopened
  useEffect(() => {
    if (open) setCurrentIndex(0);
  }, [open]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const currentPage = pages[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < pages.length - 1;

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft" && currentIndex > 0) {
        setCurrentIndex((i) => i - 1);
        // Refocus iframe so up/down scrolling works
        setTimeout(() => iframeRef.current?.focus(), 50);
      } else if (e.key === "ArrowRight" && currentIndex < pages.length - 1) {
        setCurrentIndex((i) => i + 1);
        setTimeout(() => iframeRef.current?.focus(), 50);
      } else if (e.key === "Escape") {
        handleClose();
      }
    }
    // Listen for keys from iframe via postMessage
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === "help-key") {
        handleKeyDown({ key: e.data.key } as KeyboardEvent);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("message", handleMessage);
    };
  }, [open, currentIndex, pages.length, handleClose]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else onOpenChange(true); }}>
      <DialogContent className="sm:max-w-3xl focus:outline-none" hideClose>
        <DialogHeader className="pt-5 px-6 pb-0">
          <DialogTitle className="flex items-center gap-3 text-xl">
            <img src="/docreview.svg" alt="Docreview Logo" className="h-8 w-8 rounded-lg shadow-sm" />
            <span><span className="text-zinc-500">Docreview help:</span> {currentPage?.title ?? ""}</span>
          </DialogTitle>
        </DialogHeader>

        {/* Content iframe */}
        <div className="px-6 pt-4 flex-1 min-h-0">
          {currentPage && (
            <iframe
              ref={iframeRef}
              key={currentPage.slug}
              src={`/help/viewer.html?page=${currentPage.slug}`}
              className="w-full border border-zinc-200 rounded-md bg-white"
              style={{ height: "60vh" }}
              title={currentPage.title}
            />
          )}
        </div>

        {/* Footer with navigation */}
        <div className="px-6 pb-4 pt-3 flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentIndex((i) => i - 1)}
            disabled={!hasPrev}
            title="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentIndex((i) => i + 1)}
            disabled={!hasNext}
            title="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          <Select
            value={currentPage?.slug ?? ""}
            onValueChange={(slug) => {
              const idx = pages.findIndex((p) => p.slug === slug);
              if (idx >= 0) setCurrentIndex(idx);
            }}
          >
            <SelectTrigger className="w-48 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pages.map((page) => (
                <SelectItem key={page.slug} value={page.slug}>
                  {page.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="text-xs text-zinc-400 ml-1">
            {pages.length > 0 ? `${currentIndex + 1} / ${pages.length}` : ""}
          </span>

          <div className="flex-1" />

          <Button variant="outline" size="sm" onClick={handleClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
