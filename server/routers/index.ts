import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router, safeEqual } from "../trpc";
import { env } from "../env";
import {
  ACTIONS,
  CONSENT_LEVELS,
  DEAL_STAGES,
  SIGNAL_TYPES,
  TRUST_LEVELS,
  automationRuns,
  automations,
  contacts,
  deals,
  employees,
  importRuns,
  memories,
  messages,
  properties,
  signals,
  tasks,
} from "../db/schema";
import { normalizePhone } from "../core/normalize";
import { promotionSuggestion } from "../core/trust";
import { AutomationSpecSchema, describeStep, validateSpec } from "../core/automation-spec";
import { aiEnabled, compilePlan, draftMessage } from "../services/ai";
import {
  advanceStage,
  approveMessage,
  audit,
  buildDraftContext,
  rejectMessage,
  requestOutreach,
  sendManual,
} from "../services/outbox";
import { ingest } from "../services/ingest";
import { exportForSkipTrace, importSkipTrace } from "../services/skiptrace";
import { FILE_SOURCES, parseSourceCsv } from "../connectors/miami-dade";
import { enrollDeal } from "../jobs/automations";
import { runDailyImports } from "../jobs/scheduler";
import { twilioConfigured } from "../services/twilio";

const id = z.number().int().positive();

const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ({ authed: ctx.authed })),
  login: publicProcedure.input(z.object({ password: z.string() })).mutation(({ ctx, input }) => {
    if (!safeEqual(input.password, env.APP_PASSWORD)) throw new TRPCError({ code: "UNAUTHORIZED", message: "Wrong password." });
    ctx.login();
    return { ok: true };
  }),
  logout: publicProcedure.mutation(({ ctx }) => {
    ctx.logout();
    return { ok: true };
  }),
});

const dashboardRouter = router({
  summary: protectedProcedure.query(async ({ ctx: { db } }) => {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [byStage, pending, sent24, openTasks, recentImports, hot] = await Promise.all([
      db.select({ stage: deals.stage, n: count() }).from(deals).groupBy(deals.stage),
      db.select({ n: count() }).from(messages).where(eq(messages.status, "pending_approval")),
      db
        .select({ n: count() })
        .from(messages)
        .where(and(inArray(messages.status, ["sent", "delivered"]), gte(messages.sentAt, since))),
      db.select({ n: count() }).from(tasks).where(eq(tasks.done, false)),
      db.select().from(importRuns).orderBy(desc(importRuns.startedAt)).limit(5),
      db
        .select({ dealId: deals.id, address: properties.address, score: properties.score, stage: deals.stage })
        .from(deals)
        .innerJoin(properties, eq(properties.id, deals.propertyId))
        .where(eq(deals.stage, "new"))
        .orderBy(desc(properties.score))
        .limit(8),
    ]);
    return {
      byStage: Object.fromEntries(byStage.map((r) => [r.stage, r.n])),
      pendingApprovals: pending[0]?.n ?? 0,
      sentLast24h: sent24[0]?.n ?? 0,
      openTasks: openTasks[0]?.n ?? 0,
      recentImports,
      hot,
      setup: {
        ai: aiEnabled(),
        twilio: twilioConfigured(),
        twilioDryRun: env.twilioDryRun,
        email: Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM),
        postalAddress: Boolean(env.BUSINESS_POSTAL_ADDRESS),
        liveCodeViolations: Boolean(env.MDC_CODE_VIOLATIONS_LAYER_URL),
      },
    };
  }),
});

const leadsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        stage: z.enum(DEAL_STAGES).optional(),
        signal: z.enum(SIGNAL_TYPES).optional(),
        minScore: z.number().int().min(0).max(100).default(0),
        hasPhone: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx: { db }, input }) => {
      const where: SQL[] = [gte(properties.score, input.minScore)];
      if (input.stage) where.push(eq(deals.stage, input.stage));
      if (input.search) {
        const q = `%${input.search}%`;
        where.push(or(ilike(properties.address, q), ilike(properties.ownerName, q), ilike(properties.folio, q))!);
      }
      if (input.signal) {
        where.push(sql`exists (select 1 from ${signals} where ${signals.propertyId} = ${properties.id} and ${signals.type} = ${input.signal})`);
      }
      if (input.hasPhone !== undefined) {
        where.push(input.hasPhone ? sql`${contacts.phone} is not null` : sql`${contacts.phone} is null`);
      }
      const rows = await db
        .select({
          dealId: deals.id,
          stage: deals.stage,
          folio: properties.folio,
          address: properties.address,
          city: properties.city,
          owner: properties.ownerName,
          score: properties.score,
          phone: contacts.phone,
          signals: sql<string[]>`(select coalesce(array_agg(distinct ${signals.type}), '{}') from ${signals} where ${signals.propertyId} = ${properties.id})`,
        })
        .from(deals)
        .innerJoin(properties, eq(properties.id, deals.propertyId))
        .leftJoin(contacts, eq(contacts.id, deals.contactId))
        .where(and(...where))
        .orderBy(desc(properties.score), desc(deals.id))
        .limit(input.limit)
        .offset(input.offset);
      return rows;
    }),

  get: protectedProcedure.input(z.object({ dealId: id })).query(async ({ ctx: { db }, input }) => {
    const [deal] = await db.select().from(deals).where(eq(deals.id, input.dealId));
    if (!deal) throw new TRPCError({ code: "NOT_FOUND" });
    const [[property], sigs, contact, msgs, openTasks, runs] = await Promise.all([
      db.select().from(properties).where(eq(properties.id, deal.propertyId)),
      db.select().from(signals).where(eq(signals.propertyId, deal.propertyId)).orderBy(desc(signals.filedOn)),
      deal.contactId ? db.select().from(contacts).where(eq(contacts.id, deal.contactId)).then((r) => r[0] ?? null) : null,
      deal.contactId
        ? db.select().from(messages).where(eq(messages.contactId, deal.contactId)).orderBy(asc(messages.createdAt))
        : [],
      db.select().from(tasks).where(and(eq(tasks.dealId, deal.id), eq(tasks.done, false))),
      db
        .select({ id: automationRuns.id, status: automationRuns.status, step: automationRuns.stepIndex, name: automations.name, nextRunAt: automationRuns.nextRunAt })
        .from(automationRuns)
        .innerJoin(automations, eq(automations.id, automationRuns.automationId))
        .where(eq(automationRuns.dealId, deal.id)),
    ]);
    return { deal, property: property!, signals: sigs, contact, messages: msgs, tasks: openTasks, runs };
  }),

  updateContact: protectedProcedure
    .input(
      z.object({
        contactId: id,
        name: z.string().min(1).optional(),
        phone: z.string().nullable().optional(),
        email: z.string().email().nullable().optional(),
        phoneConsent: z.enum(CONSENT_LEVELS).optional(),
        emailConsent: z.enum(CONSENT_LEVELS).optional(),
        onDncList: z.boolean().optional(),
        isLitigator: z.boolean().optional(),
        optedOutSms: z.boolean().optional(),
        optedOutEmail: z.boolean().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx: { db }, input }) => {
      const { contactId, phone, ...rest } = input;
      const patch: Record<string, unknown> = { ...rest };
      if (phone !== undefined) {
        const p = phone === null || phone === "" ? null : normalizePhone(phone);
        if (phone && !p) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a 10-digit US phone number." });
        patch.phone = p;
      }
      await db.update(contacts).set(patch).where(eq(contacts.id, contactId));
      await audit(db, "user", "contact.update", `contact:${contactId}`, { fields: Object.keys(patch) });
      return { ok: true };
    }),

  setStage: protectedProcedure.input(z.object({ dealId: id, stage: z.enum(DEAL_STAGES) })).mutation(async ({ ctx: { db }, input }) => {
    const changed = await advanceStage(db, input.dealId, input.stage);
    if (changed) await enrollDeal(db, input.dealId, { type: "stage_entered", stage: input.stage });
    if (input.stage === "dead" || input.stage === "closed") {
      await db.update(automationRuns).set({ status: "stopped" }).where(eq(automationRuns.dealId, input.dealId));
    }
    return { ok: true };
  }),

  updateDeal: protectedProcedure
    .input(z.object({ dealId: id, askingPrice: z.number().nullable().optional(), offerPrice: z.number().nullable().optional(), arv: z.number().nullable().optional() }))
    .mutation(async ({ ctx: { db }, input }) => {
      const { dealId, ...patch } = input;
      await db.update(deals).set(patch).where(eq(deals.id, dealId));
      return { ok: true };
    }),

  board: protectedProcedure.query(async ({ ctx: { db } }) => {
    return db
      .select({
        dealId: deals.id,
        stage: deals.stage,
        address: properties.address,
        owner: properties.ownerName,
        score: properties.score,
        askingPrice: deals.askingPrice,
        stageChangedAt: deals.stageChangedAt,
      })
      .from(deals)
      .innerJoin(properties, eq(properties.id, deals.propertyId))
      .where(sql`${deals.stage} <> 'new' or ${properties.score} >= 40`)
      .orderBy(desc(properties.score))
      .limit(500);
  }),
});

