"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  LayoutDashboard,
  Database,
  Workflow,
  ListChecks,
  Settings,
  Waves,
  LogOut,
  Moon,
  Sun,
  ChevronDown,
} from "lucide-react";
import { logoutAction } from "@/lib/actions/auth";
import { useTheme } from "@/components/theme-provider";
import { cn, initials } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface CurrentUser {
  id: string;
  email: string;
  display_name: string | null;
  avatar_color: string | null;
}

const NAV = [
  { href: "/dashboard", label: "概览", icon: LayoutDashboard },
  { href: "/sources", label: "数据源", icon: Database },
  { href: "/workflows", label: "工作流", icon: Workflow },
  { href: "/tasks", label: "分析任务", icon: ListChecks },
  { href: "/settings", label: "设置", icon: Settings },
];

export function AppShell({
  user,
  children,
}: {
  user: CurrentUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="flex min-h-svh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border/70 bg-sidebar md:flex">
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border/70 px-5">
          <div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Waves className="size-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">VoiceLens</span>
          <span className="ml-auto rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            BETA
          </span>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <item.icon
                  className={cn(
                    "size-4 transition-colors",
                    active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                  )}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border/70 p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60">
                <span
                  className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                  style={{ background: user.avatar_color ?? "var(--primary)" }}
                >
                  {initials(user.display_name ?? user.email)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {user.display_name ?? user.email}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {user.email}
                  </span>
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-56">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                工作区账号
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  navigator.clipboard?.writeText(user.id).catch(() => {});
                  toast.success("用户 ID 已复制");
                }}
              >
                复制用户 ID
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  // The action clears the HttpOnly cookie and redirects.
                  await logoutAction();
                }}
              >
                <LogOut className="size-4" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:pl-60">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-md md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
              <Waves className="size-4" />
            </div>
            <span className="text-sm font-semibold">VoiceLens</span>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {mounted && (
              <nav className="mr-2 flex items-center gap-0.5 md:hidden">
                {NAV.map((item) => (
                  <Link key={item.href} href={item.href} aria-label={item.label}>
                    <Button
                      size="icon"
                      variant={
                        pathname === item.href || pathname.startsWith(`${item.href}/`)
                          ? "secondary"
                          : "ghost"
                      }
                      className="size-8"
                    >
                      <item.icon className="size-4" />
                    </Button>
                  </Link>
                ))}
              </nav>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={toggle}
              aria-label="切换主题"
            >
              {mounted && theme === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="size-8 rounded-full p-0 md:hidden"
              onClick={async () => {
                await logoutAction();
              }}
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
