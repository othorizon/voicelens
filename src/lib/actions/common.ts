import { redirect } from "next/navigation";
import { currentUser, type AuthUser } from "@/lib/auth";

export interface Session {
  userId: string;
  user: AuthUser;
}

/**
 * Server-action guard. Every signed-in member shares one workspace, so being
 * signed in is the whole authorization check — there is no per-row ownership.
 */
export async function requireSession(): Promise<Session> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return { userId: user.id, user };
}

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

export function fail(message: string): never {
  throw new ActionError(message);
}
