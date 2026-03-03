"use client";

import { useState, useRef, useCallback } from "react";
import type { Label } from "@prisma/client";
import { toast } from "sonner";
import type { DocWithLabels } from "@/types";
import { Button } from "@/components/ui/button";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { LabelProvider } from "@/contexts/label-context";
import { broadcastChange, useCrossTabListener, crossTabReason, type CrossTabReceivedEvent } from "@/lib/cross-tab";
import { apiFetch } from "@/lib/api-fetch";
import {
  AddDocContent,
  type AddDocContentHandle,
} from "@/components/add-doc-content";

interface AddDocPageClientProps {
  initialLabels: Label[];
  initialUrl?: string;
}

interface LastAdded {
  docId: string;
  title: string;
  mimeType: string | null;
}

export function AddDocPageClient({
  initialLabels,
  initialUrl,
}: AddDocPageClientProps) {
  const [labels, setLabels] = useState<Label[]>(initialLabels);
  const contentRef = useRef<AddDocContentHandle>(null);
  const [lastAdded, setLastAdded] = useState<LastAdded | null>(null);

  function handleLabelDelete(id: string) {
    setLabels((prev) => prev.filter((l) => l.labelId !== id));
  }

  const refetchLabels = useCallback(async (event?: CrossTabReceivedEvent) => {
    try {
      const reason = event ? crossTabReason(event) : undefined;
      const res = await apiFetch("/api/labels", { reason });
      if (res.ok) setLabels(await res.json());
    } catch { /* cross-tab sync is best-effort */ }
  }, []);

  useCrossTabListener(refetchLabels);

  const handleSuccess = useCallback((doc: DocWithLabels) => {
    contentRef.current?.reset();
    setLastAdded({ docId: doc.docId, title: doc.title, mimeType: doc.mimeType });
    broadcastChange({ type: "docs" });
    toast.success(`Added "${doc.title}"`);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-md px-4 py-8">
        <h1 className="mb-6 text-lg font-semibold text-zinc-900">
          Add Document
        </h1>

        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <LabelProvider
            allLabels={labels}
            onLabelsChange={setLabels}
            onLabelDelete={handleLabelDelete}
          >
            <AddDocContent
              ref={contentRef}
              initialUrl={initialUrl}
              onSuccess={handleSuccess}
              onUrlChange={() => setLastAdded(null)}
              buttons={({ handleAdd, adding, isValid }) => (
                <div className="mt-6 flex gap-2">
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
                    onClick={() => {
                      contentRef.current?.reset();
                      setLastAdded(null);
                    }}
                    title="Reset the form"
                  >
                    Clear
                  </Button>
                  <Button variant="outline" size="sm" asChild title="Go to the document list">
                    <a href="/docs">Doc List</a>
                  </Button>
                </div>
              )}
            />
          </LabelProvider>

          {lastAdded && (
            <div className="mt-4 flex items-center gap-1.5 text-sm text-zinc-700">
              <span>Document added:</span>
              <a
                href={`/comments/${lastAdded.docId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-zinc-900 hover:underline"
              >
                <DocTypeIcon
                  mimeType={lastAdded.mimeType}
                  className="h-4 w-4 flex-shrink-0"
                />
                {lastAdded.title}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
