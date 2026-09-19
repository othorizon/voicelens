import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { listBatches } from "@/lib/queries";
import { ImportPanel } from "@/components/import-panel";

export const metadata: Metadata = { title: "导入数据" };
export const dynamic = "force-dynamic";

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const batches = await listBatches(supabase, id);
  const hasActive = batches.some((b) => ["pending", "processing"].includes(String(b.status)));

  return <ImportPanel sourceId={id} batches={batches} autoRefresh={hasActive} />;
}
