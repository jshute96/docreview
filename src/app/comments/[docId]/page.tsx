import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { DocDetail } from "@/components/doc-detail";
import { requireAuth } from "@/lib/auth-utils";
import { docWithCommentsInclude, stripTitle } from "@/lib/doc-queries";
import type { DocWithComments } from "@/types";

type PageProps = { params: Promise<{ docId: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Doc - Docreview" };
}

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
      {/* Pre-read cached title from localStorage for this doc (runs before React hydrates) */}
      <script dangerouslySetInnerHTML={{ __html: `try{var k="docr:"+${JSON.stringify(userId)}+":title:"+${JSON.stringify(doc.googleDocId)};var e=JSON.parse(localStorage.getItem(k));window.__docrTitleCache=e&&e.value?{${JSON.stringify(doc.googleDocId)}:e}:{}}catch(x){}` }} />
      <div className="px-4 py-8">
        <DocDetail doc={stripTitle(doc) as DocWithComments} allLabels={allLabels} userId={userId} />
      </div>
    </div>
  );
}
