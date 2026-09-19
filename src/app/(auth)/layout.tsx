import { Waves, Database, Workflow, BarChart3 } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden border-r border-border/60 bg-sidebar lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 bg-grid opacity-[0.55]" />
        <div
          className="absolute -top-40 -left-32 size-[34rem] rounded-full opacity-25 blur-[110px]"
          style={{ background: "radial-gradient(circle, var(--chart-1), transparent 65%)" }}
        />
        <div
          className="absolute -right-24 -bottom-32 size-[30rem] rounded-full opacity-20 blur-[110px]"
          style={{ background: "radial-gradient(circle, var(--chart-2), transparent 65%)" }}
        />

        <div className="relative flex items-center gap-2.5 p-10">
          <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Waves className="size-5" />
          </div>
          <span className="text-base font-semibold tracking-tight">VoiceLens</span>
        </div>

        <div className="relative px-10 pb-6">
          <h2 className="max-w-md text-3xl leading-[1.25] font-semibold tracking-tight text-balance">
            为 ASR-LLM-TTS 语音对话数据
            <br />
            建立的三层分析视角
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            上传 JSONL 与音频，按业务语义定义 extra 字段 schema，
            在可视化工作流中编排「规划 → 预览 → 生成」，
            得到可逐层下探的会话 / 用户 / 全局分析报告。
          </p>

          <div className="mt-9 grid gap-3">
            {[
              {
                icon: Database,
                title: "数据源与业务语义",
                body: "多批次导入、音频入对象存储、extra 字段 schema 手工定义并决定分析用法",
              },
              {
                icon: Workflow,
                title: "AI 自主规划提示词",
                body: "三层抽样后动态生成 session / user / global 分析提示词与报告提示词，每次修改留存版本",
              },
              {
                icon: BarChart3,
                title: "动态单页报告",
                body: "结构化指标 + 图表 + 证据引用，生成可下探的可视化 HTML 报告",
              },
            ].map((f) => (
              <div
                key={f.title}
                className="flex gap-3 rounded-xl border border-border/70 bg-card/60 p-4 backdrop-blur-sm"
              >
                <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
                  <f.icon className="size-4" />
                </div>
                <div>
                  <div className="text-sm font-medium">{f.title}</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {f.body}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative p-10 text-xs text-muted-foreground">
          Powered by qwen3.8-omni-flash · 文本 / 图像 / 音频多模态输入
        </div>
      </div>

      <div className="flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-[400px]">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Waves className="size-5" />
            </div>
            <span className="text-base font-semibold tracking-tight">VoiceLens</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
