"use client";

import { signIn } from "next-auth/react";
import { useEffect } from "react";

export function AutoSignIn() {
  useEffect(() => {
    // We use a small timeout to ensure the client-side auth state is ready
    // and to avoid potential race conditions during initial mount.
    const timer = setTimeout(() => {
      signIn("offline", { callbackUrl: "/docs" });
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
      <p className="text-sm text-zinc-500">Signing in automatically...</p>
    </div>
  );
}
