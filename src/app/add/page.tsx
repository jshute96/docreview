import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth-utils";
import { AddDocPageClient } from "@/components/add-doc-page-client";

export default async function AddPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const session = await requireAuth();
  const userId = session.user.id;

  const [labels, params] = await Promise.all([
    prisma.label.findMany({
      where: { userId },
      orderBy: { position: "asc" },
    }),
    searchParams,
  ]);

  return (
    <AddDocPageClient
      initialLabels={labels}
      initialUrl={params.url}
    />
  );
}
