// Bridge for communicating with the Docreview Chrome extension.
//
// The extension's docreview-bridge.js content script relays messages between
// the web page and the extension's background worker via window.postMessage.

export interface ExtensionStatus {
  version: number;
  baseUrl: string;
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

/** Check if the extension supports in-page comment navigation (version >= 2). */
export function supportsCommentNavigation(): boolean {
  return (cachedExtensionStatus?.version ?? 0) >= 2;
}
