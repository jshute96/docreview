import { signIn } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { OFFLINE_MODE, getExpectedOfflineId } from "@/lib/offline";
import { getValidSession } from "@/lib/auth-utils";
import { AutoSignIn } from "@/components/auto-signin";

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
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: "/docs" });
              }}
            >
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-50"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
                  />
                  <path
                    fill="#34A853"
                    d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                  />
                  <path
                    fill="#EA4335"
                    d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"
                  />
                </svg>
                Sign in with Google
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
