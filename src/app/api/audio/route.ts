import { NextResponse } from "next/server";
import { currentViewer, resolveAudioSource } from "@/lib/auth/access";
import { PLAYBACK_URL_TTL, signedUrl } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/audio?path=<storage object path>
 * Redirects to a short-lived presigned URL so the browser can play audio without
 * ever holding a storage credential.
 *
 * The path is request input, so it is resolved back to the message that stores
 * it and authorized against that message's data source — otherwise any member
 * holding a path would be signed a URL for another member's audio.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "missing path" }, { status: 400 });

  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!(await resolveAudioSource(viewer, path))) {
    return NextResponse.json({ error: "音频不存在" }, { status: 404 });
  }

  const signed = await signedUrl(path, PLAYBACK_URL_TTL);
  if (!signed) return NextResponse.json({ error: "无法生成音频访问链接" }, { status: 404 });

  return NextResponse.redirect(signed, 302);
}
