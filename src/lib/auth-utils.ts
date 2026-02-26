import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { OFFLINE_MODE, getExpectedOfflineId } from "@/lib/offline";

/**
 * Returns the current session only if it is valid for the current mode.
 * In offline mode, a session is invalid if its user ID doesn't match the
 * expected OFFLINE_USER_ID.
 */
export async function getValidSession() {
  const session = await auth();
  if (!session?.user?.id) return null;

  if (OFFLINE_MODE) {
    const expectedId = getExpectedOfflineId();
    if (session.user.id !== expectedId) {
      return null;
    }
  }

  return session;
}

/**
 * Ensures a valid session exists, or redirects to the login page.
 * Use this in Server Components for protected pages.
 */
export async function requireAuth() {
  const session = await getValidSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}
