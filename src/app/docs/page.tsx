import { prisma } from "@/lib/prisma";
import { DocTable } from "@/components/doc-table";
import { docWithCountsInclude, withCommentCounts, stripServerOnly } from "@/lib/doc-queries";
import { OFFLINE_MODE } from "@/lib/offline";
import { requireAuth } from "@/lib/auth-utils";
import type { DocWithLabels } from "@/types";

export default async function DocsPage() {
  const session = await requireAuth();
  const userId = session.user.id;

  const [rawDocs, labels, status] = await Promise.all([
    prisma.doc.findMany({
      where: { userId },
      include: docWithCountsInclude,
      orderBy: { lastCommentActivity: "desc" },
    }),
    prisma.label.findMany({
      where: { userId },
      orderBy: { position: "asc" },
    }),
    prisma.status.findUnique({
      where: { userId },
      select: { hasSeenHelp: true },
    }),
  ]);

  const docs = rawDocs.map(withCommentCounts).map(stripServerOnly);

  const googleDocIds = rawDocs.map((d) => d.googleDocId);

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Hide page until useCachedMetadata populates titles from localStorage, preventing a flash of untitled docs */}
      <style id="hide-until-titles" dangerouslySetInnerHTML={{ __html: `body{visibility:hidden}` }} />
      <script dangerouslySetInnerHTML={{ __html: `setTimeout(function(){var s=document.getElementById("hide-until-titles");if(s)s.remove()},2000)` }} />
      {/* Pre-read cached metadata from localStorage for these doc IDs (runs before React hydrates) */}
      <script dangerouslySetInnerHTML={{ __html: `try{var ids=${JSON.stringify(googleDocIds)};var u=${JSON.stringify(userId)};var c={};for(var i=0;i<ids.length;i++){var k="docr:"+u+":meta:"+ids[i];try{var e=JSON.parse(localStorage.getItem(k));if(e&&e.value)c[ids[i]]=e}catch(x){}}window.__docrMetaCache=c}catch(x){}` }} />
      <div className="mx-auto max-w-6xl px-4 py-8">
        <DocTable
          initialDocs={docs as DocWithLabels[]}
          initialLabels={labels}
          isOffline={OFFLINE_MODE}
          userId={userId}
          hasSeenHelp={status?.hasSeenHelp ?? false}
        />
      </div>
    </div>
  );
}
