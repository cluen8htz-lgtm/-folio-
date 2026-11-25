import { Hono, type Context } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { eq } from "drizzle-orm";
import type { DB } from "./db/client";
import { contacts } from "./db/schema";
import { env } from "./env";
import { appRouter } from "./routers";
import { createContextFactory, safeEqual } from "./trpc";
import { verifyTwilioSignature } from "./services/twilio";
import { handleInboundSms, handleStatusCallback } from "./services/inbound";
import { unsubscribeToken } from "./services/email";
import { audit } from "./services/outbox";

export function createApp(db: DB) {
  const app = new Hono();
  const createContext = createContextFactory(db);

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use(
    "/api/trpc/*",
    trpcServer({
      endpoint: "/api/trpc",
      router: appRouter,
      createContext: (opts, c) => createContext(c, opts.resHeaders),
    }),
  );

  /** Twilio posts form-encoded params; reject anything not signed by our account. */
  async function twilioParams(c: Context) {
    const form = await c.req.parseBody();
    const params = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]));
    const url = `${env.PUBLIC_URL}${new URL(c.req.url).pathname}`;
    if (env.TWILIO_AUTH_TOKEN) {
      if (!verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params, c.req.header("X-Twilio-Signature"))) return null;
    } else if (env.isProd) {
      return null;
    }
    return params;
  }

  app.post("/webhooks/twilio/inbound", async (c) => {
    const p = await twilioParams(c);
    if (!p) return c.text("invalid signature", 403);
    await handleInboundSms(db, p.From ?? "", p.Body ?? "", p.MessageSid ?? "");
    // Empty TwiML: replies come from people or approved drafts, never auto-generated here.
    return c.body("<Response></Response>", 200, { "Content-Type": "text/xml" });
  });

  app.post("/webhooks/twilio/status", async (c) => {
    const p = await twilioParams(c);
    if (!p) return c.text("invalid signature", 403);
    await handleStatusCallback(db, p.MessageSid ?? "", p.MessageStatus ?? "", p.ErrorCode);
    return c.body(null, 204);
  });

  const unsubscribe = async (contactId: number, token: string) => {
    if (!Number.isInteger(contactId) || !safeEqual(token, unsubscribeToken(contactId))) return false;
    await db.update(contacts).set({ optedOutEmail: true }).where(eq(contacts.id, contactId));
    await audit(db, "contact", "email.opt_out", `contact:${contactId}`);
    return true;
  };
  // GET shows a confirm button (link scanners prefetch GETs); POST unsubscribes.
  app.get("/webhooks/unsubscribe/:id/:token", (c) =>
    c.html(
      `<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem"><h1>Unsubscribe</h1><form method="post"><button style="padding:.6rem 1rem">Stop emailing me</button></form></body>`,
    ),
  );
  app.post("/webhooks/unsubscribe/:id/:token", async (c) => {
    const ok = await unsubscribe(Number(c.req.param("id")), c.req.param("token"));
    return c.html(ok ? "<p style='font-family:system-ui'>You're unsubscribed. You won't get more emails from us.</p>" : "Invalid link", ok ? 200 : 400);
  });

  return app;
}
