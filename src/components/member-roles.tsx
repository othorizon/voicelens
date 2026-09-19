"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, ShieldAlert, ShieldCheck, User, UserX } from "lucide-react";
import { setUserRole } from "@/lib/actions/members";
import {
  assignableRoles,
  canAssignRole,
  ROLE_LABEL,
  ROLE_HINT,
  type Role,
} from "@/lib/auth/roles";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { initials } from "@/lib/utils";

export interface MemberRow {
  id: string;
  email: string;
  display_name: string | null;
  avatar_color: string | null;
  role: Role;
  source_count: number;
}

const ROLE_ICON: Record<Role, typeof User> = {
  owner: ShieldCheck,
  admin: ShieldAlert,
  member: User,
  none: UserX,
};

const ROLE_TONE: Record<Role, string> = {
  owner: "border-primary/40 text-primary",
  admin: "border-primary/30 text-foreground",
  member: "border-border text-muted-foreground",
  none: "border-destructive/30 text-destructive",
};

/**
 * The workspace roster. The picker is rendered from the same `canAssignRole`
 * table the server enforces with, so what is offered here is exactly what
 * `setUserRole` will accept.
 */
export function MemberRoles({ members, actor }: { members: MemberRow[]; actor: { id: string; role: Role } }) {
  const options = assignableRoles(actor.role);

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {members.map((m) => (
        <MemberCard key={m.id} member={m} actor={actor} options={options} />
      ))}
    </div>
  );
}

function MemberCard({
  member,
  actor,
  options,
}: {
  member: MemberRow;
  actor: { id: string; role: Role };
  options: Role[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [role, setRole] = useState<Role>(member.role);
  const Icon = ROLE_ICON[role];

  const allowed = options.filter((next) =>
    canAssignRole(actor, { id: member.id, role: member.role }, next),
  );
  const editable = allowed.length > 0;

  function change(next: string) {
    const previous = role;
    setRole(next as Role);
    startTransition(async () => {
      try {
        await setUserRole(member.id, next);
        toast.success(`${member.display_name ?? member.email} → ${ROLE_LABEL[next as Role]}`);
        router.refresh();
      } catch (e) {
        setRole(previous);
        toast.error(e instanceof Error ? e.message : "修改角色失败");
      }
    });
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/70 p-3">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
        style={{ background: member.avatar_color ?? "var(--primary)" }}
      >
        {initials(member.display_name ?? member.email)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{member.display_name ?? "—"}</span>
          {member.id === actor.id && (
            <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
              我
            </Badge>
          )}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground">{member.email}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {member.source_count > 0 ? `${member.source_count} 个数据源` : "暂无数据源"}
        </div>
      </div>

      {editable ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {pending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <Select value={role} onValueChange={change} disabled={pending}>
            <SelectTrigger size="sm" className="w-[104px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowed.map((r) => (
                <SelectItem key={r} value={r} className="text-[12px]">
                  {ROLE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <Badge
          variant="outline"
          className={`shrink-0 gap-1 ${ROLE_TONE[role]}`}
          title={ROLE_HINT[role]}
        >
          <Icon className="size-3" />
          {ROLE_LABEL[role]}
        </Badge>
      )}
    </div>
  );
}