const messagesRouter = router({
  approvals: protectedProcedure.query(async ({ ctx: { db } }) => {
    return db
      .select({
        id: messages.id,
        channel: messages.channel,
        subject: messages.subject,
        body: messages.body,
        purpose: messages.purpose,
        sendAfter: messages.sendAfter,
        createdAt: messages.createdAt,
        dealId: messages.dealId,
        contactName: contacts.name,
        phoneConsent: contacts.phoneConsent,
        employeeName: employees.name,
      })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .leftJoin(employees, eq(employees.id, messages.employeeId))
      .where(eq(messages.status, "pending_approval"))
      .orderBy(asc(messages.createdAt));
  }),
  approve: protectedProcedure
    .input(z.object({ messageId: id, body: z.string().min(1).optional(), subject: z.string().nullable().optional() }))
    .mutation(({ ctx: { db }, input }) =>
      approveMessage(db, input.messageId, input.body !== undefined ? { body: input.body, subject: input.subject } : undefined),
    ),
  reject: protectedProcedure
    .input(z.object({ messageId: id, reason: z.string().optional() }))
    .mutation(({ ctx: { db }, input }) => rejectMessage(db, input.messageId, input.reason)),
  sendManual: protectedProcedure
    .input(z.object({ contactId: id, dealId: id.optional(), channel: z.enum(["sms", "email"]), body: z.string().min(1).max(1600), subject: z.string().optional() }))
    .mutation(({ ctx: { db }, input }) => sendManual(db, input)),
  /** A person asks an employee for a draft; always lands in the approval queue. */
  requestDraft: protectedProcedure
    .input(z.object({ dealId: id, employeeId: id, channel: z.enum(["sms", "email"]), goal: z.string().min(3) }))
    .mutation(async ({ ctx: { db }, input }) => {
      const { ctx: draftCtx, contactId } = await buildDraftContext(db, input);
      const draft = await draftMessage(draftCtx);
      const [m] = await db
        .insert(messages)
        .values({
          contactId,
          dealId: input.dealId,
          channel: input.channel,
          direction: "outbound",
          status: "pending_approval",
          subject: draft.subject,
          body: draft.body,
          purpose: input.goal,
          employeeId: input.employeeId,
        })
        .returning({ id: messages.id });
      return { messageId: m!.id };
    }),
  outreach: protectedProcedure
    .input(z.object({ dealId: id, employeeId: id, channel: z.enum(["sms", "email"]), goal: z.string().min(3) }))
    .mutation(({ ctx: { db }, input }) => requestOutreach(db, input)),
});

const trustShape = z.object(Object.fromEntries(ACTIONS.map((a) => [a, z.enum(TRUST_LEVELS)])) as Record<(typeof ACTIONS)[number], z.ZodEnum<{ ask: "ask"; draft: "draft"; act: "act" }>>);

