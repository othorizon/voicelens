import type { Metadata } from "next";
import { scalar } from "@/lib/db";
import { ExtraSchemaEditor } from "@/components/extra-schema-editor";
import type { ExtraFieldDef } from "@/lib/types";
import { requireSourcePage } from "@/lib/actions/common";

export const metadata: Metadata = { title: "字段 Schema" };
export const dynamic = "force-dynamic";

export default async function SchemaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSourcePage(id);
  const schema = await scalar<ExtraFieldDef[]>(
    `select extra_schema from data_sources where id = $1`,
    [id],
  );

  return (
    <ExtraSchemaEditor
      sourceId={id}
      initial={schema ?? []}
    />
  );
}
