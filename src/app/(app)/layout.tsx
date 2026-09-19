import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell, type CurrentUser } from "@/components/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, email, display_name, avatar_color")
    .eq("id", user.id)
    .maybeSingle();

  const current: CurrentUser = profile ?? {
    id: user.id,
    email: user.email ?? "",
    display_name: user.email?.split("@")[0] ?? null,
    avatar_color: null,
  };

  return <AppShell user={current}>{children}</AppShell>;
}
