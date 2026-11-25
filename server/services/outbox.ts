import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  auditLog,
  contacts,
  deals,
  employees,
  memories,
  messages,
  properties,
  signals,
  tasks,
  type DealStage,
} from "../db/schema";
import { env } from "../env";
import { checkCompliance, type ComplianceResult } from "../core/compliance";
import { decide } from "../core/trust";
import { draftMessage, lessonFromEdit, type DraftContext } from "./ai";
import { sendSms } from "./twilio";
import { emailFooter, sendEmail, unsubscribeUrl } from "./email";

/**
 * Every outbound message goes through here:
 *   draft → compliance → trust gate → (task | approval queue | send)
 * and every send re-checks compliance at the moment it goes out.
 */

export async function audit(db: DB, actor: string, action: string, subject: string, details: Record<string, unknown> = {}) {
  await db.insert(auditLog).values({ actor, action, subject, details });
}

async function complianceFor(db: DB, contactId: number, channel: "sms" | "email", now = new Date()): Promise<ComplianceResult> {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!c) return { kind: "block", reason: "Contact not found." };
  const since = new Date(now.getTime() - 24 * 3600_000);
  const recent =
    channel === "sms"
      ? await db
          .select({ sentAt: messages.sentAt })
          .from(messages)
          .where(
            and(
              eq(messages.contactId, contactId),
              eq(messages.channel, "sms"),
              eq(messages.direction, "outbound"),
              inArray(messages.status, ["sent", "delivered"]),
              gte(messages.sentAt, since),
            ),
          )
      : [];
  return checkCompliance({
    channel,
    now,
    timeZone: env.TEAM_TIMEZONE,
    consent: channel === "sms" ? c.phoneConsent : c.emailConsent,
    optedOut: channel === "sms" ? c.optedOutSms : c.optedOutEmail,
    onDncList: c.onDncList,
    isLitigator: c.isLitigator,
    hasAddress: Boolean(channel === "sms" ? c.phone : c.email),
    recentOutboundSms: recent.map((r) => r.sentAt!).filter(Boolean),
    businessPostalAddress: env.BUSINESS_POSTAL_ADDRESS,
  });
}

export async function buildDraftContext(
  db: DB,
  opts: { dealId: number; employeeId: number; channel: "sms" | "email"; goal: string },
): Promise<{ ctx: DraftContext; contactId: number }> {
  const [deal] = await db.select().from(deals).where(eq(deals.id, opts.dealId));
  if (!deal?.contactId) throw new Error("Deal has no contact.");
  const [[contact], [property], [employee]] = await Promise.all([
    db.select().from(contacts).where(eq(contacts.id, deal.contactId)),
    db.select().from(properties).where(eq(properties.id, deal.propertyId)),
    db.select().from(employees).where(eq(employees.id, opts.employeeId)),
  ]);
  if (!contact || !property || !employee) throw new Error("Missing contact, property or employee.");
  const [sigs, mems, history] = await Promise.all([
    db.select().from(signals).where(eq(signals.propertyId, property.id)),
    db.select().from(memories).orderBy(desc(memories.createdAt)).limit(40),
    db
      .select()
      .from(messages)
      .where(and(eq(messages.contactId, contact.id), inArray(messages.status, ["sent", "delivered", "received"])))
      .orderBy(desc(messages.createdAt))
      .limit(30),
  ]);
  return {
    contactId: contact.id,
    ctx: {
      employee,
      teamName: env.TEAM_NAME,
      memories: mems.map((m) => m.content),
      contact: { name: contact.name },
      property: {
        address: property.address,
        city: property.city,
        signals: sigs.map((s) => `${s.type}${s.filedOn ? ` filed ${s.filedOn}` : ""}`),
      },
      history: history.reverse().map((m) => ({
        direction: m.direction,
        channel: m.channel,
        body: m.body,
        at: m.createdAt.toISOString().slice(0, 16),
      })),
      channel: opts.channel,
      goal: opts.goal,
    },
  };
}

