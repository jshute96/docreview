import { redirect, notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DocDetail } from "@/components/doc-detail";
import { requireAuth } from "@/lib/auth-utils";
import { docWithCommentsInclude, stripServerOnly } from "@/lib/doc-queries";
import type { DocWithComments } from "@/types";

type PageProps = { params: Promise<{ docId: string }> };

export default async function DocDetailPage({ params }: PageProps) {
  const { docId } = await params;
  const session = await requireAuth();
  const userId = session.user.id;

  const [doc, allLabels] = await Promise.all([
    prisma.doc.findUnique({
      where: { docId },
      include: docWithCommentsInclude,
    }),
    prisma.label.findMany({
      where: { userId },
      orderBy: { position: "asc" },
    }),
  ]);

  if (!doc || doc.userId !== userId) notFound();

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Hide page until useCachedMetadata populates title from localStorage, preventing a flash of untitled doc */}
      <style id="hide-until-titles" dangerouslySetInnerHTML={{ __html: `body{visibility:hidden}` }} />
      <script dangerouslySetInnerHTML={{ __html: `setTimeout(function(){var s=document.getElementById("hide-until-titles");if(s)s.remove()},2000)` }} />
      {/* Pre-read cached metadata from localStorage for this doc (runs before React hydrates) */}
      <script dangerouslySetInnerHTML={{ __html: `try{var k="docr:"+${JSON.stringify(userId)}+":meta:"+${JSON.stringify(doc.googleDocId)};var e=JSON.parse(localStorage.getItem(k));window.__docrMetaCache=e&&e.value?{${JSON.stringify(doc.googleDocId)}:e}:{}}catch(x){}` }} />
      <div className="px-4 py-8">
        <DocDetail doc={stripServerOnly(doc) as DocWithComments} allLabels={allLabels} userId={userId} />
      </div>
    </div>
  );
}
