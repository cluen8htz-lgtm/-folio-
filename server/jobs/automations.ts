import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { DB } from "../db/client";
import { automationRuns, automations, deals, messages, properties, signals, tasks, employees } from "../db/schema";
import { AutomationSpecSchema, type AutomationSpec } from "../core/automation-spec";
import { advanceStage, deliver, requestOutreach } from "../services/outbox";

export type TriggerEvent = { type: "deal_created" } | { type: "stage_entered"; stage: string } | { type: "no_reply" };

function parseSpec(raw: unknown): AutomationSpec | null {
  const r = AutomationSpecSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Starts every enabled automation whose trigger matches this deal + event. */
export async function enrollDeal(db: DB, dealId: number, event: TriggerEvent) {
  const [deal] = await db.select().from(deals).where(eq(deals.id, dealId));
  if (!deal) return 0;
  const [prop] = await db.select().from(properties).where(eq(properties.id, deal.propertyId));
  const sigTypes = new Set(
    (await db.select({ type: signals.type }).from(signals).where(eq(signals.propertyId, deal.propertyId))).map((s) => s.type),
  );
  const autos = await db.select().from(automations).where(eq(automations.enabled, true));
  let enrolled = 0;
  for (const a of autos) {
    const spec = parseSpec(a.spec);
    if (!spec || spec.trigger.type !== event.type) continue;
    if ((prop?.score ?? 0) < spec.trigger.minScore) continue;
    if (event.type === "stage_entered" && spec.trigger.stage !== event.stage) continue;
    if (
      event.type === "deal_created" &&
      spec.trigger.signalTypes.length > 0 &&
      !spec.trigger.signalTypes.some((t) => sigTypes.has(t))
    )
      continue;
    const r = await db
      .insert(automationRuns)
      .values({ automationId: a.id, dealId })
      .onConflictDoNothing()
      .returning({ id: automationRuns.id });
    enrolled += r.length;
  }
  return enrolled;
}

/** Enrolls deals we messaged N+ days ago that haven't answered since. */
export async function enrollNoReply(db: DB, now = new Date()) {
  const autos = (await db.select().from(automations).where(eq(automations.enabled, true)))
    .map((a) => ({ a, spec: parseSpec(a.spec) }))
    .filter((x) => x.spec?.trigger.type === "no_reply");
  let enrolled = 0;
  for (const { a, spec } of autos) {
    const cutoff = new Date(now.getTime() - spec!.trigger.days! * 86400_000);
    const open = await db
      .select()
      .from(deals)
      .where(inArray(deals.stage, ["contacted", "conversation"]));
    for (const d of open) {
      if (!d.contactId) continue;
      const [last] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.contactId, d.contactId), inArray(messages.status, ["sent", "delivered", "received"])))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (!last || last.direction !== "outbound" || !last.sentAt || last.sentAt > cutoff) continue;
      const r = await db
        .insert(automationRuns)
        .values({ automationId: a.id, dealId: d.id })
        .onConflictDoNothing()
        .returning({ id: automationRuns.id });
      enrolled += r.length;
    }
  }
  return enrolled;
}

async function repliedSince(db: DB, contactId: number, since: Date) {
  const [m] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.contactId, contactId), eq(messages.direction, "inbound"), gt(messages.createdAt, since)))
    .limit(1);
  return Boolean(m);
}

/** Advances every due run until it hits a wait or finishes. */
export async function runDueAutomations(db: DB, now = new Date()) {
  const due = await db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.status, "active"), lte(automationRuns.nextRunAt, now)))
    .orderBy(asc(automationRuns.nextRunAt))
    .limit(100);
  let advanced = 0;
  for (const run of due) {
    const [auto] = await db.select().from(automations).where(eq(automations.id, run.automationId));
    const spec = auto && parseSpec(auto.spec);
    const [deal] = await db.select().from(deals).where(eq(deals.id, run.dealId));
    if (!auto || !spec || !auto.enabled || !deal) {
      await db.update(automationRuns).set({ status: "stopped" }).where(eq(automationRuns.id, run.id));
      continue;
    }
    if (deal.stage === "dead" || deal.stage === "closed") {
      await db.update(automationRuns).set({ status: "stopped" }).where(eq(automationRuns.id, run.id));
      continue;
    }
    let i = run.stepIndex;
    let status: "active" | "done" | "stopped" | "error" = "active";
    let nextRunAt = now;
    let lastError: string | null = null;
    try {
      while (i < spec.steps.length) {
        const step = spec.steps[i]!;
        i++;
        if (step.type === "wait") {
          nextRunAt = new Date(now.getTime() + (step.hours ?? 0) * 3600_000);
          break;
        }
        if (step.type === "stop_if_replied") {
          if (deal.contactId && (await repliedSince(db, deal.contactId, run.startedAt))) {
            status = "stopped";
            break;
          }
        } else if (step.type === "send") {
          const employeeId = auto.employeeId ?? (await defaultEmployeeId(db));
          if (!employeeId) throw new Error("No AI employee to send as.");
          await requestOutreach(db, {
            dealId: deal.id,
            employeeId,
            channel: step.channel!,
            goal: step.goal!,
            automationRunId: run.id,
          });
        } else if (step.type === "set_stage") {
          await advanceStage(db, deal.id, step.stage!);
        } else if (step.type === "create_task") {
          await db.insert(tasks).values({ dealId: deal.id, title: step.title!, employeeId: auto.employeeId });
        }
      }
      if (status === "active" && i >= spec.steps.length && nextRunAt <= now) status = "done";
    } catch (err) {
      status = "error";
      lastError = err instanceof Error ? err.message : String(err);
    }
    await db.update(automationRuns).set({ stepIndex: i, status, nextRunAt, lastError }).where(eq(automationRuns.id, run.id));
    advanced++;
  }
  return advanced;
}

async function defaultEmployeeId(db: DB): Promise<number | null> {
  const [e] = await db.select({ id: employees.id }).from(employees).where(eq(employees.active, true)).orderBy(asc(employees.id)).limit(1);
  return e?.id ?? null;
}

/** Sends approved messages whose send window has opened. */
export async function deliverDue(db: DB, now = new Date()) {
  const ready = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.status, "approved"), or(isNull(messages.sendAfter), lte(messages.sendAfter, now))))
    .limit(100);
  for (const m of ready) await deliver(db, m.id, now);
  return ready.length;
}