export type OutreachResult =
  | { outcome: "blocked"; reason: string; messageId: number }
  | { outcome: "proposed"; taskId: number }
  | { outcome: "queued_for_approval"; messageId: number }
  | { outcome: "scheduled"; messageId: number; sendAfter: Date }
  | { outcome: "sent"; messageId: number };

/** An AI employee wants to message a deal's contact. */
export async function requestOutreach(
  db: DB,
  opts: { dealId: number; employeeId: number; channel: "sms" | "email"; goal: string; automationRunId?: number },
): Promise<OutreachResult> {
  const [employee] = await db.select().from(employees).where(eq(employees.id, opts.employeeId));
  if (!employee) throw new Error("Employee not found.");
  const [deal] = await db.select().from(deals).where(eq(deals.id, opts.dealId));
  if (!deal?.contactId) throw new Error("Deal has no contact.");

  const compliance = await complianceFor(db, deal.contactId, opts.channel);
  if (compliance.kind === "block") {
    const [m] = await db
      .insert(messages)
      .values({
        contactId: deal.contactId,
        dealId: deal.id,
        channel: opts.channel,
        direction: "outbound",
        status: "blocked",
        purpose: opts.goal,
        employeeId: employee.id,
        automationRunId: opts.automationRunId,
        blockedReason: compliance.reason,
      })
      .returning({ id: messages.id });
    return { outcome: "blocked", reason: compliance.reason, messageId: m!.id };
  }

  const action = opts.channel === "sms" ? "send_sms" : "send_email";
  const decision = decide(employee.trust[action], {
    requiresHuman: compliance.kind === "ok" && compliance.requiresHuman,
  });

  if (decision === "propose") {
    const [t] = await db
      .insert(tasks)
      .values({
        dealId: deal.id,
        employeeId: employee.id,
        title: `${employee.name} suggests a ${opts.channel === "sms" ? "text" : "email"}: ${opts.goal}`,
        proposal: { action, payload: { goal: opts.goal, channel: opts.channel } },
      })
      .returning({ id: tasks.id });
    return { outcome: "proposed", taskId: t!.id };
  }

  const { ctx } = await buildDraftContext(db, opts);
  const draft = await draftMessage(ctx);
  const sendAfter = compliance.kind === "defer" ? compliance.until : null;

  if (decision === "draft") {
    const [m] = await db
      .insert(messages)
      .values({
        contactId: deal.contactId,
        dealId: deal.id,
        channel: opts.channel,
        direction: "outbound",
        status: "pending_approval",
        subject: draft.subject,
        body: draft.body,
        purpose: opts.goal,
        employeeId: employee.id,
        automationRunId: opts.automationRunId,
        sendAfter,
      })
      .returning({ id: messages.id });
    return { outcome: "queued_for_approval", messageId: m!.id };
  }

  const [m] = await db
    .insert(messages)
    .values({
      contactId: deal.contactId,
      dealId: deal.id,
      channel: opts.channel,
      direction: "outbound",
      status: "approved",
      subject: draft.subject,
      body: draft.body,
      purpose: opts.goal,
      employeeId: employee.id,
      automationRunId: opts.automationRunId,
      sendAfter,
    })
    .returning({ id: messages.id });
  if (sendAfter) return { outcome: "scheduled", messageId: m!.id, sendAfter };
  await deliver(db, m!.id);
  return { outcome: "sent", messageId: m!.id };
}

/** A person approves a pending draft (optionally edited). */
export async function approveMessage(db: DB, messageId: number, edited?: { body: string; subject?: string | null }) {
  const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!m || m.status !== "pending_approval") throw new Error("Message is not waiting for approval.");
  const changed = edited !== undefined && edited.body.trim() !== m.body.trim();
  await db
    .update(messages)
    .set({ status: "approved", body: edited?.body ?? m.body, subject: edited?.subject ?? m.subject })
    .where(eq(messages.id, messageId));
  if (m.employeeId) {
    const [e] = await db.select().from(employees).where(eq(employees.id, m.employeeId));
    if (e) {
      await db
        .update(employees)
        .set(changed ? { editedCount: e.editedCount + 1 } : { approvedCount: e.approvedCount + 1 })
        .where(eq(employees.id, e.id));
    }
  }
  await audit(db, "user", changed ? "message.approved_with_edits" : "message.approved", `message:${messageId}`);
  if (changed) {
    // Learn from the edit in the background; a failure here must not block sending.
    void lessonFromEdit(m.body, edited!.body)
      .then((lesson) => (lesson ? db.insert(memories).values({ kind: "correction", content: lesson, source: "edit" }) : null))
      .catch((err) => console.error("lessonFromEdit failed", err));
  }
  return deliver(db, messageId);
}

