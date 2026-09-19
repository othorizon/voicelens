"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, AudioLines } from "lucide-react";
import { cn } from "@/lib/utils";

/** Inline audio player that resolves bytes through the signed-URL proxy route. */
export function AudioChip({ path, className }: { path: string; className?: string }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLAudioElement | null>(null);
  const src = `/api/audio?path=${encodeURIComponent(path)}`;

  useEffect(() => {
    return () => {
      ref.current?.pause();
    };
  }, []);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!ref.current) {
      ref.current = new Audio(src);
      ref.current.preload = "none";
      ref.current.onended = () => setPlaying(false);
      ref.current.onerror = () => {
        setPlaying(false);
        setLoading(false);
      };
    }
    if (playing) {
      ref.current.pause();
      setPlaying(false);
      return;
    }
    setLoading(true);
    try {
      await ref.current.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-px text-[10.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary",
        playing && "border-primary/60 text-primary",
        className,
      )}
      title="播放该条消息的音频"
    >
      {loading ? (
        <Loader2 className="size-3 animate-spin" />
      ) : playing ? (
        <Pause className="size-3" />
      ) : (
        <Play className="size-3" />
      )}
      <AudioLines className="size-3" />
      音频
    </button>
  );
}
