import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();

function parseDate(val: string | null): Date | null {
  return val ? new Date(val) : null;
}

async function main() {
  const raw = readFileSync(join(__dirname, "data-export.json"), "utf-8");
  const data = JSON.parse(raw);

  // 1. Users
  for (const u of data.users) {
    await prisma.user.create({
      data: {
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: parseDate(u.emailVerified),
        image: u.image,
      },
    });
  }
  console.log(`Imported ${data.users.length} users`);

  // 2. Accounts
  for (const a of data.accounts) {
    await prisma.account.create({
      data: {
        id: a.id,
        userId: a.userId,
        type: a.type,
        provider: a.provider,
        providerAccountId: a.providerAccountId,
        refresh_token: a.refresh_token,
        access_token: a.access_token,
        expires_at: a.expires_at,
        token_type: a.token_type,
        scope: a.scope,
        id_token: a.id_token,
        session_state: a.session_state,
      },
    });
  }
  console.log(`Imported ${data.accounts.length} accounts`);

  // 3. Sessions
  for (const s of data.sessions) {
    await prisma.session.create({
      data: {
        id: s.id,
        sessionToken: s.sessionToken,
        userId: s.userId,
        expires: new Date(s.expires),
      },
    });
  }
  console.log(`Imported ${data.sessions.length} sessions`);

  // 4. VerificationTokens
  for (const v of data.verificationTokens) {
    await prisma.verificationToken.create({
      data: {
        identifier: v.identifier,
        token: v.token,
        expires: new Date(v.expires),
      },
    });
  }
  console.log(`Imported ${data.verificationTokens.length} verificationTokens`);

  // 5. Statuses
  for (const s of data.statuses) {
    await prisma.status.create({
      data: {
        userId: s.userId,
        lastGmailUpdateTimestamp: parseDate(s.lastGmailUpdateTimestamp),
      },
    });
  }
  console.log(`Imported ${data.statuses.length} statuses`);

  // 6. Labels
  for (const l of data.labels) {
    await prisma.label.create({
      data: {
        labelId: l.id,
        userId: l.userId,
        name: l.name,
        color: l.color,
        position: l.position,
      },
    });
  }
  console.log(`Imported ${data.labels.length} labels`);

  // 7. Docs
  for (const d of data.docs) {
    await prisma.doc.create({
      data: {
        docId: d.id,
        userId: d.userId,
        googleDocId: d.googleDocId,
        title: d.title,
        driveUrl: d.driveUrl,
        mimeType: d.mimeType,
        role: d.role,
        status: d.status,
        isDeleted: d.isDeleted,
        lastModifiedInDrive: parseDate(d.lastModifiedInDrive),
        owner: d.owner,
        createdTimeInDrive: parseDate(d.createdTimeInDrive),
        addedAt: new Date(d.addedAt),
        commentsLastSyncedAt: parseDate(d.commentsLastSyncedAt),
      },
    });
  }
  console.log(`Imported ${data.docs.length} docs`);

  // 8. DocLabels
  for (const dl of data.docLabels) {
    await prisma.docLabel.create({
      data: {
        docId: dl.docId,
        labelId: dl.labelId,
      },
    });
  }
  console.log(`Imported ${data.docLabels.length} docLabels`);

  // 9. Comments
  for (const c of data.comments) {
    await prisma.comment.create({
      data: {
        commentId: c.id,
        docId: c.docId,
        googleCommentId: c.googleCommentId,
        type: c.type,
        suggestionType: c.suggestionType,
        resolved: c.resolved,
        isThreadAuthor: c.isThreadAuthor,
        iParticipated: c.iParticipated,
        status: c.status,
        driveCreatedAt: parseDate(c.driveCreatedAt),
        driveModifiedAt: parseDate(c.driveModifiedAt),
        replyCount: c.replyCount,
        createdAt: new Date(c.createdAt),
        updatedAt: new Date(c.updatedAt),
      },
    });
  }
  console.log(`Imported ${data.comments.length} comments`);

  console.log("\nImport complete!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
