/**
 * The four workspace roles, and every rule that derives from them.
 *
 * Kept free of server-only imports so the settings UI can label and gate the
 * role picker from the exact same table the server enforces with.
 */

export const ROLES = ["owner", "admin", "member", "none"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "所有者",
  admin: "管理员",
  member: "成员",
  none: "无权限",
};

export const ROLE_HINT: Record<Role, string> = {
  owner: "平台的第一个账号，拥有全部权限",
  admin: "查看和管理所有人的数据，可分配成员与无权限",
  member: "创建和管理自己的数据源及其下全部内容",
  none: "登录后不可查看或操作任何内容，等待开通",
};

/** Anything unrecognised reads as no access, never as more access. */
export function asRole(value: string | null | undefined): Role {
  return (ROLES as readonly string[]).includes(value ?? "") ? (value as Role) : "none";
}

/** owner/admin see and manage every member's data. */
export function canViewAllData(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Everything below `member` is signed in but not activated. */
export function canUseApp(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export function canAssignRoles(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Which roles this actor may hand out. Ownership is not transferable here. */
export function assignableRoles(actor: Role): Role[] {
  if (actor === "owner") return ["admin", "member", "none"];
  if (actor === "admin") return ["member", "none"];
  return [];
}

/**
 * Whether `actor` may move `target` from `current` to `next`.
 *
 * An admin may only touch accounts that are themselves member/none, so admins
 * can neither promote each other nor demote one another — only the owner can.
 * Nobody may change the owner, or their own role.
 */
export function canAssignRole(
  actor: { id: string; role: Role },
  target: { id: string; role: Role },
  next: Role,
): boolean {
  if (!canAssignRoles(actor.role)) return false;
  if (actor.id === target.id) return false;
  if (target.role === "owner" || next === "owner") return false;
  if (!assignableRoles(actor.role).includes(next)) return false;
  if (actor.role === "admin" && !(target.role === "member" || target.role === "none")) return false;
  return true;
}
