import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ExtraSchemaEditor } from "@/components/extra-schema-editor";
import type { ExtraFieldDef } from "@/lib/types";

export const metadata: Metadata = { title: "字段 Schema" };
export const dynamic = "force-dynamic";

export default async function SchemaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("data_sources")
    .select("extra_schema")
    .eq("id", id)
    .maybeSingle();

  return (
    <ExtraSchemaEditor
      sourceId={id}
      initial={((data?.extra_schema as ExtraFieldDef[] | null) ?? []) as ExtraFieldDef[]}
    />
  );
}
