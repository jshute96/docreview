import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { OFFLINE_MODE, OFFLINE_USER_ID, FALLBACK_OFFLINE_USER } from "@/lib/offline";

const offlineProviders = [
  Credentials({
    id: "offline",
    name: "Offline",
    credentials: {},
    async authorize() {
      // If OFFLINE_USER_ID is set, impersonate (and create if missing) that user
      if (OFFLINE_USER_ID) {
        return await prisma.user.upsert({
          where: { id: OFFLINE_USER_ID },
          update: {},
          create: {
            id: OFFLINE_USER_ID,
            email: `${OFFLINE_USER_ID}@localhost`,
            name: OFFLINE_USER_ID,
          },
        });
      }

      // Otherwise create/use a standalone offline user
      const user = await prisma.user.upsert({
        where: { id: FALLBACK_OFFLINE_USER.id },
        update: {},
        create: {
          id: FALLBACK_OFFLINE_USER.id,
          email: FALLBACK_OFFLINE_USER.email,
          name: FALLBACK_OFFLINE_USER.name,
        },
      });
      return user;
    },
  }),
];

const googleProviders = [
  Google({
    clientId: process.env.AUTH_GOOGLE_ID!,
    clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    // Safe with a single provider — only guards against cross-provider email collisions
    allowDangerousEmailAccountLinking: true,
    authorization: {
      params: {
        access_type: "offline",
        prompt: "consent",
        scope:
          "openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents.readonly",
      },
    },
  }),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: OFFLINE_MODE ? offlineProviders : googleProviders,
  // CredentialsProvider doesn't work with database sessions (PrismaAdapter
  // won't create a DB session for it), so use JWT in offline mode.
  session: { strategy: OFFLINE_MODE ? "jwt" : "database" },
  callbacks: {
    session({ session, user, token }) {
      // Database strategy passes `user`; JWT strategy passes `token`
      session.user.id = user?.id ?? token?.sub ?? "";
      return session;
    },
  },
});
