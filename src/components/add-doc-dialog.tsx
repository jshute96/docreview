"use client";

import { useState, useRef, useCallback } from "react";
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
import { openCommentsPage } from "@/lib/tab-targets";
import {
  DocForm,
  type DocFormHandle,
} from "@/components/add-doc-form";

interface AddDocDialogProps {
  onDocAdded: (doc: DocWithLabels) => void;
  trigger?: React.ReactNode;
}

export function AddDocDialog({
  onDocAdded,
  trigger,
}: AddDocDialogProps) {
  const [open, setOpen] = useState(false);
  const [dialogExisting, setDialogExisting] = useState(false);
  const contentRef = useRef<DocFormHandle>(null);
  const handleExistingChange = useCallback((v: boolean) => setDialogExisting(v), []);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) {
          contentRef.current?.reset();
          setDialogExisting(false);
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
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{dialogExisting ? "Update Document" : "Add Document"}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="p-6 pt-4">
            <DocForm
              ref={contentRef}
              onExistingChange={handleExistingChange}
              onSuccess={(newDoc) => {
                const wasExisting = dialogExisting;
                onDocAdded(newDoc);
                setOpen(false);
                broadcastChange({ type: "docs", docIds: [newDoc.docId] });
                toast.success(`${wasExisting ? "Updated" : "Added"} "${newDoc.title || "Unknown title"}"`)
              }}
              buttons={({ handleAction, processing, isValid, isExisting, existingDocId }) => (
                <div className="mt-4 flex gap-2 justify-end">
                  {isExisting && existingDocId && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mr-auto"
                      onClick={() => window.open(`/comments/${existingDocId}`, "_blank")}
                      title="Open the document's comments page"
                    >
                      Open
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isValid || processing}
                    onClick={handleAction}
                    title={isExisting ? "Update the document in your list" : "Add the document to your list"}
                  >
                    {processing
                      ? (isExisting ? "Updating\u2026" : "Adding\u2026")
                      : (isExisting ? "Update" : "Add")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isValid || processing}
                    onClick={async () => {
                      const doc = await handleAction();
                      if (doc) openCommentsPage(doc.docId, doc.googleDocId);
                    }}
                    title={isExisting ? "Update the document and open its comments page" : "Add the document and open its comments page"}
                  >
                    {isExisting ? "Update & Open" : "Add & Open"}
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
