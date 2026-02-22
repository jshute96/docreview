import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DocTable } from "@/components/doc-table";
import type { DocWithLabels } from "@/types";

export default async function DocsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const [docs, labels] = await Promise.all([
    prisma.doc.findMany({
      where: { userId },
      include: {
        labels: { include: { label: true } },
        _count: { select: { comments: { where: { status: "ACTIVE" } } } },
      },
      orderBy: { lastModifiedInDrive: "desc" },
    }),
    prisma.label.findMany({
      where: { userId },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <DocTable
          initialDocs={docs as DocWithLabels[]}
          initialLabels={labels}
        />
      </div>
    </div>
  );
}
