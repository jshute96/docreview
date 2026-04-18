"use client";

import {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { apiFetch, isAuthError } from "@/lib/api-fetch";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { DocStatus } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import { LabelPicker } from "@/components/label-picker";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";
import { useAutoResize } from "@/hooks/use-auto-resize";
import { useLabelSync } from "@/hooks/use-label-sync";
import { useLabels } from "@/contexts/label-context";
import { Checkbox } from "@/components/ui/checkbox";
import { StarButton } from "@/components/star-button";
import { getExtensionStatus, pingExtension, resolveUrl, cancelResolve } from "@/lib/bridge-to-extension";

type ValidationState = "idle" | "validating" | "valid" | "invalid";

function errorMessageForCode(code: string): string {
  switch (code) {
    case "invalid_url":
      return "Not a recognized Google Drive URL or doc ID";
    case "invalid_mime_type":
      return "Only Docs, Sheets, and Slides are supported";
    case "trashed":
      return "This document is in the trash";
    case "no_access":
      return "Document not found or you don't have access";
    default:
      return "Validation failed";
  }
}

/** Check if a URL's hostname is in the extension's resolve hosts list. */
function matchesResolveHosts(input: string, hosts: string[]): boolean {
  if (!hosts.length) return false;
  const trimmed = input.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?([^\/\s]+)\/(.+)/);
  if (!match) return false;
  return hosts.includes(match[1].toLowerCase());
}

export interface DocFormHandle {
  reset: () => void;
}

interface DocFormProps {
  onSuccess: (doc: DocWithLabels) => void;
  // If fixedDocId is provided, we skip URL validation and show the fixed doc title
  fixedDocId?: string;
  fixedTitle?: string;
  fixedMimeType?: string | null;
  // For URL mode
  initialUrl?: string;
  initialNotes?: string;
  onUrlChange?: () => void;
  onExistingChange?: (isExisting: boolean) => void;
  // Custom API endpoint (defaults to /api/docs/add)
  apiEndpoint?: string;
  // Render prop for buttons
  buttons: (args: {
    handleAction: () => Promise<DocWithLabels | null>;
    processing: boolean;
    isValid: boolean;
    isExisting: boolean;
    existingDocId: string | null;
  }) => ReactNode;
}

