"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { clearAll as clearBrowserCache } from "@/lib/browser-cache";
import { apiFetch } from "@/lib/api-fetch";
import { broadcastChange } from "@/lib/cross-tab";

type Step = "confirm" | "choose";

interface DeleteAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteAllDialog({ open, onOpenChange }: DeleteAllDialogProps) {
  const [step, setStep] = useState<Step>("confirm");
  const [deleting, setDeleting] = useState(false);

  function reset() {
    setStep("confirm");
    setDeleting(false);
    onOpenChange(false);
  }

  async function doDelete(deleteAccount: boolean) {
    setDeleting(true);
    try {
      const res = await apiFetch("/api/user/delete-all-data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteAccount }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Delete failed");
      }
      clearBrowserCache();
      if (deleteAccount) {
        broadcastChange({ type: "signout" });
        toast.success("All data deleted");
        signOut({ callbackUrl: "/login" });
      } else {
        broadcastChange({ type: "docs" });
        broadcastChange({ type: "labels" });
        toast.success("All data deleted — your account has been reset");
        reset();
        window.location.reload();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  // When dialog opens, always start at step 1
  function handleOpenChange(isOpen: boolean) {
    if (isOpen) {
      setStep("confirm");
      setDeleting(false);
    }
    onOpenChange(isOpen);
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        {step === "confirm" ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete all data?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete all your documents, comments, labels,
                and settings from Docreview. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={reset}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={(e) => { e.preventDefault(); setStep("choose"); }} className={buttonVariants({ variant: "outline" })}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Should we also delete user credentials?</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={reset} disabled={deleting}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); doDelete(false); }}
                disabled={deleting}
                className={buttonVariants({ variant: "outline" })}
                title="Deletes all your data but keeps your login, resetting to new user state"
              >
                Delete data, stay logged in
              </AlertDialogAction>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); doDelete(true); }}
                disabled={deleting}
                className={buttonVariants({ variant: "outline" })}
                title="Deletes all your data and removes your login credentials from Docreview"
              >
                Delete data and log out
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
