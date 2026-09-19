import type { Metadata } from "next";
import { listBatches } from "@/lib/queries";
import { ImportPanel } from "@/components/import-panel";
import { requireSourcePage } from "@/lib/actions/common";
import { maxZipBytes } from "@/lib/engine/import";

export const metadata: Metadata = { title: "导入数据" };
export const dynamic = "force-dynamic";

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSourcePage(id);
  const batches = await listBatches(id);
  const hasActive = batches.some((b) => ["pending", "processing"].includes(String(b.status)));

  return (
    <ImportPanel sourceId={id} batches={batches} autoRefresh={hasActive} maxBytes={maxZipBytes()} />
  );
}
