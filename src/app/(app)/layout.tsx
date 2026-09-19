import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AppShell, type CurrentUser } from "@/components/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const current: CurrentUser = {
    id: user.id,
    email: user.email,
    display_name: user.display_name ?? user.email.split("@")[0],
    avatar_color: user.avatar_color,
  };

  return <AppShell user={current}>{children}</AppShell>;
}
