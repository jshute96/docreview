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
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { DocWithLabels } from "@/types";
import { LabelPicker } from "@/components/label-picker";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";
import { useAutoResize } from "@/hooks/use-auto-resize";
import { useLabelSync } from "@/hooks/use-label-sync";
import { useLabels } from "@/contexts/label-context";
import { Checkbox } from "@/components/ui/checkbox";
import { StarButton } from "@/components/star-button";

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
    const [notes, setNotes] = useState("");
    const [isStarred, setIsStarred] = useState(false);
    const [addToInbox, setAddAsActive] = useState(true);
    const [processing, setProcessing] = useState(false);

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const notesRef = useRef<HTMLTextAreaElement>(null);
    const initialUrlTriggered = useRef(false);

    useLabelSync(allLabels, setSelectedLabelIds);
    useAutoResize(notesRef, notes);

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
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    }

    useImperativeHandle(ref, () => ({ reset: resetForm }));

    function toggleLabel(id: string) {
      setSelectedLabelIds((prev) =>
        prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
      );
    }

    async function validateUrl(urlToValidate: string) {
      const controller = new AbortController();
      abortRef.current = controller;
      setValidationState("validating");

      try {
        const res = await apiFetch(
          `/api/docs/validate?url=${encodeURIComponent(urlToValidate)}`,
          { signal: controller.signal }
        );
        const data = await res.json();
        if (res.ok) {
          setValidTitle(data.title ?? null);
          setValidMimeType(data.mimeType ?? null);
          setValidationState("valid");
          if (data.existing) {
            setIsExisting(true);
            setExistingDocId(data.docId ?? null);
            setSelectedLabelIds(data.labels ?? []);
            setIsStarred(data.isStarred ?? false);
            setNotes(data.notes ?? "");
            setAddAsActive(data.status === "INBOX");
          } else {
            setIsExisting(false);
            setExistingDocId(null);
          }
        } else {
          if (data.title) setValidTitle(data.title);
          if (data.mimeType) setValidMimeType(data.mimeType);
          setValidationState("invalid");
          setValidationError(errorMessageForCode(data.error));
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        if (!isAuthError(err)) {
          setValidationState("invalid");
          setValidationError("Validation failed");
        }
      }
    }

    function handleUrlChange(newUrl: string) {
      setUrl(newUrl);
      setValidationState("idle");
      setValidationError(null);
      setValidTitle(null);
      setValidMimeType(null);
      setExistingDocId(null);
      setIsExisting(false);
      onUrlChange?.();

      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      if (!newUrl.trim()) return;

      debounceRef.current = setTimeout(() => {
        validateUrl(newUrl);
      }, 250);
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
            url: fixedDocId ? undefined : url,
            labelIds: selectedLabelIds,
            isStarred,
            notes,
            status: addToInbox ? "INBOX" : "ARCHIVED",
          }),
        });
        if (!res.ok) throw new Error("Action failed");
        const newDoc: DocWithLabels = await res.json();
        onSuccess(newDoc);
        return newDoc;
      } catch (err) {
        if (!isAuthError(err)) toast.error("Operation failed");
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
      };
    }, []);

    function ValidationIcon() {
      switch (validationState) {
        case "idle":
          return <CheckCircle2 className="h-4 w-4 text-zinc-300" />;
        case "validating":
          return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
        case "valid":
          return <CheckCircle2 className="h-4 w-4 text-green-500" />;
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
                {existingDocId ? (
                  <a
                    href={`/comments/${existingDocId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 hover:underline line-clamp-1"
                    title={validTitle}
                  >
                    <DocTypeIcon
                      mimeType={validMimeType}
                      className="h-4 w-4 flex-shrink-0"
                    />
                    {validTitle}
                  </a>
                ) : (
                  <p
                    className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 line-clamp-1"
                    title={validTitle}
                  >
                    <DocTypeIcon
                      mimeType={validMimeType}
                      className="h-4 w-4 flex-shrink-0"
                    />
                    {validTitle}
                  </p>
                )}
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
            placeholder="Add notes..."
            rows={1}
            className={`${TEXTAREA_CLASSES} w-full max-h-[200px]`}
          />
        </div>

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
