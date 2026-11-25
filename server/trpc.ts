import crypto from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context as HonoContext } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
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

export function createContextFactory(db: DB) {
  return (c: HonoContext) => ({
    db,
    authed: safeEqual(getCookie(c, SESSION_COOKIE) ?? "", sessionValue()),
    login: () =>
      setCookie(c, SESSION_COOKIE, sessionValue(), {
        httpOnly: true,
        sameSite: "Lax",
        secure: env.isProd,
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      }),
    logout: () => deleteCookie(c, SESSION_COOKIE, { path: "/" }),
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
