import type { Doc, Label, DocLabel } from "@prisma/client";

export type DocWithLabels = Doc & {
  labels: (DocLabel & { label: Label })[];
  _count: { comments: number };
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
