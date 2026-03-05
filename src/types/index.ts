import type { Doc, Label, DocLabel, Comment } from "@prisma/client";

export type DocWithLabels = Doc & {
  labels: (DocLabel & { label: Label })[];
  _count: { unreadComments: number; inboxComments: number; openComments: number };
};

export type DocWithComments = Doc & {
  labels: (DocLabel & { label: Label })[];
  comments: Comment[];
};

// Augment NextAuth session to include user.id
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}
