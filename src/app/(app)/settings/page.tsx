import type { Metadata } from "next";
import { Bot, Database, ShieldCheck, Users, Cpu, Cloud } from "lucide-react";
import { count as countRows, maybeOne, query } from "@/lib/db";
import { ownerScope, requireSession } from "@/lib/actions/common";
import { listModels, readDefaults, readDefaultsPatch } from "@/lib/models/registry";
import { MODE_LABEL } from "@/lib/models/mode";
import { ModelSettings, type ModelCard } from "@/components/model-settings";
import { canAssignRoles, ROLE_HINT, ROLE_LABEL, asRole, type Role } from "@/lib/auth/roles";
import { MemberRoles, type MemberRow } from "@/components/member-roles";
import { PageHeader, StatCard } from "@/components/ui-kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { initials } from "@/lib/utils";

export const metadata: Metadata = { title: "设置" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireSession();
  const user = session.user;
  const scope = ownerScope(session);
  const manages = canAssignRoles(session.role);

  // `profiles` is a view over `users` without the password column, so no query
  // here can reach a credential. The roster is only assembled for owner/admin —
  // a member has no business enumerating the workspace.
  const [profile, members, sourceCount] = await Promise.all([
    maybeOne<{
      display_name: string | null;
      avatar_color: string | null;
      role: string;
      created_at: string;
    }>(`select display_name, avatar_color, role, created_at from profiles where id = $1`, [user.id]),
    manages
      ? query<MemberRow & { role: string }>(
          `select p.id, p.email, p.display_name, p.avatar_color, p.role,
                  count(d.id)::int as source_count
           from profiles p
           left join data_sources d on d.created_by = p.id
           group by p.id, p.email, p.display_name, p.avatar_color, p.role, p.created_at
           order by
             case p.role when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end,
             p.created_at`,
        )
      : Promise.resolve([]),
    countRows(
      `select count(*) from data_sources where ($1::uuid is null or created_by = $1)`,
      [scope],
    ),
  ]);

  const roster: MemberRow[] = members.map((m) => ({ ...m, role: asRole(m.role) }));
  const myRole: Role = session.role;

  // Models live in the database now. Only the owner may change them, but the
  // whole workspace sees what is configured — a member picking a model for
  // their own data source needs the names.
  const [registry, defaults, defaultsPatch] = await Promise.all([
    listModels(),
    readDefaults(),
    readDefaultsPatch(),
  ]);
  const cards: ModelCard[] = registry.map((m) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    baseUrl: m.baseUrl,
    model: m.model,
    enableThinking: m.enableThinking,
    enabled: m.enabled,
    note: m.note,
    keyPresent: m.key.present,
    keyReadable: m.key.readable,
    keyMasked: m.key.masked,
  }));
  const usable = cards.filter((m) => m.enabled && m.keyReadable && m.keyPresent);
  const defaultOmni = cards.find((m) => m.id === defaults.omniModelId) ?? null;
  const defaultMultimodal = cards.find((m) => m.id === defaults.multimodalModelId) ?? null;
  const ready = Boolean(defaultOmni || defaultMultimodal);

  return (
    <>
      <PageHeader
        title="设置"
        description={
          manages
            ? "当前账号、成员与角色分配、模型与基础设施配置。"
            : "当前账号、模型与基础设施配置。"
        }
      />
      <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-8">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={manages ? "数据源" : "我的数据源"}
            value={sourceCount}
            icon={Database}
          />
          <StatCard
            label={manages ? "工作区成员" : "我的角色"}
            value={manages ? roster.length : ROLE_LABEL[myRole]}
            hint={manages ? undefined : ROLE_HINT[myRole]}
            icon={Users}
            tone="info"
          />
          <StatCard
            label="可用模型"
            value={usable.length}
            hint={`共 ${cards.length} 套配置`}
            icon={Cpu}
            tone={usable.length ? "good" : "bad"}
          />
          <StatCard
            label="默认分析模式"
            value={ready ? MODE_LABEL[defaults.mode] : "未配置"}
            hint={ready ? MODE_LABEL[defaults.mode] : "尚未选择默认模型，任务无法运行"}
            icon={Bot}
            tone={ready ? "good" : "bad"}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">我的账号</CardTitle>
              <CardDescription className="text-[12.5px]">登录态由本平台自己签发，会话是一枚签名的 HttpOnly Cookie。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <span
                  className="grid size-11 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
                  style={{ background: String(profile?.avatar_color ?? "var(--primary)") }}
                >
                  {initials(profile?.display_name ?? user.email)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {profile?.display_name ?? user.email.split("@")[0]}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">{user.email}</div>
                </div>
                <Badge variant="outline" className="ml-auto shrink-0">
                  {ROLE_LABEL[myRole]}
                </Badge>
              </div>
              <Separator />
              <dl className="space-y-1.5 text-[12px]">
                <Row k="用户 ID" v={user.id} mono />
                <Row k="注册时间" v={(profile?.created_at ?? "").replace("T", " ").slice(0, 19)} />
                <Row k="认证方式" v="邮箱 + 密码（argon2id）" />
                <Row k="当前权限" v={ROLE_HINT[myRole]} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4 text-primary" />
                数据与权限模型
              </CardTitle>
              <CardDescription className="text-[12.5px]">
                数据按创建者隔离：成员只看得到自己创建的数据源，所有者与管理员看得到全部。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
              {[
                { k: "角色", v: "所有者拥有全部权限；管理员可查看和管理所有人的数据，并分配「成员 / 无权限」；成员只管自己的数据；新注册账号默认无权限。" },
                { k: "归属边界", v: "以数据源为单位：其下的会话、消息、工作流、模板、预览与分析任务都跟随数据源的创建者。" },
                { k: "访问控制", v: "授权在应用层：未登录请求在中间件被重定向，服务端动作与路由各自再按创建者校验一次。" },
                { k: "角色变更", v: "角色不写进会话 Cookie，每次请求都回库读取，所以调整后对方下一次请求就生效，无需重新登录。" },
                { k: "浏览器边界", v: "浏览器只与本平台自己的服务端路由通信，任何数据库或对象存储凭据都不下发到前端。" },
                { k: "音频存储", v: "音频字节存放在 S3 兼容私有桶（阿里云 OSS），数据库中只保存对象路径。" },
                { k: "播放与送模型", v: "播放与分析都通过短时效预签名 URL 访问，播放 10 分钟、送模型 1 小时。" },
                { k: "后台任务", v: "规划、预览、全量分析由独立 Worker 进程直连数据库执行，进度与日志写回任务对象。" },
              ].map((r) => (
                <div key={r.k} className="rounded-lg border border-border/60 p-3">
                  <div className="font-medium text-foreground">{r.k}</div>
                  <div className="mt-0.5">{r.v}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {manages && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">成员与角色</CardTitle>
              <CardDescription className="text-[12.5px]">
                在登录页注册的账号默认没有任何权限，需要在这里开通。
                {myRole === "owner"
                  ? "作为所有者，你可以任免管理员。"
                  : "作为管理员，你可以在「成员 / 无权限」之间调整；任免管理员只有所有者可以操作。"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MemberRoles members={roster} actor={{ id: user.id, role: myRole }} />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Cpu className="size-4 text-primary" />
              分析模型
            </CardTitle>
            <CardDescription className="text-[12.5px]">
              {myRole === "owner"
                ? "配置 OpenAI 兼容的模型端点与默认分析模式。API Key 加密存库，保存后只回显掩码。"
                : "由所有者配置。你可以在各数据源的「分析模型」页签里，从这些模型中为该数据源选择。"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ModelSettings
              models={cards}
              defaults={defaults}
              stagePatch={defaultsPatch.stages}
              canManage={myRole === "owner"}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Cloud className="size-4 text-primary" />
              运行环境
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-[12px] sm:grid-cols-2 lg:grid-cols-3">
              <Row k="默认 omni 模型" v={defaultOmni ? `${defaultOmni.name} · ${defaultOmni.model}` : "未选择"} mono />
              <Row
                k="默认多模态模型"
                v={defaultMultimodal ? `${defaultMultimodal.name} · ${defaultMultimodal.model}` : "未选择"}
                mono
              />
              <Row k="兼容协议" v="OpenAI Chat Completions（stream）" />
              <Row k="模型凭据" v="AES-256-GCM 加密后存库，前端只回显掩码" />
              <Row k="后端数据库" v="PostgreSQL（pg 直连）" />
              <Row k="对象存储" v={`S3 兼容 · bucket: ${process.env.S3_BUCKET ?? "—"}`} />
              <Row k="后台 Worker" v="tsx 常驻进程，轮询任务队列" />
              <Row k="可视化编排" v="React Flow (@xyflow/react)" />
              <Row k="UI" v="Next.js App Router + shadcn/ui + Tailwind v4" />
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className={mono ? "num truncate text-foreground" : "truncate text-foreground"} title={v}>
        {v}
      </dd>
    </div>
  );
}
