"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { signOut } from "next-auth/react";
import { toast } from "sonner";
import { RefreshCw, Trash2, Pencil, CircleHelp } from "lucide-react";
import { HamburgerButton } from "@/components/hamburger-button";
import { AccessState, CommentStatus, CommentType, DocRole, DocStatus, type Comment, type Label } from "@prisma/client";
import type { DocWithComments, DocWithLabels } from "@/types";
import type { CommentThread, ThreadMap, SuggestionContent } from "@/lib/google-drive";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { LabelBadge } from "@/components/label-badge";
import { EditDocDialog } from "@/components/edit-doc-dialog";
import { DeleteReAddDialog } from "@/components/delete-readd-dialog";
import { ROLE_COLORS } from "@/lib/role-colors";
import type { TriState } from "@/lib/tri-state";
import { CommentFilterBar } from "@/components/comment-filter-bar";
import { isThreadRead, totalMessageCount } from "@/lib/read-state";
import { CommentRow } from "@/components/comment-row";
import { pingExtension, navigateToComment, handleOpenDocClick, supportsCommentNavigation, selectCommentInDoc, setCommentSelectionHandler, setDocReadyHandler, getCommentsAndSuggestionsFromDoc, getSuggestionFromDoc, type ExtensionSuggestion, type ExtensionCommentInfo } from "@/lib/bridge-to-extension";
import { extensionToThread, extensionToSuggestionContent } from "@/lib/extension-suggestions";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FriendlyDate } from "@/components/friendly-date";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogButtons } from "@/components/dialog-buttons";
import { formatDate } from "@/lib/utils";
import { createMatcher } from "@/lib/highlight";
import { broadcastChange, useCrossTabListener, crossTabReason, type CrossTabReceivedEvent } from "@/lib/cross-tab";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";
import { HelpDialog } from "@/components/help-dialog";
import { StarButton } from "@/components/star-button";
import { LabelProvider } from "@/contexts/label-context";
import { useCachedMetadata } from "@/hooks/use-cached-metadata";
import { docTarget } from "@/lib/tab-targets";

// Bounds the automatic re-fetch after a partial extension scrape (see
// schedulePartialScrapeRetry). The budget is per episode, not per page load —
// it resets once a scrape comes back complete.
const PARTIAL_SCRAPE_MAX_RETRIES = 3;
const PARTIAL_SCRAPE_RETRY_MS = 2000;

// Key for looking up thread/content/suggestion data — suggestions use googleSuggestionId,
// comments use googleCommentId. Extension-sourced suggestions only have googleCommentId
// (disco ID) so we fall back to that.
function commentKey(c: Comment): string {
  if (c.type === CommentType.SUGGESTION) return c.googleSuggestionId ?? c.googleCommentId ?? "";
  return c.googleCommentId ?? "";
}

/** Merge new thread data into an existing map, preserving extension-sourced fields
 *  (originalContentDeleted, tabName) that Drive API data doesn't carry. */
function mergeThreads(prev: ThreadMap, incoming: ThreadMap): ThreadMap {
  const merged = { ...prev, ...incoming };
  for (const id of Object.keys(incoming)) {
    const p = prev[id];
    if (!p) continue;
    const restore: Partial<CommentThread> = {};
    if (p.originalContentDeleted !== undefined && incoming[id].originalContentDeleted === undefined) restore.originalContentDeleted = p.originalContentDeleted;
    if (p.tabName && !incoming[id].tabName) restore.tabName = p.tabName;
    if (Object.keys(restore).length > 0) merged[id] = { ...merged[id], ...restore };
  }
  return merged;
}

interface DocDetailProps {
  doc: DocWithComments;
  allLabels: Label[];
  userId: string;
  userName?: string;
}

