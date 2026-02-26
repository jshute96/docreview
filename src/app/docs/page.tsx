import { prisma } from "@/lib/prisma";
import { DocTable } from "@/components/doc-table";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";
import { OFFLINE_MODE } from "@/lib/offline";
import { requireAuth } from "@/lib/auth-utils";
import type { DocWithLabels } from "@/types";

export default async function DocsPage() {
  const session = await requireAuth();
  const userId = session.user.id;

  const [rawDocs, labels] = await Promise.all([
    prisma.doc.findMany({
      where: { userId },
      include: docWithCountsInclude,
      orderBy: { lastModifiedInDrive: "desc" },
    }),
    prisma.label.findMany({
      where: { userId },
      orderBy: { position: "asc" },
    }),
  ]);

  const docs = rawDocs.map(withCommentCounts);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <DocTable
          initialDocs={docs as DocWithLabels[]}
          initialLabels={labels}
          isOffline={OFFLINE_MODE}
        />
      </div>
    </div>
  );
}
