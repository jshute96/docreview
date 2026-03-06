"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { apiFetch, isAuthError, generateContextId } from "@/lib/api-fetch";
import type { DocWithLabels } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLabels } from "@/contexts/label-context";
import { DocForm, type DocFormHandle } from "@/components/add-doc-form";

interface DeleteReAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string;
  docTitle: string;
  mimeType: string | null;
  onSuccess: (newDoc: DocWithLabels) => void;
}

export function DeleteReAddDialog({
  open,
  onOpenChange,
  docId,
  docTitle,
  mimeType,
  onSuccess,
}: DeleteReAddDialogProps) {
  const { allLabels } = useLabels();
  const formRef = useRef<DocFormHandle>(null);

  useEffect(() => {
    if (open) {
      formRef.current?.reset();
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete & re-add document</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="p-6 pt-1">
            <DocForm
              ref={formRef}
              onSuccess={onSuccess}
              fixedDocId={docId}
              fixedTitle={docTitle}
              fixedMimeType={mimeType}
              apiEndpoint={`/api/docs/${docId}/re-add`}
              buttons={({ handleAction, processing }) => (
                <div className="mt-2 flex gap-2 justify-end border-t border-zinc-100 pt-6">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAction}
                    disabled={processing}
                    title="Delete the document and all its state, then add it back as a fresh document"
                  >
                    {processing ? "Deleting & re-adding\u2026" : "Delete & re-add"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenChange(false)}
                    disabled={processing}
                    title="Cancel and close the dialog"
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