const employeesRouter = router({
  list: protectedProcedure.query(async ({ ctx: { db } }) => {
    const rows = await db.select().from(employees).orderBy(asc(employees.id));
    return rows.map((e) => ({
      ...e,
      suggestions: ACTIONS.map((a) => ({ action: a, suggestion: promotionSuggestion(e.trust[a], e) })).filter((s) => s.suggestion),
    }));
  }),
  upsert: protectedProcedure
    .input(z.object({ id: id.optional(), name: z.string().min(1), role: z.string().min(1), instructions: z.string().default(""), trust: trustShape, active: z.boolean().default(true) }))
    .mutation(async ({ ctx: { db }, input }) => {
      const { id: eid, ...values } = input;
      if (eid) {
        await db.update(employees).set(values).where(eq(employees.id, eid));
        await audit(db, "user", "employee.update", `employee:${eid}`, { trust: values.trust });
        return { id: eid };
      }
      const [e] = await db.insert(employees).values(values).returning({ id: employees.id });
      return { id: e!.id };
    }),
});

const memoryRouter = router({
  list: protectedProcedure.query(({ ctx: { db } }) => db.select().from(memories).orderBy(desc(memories.createdAt))),
  add: protectedProcedure
    .input(z.object({ kind: z.enum(["preference", "fact", "playbook"]), content: z.string().min(3).max(2000) }))
    .mutation(async ({ ctx: { db }, input }) => {
      await db.insert(memories).values({ ...input, source: "user" });
      return { ok: true };
    }),
  remove: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx: { db }, input }) => {
    await db.delete(memories).where(eq(memories.id, input.id));
    return { ok: true };
  }),
});

const automationsRouter = router({
  list: protectedProcedure.query(async ({ ctx: { db } }) => {
    const rows = await db.select().from(automations).orderBy(desc(automations.createdAt));
    const stats = await db
      .select({ automationId: automationRuns.automationId, status: automationRuns.status, n: count() })
      .from(automationRuns)
      .groupBy(automationRuns.automationId, automationRuns.status);
    return rows.map((a) => {
      const spec = AutomationSpecSchema.safeParse(a.spec);
      return {
        ...a,
        steps: spec.success ? spec.data.steps.map(describeStep) : [],
        summary: spec.success ? spec.data.summary : "",
        runs: Object.fromEntries(stats.filter((s) => s.automationId === a.id).map((s) => [s.status, s.n])),
      };
    });
  }),
  compile: protectedProcedure.input(z.object({ plan: z.string().min(8).max(1000) })).mutation(async ({ input }) => {
    const spec = await compilePlan(input.plan);
    return { spec, steps: spec.steps.map(describeStep), errors: validateSpec(spec) };
  }),
  create: protectedProcedure
    .input(z.object({ plan: z.string(), spec: AutomationSpecSchema, employeeId: id.nullable() }))
    .mutation(async ({ ctx: { db }, input }) => {
      const errors = validateSpec(input.spec);
      if (errors.length) throw new TRPCError({ code: "BAD_REQUEST", message: errors.join(" ") });
      const [a] = await db
        .insert(automations)
        .values({ name: input.spec.name, plan: input.plan, spec: input.spec, employeeId: input.employeeId, enabled: false })
        .returning({ id: automations.id });
      return { id: a!.id };
    }),
  setEnabled: protectedProcedure.input(z.object({ id, enabled: z.boolean() })).mutation(async ({ ctx: { db }, input }) => {
    await db.update(automations).set({ enabled: input.enabled }).where(eq(automations.id, input.id));
    if (!input.enabled) {
      await db.update(automationRuns).set({ status: "stopped" }).where(and(eq(automationRuns.automationId, input.id), eq(automationRuns.status, "active")));
    }
    await audit(db, "user", input.enabled ? "automation.enable" : "automation.disable", `automation:${input.id}`);
    return { ok: true };
  }),
  remove: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx: { db }, input }) => {
    await db.delete(automations).where(eq(automations.id, input.id));
    return { ok: true };
  }),
});

