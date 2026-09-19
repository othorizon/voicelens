"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, ArrowRight, Waves } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const isRegister = mode === "register";
  const [email, setEmail] = useState(isRegister ? "" : "demo@voicelens.ai");
  const [password, setPassword] = useState(isRegister ? "" : "voicelens123");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const supabase = createClient();
    try {
      if (isRegister) {
        const { error } = await supabase.rpc("register_user", {
          p_email: email,
          p_password: password,
          p_display_name: name || null,
        });
        if (error) throw error;
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast.success(isRegister ? "账号已创建，欢迎加入" : "登录成功");
      router.replace("/dashboard");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-[400px] border-border/70 shadow-xl shadow-black/10 backdrop-blur">
      <CardContent className="pt-8">
        <div className="mb-7 flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Waves className="size-5" />
          </div>
          <div>
            <div className="text-[15px] leading-tight font-semibold tracking-tight">
              VoiceLens
            </div>
            <div className="text-xs text-muted-foreground">语音对话智能分析平台</div>
          </div>
        </div>

        <h1 className="text-xl font-semibold tracking-tight">
          {isRegister ? "创建账号" : "登录"}
        </h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          {isRegister
            ? "注册后即可访问团队工作区中的全部数据源与分析任务"
            : "使用邮箱登录，进入你的分析工作台"}
        </p>

        <form onSubmit={submit} className="space-y-4">
          {isRegister && (
            <div className="space-y-1.5">
              <Label htmlFor="name">显示名称</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：数据分析组"
                autoComplete="name"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isRegister ? "至少 8 位" : "••••••••"}
              autoComplete={isRegister ? "new-password" : "current-password"}
            />
          </div>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {isRegister ? "注册并登录" : "登录"}
            {!busy && <ArrowRight className="size-4" />}
          </Button>
        </form>

        <div className="mt-6 text-center text-sm text-muted-foreground">
          {isRegister ? (
            <>
              已有账号？{" "}
              <Link href="/login" className="font-medium text-primary hover:underline">
                去登录
              </Link>
            </>
          ) : (
            <>
              还没有账号？{" "}
              <Link href="/register" className="font-medium text-primary hover:underline">
                创建一个
              </Link>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
