import { redirect } from "next/navigation";
import { viewerState } from "@/lib/auth/access";
import { AppShell, type CurrentUser } from "@/components/app-shell";

/**
 * The gate for every signed-in page.
 *
 * `middleware.ts` runs on the Edge runtime and only verifies the session
 * token, so it cannot read a role — that check lands here, where the database
 * is reachable. An account without a role gets the holding page instead.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const state = await viewerState();
  if (state.kind === "anonymous") redirect("/login");
  if (state.kind === "inactive") redirect("/pending");

  const { viewer } = state;
  const current: CurrentUser = {
    id: viewer.userId,
    email: viewer.user.email,
    display_name: viewer.user.display_name ?? viewer.user.email.split("@")[0],
    avatar_color: viewer.user.avatar_color,
    role: viewer.role,
  };

  return <AppShell user={current}>{children}</AppShell>;
}