const tasksRouter = router({
  list: protectedProcedure.query(({ ctx: { db } }) =>
    db
      .select({ id: tasks.id, title: tasks.title, dealId: tasks.dealId, proposal: tasks.proposal, employeeId: tasks.employeeId, createdAt: tasks.createdAt })
      .from(tasks)
      .where(eq(tasks.done, false))
      .orderBy(desc(tasks.createdAt))
      .limit(200),
  ),
  complete: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx: { db }, input }) => {
    await db.update(tasks).set({ done: true }).where(eq(tasks.id, input.id));
    return { ok: true };
  }),
  /** "Yes" to an ask-level proposal: the employee drafts it for approval. */
  acceptProposal: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx: { db }, input }) => {
    const [t] = await db.select().from(tasks).where(eq(tasks.id, input.id));
    if (!t?.proposal || !t.dealId || !t.employeeId) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a proposal." });
    const channel = t.proposal.payload.channel === "email" ? "email" : "sms";
    const goal = String(t.proposal.payload.goal ?? "Follow up");
    const { ctx: draftCtx, contactId } = await buildDraftContext(db, { dealId: t.dealId, employeeId: t.employeeId, channel, goal });
    const draft = await draftMessage(draftCtx);
    await db.insert(messages).values({
      contactId,
      dealId: t.dealId,
      channel,
      direction: "outbound",
      status: "pending_approval",
      subject: draft.subject,
      body: draft.body,
      purpose: goal,
      employeeId: t.employeeId,
    });
    const [e] = await db.select().from(employees).where(eq(employees.id, t.employeeId));
    if (e) await db.update(employees).set({ approvedCount: e.approvedCount + 1 }).where(eq(employees.id, e.id));
    await db.update(tasks).set({ done: true }).where(eq(tasks.id, t.id));
    return { ok: true };
  }),
});

const importsRouter = router({
  sources: protectedProcedure.query(() =>
    Object.entries(FILE_SOURCES).map(([type, s]) => ({ type: type as (typeof SIGNAL_TYPES)[number], ...s })),
  ),
  runs: protectedProcedure.query(({ ctx: { db } }) => db.select().from(importRuns).orderBy(desc(importRuns.startedAt)).limit(50)),
  preview: protectedProcedure
    .input(z.object({ type: z.enum(SIGNAL_TYPES), csv: z.string().max(20_000_000) }))
    .mutation(({ input }) => {
      const parsed = parseSourceCsv(input.type, input.csv);
      return { valid: parsed.records.length, sample: parsed.records.slice(0, 5), skipped: parsed.skipped.slice(0, 20), skippedCount: parsed.skipped.length };
    }),
  uploadCsv: protectedProcedure
    .input(z.object({ type: z.enum(SIGNAL_TYPES), csv: z.string().max(20_000_000) }))
    .mutation(async ({ ctx: { db }, input }) => {
      const parsed = parseSourceCsv(input.type, input.csv);
      const result = await ingest(db, FILE_SOURCES[input.type].source, parsed.records);
      return { ...result, skipped: parsed.skipped.length };
    }),
  skipTrace: protectedProcedure
    .input(z.object({ csv: z.string().max(20_000_000) }))
    .mutation(({ ctx: { db }, input }) => importSkipTrace(db, input.csv)),
  exportForSkipTrace: protectedProcedure
    .input(z.object({ minScore: z.number().int().min(0).max(100).default(0) }))
    .mutation(({ ctx: { db }, input }) => exportForSkipTrace(db, input)),
  runLive: protectedProcedure.mutation(async ({ ctx: { db } }) => {
    if (!env.MDC_CODE_VIOLATIONS_LAYER_URL) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MDC_CODE_VIOLATIONS_LAYER_URL is not set." });
    return runDailyImports(db);
  }),
});

export const appRouter = router({
  auth: authRouter,
  dashboard: dashboardRouter,
  leads: leadsRouter,
  messages: messagesRouter,
  employees: employeesRouter,
  memory: memoryRouter,
  automations: automationsRouter,
  tasks: tasksRouter,
  imports: importsRouter,
});

export type AppRouter = typeof appRouter;
