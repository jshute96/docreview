import { redirect, notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DocDetail } from "@/components/doc-detail";
import { requireAuth } from "@/lib/auth-utils";
import type { DocWithComments } from "@/types";

export default async function DocDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireAuth();
  const userId = session.user.id;

  const [doc, allLabels] = await Promise.all([
    prisma.doc.findUnique({
      where: { id },
      include: {
        labels: { 
          include: { label: true },
          orderBy: { label: { position: "asc" } },
        },
        comments: { orderBy: { driveCreatedAt: "asc" } },
      },
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
