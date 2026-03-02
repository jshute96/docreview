import { signIn } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { OFFLINE_MODE, getExpectedOfflineId } from "@/lib/offline";
import { getValidSession } from "@/lib/auth-utils";
import { AutoSignIn } from "@/components/auto-signin";
import { GoogleSignInButton } from "@/components/google-signin-button";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getValidSession();
  if (session) redirect("/docs");

  const { error } = await searchParams;

  const validUsers = error && OFFLINE_MODE 
    ? await prisma.user.findMany({ select: { id: true, name: true } })
    : [];

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold text-zinc-900 text-center">Docreview</h1>
        
        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-xs text-red-600">
            <div className="mb-2 font-semibold">
              {error === "CredentialsSignin"
                ? "Offline Sign-in Failed"
                : `Error: ${error}`}
            </div>
            <p className="mb-3">
              {getExpectedOfflineId() 
                ? `User ID "${getExpectedOfflineId()}" was not found in the database.`
                : "The default offline user could not be found or created."}
            </p>
            
            {validUsers.length > 0 && (
              <div className="mb-3 border-t border-red-100 pt-2">
                <p className="mb-1 font-medium">Available user IDs:</p>
                <ul className="list-inside list-disc opacity-80">
                  {validUsers.map(u => (
                    <li key={u.id}>{u.id} {u.name ? `(${u.name})` : ""}</li>
                  ))}
                </ul>
              </div>
            )}

            {OFFLINE_MODE && (
              <a href="/docs" className="font-medium underline hover:text-red-800">
                Back to Docs
              </a>
            )}
          </div>
        )}

        {OFFLINE_MODE && !error ? (
          <div className="mt-8 mb-4">
            <AutoSignIn />
          </div>
        ) : OFFLINE_MODE ? (
          <>
            <p className="mb-6 text-sm text-zinc-500 text-center">
              Offline mode — Google APIs are disabled
            </p>
            <form
              action={async () => {
                "use server";
                await signIn("offline", { redirectTo: "/docs" });
              }}
            >
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-50"
              >
                Sign in (offline)
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="mb-6 text-sm text-zinc-500 text-center">
              Track your Google Docs workflow
            </p>
            <GoogleSignInButton />
          </>
        )}
      </div>
    </div>
  );
}
