"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";
import type { DocWithLabels } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { broadcastChange } from "@/lib/cross-tab";
import {
  AddDocContent,
  type AddDocContentHandle,
} from "@/components/add-doc-content";

interface AddDocDialogProps {
  onDocAdded: (doc: DocWithLabels) => void;
  trigger?: React.ReactNode;
}

export function AddDocDialog({
  onDocAdded,
  trigger,
}: AddDocDialogProps) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<AddDocContentHandle>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) {
          contentRef.current?.reset();
        }
        setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" title="Add a Google Drive document by URL or doc ID">
            Add doc
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Document</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="p-6 pt-4">
            <AddDocContent
              ref={contentRef}
              onSuccess={(newDoc) => {
                onDocAdded(newDoc);
                setOpen(false);
                broadcastChange({ type: "docs", docId: newDoc.docId });
                toast.success(`Added "${newDoc.title}"`);
              }}
              buttons={({ handleAdd, adding, isValid }) => (
                <div className="mt-4 flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isValid || adding}
                    onClick={handleAdd}
                    title="Add the document to your list"
                  >
                    {adding ? "Adding\u2026" : "Add"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isValid || adding}
                    onClick={async () => {
                      const doc = await handleAdd();
                      if (doc) window.open(`/comments/${doc.docId}`, "_blank");
                    }}
                    title="Add the document and open its comments page"
                  >
                    Add & Open
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen(false)}
                    title="Close without adding"
                  >
                    Cancel
                  </Button>
                </div>
              )}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
