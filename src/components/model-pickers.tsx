"use client";

import {
  MODEL_KIND_LABEL,
  MODE_LABEL,
  type AnalysisMode,
  type ModelKind,
} from "@/lib/models/mode";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The two pickers shared by the workspace default (settings page) and the
 * per-source override. They differ only in what an empty choice means, which
 * is why that is a label rather than two components: "未选择" at the workspace
 * level, "继承全局默认" on a data source.
 */

export interface ModelOption {
  id: string;
  name: string;
  kind: ModelKind;
  model: string;
  enabled: boolean;
}

// Radix treats "" as "no value", so an explicit empty choice needs a sentinel.
const EMPTY = "__empty__";

export function ModePicker({
  label,
  value,
  onChange,
  modes,
  disabled,
  emptyLabel,
}: {
  label: string;
  value: AnalysisMode | null;
  onChange: (mode: AnalysisMode | null) => void;
  modes: readonly AnalysisMode[];
  disabled?: boolean;
  /** When given, an extra option meaning "no choice here". */
  emptyLabel?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12px] text-muted-foreground">{label}</Label>
      <Select
        value={value ?? EMPTY}
        disabled={disabled}
        onValueChange={(v) => onChange(v === EMPTY ? null : (v as AnalysisMode))}
      >
        <SelectTrigger className="w-full text-[12.5px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {emptyLabel && (
            <SelectItem value={EMPTY} className="text-[12.5px]">
              {emptyLabel}
            </SelectItem>
          )}
          {modes.map((m) => (
            <SelectItem key={m} value={m} className="text-[12.5px]">
              {MODE_LABEL[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ModelPicker({
  label,
  kind,
  value,
  options,
  onChange,
  disabled,
  emptyLabel = "未选择",
}: {
  label: string;
  kind: ModelKind;
  value: string | null;
  options: ModelOption[];
  onChange: (id: string | null) => void;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const usable = options.filter((o) => o.kind === kind);
  // A model that was disabled after being selected still has to render, or the
  // picker would silently show the wrong thing.
  const stale = value && !usable.some((o) => o.id === value);

  return (
    <div className="space-y-1.5">
      <Label className="text-[12px] text-muted-foreground">{label}</Label>
      <Select
        value={value ?? EMPTY}
        disabled={disabled}
        onValueChange={(v) => onChange(v === EMPTY ? null : v)}
      >
        <SelectTrigger className="w-full text-[12.5px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={EMPTY} className="text-[12.5px]">
            {emptyLabel}
          </SelectItem>
          {usable.map((o) => (
            <SelectItem key={o.id} value={o.id} disabled={!o.enabled} className="text-[12.5px]">
              {o.name}
              <span className="ml-1.5 text-[11px] text-muted-foreground">
                {o.model}
                {o.enabled ? "" : " · 已停用"}
              </span>
            </SelectItem>
          ))}
          {stale && (
            <SelectItem value={value} className="text-[12.5px]">
              已失效的选择
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      {usable.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          还没有可用的{MODEL_KIND_LABEL[kind]}，需要所有者先在设置页添加。
        </p>
      )}
    </div>
  );
}
