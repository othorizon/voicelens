import { ActionError } from "@/lib/actions/common";

/**
 * Turn a range bound from the UI into an instant.
 *
 * The date pickers hand over a plain day (`2026-03-08`), and a day means the
 * day where the deployment lives: the container's TZ, which the shipped image
 * pins to Asia/Shanghai and a run can override. Node parses a timestamp with no
 * zone on it in exactly that timezone, so the conversion needs no library and
 * no second copy of the setting. Reading the day in the browser's timezone
 * instead would move the boundary for anyone travelling, and reading it as UTC
 * would cut 8 hours off the last day of a +08:00 deployment.
 *
 * The end of a day is inclusive — picking 3-08 covers everything recorded that
 * day, not everything up to its first second.
 *
 * A value that already carries a time (an ISO instant from an API caller) is
 * kept as it is.
 */
export function rangeBound(
  value: string | null | undefined,
  edge: "start" | "end",
): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const at = dayOnly ? `${raw}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}` : raw;
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) throw new ActionError(`时间格式无法识别：${raw}`);
  return parsed.toISOString();
}
