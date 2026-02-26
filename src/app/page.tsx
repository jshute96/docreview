import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth-utils";

export default async function Home() {
  const session = await getValidSession();
  if (session) {
    redirect("/docs");
  }

  redirect("/login");
}
