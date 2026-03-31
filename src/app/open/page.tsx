import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { parseGoogleDocId } from "@/lib/google-drive";
import { tryResolveRedirect } from "@/lib/url-utils";

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

  let googleDocId = parseGoogleDocId(docParam);

  // If the URL isn't a recognized Google Doc link, try following redirects
  // (e.g. bit.ly/xyz → docs.google.com/document/d/...)
  let resolvedUrl: string | undefined;
  if (!googleDocId) {
    const resolved = await tryResolveRedirect(docParam);
    if (resolved) {
      googleDocId = parseGoogleDocId(resolved);
      resolvedUrl = resolved;
    }
  }

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

  // Pass the resolved Google Doc URL (not the shortener) to the add page
  const docForAdd = resolvedUrl ?? docParam;
  redirect(`/add?doc=${encodeURIComponent(docForAdd)}`);
}
