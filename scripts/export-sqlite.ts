import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany();
  const accounts = await prisma.account.findMany();
  const sessions = await prisma.session.findMany();
  const verificationTokens = await prisma.verificationToken.findMany();
  const statuses = await prisma.status.findMany();
  const labels = await prisma.label.findMany();
  const docs = await prisma.doc.findMany();
  const docLabels = await prisma.docLabel.findMany();
  const comments = await prisma.comment.findMany();

  const data = {
    users,
    accounts,
    sessions,
    verificationTokens,
    statuses,
    labels,
    docs,
    docLabels,
    comments,
  };

  const outPath = join(__dirname, "data-export.json");
  writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log("Exported:");
  console.log(`  users: ${users.length}`);
  console.log(`  accounts: ${accounts.length}`);
  console.log(`  sessions: ${sessions.length}`);
  console.log(`  verificationTokens: ${verificationTokens.length}`);
  console.log(`  statuses: ${statuses.length}`);
  console.log(`  labels: ${labels.length}`);
  console.log(`  docs: ${docs.length}`);
  console.log(`  docLabels: ${docLabels.length}`);
  console.log(`  comments: ${comments.length}`);
  console.log(`\nWritten to ${outPath}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
