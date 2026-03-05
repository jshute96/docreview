import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { parseGoogleDocId } from "@/lib/google-drive";

export default async function OpenPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string }>;
}) {
  const session = await requireAuth();
  const userId = session.user!.id!;
  const { doc: docParam } = await searchParams;

  if (!docParam) {
    redirect("/add");
  }

  const googleDocId = parseGoogleDocId(docParam);
  if (!googleDocId) {
    redirect(`/add?doc=${encodeURIComponent(docParam)}`);
  }

  const existing = await prisma.doc.findUnique({
    where: { userId_googleDocId: { userId, googleDocId } },
    select: { docId: true },
  });

  if (existing) {
    redirect(`/comments/${existing.docId}`);
  }

  redirect(`/add?doc=${encodeURIComponent(docParam)}`);
}
