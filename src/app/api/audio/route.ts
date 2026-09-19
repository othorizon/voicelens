import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/audio?path=<storage object path>
 * Redirects to a short-lived signed URL so the browser can play audio without
 * ever holding a storage credential.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "missing path" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase.storage.from("audio").createSignedUrl(path, 600);
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: "无法生成音频访问链接" }, { status: 404 });
  }

  return NextResponse.redirect(data.signedUrl, 302);
}
