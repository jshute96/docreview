import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DocDetail } from "@/components/doc-detail";
import type { DocWithComments } from "@/types";

export default async function DocDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const { id } = await params;

  const doc = await prisma.doc.findUnique({
    where: { id },
    include: {
      labels: { include: { label: true } },
      comments: { orderBy: { driveCreatedAt: "asc" } },
    },
  });

  if (!doc || doc.userId !== userId) notFound();

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <DocDetail doc={doc as DocWithComments} />
      </div>
    </div>
  );
}
