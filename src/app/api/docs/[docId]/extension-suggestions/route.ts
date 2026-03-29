import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { logError, logInfo } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { mergeExtensionSuggestions, type ExtensionSuggestionInput } from "@/lib/extension-suggestion-merge";

/**
 * Merge extension-scraped suggestions into the database.
 * Called by the comments page after fetching suggestion data from an open
 * Google Docs tab via the Chrome extension.
 *
 * Body: { suggestions: ExtensionSuggestionInput[] }
 * Returns: { success, result: { merged, inserted, skipped, resolved }, comments }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const { docId } = await params;

    const doc = await prisma.doc.findFirst({ where: { docId, userId } });
    if (!doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const suggestions = body.suggestions as ExtensionSuggestionInput[] | undefined;
    if (!suggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
      return NextResponse.json({ error: "No suggestions provided" }, { status: 400 });
    }

    const googleDocId = doc.driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? doc.googleDocId;
    logInfo(`[Suggestions:Ext] POST /extension-suggestions for ${googleDocId}: ${suggestions.length} suggestions`);

    try {
      const result = await mergeExtensionSuggestions(docId, googleDocId, suggestions);
      return NextResponse.json({
        success: true,
        result: {
          merged: result.merged,
          inserted: result.inserted,
          skipped: result.skipped,
          resolved: result.resolved,
        },
        comments: result.comments,
      });
    } catch (err) {
      logError(`[Suggestions:Ext] Failed to merge extension suggestions for ${googleDocId}:`, err);
      return NextResponse.json({ error: "Failed to merge suggestions" }, { status: 500 });
    }
  });
}
