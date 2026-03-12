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
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
      <div className="mb-8 flex flex-col items-center">
        <img src="/docreview.svg" alt="Docreview Logo" className="mb-4 h-16 w-16 shadow-lg rounded-xl" />
        <h1 className="mb-2 text-3xl font-bold tracking-tight text-zinc-900">Docreview</h1>
        <p className="text-zinc-500">Your inbox for document reviews.</p>
      </div>
        
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
            <GoogleSignInButton />

            <div className="mt-6 text-sm text-zinc-400">
              <h2 className="mb-1 font-semibold text-zinc-500">Permissions</h2>
              <p className="mb-2">On your first login, you&apos;ll be asked for these permissions:</p>
              <ul className="list-disc list-outside ml-4 space-y-2">
                <li><span className="font-medium text-zinc-500">Read and write Google Drive</span>
                  <ul className="list-disc list-outside ml-4 mt-0.5"><li>To find documents and read comments.</li></ul>
                  <ul className="list-disc list-outside ml-4 mt-0.5"><li>To reply to or resolve comments.</li></ul>
                </li>
                <li><span className="font-medium text-zinc-500">Read Google Docs</span>
                  <ul className="list-disc list-outside ml-4 mt-0.5"><li>To read suggestions on documents.</li></ul>
                </li>
                <li><span className="font-medium text-zinc-500">Read Gmail</span>
                  <ul className="list-disc list-outside ml-4 mt-0.5">
                    <li>To read notifications on Google Drive documents.</li>
                    <li>Only mail from <span className="font-mono whitespace-nowrap text-xs">drive-shares-dm-noreply@google.com</span> and <span className="font-mono whitespace-nowrap text-xs">comments-noreply@docs.google.com</span>.</li>
                  </ul>
                </li>
              </ul>

              <h2 className="mt-4 mb-1 font-semibold text-zinc-500">Data Storage</h2>
              <ul className="list-disc list-outside ml-4 space-y-2">
                <li><span className="font-medium text-zinc-500">Stored data:</span>
                  <ul className="list-disc list-outside ml-4 mt-0.5 space-y-0.5">
                    <li>Opaque IDs for documents and comments</li>
                    <li><b>Document titles</b></li>
                    <li>All metadata entered in Docreview: labels, notes, etc.</li>
                    <li>No user IDs, document contents, or comment text</li>
                  </ul>
                </li>
                <li><span className="font-medium text-zinc-500">All other data is transient, in your browser only</span></li>
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
