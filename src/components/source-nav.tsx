"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Braces,
  Cpu,
  LayoutDashboard,
  MessagesSquare,
  Sparkles,
  Upload,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  "layout-dashboard": LayoutDashboard,
  "messages-square": MessagesSquare,
  upload: Upload,
  braces: Braces,
  workflow: Workflow,
  sparkles: Sparkles,
  cpu: Cpu,
};

export function SourceNav({
  id,
  items,
}: {
  id: string;
  items: { href: string; label: string; icon: string; exact?: boolean }[];
}) {
  const pathname = usePathname();
  return (
    <nav className="-mb-px flex gap-0.5 overflow-x-auto scrollbar-thin">
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        const Icon = ICONS[item.icon] ?? LayoutDashboard;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
