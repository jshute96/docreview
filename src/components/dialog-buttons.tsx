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
    <div className="mt-4 flex gap-2">
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        {cancelLabel}
      </Button>
    </div>
  );
}
