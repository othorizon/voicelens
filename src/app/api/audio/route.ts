import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { PLAYBACK_URL_TTL, signedUrl } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/audio?path=<storage object path>
 * Redirects to a short-lived presigned URL so the browser can play audio without
 * ever holding a storage credential.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "missing path" }, { status: 400 });

  if (!(await currentUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const signed = await signedUrl(path, PLAYBACK_URL_TTL);
  if (!signed) return NextResponse.json({ error: "无法生成音频访问链接" }, { status: 404 });

  return NextResponse.redirect(signed, 302);
}
