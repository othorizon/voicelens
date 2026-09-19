import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Clock, Waves, ShieldCheck } from "lucide-react";
import { viewerState } from "@/lib/auth/access";
import { logoutAction } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = { title: "等待开通" };
export const dynamic = "force-dynamic";

/**
 * Where an account with the `none` role lands. Registration succeeds and the
 * session is real — there is just nothing to show until an owner or admin
 * assigns a role, which takes effect on the next request.
 *
 * Lives outside the (app) group so it renders without the nav shell.
 */
export default async function PendingPage() {
  const state = await viewerState();
  if (state.kind === "anonymous") redirect("/login");
  if (state.kind === "active") redirect("/dashboard");

  return (
    <div className="grid min-h-svh place-items-center bg-background p-6">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Waves className="size-5" />
          </div>
          <span className="text-base font-semibold tracking-tight">VoiceLens</span>
        </div>

        <Card>
          <CardHeader>
            <div className="mb-1 grid size-10 place-items-center rounded-full bg-accent text-accent-foreground">
              <Clock className="size-5" />
            </div>
            <CardTitle className="text-base">账号待开通</CardTitle>
            <CardDescription className="text-[13px] leading-relaxed">
              注册已经成功，但这个账号还没有被分配权限，暂时看不到任何数据。
              请联系工作区的所有者或管理员为你开通。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-[12.5px] font-medium">
                <ShieldCheck className="size-3.5 text-primary" />
                开通后可以做什么
              </div>
              <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
                <li>
                  <span className="text-foreground">成员</span>
                  ：创建自己的数据源，导入数据、编排工作流、跑分析任务
                </li>
                <li>
                  <span className="text-foreground">管理员</span>
                  ：在此之上还能查看和管理所有人的数据，并为其他人分配角色
                </li>
              </ul>
            </div>

            <div className="text-[12px] text-muted-foreground">
              管理员开通后无需重新登录，刷新页面即可生效。
            </div>

            <Separator />

            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm" className="flex-1">
                <a href="/pending">刷新状态</a>
              </Button>
              <form action={logoutAction} className="flex-1">
                <Button type="submit" variant="ghost" size="sm" className="w-full">
                  退出登录
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
