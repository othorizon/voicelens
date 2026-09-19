/** Small server-renderable SVG charts used across the console pages. */

export function Sparkline({
  data,
  labels,
  height = 76,
}: {
  data: number[];
  labels?: string[];
  height?: number;
}) {
  if (!data.length) return <div className="py-4 text-center text-xs text-muted-foreground">无数据</div>;
  const W = 640;
  const H = height;
  const pad = 6;
  const max = Math.max(...data, 1);
  const stepX = data.length > 1 ? (W - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((v, i) => [pad + stepX * i, H - pad - (v / max) * (H - pad * 2 - 10)] as const);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H - pad} L${pts[0][0].toFixed(1)},${H - pad} Z`;

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#spark-fill)" />
        <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.length <= 45 &&
          pts.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r="2.4" fill="var(--chart-1)">
              <title>{`${labels?.[i] ?? i}: ${data[i]}`}</title>
            </circle>
          ))}
      </svg>
      {labels?.length ? (
        <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground num">
          <span>{labels[0]}</span>
          <span>{labels[Math.floor(labels.length / 2)]}</span>
          <span>{labels[labels.length - 1]}</span>
        </div>
      ) : null}
    </div>
  );
}

export function BarStrip({ data }: { data: { name: string; value: number }[] }) {
  if (!data.length) return <div className="py-4 text-center text-xs text-muted-foreground">无数据</div>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <div className="space-y-2">
      {data.map((d, i) => (
        <div key={d.name} className="grid grid-cols-[92px_1fr_58px] items-center gap-2.5 text-[12px]">
          <span className="truncate text-muted-foreground">{d.name}</span>
          <span className="h-2 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full transition-all"
              style={{
                width: `${Math.max(2, (d.value / max) * 100)}%`,
                background: `var(--chart-${(i % 5) + 1})`,
              }}
            />
          </span>
          <span className="num text-right text-muted-foreground">
            {d.value}
            <span className="ml-0.5 text-[10.5px] opacity-70">{Math.round((d.value / total) * 100)}%</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function Donut({ data, size = 108 }: { data: { name: string; value: number }[]; size?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return <div className="py-4 text-center text-xs text-muted-foreground">无数据</div>;
  const R = size / 2;
  const r = R * 0.6;
  let angle = -Math.PI / 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {data.map((d, i) => {
        const sweep = (d.value / total) * Math.PI * 2;
        const a0 = angle;
        const a1 = angle + sweep;
        angle = a1;
        const p = (rad: number, a: number) => `${R + rad * Math.cos(a)},${R + rad * Math.sin(a)}`;
        const large = sweep > Math.PI ? 1 : 0;
        const path =
          sweep >= Math.PI * 2 - 1e-6
            ? `M${R - R},${R} A${R},${R} 0 1 1 ${R + R},${R} A${R},${R} 0 1 1 ${R - R},${R} Z M${R - r},${R} A${r},${r} 0 1 0 ${R + r},${R} A${r},${r} 0 1 0 ${R - r},${R} Z`
            : `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
        return (
          <path key={d.name + i} d={path} fill={`var(--chart-${(i % 5) + 1})`} stroke="var(--card)" strokeWidth={1.5}>
            <title>{`${d.name}: ${d.value} (${((d.value / total) * 100).toFixed(1)}%)`}</title>
          </path>
        );
      })}
    </svg>
  );
}