export function DocDetail({ doc: initialDoc, allLabels: initialLabels, userId, userName }: DocDetailProps) {
  const [doc, setDoc] = useState(initialDoc);
  const [labels, setLabelsRaw] = useState<Label[]>(initialLabels);
  const { titles: cachedTitles, owners: cachedOwners } = useCachedMetadata(userId, [doc]);
  const displayTitle = cachedTitles[doc.googleDocId] || doc.title || "Unknown title";
  const googleDocId = doc.driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? doc.googleDocId;

  function handleOpenDoc(e: React.MouseEvent<HTMLAnchorElement>) {
    handleOpenDocClick(e, googleDocId, doc.driveUrl, docTarget(googleDocId));
  }

  function setLabels(newLabels: Label[]) {
    setLabelsRaw(newLabels);
    const labelMap = new Map(newLabels.map((l) => [l.labelId, l]));
    setDoc((prev) => ({
      ...prev,
      labels: prev.labels
        .map((dl) => ({
          ...dl,
          label: labelMap.get(dl.labelId) ?? dl.label,
        }))
        .sort((a, b) => (a.label?.position ?? 0) - (b.label?.position ?? 0)),
    }));
  }

  function handleLabelDelete(id: string) {
    setLabels(labels.filter((l) => l.labelId !== id));
    setDoc((prev) => ({
      ...prev,
      labels: prev.labels.filter((dl) => dl.labelId !== id),
    }));
  }

  const [comments, setComments] = useState<Comment[]>(initialDoc.comments);
  const [archiving, setArchiving] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [bulkArchiving, setBulkArchiving] = useState(false);
  const [bulkArchivingResolved, setBulkArchivingResolved] = useState(false);
  const [bulkUnarchiving, setBulkUnarchiving] = useState(false);
  const [bulkMarkingRead, setBulkMarkingRead] = useState(false);
  const [bulkMarkingUnread, setBulkMarkingUnread] = useState(false);
  const [threadMap, setThreadMap] = useState<ThreadMap>({});
  const [threadsForbidden, setThreadsForbidden] = useState(false);
  const [suggestionContent, setSuggestionContent] = useState<Record<string, SuggestionContent>>({});
  const [documentText, setDocumentText] = useState<string | undefined>(undefined);
  const [viewedByMeTime, setViewedByMeTime] = useState<string | null>(null);
  const [showUntrackDialog, setShowUntrackDialog] = useState(false);
  const [showReAddDialog, setShowReAddDialog] = useState(false);
  const [showViewedTimeDialog, setShowViewedTimeDialog] = useState(false);
  const [viewedTimeInput, setViewedTimeInput] = useState("");
  const [savingViewedTime, setSavingViewedTime] = useState(false);

  const viewedTimeInputValid = !isNaN(new Date(viewedTimeInput).getTime()) && viewedTimeInput.trim() !== "";

  async function handleSaveViewedTime() {
    setSavingViewedTime(true);
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}/viewed-time`, {
        method: "PUT",
        body: JSON.stringify({ viewedByMeTime: new Date(viewedTimeInput).toISOString() }),
        contextId: generateContextId(),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      setViewedByMeTime(data.viewedByMeTime);
      setShowViewedTimeDialog(false);
      toast.success("Viewed time updated");
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to update viewed time");
    } finally {
      setSavingViewedTime(false);
    }
  }

  // Derive searchable text from threadMap (author names + all reply content)
  const threadText = useMemo(() => {
    const result: Record<string, string> = {};
    for (const [id, thread] of Object.entries(threadMap)) {
      const parts: string[] = [thread.author, thread.content];
      for (const r of thread.replies) {
        if (r.author) parts.push(r.author);
        if (r.content) parts.push(r.content);
      }
      result[id] = parts.join("\n");
    }
    return result;
  }, [threadMap]);

  // Derive preview content ("Author: text") from threadMap
  const commentContent = useMemo(() => {
    const result: Record<string, string> = {};
    for (const [id, thread] of Object.entries(threadMap)) {
      result[id] = thread.author ? `${thread.author}: ${thread.content}` : thread.content;
    }
    return result;
  }, [threadMap]);

  const handleThreadUpdate = useCallback((id: string, thread: CommentThread) => {
    setThreadMap((prev) => ({ ...prev, [id]: thread }));
  }, []);

  // Push extension suggestions to the server for DB merge, then replace the
  // matching entries in the local comments list with the updated DB records.
  // Returns the server's `skipped` count — suggestions it refused to store
  // because their disco ID didn't validate. The extension and the server apply
  // slightly different checks, so a suggestion can pass the scrape (counted as
  // present, not missing) and still be rejected here; treating that as a
  // partial result keeps it eligible for a re-fetch.
  //
  // Returns null when the merge didn't happen at all (non-OK response). Callers
  // must not read that as "0 skipped" — nothing was persisted, so the fetch is
  // incomplete and needs retrying just as much as a partial scrape does.
  async function mergeExtensionSuggestions(suggestions: ExtensionSuggestion[], contextId?: string): Promise<number | null> {
    const cid = contextId ?? generateContextId();
    const res = await apiFetch(`/api/docs/${doc.docId}/extension-suggestions`, {
      method: "POST",
      body: JSON.stringify({ suggestions }),
      contextId: cid,
    });
    if (!res.ok) {
      console.log("[doc-detail] extension suggestions: server merge failed", res.status); // eslint-disable-line no-console
      return null;
    }
    const data = await res.json();
    if (data.comments && Array.isArray(data.comments)) {
      setComments(prev => {
        const returnedIds = new Set((data.comments as Comment[]).map((c: Comment) => c.commentId));
        const withoutReturned = prev.filter(c => !returnedIds.has(c.commentId));
        return [...withoutReturned, ...(data.comments as Comment[])];
      });
    }
    return typeof data.result?.skipped === "number" ? data.result.skipped : 0;
  }

  const handleSuggestionRefresh = useCallback((discoId: string, thread: CommentThread, content: SuggestionContent, raw: ExtensionSuggestion) => {
    setThreadMap((prev) => ({ ...prev, [discoId]: thread }));
    setSuggestionContent((prev) => ({ ...prev, [discoId]: content }));
    const contextId = generateContextId();
    mergeExtensionSuggestions([raw], contextId).then((skipped) => {
      // null = the request failed outright; > 0 = the server rejected the disco
      // ID. Either way nothing was persisted, so don't broadcast a change that
      // didn't happen, and don't let the local panel update imply it synced.
      if (skipped === null || skipped > 0) {
        console.log("[doc-detail] suggestion refresh: not saved —", skipped === null ? "merge request failed" : "server rejected the disco ID"); // eslint-disable-line no-console
        // Distinct causes deserve distinct advice: a rejected disco ID clears
        // up once the doc's comment pane is fully wired, a failed request doesn't.
        toast.error(skipped === null
          ? "Couldn't save the refreshed suggestion"
          : "Couldn't save the refreshed suggestion — try again once the doc finishes loading");
        return;
      }
      broadcastChange({ type: "comments", docId: doc.docId, commentType: CommentType.SUGGESTION, googleCommentId: discoId }, contextId);
    }).catch((err) => {
      console.log("[doc-detail] suggestion refresh: server merge error", err);
      if (!isAuthError(err)) toast.error("Couldn't save the refreshed suggestion");
    });
  }, [doc.docId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchThreads(contextId?: string) {
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}/threads`, { contextId });
      if (res.ok) {
        const data = await res.json();
        setThreadMap(prev => mergeThreads(prev, data.threads ?? {}));
        if (data.viewedByMeTime !== undefined) setViewedByMeTime(data.viewedByMeTime);
        setThreadsForbidden(data.forbidden ?? false);
      }
    } catch { /* threads are optional */ }
  }

  async function fetchDocContent(contextId?: string) {
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}/content`, { contextId });
      if (res.ok) {
        const data = await res.json();
        setSuggestionContent(prev => ({ ...prev, ...(data.suggestions ?? {}) }));
        if (data.documentText !== undefined) setDocumentText(data.documentText);
      }
    } catch { /* content is optional */ }
  }

  function fetchContent(contextId?: string) {
    void fetchThreads(contextId);
    void fetchDocContent(contextId);
  }

  useEffect(() => { void fetchContent(generateContextId()); }, [doc.docId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ping extension on mount so supportsCommentNavigation() has cached status
  // before the user clicks "Open" on a comment. After ping completes, also
  // try to fetch suggestion data from an open doc tab.
  const extensionSuggestionsLoaded = useRef(false);
  useEffect(() => {
    void pingExtension().then(() => {
      void fetchExtensionCommentsAndSuggestions();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Deferred re-fetch after a partial scrape. `docReady` can't be relied on for
  // this: the extension fires it once per doc page load, so when the Google Doc
  // tab was already open before this page mounted, it has already fired and the
  // handler below never runs. Without this timer the only recovery would be the
  // user manually clicking Refresh.
  const partialScrapeRetries = useRef(0);
  const partialScrapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (partialScrapeTimer.current) clearTimeout(partialScrapeTimer.current);
    // Null it too, not just clear it: schedulePartialScrapeRetry() treats a
    // non-null ref as "a retry is already pending" and would refuse to schedule
    // another one if this component is ever remounted (React Strict Mode does
    // exactly that in dev).
    partialScrapeTimer.current = null;
  }, []);

  function schedulePartialScrapeRetry() {
    if (partialScrapeTimer.current) return; // one in flight already
    if (partialScrapeRetries.current >= PARTIAL_SCRAPE_MAX_RETRIES) {
      console.log("[doc-detail] extension: giving up on partial scrape after", partialScrapeRetries.current, "retries"); // eslint-disable-line no-console
      return;
    }
    partialScrapeRetries.current++;
    partialScrapeTimer.current = setTimeout(() => {
      partialScrapeTimer.current = null;
      void fetchExtensionCommentsAndSuggestions();
    }, PARTIAL_SCRAPE_RETRY_MS);
  }

  // Fetch suggestions and comment info from the Google Docs DOM via the extension:
  //   1. Push suggestions to the server for DB merge (hash matching, insert/update)
  //   2. Merge the returned DB records into the comments list
  //   3. Keep extension thread/content data for reply display (not in DB)
  //   4. Merge comment originalContentDeleted flags into the thread map
  //
  // A partial result is safe to merge because the merge is purely additive:
  // `mergeExtensionSuggestions` never treats "absent from this payload" as
  // resolved or deleted, so a short batch can't retract anything. Don't add
  // deletion reconciliation there without revisiting this.
  async function fetchExtensionCommentsAndSuggestions() {
    const data = await getCommentsAndSuggestionsFromDoc(googleDocId);
    // null covers both "no extension / no doc tab open" (not transient — arming
    // a retry would just burn the budget every 2s for a doc the user never
    // opened) and "bridge timeout / torn-down frame" (transient). We can't tell
    // them apart here, so we deliberately don't retry: returning early preserves
    // any timer and budget an earlier partial already armed, rather than
    // cancelling them the way the complete-scrape branch below would.
    if (!data) return;
    const { suggestions, comments: commentInfos, missingIdCount } = data;

    // A partial scrape (items the extension couldn't assign a disco ID, even
    // after retrying in-page) is transient. Take what we got, but leave the
    // "loaded" flag clear and schedule a re-fetch — marking it loaded here
    // would freeze the page on incomplete data.
    // Two independent questions, deliberately tracked separately:
    //   partial   — should we try again? (incomplete data, or a transient error)
    //   persisted — did anything actually reach the DB?
    // An expired token answers "no" to both: retrying is pointless until the
    // user re-auths, but the load is emphatically not complete, so the
    // `extensionSuggestionsLoaded` gate must stay open for the next fetch.
    let partial = missingIdCount > 0;
    let persisted = true;
    if (partial) {
      console.log("[doc-detail] extension: partial scrape —", missingIdCount, "item(s) had no disco ID; will retry"); // eslint-disable-line no-console
    }

    if (suggestions.length > 0) {
      console.log("[doc-detail] extension: got", suggestions.length, "suggestions from doc tab"); // eslint-disable-line no-console

      // Keep extension thread data and suggestion content for display —
      // the DB doesn't store reply text, so we hold it in the thread map
      const newThreads: ThreadMap = {};
      const newSuggContent: Record<string, SuggestionContent> = {};
      for (const s of suggestions) {
        newThreads[s.id] = extensionToThread(s);
        newSuggContent[s.id] = extensionToSuggestionContent(s);
      }
      setThreadMap(prev => ({ ...prev, ...newThreads }));
      setSuggestionContent(prev => ({ ...prev, ...newSuggContent }));

      // Push to server for DB merge and update the comments list
      try {
        // The server applies its own disco ID check; anything it rejects makes
        // this scrape partial too, even when the extension reported none missing.
        const skipped = await mergeExtensionSuggestions(suggestions);
        if (skipped === null) {
          console.log("[doc-detail] extension: server merge failed; nothing persisted, will retry"); // eslint-disable-line no-console
          persisted = false;
          partial = true;
        } else if (skipped > 0) {
          console.log("[doc-detail] extension: server skipped", skipped, "suggestion(s) with an invalid disco ID; will retry"); // eslint-disable-line no-console
          partial = true;
        }
      } catch (err) {
        // Nothing landed either way, so this is never a completed load.
        persisted = false;
        // Whether to *retry* is a separate question from whether it persisted.
        // An expired token isn't transient — apiFetch already surfaced the
        // reauth toast, and retrying would just repeat it until the budget runs
        // out. Anything else (5xx, network blip) is worth another attempt.
        if (!isAuthError(err)) partial = true;
        console.log("[doc-detail] extension suggestions: server merge error", err); // eslint-disable-line no-console
      }

      if (!partial && persisted) extensionSuggestionsLoaded.current = true;
    }

    if (partial) {
      schedulePartialScrapeRetry();
    } else if (persisted) {
      // Complete scrape — disarm any pending retry before resetting the budget.
      // A retry armed by an earlier partial is now redundant (this fetch got
      // everything), and leaving it armed while zeroing the counter is what
      // would let alternating partial/complete results re-arm a fresh budget
      // indefinitely.
      if (partialScrapeTimer.current) {
        clearTimeout(partialScrapeTimer.current);
        partialScrapeTimer.current = null;
      }
      // Reset so a later unrelated partial (a cross-tab event, the doc reopened
      // elsewhere) gets its own full set of retries instead of inheriting a
      // spent counter from earlier in this page's lifetime.
      partialScrapeRetries.current = 0;
    }

    // Merge originalContentDeleted from extension into comment thread entries
    if (commentInfos.length > 0) {
      mergeCommentInfos(commentInfos);
    }
  }

  /** Merge extension comment info (originalContentDeleted) into existing thread map entries. */
  function mergeCommentInfos(commentInfos: ExtensionCommentInfo[]) {
    setThreadMap(prev => {
      const updates: ThreadMap = {};
      for (const ci of commentInfos) {
        const existing = prev[ci.id];
        const orphaned = ci.originalContentDeleted; // false = checked & not deleted, true = deleted
        const tabName = ci.tabName || undefined;
        if (existing) {
          if (existing.originalContentDeleted !== orphaned ||
              existing.tabName !== tabName) {
            updates[ci.id] = { ...existing, originalContentDeleted: orphaned, tabName };
          }
        } else if (orphaned !== undefined || tabName) {
          // No thread data yet — create a minimal placeholder so the fields are available
          // when the Drive thread data arrives and merges with it
          updates[ci.id] = {
            id: ci.id, author: "", fromMe: false, content: "",
            createdTime: "", resolved: false, replies: [],
            ...(orphaned !== undefined ? { originalContentDeleted: orphaned } : {}),
            tabName,
          };
        }
      }
      if (Object.keys(updates).length === 0) return prev;
      return { ...prev, ...updates };
    });
  }

  // When the extension reports that a Google Doc's stream view has appeared
  // (meaning suggestions are scrapable), auto-fetch suggestions if we haven't
  // successfully loaded them yet. This covers the case where the user clicks
  // "Open" to open the doc — by the time the doc is ready, this fires
  // automatically instead of requiring a manual Refresh.
  useEffect(() => {
    setDocReadyHandler((docId) => {
      console.log("[doc-detail] docReady received for", docId, "| this doc:", googleDocId, "| already loaded:", extensionSuggestionsLoaded.current);
      if (docId !== googleDocId) return;
      if (extensionSuggestionsLoaded.current) return;
      console.log("[doc-detail] docReady: auto-fetching suggestions");
      void fetchExtensionCommentsAndSuggestions();
    });
    return () => setDocReadyHandler(null);
  }, [googleDocId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track which comment is currently selected in the Google Doc tab.
  // When the extension reports a selection change, we highlight the
  // corresponding row in the comments table.
  const [selectedDiscoId, setSelectedDiscoId] = useState<string | null>(null);
  useEffect(() => {
    setCommentSelectionHandler((docId, discoId, selected) => {
      if (docId !== googleDocId) return;
      setSelectedDiscoId(selected ? discoId : null);
    });
    return () => setCommentSelectionHandler(null);
  }, [googleDocId]);

  const [notFound, setNotFound] = useState(false);
  const handleCrossTab = useCallback(async (event: CrossTabReceivedEvent) => {
    if (event.type === "signout") {
      signOut({ callbackUrl: "/login" });
      return;
    }
    try {
      const contextId = generateContextId();
      const reason = crossTabReason(event, "doc-detail");
      // freezeSort: when true, preserves the current table order so updated
      // comments don't jump (e.g. after an extension-triggered comment sync).
      const refetchDoc = async (freezeSort = false) => {
        const docRes = await apiFetch(`/api/docs/${initialDoc.docId}`, { contextId, reason });
        if (docRes.ok) {
          const updated: DocWithComments = await docRes.json();
          setDoc(updated);
          setComments(updated.comments);
          setSortActive(!freezeSort);
        } else if (docRes.status === 404 || docRes.status === 410) {
          setNotFound(true);
        }
      };

      if (event.type === "docs") {
        // Skip if the event is for a different doc
        const isTarget = event.docIds?.includes(initialDoc.docId);
        if (event.docIds && !isTarget) {
          console.log("[cross-tab] doc-detail: ignored docs event for other doc"); // eslint-disable-line no-console
          return;
        }
        console.log("[cross-tab] doc-detail: refreshing (docs event)"); // eslint-disable-line no-console
        const [labelsRes] = await Promise.all([
          apiFetch("/api/labels", { contextId }),
          refetchDoc(),
        ]);
        if (labelsRes.ok) setLabelsRaw(await labelsRes.json());
      } else if (event.type === "labels") {
        console.log("[cross-tab] doc-detail: refreshing (labels event)"); // eslint-disable-line no-console
        const [labelsRes] = await Promise.all([
          apiFetch("/api/labels", { contextId }),
          refetchDoc(),
        ]);
        if (labelsRes.ok) setLabelsRaw(await labelsRes.json());
      } else if (event.type === "comments" && (event.docId === initialDoc.docId || event.docId === initialDoc.googleDocId)) {
        const isSuggestionEvent = event.commentType === CommentType.SUGGESTION;
        // googleCommentId serves different roles depending on event type:
        // for comments it targets a single Drive thread fetch; for suggestions
        // it targets a single extension scrape.
        const googleCommentId = event.googleCommentId;
        // When the sync response included thread data, use it directly instead
        // of making a redundant Drive API call. Suggestion events and events
        // without inline threads fall through to their own handling below.
        const inlineThreads = !isSuggestionEvent && googleCommentId && event.threads
          ? event.threads as ThreadMap : undefined;
        console.log("[cross-tab] doc-detail: refreshing (comments event" + (isSuggestionEvent ? ", suggestion" : "") + (googleCommentId ? `, id=${googleCommentId}` : "") + (inlineThreads ? ", inline" : "") + ")"); // eslint-disable-line no-console
        // Fetch doc (and threads if not inline) in parallel, then apply both
        // state updates together so React batches them into one render. This
        // prevents expanded threads from flashing a loading state — the
        // initialThread sync effect updates fetchedModifiedMs before the
        // staleness check sees the new driveModifiedAt. Also freezes sort order
        // so updated comments don't jump (same as in-app reply).
        //
        // Suggestion events skip the Drive thread fetch — thread data comes
        // from the extension's DOM scrape. After the doc fetch, the extension
        // is re-scraped for richer data (replies, author, accepted/rejected).
        const docPromise = apiFetch(`/api/docs/${initialDoc.docId}`, { contextId, reason });
        const threadsPromise = inlineThreads || isSuggestionEvent
          ? Promise.resolve(null)
          : apiFetch(
              googleCommentId
                ? `/api/docs/${initialDoc.docId}/threads?commentId=${encodeURIComponent(googleCommentId)}`
                : `/api/docs/${initialDoc.docId}/threads`,
              { contextId },
            );
        const [docRes, threadsRes] = await Promise.all([docPromise, threadsPromise]);
        if (docRes.ok) {
          const updated: DocWithComments = await docRes.json();
          // Apply thread data: inline from sync response, or fetched from API.
          // Inline threads always contain exactly one entry (the synced comment),
          // so we merge directly. viewedByMeTime is not updated for inline syncs
          // — it reflects when the user viewed the doc, not comment activity.
          if (inlineThreads) {
            setThreadMap(prev => ({ ...prev, ...inlineThreads }));
          } else if (threadsRes?.ok) {
            const threadData = await threadsRes.json();
            if (googleCommentId) {
              if (Object.keys(threadData.threads).length === 0) {
                setThreadMap(prev => { const next = { ...prev }; delete next[googleCommentId]; return next; });
              } else {
                setThreadMap(prev => mergeThreads(prev, threadData.threads));
              }
            } else {
              setThreadMap(threadData.threads ?? {});
            }
            if (threadData.viewedByMeTime !== undefined) setViewedByMeTime(threadData.viewedByMeTime);
          }
          setDoc(updated);
          setComments(updated.comments);
          setSortActive(false);
          // After updating DB records, re-scrape the extension for richer data
          // (replies, author, accepted/rejected status) — fire-and-forget so the
          // cross-tab handler isn't blocked by the extension round-trip.
          if (isSuggestionEvent && googleCommentId) {
            void (async () => {
              try {
                const raw = await getSuggestionFromDoc(googleDocId, googleCommentId);
                if (!raw) return;
                // Thread and suggestion content are display-only — the DB never
                // stores reply text — so showing them doesn't depend on the merge.
                setThreadMap(prev => ({ ...prev, [googleCommentId]: extensionToThread(raw) }));
                setSuggestionContent(prev => ({ ...prev, [googleCommentId]: extensionToSuggestionContent(raw) }));
                // The merge persists the metadata. Don't discard its outcome:
                // null (request failed) or a non-zero skip means the row wasn't
                // updated, and the panel would otherwise imply it was.
                const skipped = await mergeExtensionSuggestions([raw]);
                if (skipped === null || skipped > 0) {
                  console.log("[cross-tab] doc-detail: suggestion re-scrape not persisted —", // eslint-disable-line no-console
                    skipped === null ? "merge request failed" : "server rejected the disco ID");
                }
              } catch (err) {
                // Background refresh triggered by another tab — log rather than
                // toast, since the user didn't initiate this here.
                console.log("[cross-tab] doc-detail: suggestion re-scrape failed", err); // eslint-disable-line no-console
              }
            })();
          } else if (isSuggestionEvent) {
            // Unexpected — suggestion events should always carry a disco ID
            // (extracted by the extension on mousedown, or included in the
            // per-suggestion refresh broadcast). Fall back to scraping all.
            console.warn("[cross-tab] doc-detail: suggestion event without disco ID, fetching all"); // eslint-disable-line no-console
            void fetchExtensionCommentsAndSuggestions();
          }
        } else if (docRes.status === 404 || docRes.status === 410) {
          setNotFound(true);
        }
      } else {
        console.log("[cross-tab] doc-detail: ignored", event.type, "event"); // eslint-disable-line no-console
      }
    } catch { /* cross-tab sync is best-effort */ }
  }, [initialDoc.docId]); // eslint-disable-line react-hooks/exhaustive-deps

  useCrossTabListener(handleCrossTab);

  const hasAnyMine = comments.some((c) => c.isThreadAuthor);
  const hasAnyReplied = comments.some((c) => c.isReplyAuthor);
  const hasAnyAssigned = comments.some((c) => c.assignedToMe);
  const hasAnyMentioned = comments.some((c) => c.mentionedMe);

  const [mineFilter, setMineFilter] = useState<TriState>("off");
  const [repliedFilter, setRepliedFilter] = useState<TriState>("off");
  const [assignedFilter, setAssignedFilter] = useState<TriState>("off");
  const [mentionedFilter, setMentionedFilter] = useState<TriState>("off");
  const [resolvedFilter, setResolvedFilter] = useState<TriState>("off");
  const [showMode, setShowMode] = useState<"inbox" | "open" | "resolved" | "all">("inbox");
  const [suggestionsFilter, setSuggestionsFilter] = useState<TriState>("off");
  const [unreadFilter, setUnreadFilter] = useState<TriState>("off");
  const [isStarredFilter, setIsStarredFilter] = useState<TriState>("off");
  const [searchFilter, setSearchFilter] = useState("");
  /** Only the two date columns sort. Status combines several flags into one
   *  column with no meaningful order, and Unread is a pair of numbers. */
  type SortCol = "driveCreatedAt" | "driveModifiedAt";
  type SortDir = "asc" | "desc";
  const [sortCol, setSortCol] = useState<SortCol>("driveModifiedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // When a single comment is updated (reply, resolve, refresh), we freeze the
  // table order so it doesn't jump around. Sort icons go unselected to signal
  // the order may be stale. Clicking a column header or the global Refresh
  // reactivates sorting.
  const [sortActive, setSortActive] = useState(true);
  const frozenOrderRef = useRef<Map<string, number>>(new Map());

  // Re-enable sorting when any filter changes so the new view is properly sorted
  useEffect(() => {
    setSortActive(true);
  }, [showMode, mineFilter, repliedFilter, assignedFilter, mentionedFilter, resolvedFilter, suggestionsFilter, unreadFilter, isStarredFilter, searchFilter]);

  // IDs of comments animating out (slide collapse) before removal from the filtered list
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  // Increment to signal all rows to expand or collapse
  const [expandSignal, setExpandSignal] = useState(0);
  const [expandUnreadSignal, setExpandUnreadSignal] = useState(0);
  const [collapseSignal, setCollapseSignal] = useState(0);

  function wouldBeFilteredOut(c: Comment): boolean {
    if (showMode === "inbox" && (c.status === CommentStatus.ARCHIVED || c.status === CommentStatus.MUTED)) return true;
    if (showMode === "open" && c.resolved) return true;
    if (showMode === "resolved" && !c.resolved) return true;
    if (mineFilter === "include" && !c.isThreadAuthor) return true;
    if (mineFilter === "exclude" && c.isThreadAuthor) return true;
    if (repliedFilter === "include" && !c.isReplyAuthor) return true;
    if (repliedFilter === "exclude" && c.isReplyAuthor) return true;
    if (assignedFilter === "include" && !c.assignedToMe) return true;
    if (assignedFilter === "exclude" && c.assignedToMe) return true;
    if (mentionedFilter === "include" && !c.mentionedMe) return true;
    if (mentionedFilter === "exclude" && c.mentionedMe) return true;
    if (resolvedFilter === "include" && !c.resolved) return true;
    if (resolvedFilter === "exclude" && c.resolved) return true;
    if (suggestionsFilter === "include" && c.type !== CommentType.SUGGESTION) return true;
    if (suggestionsFilter === "exclude" && c.type === CommentType.SUGGESTION) return true;
    if (unreadFilter === "include" && isThreadRead(c)) return true;
    if (unreadFilter === "exclude" && !isThreadRead(c)) return true;
    if (isStarredFilter === "include" && !c.isStarred) return true;
    if (isStarredFilter === "exclude" && c.isStarred) return true;
    return false;
  }

  function handleSort(col: SortCol) {
    setSortActive(true);
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    const contextId = generateContextId();
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}/refresh`, { method: "POST", contextId });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const { threads, viewedByMeTime: vbmt, suggestionContent, documentText, ...updated } = data;
      setDoc(updated as DocWithComments);
      setComments(updated.comments);
      setSortActive(true);
      // Use thread/content data returned by the refresh endpoint instead of
      // making separate /comments + /content fetches.
      // Merge Drive data into existing maps — don't replace, because the extension
      // provides richer suggestion threads and descriptions that Drive doesn't have.
      // Extension sync runs right after and will refresh its entries too.
      if (threads !== undefined) setThreadMap(prev => mergeThreads(prev, threads));
      if (vbmt !== undefined) setViewedByMeTime(vbmt);
      if (suggestionContent !== undefined) setSuggestionContent(prev => ({ ...prev, ...suggestionContent }));
      if (documentText !== undefined) setDocumentText(documentText);
      broadcastChange({ type: "comments", docId: doc.docId }, contextId);
      // Refresh suggestions from the extension after the server data is applied,
      // so the richer extension data (replies, author, status) overwrites the
      // server's Docs API data. This also merges extension records into the DB.
      await fetchExtensionCommentsAndSuggestions();
      toast.success("Comments synced");
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to sync comments");
    } finally {
      setRefreshing(false);
    }
  }

  function handleEditSave(updated: DocWithLabels) {
    setDoc((prev) => ({ ...prev, role: updated.role, labels: updated.labels, status: updated.status, isStarred: updated.isStarred, notes: updated.notes }));
  }

  async function handleArchive() {
    setArchiving(true);
    const contextId = generateContextId();
    try {
      const newStatus = doc.status === DocStatus.INBOX ? DocStatus.ARCHIVED : DocStatus.INBOX;
      const res = await apiFetch(`/api/docs/${doc.docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithLabels = await res.json();
      setDoc((prev) => ({ ...prev, status: updated.status }));
      broadcastChange({ type: "docs", docIds: [doc.docId] }, contextId);
      toast.success(newStatus === DocStatus.ARCHIVED ? "Archived" : "Unarchived");
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to update status");
    } finally {
      setArchiving(false);
    }
  }

  async function handleToggleStar() {
    const contextId = generateContextId();
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isStarred: !doc.isStarred }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithLabels = await res.json();
      setDoc((prev) => ({ ...prev, isStarred: updated.isStarred }));
      broadcastChange({ type: "docs", docIds: [doc.docId] }, contextId);
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to update star");
    }
  }

  async function handleBulkStatusChange(fromStatus: CommentStatus, toStatus: CommentStatus) {
    const targets = filteredComments.filter((c) => c.status === fromStatus);
    if (targets.length === 0) return;

    const setBusy = toStatus === CommentStatus.ARCHIVED ? setBulkArchiving : setBulkUnarchiving;
    const verb = toStatus === CommentStatus.ARCHIVED ? "archive" : "unarchive";
    const pastVerb = toStatus === CommentStatus.ARCHIVED ? "Archived" : "Unarchived";

    setBusy(true);
    const contextId = generateContextId();
    try {
      const commentIds = targets.map((c) => c.commentId);
      const res = await apiFetch(`/api/docs/${doc.docId}/comments`, {
        method: "PATCH",
        body: JSON.stringify({ commentIds, status: toStatus }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");

      const { count } = await res.json();
      setComments((prev) =>
        prev.map((c) =>
          commentIds.includes(c.commentId) ? { ...c, status: toStatus } : c
        )
      );

      // Trigger animations for comments that are now filtered out
      targets.forEach(c => {
        const updated = { ...c, status: toStatus };
        if (wouldBeFilteredOut(updated)) {
          setExitingIds((prev) => new Set(prev).add(updated.commentId));
        }
      });

      setTimeout(() => {
        setExitingIds((prev) => {
          const next = new Set(prev);
          targets.forEach(c => next.delete(c.commentId));
          return next;
        });
      }, 200);

      broadcastChange({ type: "comments", docId: doc.docId }, contextId);
      toast.success(`${pastVerb} ${count} comments`);
    } catch (err) {
      if (!isAuthError(err)) toast.error(`Failed to ${verb} comments`);
    } finally {
      setBusy(false);
    }
  }

  function handleArchiveAll() { void handleBulkStatusChange(CommentStatus.INBOX, CommentStatus.ARCHIVED); }
  function handleUnarchiveAll() { void handleBulkStatusChange(CommentStatus.ARCHIVED, CommentStatus.INBOX); }

  async function handleArchiveAllResolved() {
    const targets = filteredComments.filter((c) => c.status === CommentStatus.INBOX && c.resolved);
    if (targets.length === 0) return;

    setBulkArchivingResolved(true);
    const contextId = generateContextId();
    try {
      const commentIds = targets.map((c) => c.commentId);
      const res = await apiFetch(`/api/docs/${doc.docId}/comments`, {
        method: "PATCH",
        body: JSON.stringify({ commentIds, status: CommentStatus.ARCHIVED }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");

      const { count } = await res.json();
      setComments((prev) =>
        prev.map((c) =>
          commentIds.includes(c.commentId) ? { ...c, status: CommentStatus.ARCHIVED } : c
        )
      );

      targets.forEach(c => {
        const updated = { ...c, status: CommentStatus.ARCHIVED };
        if (wouldBeFilteredOut(updated)) {
          setExitingIds((prev) => new Set(prev).add(updated.commentId));
        }
      });

      setTimeout(() => {
        setExitingIds((prev) => {
          const next = new Set(prev);
          targets.forEach(c => next.delete(c.commentId));
          return next;
        });
      }, 200);

      broadcastChange({ type: "comments", docId: doc.docId }, contextId);
      toast.success(`Archived ${count} resolved comments`);
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to archive resolved comments");
    } finally {
      setBulkArchivingResolved(false);
    }
  }

  async function handleBulkReadChange(targetIsRead: boolean) {
    const targets = filteredComments.filter((c) => isThreadRead(c) !== targetIsRead);
    // Mirrors how the server turns the isRead request field into a count.
    const readCountFor = (c: Comment) => (targetIsRead ? totalMessageCount(c.replyCount) : 0);
    if (targets.length === 0) return;

    const setBusy = targetIsRead ? setBulkMarkingRead : setBulkMarkingUnread;
    const pastVerb = targetIsRead ? "read" : "unread";

    setBusy(true);
    const contextId = generateContextId();
    try {
      const commentIds = targets.map((c) => c.commentId);
      const res = await apiFetch(`/api/docs/${doc.docId}/comments`, {
        method: "PATCH",
        body: JSON.stringify({ commentIds, isRead: targetIsRead }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");

      const { count } = await res.json();
      setComments((prev) =>
        prev.map((c) =>
          commentIds.includes(c.commentId) ? { ...c, readMessageCount: readCountFor(c) } : c
        )
      );

      // Trigger exit animations for comments that would be filtered out
      targets.forEach((c) => {
        const updated = { ...c, readMessageCount: readCountFor(c) };
        if (wouldBeFilteredOut(updated)) {
          setExitingIds((prev) => new Set(prev).add(updated.commentId));
        }
      });

      setTimeout(() => {
        setExitingIds((prev) => {
          const next = new Set(prev);
          targets.forEach((c) => next.delete(c.commentId));
          return next;
        });
      }, 200);

      broadcastChange({ type: "comments", docId: doc.docId }, contextId);
      toast.success(`Marked ${count} comments ${pastVerb}`);
    } catch (err) {
      if (!isAuthError(err)) toast.error(`Failed to mark comments ${pastVerb}`);
    } finally {
      setBusy(false);
    }
  }

  function handleMarkAllRead() { void handleBulkReadChange(true); }
  function handleMarkAllUnread() { void handleBulkReadChange(false); }

  function handleCommentUpdate(updated: Comment) {
    setSortActive(false);
    if (wouldBeFilteredOut(updated)) {
      setExitingIds((prev) => new Set(prev).add(updated.commentId));
      setTimeout(() => {
        setExitingIds((prev) => {
          if (!prev.has(updated.commentId)) return prev;
          const next = new Set(prev);
          next.delete(updated.commentId);
          return next;
        });
      }, 200);
    }
    setComments((prev) => prev.map((c) => (c.commentId === updated.commentId ? updated : c)));
  }

  // The comment's thread was deleted in the document, so drop the row outright
  // rather than animating it out like a filtered-away comment. Its threadMap
  // entry goes too — otherwise the deleted thread's text lingers in the search
  // index and preview map (the cross-tab path already clears it this way).
  function handleCommentDelete(commentId: string) {
    const gone = comments.find((c) => c.commentId === commentId);
    setComments((prev) => prev.filter((c) => c.commentId !== commentId));
    const key = gone?.googleCommentId ?? gone?.googleSuggestionId;
    if (key) {
      setThreadMap((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  const matcher = useMemo(() => createMatcher(searchFilter), [searchFilter]);

  const filteredComments = comments
    .filter((c) => exitingIds.has(c.commentId) || !wouldBeFilteredOut(c))
    .filter((c) => {
      if (!searchFilter) return true;
      // commentContent and threadText both derive from threadMap so the initial
      // comment text appears twice in the search string — harmless for matching.
      const key = commentKey(c);
      const text = commentContent[key] ?? "";
      const sug = suggestionContent[key];
      const sugText = sug ? `${sug.deletedText} ${sug.insertedText} ${sug.description ?? ""} ${sug.anchorText ?? ""}` : "";
      const threads = threadText[key] ?? "";
      const combined = `${text} ${sugText} ${threads}`;
      return matcher(combined);
    })
    .sort((a, b) => {
      if (!sortActive) {
        const aPos = frozenOrderRef.current.get(a.commentId) ?? Infinity;
        const bPos = frozenOrderRef.current.get(b.commentId) ?? Infinity;
        return aPos - bPos;
      }
      const aTime = a[sortCol] ? new Date(a[sortCol]!).getTime() : 0;
      const bTime = b[sortCol] ? new Date(b[sortCol]!).getTime() : 0;
      const cmp = aTime - bTime;
      return sortDir === "asc" ? cmp : -cmp;
    });

  // Snapshot display order while sort is active so we can freeze it later
  if (sortActive) {
    frozenOrderRef.current = new Map(filteredComments.map((c, i) => [c.commentId, i]));
  }

  function SortIcon({ col }: { col: SortCol }) {
    if (!sortActive || sortCol !== col) return <span className="ml-1 text-zinc-300">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  function ThButton({ col, title, children }: { col: SortCol; title?: string; children: React.ReactNode }) {
    return (
      <th className="min-w-40 py-2.5 pr-4 text-left">
        <button
          onClick={() => handleSort(col)}
          title={title}
          className="flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800"
        >
          {children}
          <SortIcon col={col} />
        </button>
      </th>
    );
  }

  async function handleUntrack() {
    const contextId = generateContextId();
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}`, { method: "DELETE", contextId });
      if (!res.ok) throw new Error("Failed to delete");
      broadcastChange({ type: "docs", docIds: [doc.docId] }, contextId);
      // Brief delay so the BroadcastChannel message is delivered before this tab closes
      await new Promise((r) => setTimeout(r, 100));
      window.close();
      // Some browsers block window.close() — fall back to navigation
      window.location.href = "/docs";
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to untrack document");
    }
  }

  function handleReAddSuccess(newDoc: DocWithLabels) {
    const contextId = generateContextId();
    broadcastChange({ type: "docs", docIds: [doc.docId, newDoc.docId] }, contextId);
    window.location.href = `/comments/${newDoc.docId}`;
  }

  const pageTitle = `${displayTitle} - Docreview`.replace(/\s+/g, " ").trim();

  // Next.js metadata reconciliation can reset document.title after effects run.
  // Use a MutationObserver to detect and override any external title changes.
  useEffect(() => {
    if (document.title !== pageTitle) document.title = pageTitle;
    const titleEl = document.querySelector("title");
    if (!titleEl) return;
    const observer = new MutationObserver(() => {
      if (document.title !== pageTitle) document.title = pageTitle;
    });
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [pageTitle]);

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="text-xl font-semibold text-zinc-900">Document not found</div>
        <p className="text-zinc-500">This document may have been deleted in another tab.</p>
        <Button variant="outline" asChild>
          <a href="/docs">Back to document list</a>
        </Button>
      </div>
    );
  }

  return (
    <LabelProvider allLabels={labels} onLabelsChange={setLabels} onLabelDelete={handleLabelDelete}>
    <div className="flex flex-col gap-6">
      {doc.accessState === AccessState.TRASHED && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2">
          <span className="font-bold">Note:</span> This document is in the trash.
        </div>
      )}
      {doc.accessState === AccessState.NOT_FOUND && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2">
          <span className="font-bold">Note:</span> This document is not accessible in Google Drive.
        </div>
      )}
      {doc.accessState === AccessState.DENIED && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2">
          <span className="font-bold">Permission denied</span>
        </div>
      )}
      {/* Header row: title left, buttons right */}
      <div className="flex items-start justify-between">
        <div className="flex items-center text-xl font-semibold pt-1">
          <a href="/docs" className="flex-shrink-0 flex items-center text-zinc-500 hover:text-blue-600 mr-2">
            <img src="/docreview.svg" alt="Docreview Logo" className="h-6 w-6 rounded-md shadow-sm mr-2" />
            Docreview:
          </a>
          <DocTypeIcon mimeType={doc.mimeType} className="h-5 w-5 flex-shrink-0 mr-1" />
          <a
            href={doc.driveUrl}
            target={docTarget(doc.googleDocId)}
            title="Open document"
            onClick={handleOpenDoc}
            className={`hover:underline hover:text-blue-600 ${
              doc.accessState !== AccessState.OK ? "line-through text-zinc-400" : "text-zinc-900"
            }`}
          ><span suppressHydrationWarning>{displayTitle}</span></a>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="text-zinc-900"
            title={doc.status === DocStatus.INBOX ? "Archive this document" : "Move this document to inbox"}
            onClick={handleArchive}
            disabled={archiving}
          >
            {doc.status === DocStatus.INBOX ? "Archive" : "Unarchive"}
          </Button>
          <Button variant="outline" size="sm" title="Open the document" className="text-zinc-900" asChild>
            <a href={doc.driveUrl} target={docTarget(doc.googleDocId)} onClick={handleOpenDoc}>Open</a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh comments"
            className="text-zinc-900"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <HamburgerButton title="More options" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setShowHelp(true)} title="Open the help guide">
                <span className="absolute left-2 flex h-4 w-4 items-center justify-center">
                  <CircleHelp className="h-4 w-4" />
                </span>
                <span className="pl-6">Help</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowUntrackDialog(true)} title="Remove this document from the database">
                <span className="absolute left-2 flex h-4 w-4 items-center justify-center">
                  <Trash2 className="h-4 w-4" />
                </span>
                <span className="pl-6">Untrack this doc</span>
              </DropdownMenuItem>
              <DropdownMenuItem inset onSelect={() => setShowReAddDialog(true)} title="Remove this document from the database, then re-add it">
                Delete & re-add
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Metadata */}
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-600">
          <span>
            <span className="font-medium text-zinc-400">Owner:</span>{" "}
            {cachedOwners[doc.googleDocId] ?? "—"}
          </span>
          <span>
            <span className="font-medium text-zinc-400">Created:</span>{" "}
            <FriendlyDate date={doc.createdTimeInDrive} />
          </span>
          <span>
            <span className="font-medium text-zinc-400">Modified:</span>{" "}
            <FriendlyDate date={doc.lastModifiedInDrive} />
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="font-medium text-zinc-400">Viewed:</span>{" "}
            {viewedByMeTime ? <FriendlyDate date={viewedByMeTime} /> : "—"}
            <button
              onClick={() => {
                setViewedTimeInput(viewedByMeTime ? formatDate(viewedByMeTime) : "");
                setShowViewedTimeDialog(true);
              }}
              className="text-zinc-400 hover:text-zinc-600 transition-colors"
              title="Edit viewed time"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </span>
          <span>
            <span className="font-medium text-zinc-400">DocId:</span>{" "}
            {doc.googleDocId}
          </span>
        </div>

        <Dialog open={showViewedTimeDialog} onOpenChange={setShowViewedTimeDialog}>
          <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Edit Viewed Time</DialogTitle>
            </DialogHeader>
            <div className="p-6 pt-1">
              <input
                type="text"
                value={viewedTimeInput}
                onChange={(e) => setViewedTimeInput(e.target.value)}
                placeholder="YYYY-MM-DD HH:MM:SS"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
            </div>
            <div className="p-6 pt-0">
              <DialogButtons
                onConfirm={handleSaveViewedTime}
                onCancel={() => setShowViewedTimeDialog(false)}
                confirmLabel={savingViewedTime ? "Saving…" : "OK"}
                disabled={savingViewedTime || !viewedTimeInputValid}
              />
            </div>
          </DialogContent>
        </Dialog>
        <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-zinc-600">
          <span className="font-medium text-zinc-400">Labels:</span>
          <StarButton starred={doc.isStarred} onToggle={handleToggleStar} />
          {doc.role === DocRole.AUTHOR && (
            <span title="You are an author of this document" className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${ROLE_COLORS.AUTHOR.badge}`}>
              Author
            </span>
          )}
          {doc.labels.map((dl) => (
            <LabelBadge key={dl.labelId} label={dl.label} />
          ))}
          {doc.role !== DocRole.AUTHOR && doc.labels.length === 0 && (
            <span className="text-zinc-400">—</span>
          )}
          <EditDocDialog
            doc={doc as unknown as DocWithLabels}
            cachedTitle={displayTitle}
            onSave={handleEditSave}
          >
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs text-zinc-900" title="Edit document labels and notes">
              Edit
            </Button>
          </EditDocDialog>
        </div>
        {doc.notes?.trim() && (
          <div className="flex gap-2 mt-2 text-sm text-zinc-600">
            <span className="font-medium text-zinc-400 flex-shrink-0 pt-1">Notes:</span>
            <textarea
              readOnly
              value={doc.notes}
              rows={Math.min(doc.notes.split("\n").length, 10)}
              className="flex-1 resize-none rounded border border-zinc-200 bg-zinc-50 px-3 py-1 text-sm text-zinc-700 focus:outline-none max-h-[200px] overflow-y-auto"
            />
          </div>
        )}
      </div>

      {/* Filters */}
      <CommentFilterBar
        mineFilter={mineFilter}
        repliedFilter={repliedFilter}
        assignedFilter={assignedFilter}
        mentionedFilter={mentionedFilter}
        showMine={hasAnyMine}
        showReplied={hasAnyReplied}
        showAssigned={hasAnyAssigned}
        showMentioned={hasAnyMentioned}
        resolvedFilter={resolvedFilter}
        showMode={showMode}
        suggestionsFilter={suggestionsFilter}
        isStarred={isStarredFilter}
        unreadFilter={unreadFilter}
        searchFilter={searchFilter}
        onMineChange={setMineFilter}
        onRepliedChange={setRepliedFilter}
        onAssignedChange={setAssignedFilter}
        onMentionedChange={setMentionedFilter}
        onResolvedChange={setResolvedFilter}
        onShowModeChange={setShowMode}
        onSuggestionsChange={setSuggestionsFilter}
        onIsStarredChange={setIsStarredFilter}
        onUnreadChange={setUnreadFilter}
        onSearchFilterChange={setSearchFilter}
      />

      {/* Comment table */}
      {filteredComments.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-400">
          {comments.length === 0
            ? 'No comments yet. Click "Refresh" to sync.'
            : "No comments match the current filters."}
        </p>
      ) : (
        <div className="rounded-lg border border-zinc-200">
          <table className="w-full min-w-fit">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="min-w-40 pl-4 py-2.5 pr-4 text-left">
                  <button
                    onClick={() => handleSort("driveCreatedAt")}
                    title="Thread creation time"
                    className="flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800"
                  >
                    Created<SortIcon col="driveCreatedAt" />
                  </button>
                </th>
                <ThButton col="driveModifiedAt" title="Thread last-modified time">Modified</ThButton>
                {/* Left-aligned and the same width as the columns beside it,
                    so the four headings space evenly. The "2 / 4" value is
                    left-aligned to match, which lands the slash near the middle
                    of the label. Unsortable, like Status: the filter bar's
                    Unread toggle is the better way to get at these anyway. */}
                <th className="min-w-40 py-2.5 pr-4 text-left">
                  <span
                    className="text-xs font-medium text-zinc-500 uppercase tracking-wide"
                    title="Unread message count / Total message count"
                  >
                    Unread
                  </span>
                </th>
                <th className="py-2.5 pr-4 text-left">
                  <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide" title="Comment status">Status</span>
                </th>
                <th className="pr-4 py-2.5 text-right">
                  {/* Wraps rather than pushing the page into horizontal
                      scrolling: six buttons plus the menu don't fit beside the
                      column headings much below a full-width window. */}
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-zinc-900"
                      title="Expand all unread comment threads"
                      onClick={() => setExpandUnreadSignal((n) => n + 1)}
                      disabled={!filteredComments.some((c) => !isThreadRead(c))}
                    >
                      Expand unread
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-zinc-900"
                      title="Expand all comment threads"
                      onClick={() => setExpandSignal((n) => n + 1)}
                    >
                      Expand all
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-zinc-900"
                      title="Collapse all comment threads"
                      onClick={() => setCollapseSignal((n) => n + 1)}
                    >
                      Collapse all
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-zinc-900"
                      title="Mark all visible comments as read"
                      onClick={handleMarkAllRead}
                      disabled={bulkMarkingRead || !filteredComments.some((c) => !isThreadRead(c))}
                    >
                      {bulkMarkingRead ? "Marking..." : "Mark all read"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-zinc-900"
                      title="Archive all visible inbox comments"
                      onClick={handleArchiveAll}
                      disabled={bulkArchiving || !filteredComments.some((c) => c.status === CommentStatus.INBOX)}
                    >
                      {bulkArchiving ? "Archiving..." : "Archive all"}
                    </Button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <HamburgerButton size="compact" title="More actions" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={handleArchiveAllResolved}
                          disabled={bulkArchivingResolved || !filteredComments.some((c) => c.status === CommentStatus.INBOX && c.resolved)}
                          title="Archive all visible comments that are Resolved"
                        >
                          {bulkArchivingResolved ? "Archiving..." : "Archive all resolved"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={handleUnarchiveAll}
                          disabled={bulkUnarchiving || !filteredComments.some((c) => c.status === CommentStatus.ARCHIVED)}
                          title="Move all visible archived comments back to inbox"
                        >
                          {bulkUnarchiving ? "Unarchiving..." : "Unarchive all"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={handleMarkAllUnread}
                          disabled={bulkMarkingUnread || !filteredComments.some((c) => isThreadRead(c))}
                          title="Mark all visible read comments as unread"
                        >
                          {bulkMarkingUnread ? "Marking..." : "Mark all unread"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </th>
              </tr>
            </thead>
              {filteredComments.map((comment) => (
                <CommentRow
                  key={comment.commentId}
                  comment={comment}
                  docId={doc.docId}
                  driveUrl={doc.driveUrl}
                  content={comment.type === CommentType.COMMENT ? commentContent[commentKey(comment)] : undefined}
                  suggestionContent={comment.type === CommentType.SUGGESTION
                    ? (suggestionContent[commentKey(comment)] ?? (comment.googleCommentId ? suggestionContent[comment.googleCommentId] : undefined))
                    : undefined}
                  initialThread={threadMap[commentKey(comment)] ?? (comment.googleCommentId ? threadMap[comment.googleCommentId] : undefined)}
                  onUpdate={handleCommentUpdate}
                  onDelete={handleCommentDelete}
                  onThreadUpdate={handleThreadUpdate}
                  isExiting={exitingIds.has(comment.commentId)}
                  searchFilter={searchFilter}
                  documentText={documentText}
                  expandSignal={expandSignal}
                  expandUnreadSignal={expandUnreadSignal}
                  collapseSignal={collapseSignal}
                  isSelected={!!selectedDiscoId && selectedDiscoId === comment.googleCommentId}
                  onSelectInDoc={supportsCommentNavigation() && comment.googleCommentId
                    ? () => selectCommentInDoc(googleDocId, comment.googleCommentId!)
                    : undefined}
                  onSuggestionRefresh={comment.type === CommentType.SUGGESTION ? handleSuggestionRefresh : undefined}
                  userName={userName}
                  emptyMessage={threadsForbidden ? "Comments not visible on this document." : undefined}
                />
              ))}
          </table>
        </div>
      )}
    </div>

    <DeleteReAddDialog
      open={showReAddDialog}
      onOpenChange={setShowReAddDialog}
      docId={doc.docId}
      docTitle={doc.title}
      mimeType={doc.mimeType}
      onSuccess={handleReAddSuccess}
    />

    <HelpDialog open={showHelp} onOpenChange={setShowHelp} />

    <AlertDialog open={showUntrackDialog} onOpenChange={setShowUntrackDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Untrack this document?</AlertDialogTitle>
          <AlertDialogDescription>
            All state for this document will be removed from the database.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleUntrack} className={buttonVariants({ variant: "outline" })}>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </LabelProvider>
  );
}
