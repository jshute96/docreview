import { notFound } from "next/navigation";
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

  const [doc, allLabels, userRows] = await Promise.all([
    prisma.doc.findUnique({
      where: { docId },
      include: docWithCommentsInclude,
    }),
    prisma.label.findMany({
      where: { userId },
      orderBy: { position: "asc" },
    }),
    // Raw query to read user name — bypasses the obscure extension which
    // incorrectly decodes User.name (the "name" field is in the obscured set
    // for Label, and the recursive decoder can't distinguish models).
    // TODO: fix prisma-obscure.ts to be model-aware, then use prisma.user.findUnique.
    prisma.$queryRaw<{ name: string | null }[]>`SELECT name FROM users WHERE user_id = ${userId} LIMIT 1`,
  ]);

  if (!doc || doc.userId !== userId) notFound();
  const userName = userRows[0]?.name ?? undefined;

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Hide page until useCachedMetadata populates title from localStorage, preventing a flash of untitled doc */}
      <script dangerouslySetInnerHTML={{ __html: `(function(){var s=document.createElement('style');s.id='hide-until-titles';s.innerHTML='body{visibility:hidden}';document.head.appendChild(s);setTimeout(function(){if(s.parentNode)s.remove()},2000);})()` }} />
      {/* Pre-read cached metadata from localStorage for this doc (runs before React hydrates) */}
      <script dangerouslySetInnerHTML={{ __html: `try{var k="docr:"+${JSON.stringify(userId)}+":meta:"+${JSON.stringify(doc.googleDocId)};var e=JSON.parse(localStorage.getItem(k));window.__docrMetaCache=e&&e.value?{${JSON.stringify(doc.googleDocId)}:e}:{}}catch(x){}` }} />
      <div className="px-4 py-8">
        <DocDetail doc={stripServerOnly(doc) as DocWithComments} allLabels={allLabels} userId={userId} userName={userName} />
      </div>
    </div>
  );
}