export async function rejectMessage(db: DB, messageId: number, reason?: string) {
  const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!m || m.status !== "pending_approval") throw new Error("Message is not waiting for approval.");
  await db.update(messages).set({ status: "rejected", blockedReason: reason ?? null }).where(eq(messages.id, messageId));
  if (m.employeeId) {
    const [e] = await db.select().from(employees).where(eq(employees.id, m.employeeId));
    if (e) await db.update(employees).set({ rejectedCount: e.rejectedCount + 1 }).where(eq(employees.id, e.id));
  }
  if (reason?.trim()) await db.insert(memories).values({ kind: "correction", content: reason.trim(), source: "rejection" });
  await audit(db, "user", "message.rejected", `message:${messageId}`, { reason });
}

/** A person writes and sends a message themselves. */
export async function sendManual(
  db: DB,
  opts: { contactId: number; dealId?: number; channel: "sms" | "email"; body: string; subject?: string },
) {
  const [m] = await db
    .insert(messages)
    .values({
      contactId: opts.contactId,
      dealId: opts.dealId,
      channel: opts.channel,
      direction: "outbound",
      status: "approved",
      body: opts.body,
      subject: opts.subject ?? (opts.channel === "email" ? "About your property" : null),
      purpose: "manual",
    })
    .returning({ id: messages.id });
  return deliver(db, m!.id);
}

/**
 * Sends an approved message if compliance still allows it right now;
 * otherwise defers it or blocks it. Safe to call repeatedly.
 */
export async function deliver(db: DB, messageId: number, now = new Date()): Promise<{ status: string; reason?: string }> {
  const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!m || m.status !== "approved") return { status: m?.status ?? "missing" };
  if (m.sendAfter && m.sendAfter > now) return { status: "approved", reason: "waiting for send window" };

  const compliance = await complianceFor(db, m.contactId, m.channel, now);
  if (compliance.kind === "block") {
    await db.update(messages).set({ status: "blocked", blockedReason: compliance.reason }).where(eq(messages.id, m.id));
    return { status: "blocked", reason: compliance.reason };
  }
  if (compliance.kind === "defer") {
    await db.update(messages).set({ sendAfter: compliance.until }).where(eq(messages.id, m.id));
    return { status: "approved", reason: compliance.reason };
  }

  const [c] = await db.select().from(contacts).where(eq(contacts.id, m.contactId));
  try {
    const result =
      m.channel === "sms"
        ? await sendSms(c!.phone!, m.body)
        : await sendEmail(c!.email!, m.subject ?? "About your property", m.body + emailFooter(unsubscribeUrl(c!.id)));
    await db
      .update(messages)
      .set({ status: "sent", providerId: result.providerId, sentAt: now })
      .where(eq(messages.id, m.id));
    if (m.dealId) await advanceStage(db, m.dealId, "contacted", { onlyFrom: ["new"] });
    return { status: "sent" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db.update(messages).set({ status: "failed", blockedReason: reason }).where(eq(messages.id, m.id));
    return { status: "failed", reason };
  }
}

export async function advanceStage(db: DB, dealId: number, stage: DealStage, opts: { onlyFrom?: DealStage[] } = {}) {
  const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
  if (!d || d.stage === stage) return false;
  if (opts.onlyFrom && !opts.onlyFrom.includes(d.stage)) return false;
  await db.update(deals).set({ stage, stageChangedAt: new Date() }).where(eq(deals.id, dealId));
  await audit(db, "system", "deal.stage", `deal:${dealId}`, { from: d.stage, to: stage });
  return true;
}
