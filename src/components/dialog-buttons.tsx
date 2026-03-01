"use client";

import { Button } from "@/components/ui/button";

interface DialogButtonsProps {
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  disabled?: boolean;
}

export function DialogButtons({
  onConfirm,
  onCancel,
  confirmLabel = "Save",
  cancelLabel = "Cancel",
  disabled = false,
}: DialogButtonsProps) {
  return (
    <div className="mt-2 flex gap-2 justify-end">
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onConfirm} className="text-zinc-900">
        {confirmLabel}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onCancel} className="text-zinc-900">
        {cancelLabel}
      </Button>
    </div>
  );
}
