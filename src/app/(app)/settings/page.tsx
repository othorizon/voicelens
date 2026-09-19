import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Bot, Database, ShieldCheck, Users, Cpu, Cloud } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, StatCard } from "@/components/ui-kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { initials } from "@/lib/utils";

export const metadata: Metadata = { title: "设置" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: members }, { count: sourceCount }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    supabase.from("profiles").select("id, email, display_name, avatar_color, role, created_at").order("created_at", { ascending: true }),
    supabase.from("data_sources").select("id", { count: "exact", head: true }),
  ]);

  const model = process.env.AI_MODEL ?? "qwen3.8-omni-flash";
  const baseUrl = process.env.AI_BASE_URL ?? "";
  const host = baseUrl.replace(/^https?:\/\//, "").split("/")[0];
  const aiConfigured = Boolean(process.env.AI_API_KEY && baseUrl);

  return (
    <>
      <PageHeader title="设置" description="当前账号、团队工作区成员、模型与基础设施配置。" />
      <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-8">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="数据源" value={sourceCount ?? 0} icon={Database} />
          <StatCard label="工作区成员" value={(members ?? []).length} icon={Users} tone="info" />
          <StatCard label="分析模型" value={model.replace("qwen3.8-", "")} hint={model} icon={Cpu} tone="good" />
          <StatCard
            label="模型连通性"
            value={aiConfigured ? "已配置" : "未配置"}
            hint={host || "缺少 AI_BASE_URL"}
            icon={Bot}
            tone={aiConfigured ? "good" : "bad"}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">我的账号</CardTitle>
              <CardDescription className="text-[12.5px]">登录态由 Supabase Auth 管理，会话保存在 HttpOnly Cookie 中。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <span
                  className="grid size-11 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
                  style={{ background: String(profile?.avatar_color ?? "var(--primary)") }}
                >
                  {initials(String(profile?.display_name ?? user.email))}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {String(profile?.display_name ?? user.email?.split("@")[0])}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">{user.email}</div>
                </div>
                <Badge variant="outline" className="ml-auto shrink-0">
                  {String(profile?.role ?? "member")}
                </Badge>
              </div>
              <Separator />
              <dl className="space-y-1.5 text-[12px]">
                <Row k="用户 ID" v={String(user.id)} mono />
                <Row k="注册时间" v={String(profile?.created_at ?? "").replace("T", " ").slice(0, 19)} />
                <Row k="认证方式" v="邮箱 + 密码（bcrypt）" />
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
                这是一个团队协作工作区：登录后即可访问全部数据源、工作流与分析任务，每条记录都会留下创建者。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
              {[
                { k: "行级安全", v: "全部业务表开启 RLS，仅 authenticated 角色可读写；未登录请求在中间件层被重定向。" },
                { k: "浏览器边界", v: "浏览器只与本平台自己的服务端路由通信，不直连 Supabase 写入业务数据。" },
                { k: "音频存储", v: "音频字节存放在 Supabase Storage 私有桶 audio，数据库中只保存对象路径。" },
                { k: "播放与送模型", v: "播放与分析都通过短时效签名 URL 访问，签名链接最长 1 小时。" },
                { k: "后台任务", v: "规划、预览、全量分析由独立 Worker 进程以专用成员账号执行，进度与日志写回任务对象。" },
              ].map((r) => (
                <div key={r.k} className="rounded-lg border border-border/60 p-3">
                  <div className="font-medium text-foreground">{r.k}</div>
                  <div className="mt-0.5">{r.v}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">工作区成员</CardTitle>
            <CardDescription className="text-[12.5px]">在登录页注册即可加入同一个工作区。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {(members ?? []).map((m) => (
                <div key={String(m.id)} className="flex items-center gap-2.5 rounded-lg border border-border/70 p-2.5">
                  <span
                    className="grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                    style={{ background: String(m.avatar_color ?? "var(--primary)") }}
                  >
                    {initials(String(m.display_name ?? m.email))}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium">{String(m.display_name ?? "—")}</div>
                    <div className="truncate text-[11.5px] text-muted-foreground">{String(m.email)}</div>
                  </div>
                  {String(m.id) === String(user.id) && <Badge variant="secondary">我</Badge>}
                </div>
              ))}
            </div>
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
              <Row k="模型" v={model} mono />
              <Row k="推理服务" v={host || "—"} mono />
              <Row k="兼容协议" v="OpenAI Chat Completions（stream）" />
              <Row k="输入模态" v="文本 / 图像 / 音频" />
              <Row k="后端数据库" v="Supabase Postgres + RLS" />
              <Row k="对象存储" v="Supabase Storage · bucket: audio" />
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