export const DocForm = forwardRef<DocFormHandle, DocFormProps>(
  function DocForm({
    onSuccess,
    fixedDocId,
    fixedTitle,
    fixedMimeType,
    initialUrl,
    initialNotes,
    onUrlChange,
    onExistingChange,
    apiEndpoint = "/api/docs/add",
    buttons
  }, ref) {
    const { allLabels } = useLabels();
    const [url, setUrl] = useState(initialUrl ?? "");
    const [validationState, setValidationState] =
      useState<ValidationState>(fixedDocId ? "valid" : "idle");
    const [validationError, setValidationError] = useState<string | null>(null);
    const [validTitle, setValidTitle] = useState<string | null>(fixedTitle ?? null);
    const [validMimeType, setValidMimeType] = useState<string | null>(fixedMimeType ?? null);
    const [existingDocId, setExistingDocId] = useState<string | null>(fixedDocId ?? null);
    const [isExisting, setIsExisting] = useState(false);
    const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
    const [notes, setNotes] = useState(initialNotes ?? "");
    const [isStarred, setIsStarred] = useState(false);
    const [addToInbox, setAddAsActive] = useState(true);
    const [processing, setProcessing] = useState(false);
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [validDriveUrl, setValidDriveUrl] = useState<string | null>(null);
    const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const notesRef = useRef<HTMLTextAreaElement>(null);
    const initialUrlTriggered = useRef(false);
    const resolveInFlight = useRef(false);
    const pastedRef = useRef(false);
    const validTitleRef = useRef<string | null>(validTitle);

    validTitleRef.current = validTitle;

    useLabelSync(allLabels, setSelectedLabelIds);
    useAutoResize(notesRef, notes);

    // Ping the extension on mount so the cached status is ready when needed.
    // This is async — the result will be available by the time the user types.
    const extensionReady = useRef<Promise<void> | null>(null);
    useEffect(() => {
      extensionReady.current = pingExtension().then(() => {});
    }, []);

    useEffect(() => {
      onExistingChange?.(isExisting);
    }, [isExisting, onExistingChange]);

    function resetForm() {
      setUrl("");
      setValidationState(fixedDocId ? "valid" : "idle");
      setValidationError(null);
      setValidTitle(fixedTitle ?? null);
      setValidMimeType(fixedMimeType ?? null);
      setExistingDocId(fixedDocId ?? null);
      setIsExisting(false);
      setSelectedLabelIds([]);
      setIsStarred(false);
      setNotes("");
      setAddAsActive(true);
      setProcessing(false);
      setPermissionDenied(false);
      setValidDriveUrl(null);
      setResolvedUrl(null);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    }

    useImperativeHandle(ref, () => ({ reset: resetForm }));

    function toggleLabel(id: string) {
      setSelectedLabelIds((prev) =>
        prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
      );
    }

    /** Apply validation response data to form state. */
    function applyValidationResult(data: Record<string, unknown>, ok: boolean) {
      if (ok) {
        setValidDriveUrl((data.driveUrl as string) ?? null);
        if (data.permissionDenied) {
          setPermissionDenied(true);
          setValidTitle((data.title as string) ?? "Unknown title");
          setValidMimeType((data.mimeType as string) ?? null);
          setValidationState("valid");
          setValidationError("Document not found or you don't have access");
        } else {
          setPermissionDenied(false);
          setValidTitle((data.title as string) ?? null);
          setValidMimeType((data.mimeType as string) ?? null);
          setValidationState("valid");
          setValidationError(null);
        }
        if (data.existing) {
          setIsExisting(true);
          setExistingDocId((data.docId as string) ?? null);
          setSelectedLabelIds((data.labels as string[]) ?? []);
          setIsStarred((data.isStarred as boolean) ?? false);
          setNotes((data.notes as string) ?? "");
          setAddAsActive(data.status === DocStatus.INBOX);
        } else {
          setIsExisting(false);
          setExistingDocId(null);
        }
      } else {
        if (data.title) setValidTitle(data.title as string);
        if (data.mimeType) setValidMimeType(data.mimeType as string);
        if (data.driveUrl) setValidDriveUrl(data.driveUrl as string);
        setValidationState("invalid");
        setValidationError(errorMessageForCode(data.error as string));
      }
    }

    /** Validate a URL against the server. Returns true if the URL was valid. */
    async function serverValidate(
      urlToValidate: string,
      signal: AbortSignal
    ): Promise<boolean> {
      const res = await apiFetch(
        `/api/docs/validate?url=${encodeURIComponent(urlToValidate)}`,
        { signal }
      );
      const data = await res.json();
      if (signal.aborted) return false;
      applyValidationResult(data, res.ok);
      return res.ok;
    }

    async function validateUrl(urlToValidate: string) {
      const controller = new AbortController();
      abortRef.current = controller;
      setValidationState("validating");

      // Wait for the extension ping to complete if it hasn't yet
      if (extensionReady.current) {
        await extensionReady.current;
        if (controller.signal.aborted) return;
      }
      const extension = getExtensionStatus();

      // Run server validation immediately for fast feedback.
      // For redirect URLs, also try extension resolution after —
      // if it resolves, re-validate with the resolved URL.
      try {
        const serverOk = await serverValidate(urlToValidate, controller.signal);
        if (controller.signal.aborted) return;

        // If server already accepted it, no need for extension resolution
        if (serverOk) return;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        if (!isAuthError(err)) {
          setValidationState("invalid");
          setValidationError("Validation failed");
        }
        // If server validation errored, still try extension below
      }

      // Server rejected the URL — if the extension can resolve it, try that
      if (extension?.enableResolve && matchesResolveHosts(urlToValidate, extension.resolveHosts)) {
        try {
          setValidationState("validating");
          resolveInFlight.current = true;
          console.log("[extension] Resolving:", urlToValidate);
          const result = await resolveUrl(urlToValidate);
          resolveInFlight.current = false;
          if (result.resolved) {
            console.log("[extension] Resolved to:", result.url);
          } else {
            console.log("[extension] Resolution failed:", result.error ?? "not a Google Doc");
          }
          if (controller.signal.aborted) return;
          if (result.resolved && result.url) {
            setResolvedUrl(result.url);
            // Re-validate with the resolved URL
            try {
              await serverValidate(result.url, controller.signal);
            } catch (err) {
              if (err instanceof Error && err.name === "AbortError") return;
              if (!isAuthError(err)) {
                setValidationState("invalid");
                setValidationError("Validation failed");
              }
            }
          } else {
            // Extension couldn't resolve — restore the server's invalid result
            setValidationState("invalid");
            setValidationError(errorMessageForCode("invalid_url"));
          }
        } catch (err) {
          resolveInFlight.current = false;
          // Restore the server's invalid result
          setValidationState("invalid");
          setValidationError(errorMessageForCode("invalid_url"));
        }
      }
    }

    function handleUrlChange(newUrl: string) {
      const immediate = pastedRef.current;
      pastedRef.current = false;
      setUrl(newUrl);
      setValidationState("idle");
      setValidationError(null);
      setValidTitle(null);
      setValidMimeType(null);
      setExistingDocId(null);
      setIsExisting(false);
      setPermissionDenied(false);
      setValidDriveUrl(null);
      setResolvedUrl(null);
      onUrlChange?.();

      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      // Cancel any in-flight extension URL resolution
      if (resolveInFlight.current) {
        cancelResolve();
        resolveInFlight.current = false;
      }

      if (!newUrl.trim()) return;

      if (immediate) {
        validateUrl(newUrl);
      } else {
        debounceRef.current = setTimeout(() => {
          validateUrl(newUrl);
        }, 250);
      }
    }

    // Auto-validate initialUrl on mount
    useEffect(() => {
      if (initialUrl && !initialUrlTriggered.current) {
        initialUrlTriggered.current = true;
        validateUrl(initialUrl);
      }
    }, [initialUrl]);

    async function handleAction(): Promise<DocWithLabels | null> {
      setProcessing(true);
      try {
        const res = await apiFetch(apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: fixedDocId ? undefined : (resolvedUrl ?? url),
            labelIds: selectedLabelIds,
            isStarred,
            notes,
            status: addToInbox ? DocStatus.INBOX : DocStatus.ARCHIVED,
            ...(permissionDenied && validTitle ? { title: validTitle } : {}),
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const code = data?.error as string | undefined;
          throw new Error(code ? errorMessageForCode(code) : "Operation failed");
        }
        const newDoc: DocWithLabels = await res.json();
        // API strips titles (stripServerOnly) — restore from validation state
        if (!newDoc.title && validTitleRef.current) newDoc.title = validTitleRef.current;
        onSuccess(newDoc);
        return newDoc;
      } catch (err) {
        if (!isAuthError(err)) {
          const msg = err instanceof Error ? err.message : "Operation failed";
          toast.error(msg);
        }
        return null;
      } finally {
        setProcessing(false);
      }
    }

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (abortRef.current) abortRef.current.abort();
        if (resolveInFlight.current) cancelResolve();
      };
    }, []);

    function ValidationIcon() {
      switch (validationState) {
        case "idle":
          return <CheckCircle2 className="h-4 w-4 text-zinc-300" />;
        case "validating":
          return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
        case "valid":
          return permissionDenied
            ? <AlertTriangle className="h-4 w-4 text-amber-500" />
            : <CheckCircle2 className="h-4 w-4 text-green-500" />;
        case "invalid":
          return <XCircle className="h-4 w-4 text-red-500" />;
      }
    }

    return (
      <div className="flex flex-col gap-4">
        {fixedDocId ? (
          <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 line-clamp-1">
            <DocTypeIcon mimeType={validMimeType} className="h-4 w-4 flex-shrink-0" />
            {validTitle}
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="URL or doc ID"
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                onPaste={() => { pastedRef.current = true; }} // skip debounce on paste
                onFocus={(e) => e.target.select()}
                className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
              />
              <ValidationIcon />
            </div>
            {validationError && (
              <p className="mt-1 text-xs text-red-500">{validationError}</p>
            )}
            {isExisting && (
              <p className="mt-1 text-xs text-green-600">This document already exists</p>
            )}
            {validTitle && (
              <div className="mt-1.5">
                <a
                  href={existingDocId ? `/comments/${existingDocId}` : (validDriveUrl ?? "#")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center gap-1.5 text-sm font-medium hover:underline line-clamp-1 ${
                    permissionDenied && !isExisting ? "text-zinc-400 hover:text-blue-600" : "text-zinc-900 hover:text-blue-600"
                  }`}
                  title={existingDocId ? validTitle : "Open document"}
                >
                  <DocTypeIcon
                    mimeType={validMimeType}
                    className="h-4 w-4 flex-shrink-0"
                  />
                  {validTitle}
                </a>
              </div>
            )}
          </div>
        )}

        <LabelPicker
          selectedLabelIds={selectedLabelIds}
          onToggle={toggleLabel}
          prefix={<StarButton starred={isStarred} onToggle={() => setIsStarred(!isStarred)} />}
        />

        <div>
          <label className="mb-1.5 block text-xs font-medium text-zinc-900 uppercase tracking-wide">
            Notes
          </label>
          <textarea
            ref={notesRef}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="Add notes..."
            rows={1}
            className={`${TEXTAREA_CLASSES} w-full max-h-[200px]`}
          />
        </div>

        {permissionDenied && !isExisting && (
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-zinc-900 flex-shrink-0">Set title:</label>
            <input
              type="text"
              value={validTitle ?? ""}
              onChange={(e) => setValidTitle(e.target.value)}
              onFocus={(e) => e.target.select()}
              placeholder="Unknown title"
              className="min-w-[60%] flex-1 rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
            />
          </div>
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            id="doc-form-inbox"
            checked={addToInbox}
            onCheckedChange={(checked) => setAddAsActive(checked === true)}
          />
          <label
            htmlFor="doc-form-inbox"
            className="text-sm text-zinc-700 "
          >
            Add to Inbox
          </label>
        </div>

        {buttons({
          handleAction,
          processing,
          isValid: validationState === "valid",
          isExisting,
          existingDocId,
        })}
      </div>
    );
  }
);
