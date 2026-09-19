"use server";

import { revalidatePath } from "next/cache";
import { requireAdminSession, ActionError } from "./common";
import { execute, maybeOne } from "@/lib/db";
import { asRole, canAssignRole, ROLE_LABEL, type Role } from "@/lib/auth/roles";

export interface Member {
  id: string;
  email: string;
  display_name: string | null;
  avatar_color: string | null;
  role: Role;
  created_at: string;
  source_count: number;
}

/**
 * Change one account's role.
 *
 * The rules live in @/lib/auth/roles so the picker and this check agree: an
 * admin may only move member/none accounts between member and none, the owner
 * may also hand out admin, and nobody may touch the owner or their own role.
 */
export async function setUserRole(userId: string, next: string): Promise<void> {
  const session = await requireAdminSession();
  const role = asRole(next);
  if (role !== next) throw new ActionError("未知的角色");

  const target = await maybeOne<{ id: string; role: string; email: string }>(
    `select id, role, email from users where id = $1`,
    [userId],
  );
  if (!target) throw new ActionError("用户不存在");

  const targetRole = asRole(target.role);
  if (targetRole === role) return;

  if (!canAssignRole({ id: session.userId, role: session.role }, { id: target.id, role: targetRole }, role)) {
    throw new ActionError(
      session.userId === target.id
        ? "不能修改自己的角色"
        : `无权将该用户设为「${ROLE_LABEL[role]}」`,
    );
  }

  try {
    // Re-check the target's role inside the write: two admins acting at once
    // must not be able to walk an account past what either of them may set.
    const changed = await execute(`update users set role = $2 where id = $1 and role = $3`, [
      userId,
      role,
      targetRole,
    ]);
    if (!changed) throw new ActionError("该用户的角色刚刚被其他人修改，请刷新后重试");
  } catch (err) {
    if (err instanceof ActionError) throw err;
    throw new ActionError(`修改角色失败：${(err as Error).message}`);
  }

  revalidatePath("/settings");
}
