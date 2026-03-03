import { NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { fetchDocsByIds, findDeletedDocIds, getDriveClient, invalidGrantResponse } from "@/lib/google-drive";
import { scanGmailNotifications } from "@/lib/gmail";
import { syncComments } from "@/lib/sync-comments";
import { getStatus, updateGmailTimestamp } from "@/lib/status";

const DEFAULT_DAYS_BACK = 7;

export async function POST() {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  console.log("[GmailRefresh] Starting incremental Gmail refresh");
  const t0 = Date.now();

  try {
    // Determine scan window
    const status = await getStatus(userId);
    const since = status?.lastGmailUpdateTimestamp
      ?? new Date(Date.now() - DEFAULT_DAYS_BACK * 24 * 60 * 60 * 1000);
    console.log(`[GmailRefresh] Scanning since ${since.toISOString()}`);

    // Scan Gmail for doc notifications
    const { docs: gmailDocs, errorCount } = await scanGmailNotifications(userId, since);
    if (gmailDocs.length === 0) {
      console.log(`[GmailRefresh] No docs found in Gmail (${errorCount} errors)`);
      await updateGmailTimestamp(userId, new Date());
      return NextResponse.json({ added: 0, updated: 0, deleted: 0, unarchived: 0, errorCount, comments: 0 });
    }

    // Fetch full Drive metadata for discovered docs
    const docIds = [...new Set(gmailDocs.map((d) => d.googleDocId))];
    console.log(`[GmailRefresh] Fetching Drive metadata for ${docIds.length} docs`);
    const driveDocs = await fetchDocsByIds(userId, docIds);
    const driveAuth = await getDriveClient(userId);

    // Pre-fetch existing doc IDs to distinguish adds from updates
    const existingDocIds = new Set(
      (await prisma.doc.findMany({
        where: { userId },
        select: { googleDocId: true },
      })).map((d) => d.googleDocId)
    );

    let added = 0;
    let updated = 0;
    let deleted = 0;

    // Upsert each doc returned by Drive
    for (const doc of driveDocs) {
      const isExisting = existingDocIds.has(doc.googleDocId);

      await prisma.doc.upsert({
        where: { userId_googleDocId: { userId, googleDocId: doc.googleDocId } },
        create: {
          userId,
          googleDocId: doc.googleDocId,
          title: doc.title,
          driveUrl: doc.driveUrl,
          mimeType: doc.mimeType,
          role: doc.role,
          lastModifiedInDrive: doc.lastModifiedInDrive,
          owner: doc.owner,
          createdTimeInDrive: doc.createdTimeInDrive,
        },
        update: {
          title: doc.title,
          driveUrl: doc.driveUrl,
          mimeType: doc.mimeType,
          lastModifiedInDrive: doc.lastModifiedInDrive,
          owner: doc.owner,
          createdTimeInDrive: doc.createdTimeInDrive,
          isDeleted: false,
        },
      });

      if (isExisting) {
        console.log(`[GmailRefresh]   UPDATE "${doc.title}"`);
        updated++;
      } else {
        console.log(`[GmailRefresh]   ADD "${doc.title}" — ${doc.role} (owner: ${doc.owner ?? "unknown"})`);
        added++;
      }
    }

    // Detect deletions: scan doc IDs found in Gmail but not returned by fetchDocsByIds
    const returnedIds = new Set(driveDocs.map((d) => d.googleDocId));
    const missingIds = docIds.filter((id) => !returnedIds.has(id) && existingDocIds.has(id));
    if (missingIds.length > 0) {
      console.log(`[GmailRefresh] Checking ${missingIds.length} missing docs for deletion`);
      const deletedIds = await findDeletedDocIds(userId, missingIds);
      for (const id of deletedIds) {
        await prisma.doc.updateMany({
          where: { userId, googleDocId: id },
          data: { isDeleted: true },
        });
        deleted++;
      }
    }

    // Sync comments for upserted docs
    const upsertedDocs = await prisma.doc.findMany({
      where: { userId, isDeleted: false, googleDocId: { in: [...returnedIds] } },
    });
    console.log(`[GmailRefresh] Syncing comments for ${upsertedDocs.length} docs`);
    const syncResults = await Promise.all(
      upsertedDocs.map((doc) => syncComments(doc, driveAuth))
    );
    const comments = syncResults.reduce((sum, r) => sum + r.created, 0);

    // Unarchive ARCHIVED docs with new activity, handle deletions from syncComments
    let unarchived = 0;
    for (let i = 0; i < upsertedDocs.length; i++) {
      const res = syncResults[i];
      if (res.isDeleted) {
        await prisma.doc.update({ where: { id: upsertedDocs[i].id }, data: { isDeleted: true } });
        deleted++;
        continue;
      }
      if (upsertedDocs[i].status === "ARCHIVED" && res.shouldUnarchive) {
        await prisma.doc.update({ where: { id: upsertedDocs[i].id }, data: { status: "INBOX" } });
        unarchived++;
      }
    }

    // Update timestamp for next incremental scan
    await updateGmailTimestamp(userId, new Date());

    const elapsed = Date.now() - t0;
    console.log(`[GmailRefresh] Complete in ${elapsed}ms: ${added} added, ${updated} updated, ${deleted} deleted, ${unarchived} unarchived, ${comments} comments`);
    return NextResponse.json({ added, updated, deleted, unarchived, errorCount, comments });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    console.error("[GmailRefresh] Error:", err);
    return NextResponse.json({ error: "Failed to refresh from Gmail" }, { status: 502 });
  }
}
