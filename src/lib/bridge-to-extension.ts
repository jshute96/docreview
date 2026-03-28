// Bridge to Extension — Web app module for communicating with the Chrome extension.
//
// The extension's bridge-to-docreview.js content script relays messages between
// the web page and the extension's background worker via window.postMessage.

export interface ExtensionStatus {
  version: number;
  baseUrl: string;
  enableDocs: boolean;
  enableResolve: boolean;
  resolveHosts: string[];
}

// Cached result of the extension ping. null = not yet checked,
// undefined = checked and not found, ExtensionStatus = found.
let cachedExtensionStatus: ExtensionStatus | null | undefined = null;

/**
 * Ping the extension to check if it's installed. Uses the existing
 * postMessage relay through the bridge content script → background worker.
 * Returns the status or null if the extension isn't available.
 */
export async function pingExtension(): Promise<ExtensionStatus | null> {
  try {
    const result = await sendExtensionMessage<ExtensionStatus>({ type: "ping" }, 2000);
    console.log("[extension] Detected:", result);
    cachedExtensionStatus = result;
    return result;
  } catch {
    console.log("[extension] Not detected");
    cachedExtensionStatus = undefined;
    return null;
  }
}

/** Returns cached extension status, or null if not yet checked / not found. */
export function getExtensionStatus(): ExtensionStatus | null {
  return cachedExtensionStatus ?? null;
}

let messageId = 0;

/** Send a message to the extension via the bridge content script. */
function sendExtensionMessage<T>(
  message: Record<string, unknown>,
  timeoutMs = 20000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;

    function handler(event: MessageEvent) {
      if (event.data?.source !== "docreview-extension" || event.data.id !== id)
        return;
      window.removeEventListener("message", handler);
      clearTimeout(timer);
      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve(event.data.response as T);
      }
    }

    window.addEventListener("message", handler);
    window.postMessage({ source: "docreview-page", id, ...message }, "*");

    const timer = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Extension message timeout"));
    }, timeoutMs);
  });
}

interface ResolveResult {
  resolved: boolean;
  url?: string;
  error?: string;
}

/**
 * Ask the extension to resolve a shortened URL by following redirects
 * in a background tab (which has the user's cookies for auth).
 */
export function resolveUrl(url: string): Promise<ResolveResult> {
  // Ensure the URL has a scheme — users may type "go/something" without http://
  let fullUrl = url.trim();
  if (!/^https?:\/\//i.test(fullUrl)) {
    fullUrl = "http://" + fullUrl;
  }
  return sendExtensionMessage<ResolveResult>({ type: "resolveUrl", url: fullUrl });
}

/** Cancel any in-flight URL resolution (closes background tabs). */
export function cancelResolve(): void {
  window.postMessage({ source: "docreview-page", id: ++messageId, type: "cancelResolve", fireAndForget: true }, "*");
}

/**
 * Ask the extension to focus an existing Google Docs tab for this document.
 * Returns true if a tab was found and focused, false if no tab exists.
 * Does NOT open a new tab — caller should fall through to normal link behavior.
 */
export async function focusDocTab(docId: string): Promise<boolean> {
  try {
    const result = await sendExtensionMessage<{ found: boolean }>({ type: "focusDocTab", docId }, 2000);
    return result.found;
  } catch {
    return false;
  }
}

interface NavigateResult {
  success: boolean;
  opened?: boolean;
  fallback?: boolean;
  error?: string;
}

/**
 * Ask the extension to navigate to a specific comment in an already-open
 * Google Docs tab. If the tab isn't open yet, the extension opens one with
 * a disco= URL. Subsequent navigations inject a script that scrolls to the
 * comment without reloading.
 *
 * Requires extension version >= 2.
 */
export function navigateToComment(
  docId: string,
  discoId: string,
  docUrl: string,
  resolved: boolean
): Promise<NavigateResult> {
  return sendExtensionMessage<NavigateResult>({
    type: "navigateToComment",
    docId,
    discoId,
    docUrl,
    resolved,
  });
}

/** Check if the extension supports in-page comment navigation (version >= 2, Docs enabled). */
export function supportsCommentNavigation(): boolean {
  return (cachedExtensionStatus?.version ?? 0) >= 2 && (cachedExtensionStatus?.enableDocs ?? false);
}

/**
 * Open a Google Doc, reusing an existing tab when possible.
 * When the extension is available, asks it to focus an existing tab (tracked by
 * docTabMap or found by URL). Falls back to window.open with a named target.
 *
 * Use as an onClick handler on <a target={docTarget(id)}> links — prevents
 * default when the extension handles the focus, lets the link work normally
 * when it doesn't.
 */
export function handleOpenDocClick(
  e: { preventDefault: () => void },
  googleDocId: string,
  driveUrl: string,
  targetName: string,
): void {
  if (!supportsCommentNavigation()) return;
  e.preventDefault();
  focusDocTab(googleDocId).then((found) => {
    if (!found) window.open(driveUrl, targetName);
  });
}

/**
 * Select a comment in a Google Doc tab without focusing it.
 * Used when the user clicks a comment thread in the Docreview comments page.
 * Fire-and-forget — no response expected.
 */
export function selectCommentInDoc(docId: string, discoId: string): void {
  window.postMessage({
    source: "docreview-page",
    id: ++messageId,
    type: "selectComment",
    docId,
    discoId,
    fireAndForget: true,
  }, "*");
}

/** Callback type for comment selection events from Google Doc tabs. */
export type CommentSelectionHandler = (docId: string, discoId: string | null, selected: boolean) => void;

let commentSelectionHandler: CommentSelectionHandler | null = null;

/** Register a callback for comment selection/deselection events from Google Doc tabs. */
export function setCommentSelectionHandler(handler: CommentSelectionHandler | null): void {
  commentSelectionHandler = handler;
}

/**
 * Listen for commentSelection messages from the Chrome extension bridge.
 * When a comment is selected/deselected in a Google Doc, the extension
 * relays the event here so the comments page can highlight the row.
 */
function setupCommentSelectionListener() {
  if (typeof window === "undefined") return;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.source !== "docreview-extension") return;
    if (event.data.type !== "commentSelection") return;
    commentSelectionHandler?.(event.data.docId, event.data.discoId, event.data.selected);
  });
}

setupCommentSelectionListener();

/**
 * Listen for commentSynced messages from the Chrome extension bridge.
 * When the extension detects comment activity on a Google Docs page and the
 * server sync completes, the bridge posts a commentSynced message here.
 * We broadcast it via BroadcastChannel so all open Docreview tabs refresh.
 *
 * This listener is set up once on module load (client-side only).
 */
function setupCommentSyncedListener() {
  if (typeof window === "undefined") return;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.source !== "docreview-extension") return;
    if (event.data.type !== "commentSynced" || !event.data.docId) return;
    // broadcastChange uses the shared singleton BroadcastChannel, which doesn't
    // self-deliver (by spec). To notify THIS tab too, we post via a separate
    // short-lived channel — a different object on the same channel name counts
    // as a valid recipient, so the singleton listener in this tab will fire.
    const docId = event.data.docId;
    const googleCommentId: string | undefined = event.data.googleCommentId;
    const commentType: string | undefined = event.data.commentType;
    const threads: Record<string, unknown> | undefined = event.data.threads;
    // eslint-disable-next-line no-console -- extension bridge diagnostic, not server-side app code
    console.log("[bridge-to-extension] commentSynced received, broadcasting for", docId);
    const ch = new BroadcastChannel("docreview-sync");
    ch.postMessage({ type: "comments", docId, googleCommentId, commentType, threads });
    ch.close();
  });
}

setupCommentSyncedListener();
