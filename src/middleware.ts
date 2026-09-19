import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_REFRESH_WITHIN_SECONDS,
  cookieOptions,
  signSessionToken,
  verifySessionToken,
} from "@/lib/auth/token";

/**
 * Gate every page on a valid session cookie.
 *
 * Runs on the Edge runtime, so it only verifies the signed token — it never
 * touches Postgres or the native argon2 binding. Route handlers and server
 * actions re-check the user against the database themselves.
 */

const PUBLIC_PATHS = ["/login", "/register", "/auth"];

export async function middleware(request: NextRequest) {
  const claims = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  const { pathname } = request.nextUrl;

  const isPublic =
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.includes(".");

  if (!claims && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    const res = NextResponse.redirect(url);
    // Drop a token that failed verification so it stops being re-sent.
    if (request.cookies.has(SESSION_COOKIE)) res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
    return res;
  }

  if (claims && (pathname === "/login" || pathname === "/register")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next({ request });

  // Slide the expiry forward for people who are actively using the app, so a
  // long session does not end mid-task.
  if (claims) {
    const remaining = claims.exp - Math.floor(Date.now() / 1000);
    if (remaining > 0 && remaining < SESSION_REFRESH_WITHIN_SECONDS) {
      const refreshed = await signSessionToken({
        id: claims.userId,
        email: claims.email,
        display_name: claims.displayName,
      });
      response.cookies.set(SESSION_COOKIE, refreshed, cookieOptions());
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
