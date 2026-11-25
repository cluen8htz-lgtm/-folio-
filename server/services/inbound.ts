import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../db/client";
import { automationRuns, contacts, deals, messages, tasks } from "../db/schema";
import { normalizePhone } from "../core/normalize";
import { classifyKeyword } from "../core/compliance";
import { readInbound } from "./ai";
import { advanceStage, audit } from "./outbox";

/** Handles an inbound SMS from Twilio's webhook. */
export async function handleInboundSms(db: DB, from: string, body: string, providerId: string) {
  const phone = normalizePhone(from) ?? from;
  let [contact] = await db.select().from(contacts).where(eq(contacts.phone, phone));
  if (!contact) {
    [contact] = await db.insert(contacts).values({ name: phone, phone, phoneConsent: "inbound" }).returning();
  }
  const [deal] = await db.select().from(deals).where(eq(deals.contactId, contact!.id)).orderBy(desc(deals.createdAt)).limit(1);
  const [msg] = await db
    .insert(messages)
    .values({
      contactId: contact!.id,
      dealId: deal?.id,
      channel: "sms",
      direction: "inbound",
      status: "received",
      body,
      providerId,
    })
    .returning();

  const keyword = classifyKeyword(body);
  if (keyword === "stop") {
    await db.update(contacts).set({ optedOutSms: true }).where(eq(contacts.id, contact!.id));
    // Cancel anything queued for this person.
    await db
      .update(messages)
      .set({ status: "blocked", blockedReason: "Contact opted out." })
      .where(
        and(
          eq(messages.contactId, contact!.id),
          inArray(messages.status, ["pending_approval", "approved", "proposed"]),
        ),
      );
    if (deal) await db.update(automationRuns).set({ status: "stopped" }).where(eq(automationRuns.dealId, deal.id));
    await audit(db, "contact", "sms.opt_out", `contact:${contact!.id}`);
    return { contactId: contact!.id, optedOut: true };
  }
  if (keyword === "start") {
    await db.update(contacts).set({ optedOutSms: false }).where(eq(contacts.id, contact!.id));
  }

  // A reply makes it a conversation they're part of.
  if (contact!.phoneConsent === "none") {
    await db.update(contacts).set({ phoneConsent: "inbound" }).where(eq(contacts.id, contact!.id));
  }
  if (deal) await advanceStage(db, deal.id, "conversation", { onlyFrom: ["new", "contacted"] });

  let summary = `Reply from ${contact!.name}: "${body.slice(0, 120)}"`;
  try {
    const history = (
      await db.select().from(messages).where(eq(messages.contactId, contact!.id)).orderBy(desc(messages.createdAt)).limit(12)
    )
      .reverse()
      .filter((m) => m.id !== msg!.id)
      .map((m) => `${m.direction === "inbound" ? "OWNER" : "US"}: ${m.body}`)
      .join("\n");
    const read = await readInbound(body, history);
    if (read) {
      summary = `${contact!.name}: ${read.summary} (${read.intent.replace("_", " ")})`;
      if (deal) {
        if (read.askingPrice) await db.update(deals).set({ askingPrice: read.askingPrice }).where(eq(deals.id, deal.id));
        if (read.intent === "wrong_number" || read.intent === "not_interested") {
          await db.update(automationRuns).set({ status: "stopped" }).where(eq(automationRuns.dealId, deal.id));
        }
        // Stage suggestions only move a deal forward to an appointment, or to dead
        // on a clear no; anything else is left for a person.
        if (read.suggestedStage === "appointment") await advanceStage(db, deal.id, "appointment");
        if (read.intent === "wrong_number") await advanceStage(db, deal.id, "dead");
      }
    }
  } catch (err) {
    console.error("readInbound failed", err);
  }
  await db.insert(tasks).values({ dealId: deal?.id, title: `Reply needed: ${summary}` });
  return { contactId: contact!.id, optedOut: false };
}

export async function handleStatusCallback(db: DB, providerId: string, status: string, errorCode?: string) {
  const map: Record<string, "delivered" | "failed"> = { delivered: "delivered", failed: "failed", undelivered: "failed" };
  const next = map[status];
  if (!next) return;
  await db
    .update(messages)
    .set({ status: next, blockedReason: errorCode ? `Carrier error ${errorCode}` : null })
    .where(eq(messages.providerId, providerId));
}
