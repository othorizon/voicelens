import type { Metadata } from "next";
import { requireSourcePage } from "@/lib/actions/common";
import { listModels, readDefaults, readSourcePatch } from "@/lib/models/registry";
import { SourceModelConfig } from "@/components/source-model-config";
import type { ModelOption } from "@/components/model-pickers";

export const metadata: Metadata = { title: "分析模型" };
export const dynamic = "force-dynamic";

export default async function SourceModelsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSourcePage(id);

  // Only the shape the picker needs: no base URLs, no key state, nothing a
  // member has no business seeing about the workspace's credentials.
  const [models, defaults, override] = await Promise.all([
    listModels(),
    readDefaults(),
    readSourcePatch(id),
  ]);
  const options: ModelOption[] = models.map((m) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    model: m.model,
    enabled: m.enabled,
  }));

  return (
    <SourceModelConfig sourceId={id} models={options} defaults={defaults} override={override} />
  );
}
