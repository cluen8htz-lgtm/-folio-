import crypto from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context as HonoContext } from "hono";
import { getCookie } from "hono/cookie";
import type { DB } from "./db/client";
import { env } from "./env";

export const SESSION_COOKIE = "folio_session";

export function sessionValue(): string {
  return crypto.createHmac("sha256", env.APP_SECRET).update("folio-session-v1").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function cookie(value: string, maxAge: number): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(env.isProd ? ["Secure"] : []),
  ].join("; ");
}

/**
 * The tRPC fetch adapter builds its own Response, so cookies must go on
 * its resHeaders rather than on the Hono context.
 */
/**
 * Login throttling: 8 failed attempts per IP per 15 minutes. In memory,
 * which is fine for the single instance Folio runs as.
 */
const failures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;

export function loginBlocked(ip: string, now = Date.now()): boolean {
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= MAX_FAILURES;
}
export function recordLoginFailure(ip: string, now = Date.now()) {
  failures.set(ip, [...(failures.get(ip) ?? []), now]);
}
export function clearLoginFailures(ip: string) {
  failures.delete(ip);
}

function clientIp(c: HonoContext): string {
  // Railway and most hosts put the client first in X-Forwarded-For.
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
}

export function createContextFactory(db: DB) {
  return (c: HonoContext, resHeaders: Headers) => ({
    db,
    ip: clientIp(c),
    authed: safeEqual(getCookie(c, SESSION_COOKIE) ?? "", sessionValue()),
    login: () => resHeaders.append("Set-Cookie", cookie(sessionValue(), 60 * 60 * 24 * 30)),
    logout: () => resHeaders.append("Set-Cookie", cookie("", 0)),
  });
}

export type Context = ReturnType<ReturnType<typeof createContextFactory>>;

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.authed) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next();
});
