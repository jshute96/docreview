import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { DocDetail } from "@/components/doc-detail";
import { requireAuth } from "@/lib/auth-utils";
import { docWithCommentsInclude } from "@/lib/doc-queries";
import type { DocWithComments } from "@/types";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const session = await requireAuth();
  const doc = await prisma.doc.findUnique({
    where: { id, userId: session.user.id },
    select: { title: true },
  });
  return { title: doc ? `Docreview: ${doc.title}` : "Docreview" };
}

export default async function DocDetailPage({ params }: PageProps) {
  const { id } = await params;
  const session = await requireAuth();
  const userId = session.user.id;

  const [doc, allLabels] = await Promise.all([
    prisma.doc.findUnique({
      where: { id },
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
      <div className="px-4 py-8">
        <DocDetail doc={doc as DocWithComments} allLabels={allLabels} />
      </div>
    </div>
  );
}
