"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders server components on an interval while any job is still active. */
export function AutoRefresh({ enabled, interval = 3000 }: { enabled: boolean; interval?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => router.refresh(), interval);
    return () => clearInterval(t);
  }, [enabled, interval, router]);
  return null;
}
