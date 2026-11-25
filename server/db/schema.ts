import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  real,
  date,
} from "drizzle-orm/pg-core";

/** Distress signals the importers produce. */
export const SIGNAL_TYPES = ["foreclosure", "probate", "tax_lien", "code_violation"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const DEAL_STAGES = [
  "new",
  "contacted",
  "conversation",
  "appointment",
  "offer",
  "under_contract",
  "closed",
  "dead",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/**
 * Consent recorded for a phone number or email.
 * - none: we only have it from public records / skip tracing.
 * - inbound: the person contacted us first or replied (conversational).
 * - written: prior express written consent on file.
 */
export const CONSENT_LEVELS = ["none", "inbound", "written"] as const;
export type Consent = (typeof CONSENT_LEVELS)[number];

/** A parcel. Miami-Dade identifies parcels by a 13-digit folio number. */
export const properties = pgTable(
  "properties",
  {
    id: serial("id").primaryKey(),
    folio: text("folio").notNull(),
    address: text("address"),
    city: text("city"),
    zip: text("zip"),
    county: text("county").notNull().default("miami-dade"),
    ownerName: text("owner_name"),
    mailingAddress: text("mailing_address"),
    score: integer("score").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("properties_county_folio").on(t.county, t.folio)],
);

/** One distress record from a public source, attached to a property. */
export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    type: text("type").$type<SignalType>().notNull(),
    source: text("source").notNull(),
    /** Source's own identifier (case number, violation id); dedupes re-imports. */
    externalId: text("external_id").notNull(),
    filedOn: date("filed_on"),
    amount: real("amount"),
    status: text("status"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("signals_source_external").on(t.source, t.externalId)],
);

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").references(() => properties.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  phoneConsent: text("phone_consent").$type<Consent>().notNull().default("none"),
  emailConsent: text("email_consent").$type<Consent>().notNull().default("none"),
  optedOutSms: boolean("opted_out_sms").notNull().default(false),
  optedOutEmail: boolean("opted_out_email").notNull().default(false),
  onDncList: boolean("on_dnc_list").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deals = pgTable(
  "deals",
  {
    id: serial("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    stage: text("stage").$type<DealStage>().notNull().default("new"),
    askingPrice: real("asking_price"),
    offerPrice: real("offer_price"),
    arv: real("arv"),
    assignedEmployeeId: integer("assigned_employee_id"),
    stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("deals_property").on(t.propertyId)],
);

export const MESSAGE_STATUSES = [
  "proposed", // "ask" level: AI suggests reaching out; no text yet
  "pending_approval", // drafted, waiting for a human
  "approved", // approved, waiting for the send window
  "sent",
  "delivered",
  "failed",
  "rejected",
  "blocked", // compliance refused it
  "received", // inbound
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    dealId: integer("deal_id").references(() => deals.id, { onDelete: "set null" }),
    channel: text("channel").$type<"sms" | "email">().notNull(),
    direction: text("direction").$type<"outbound" | "inbound">().notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    subject: text("subject"),
    body: text("body").notNull().default(""),
    /** Why this message exists (automation goal or the human's note). */
    purpose: text("purpose"),
    employeeId: integer("employee_id"),
    automationRunId: integer("automation_run_id"),
    blockedReason: text("blocked_reason"),
    providerId: text("provider_id"),
    sendAfter: timestamp("send_after", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_contact").on(t.contactId), index("messages_status").on(t.status)],
);

export const TRUST_LEVELS = ["ask", "draft", "act"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export const ACTIONS = ["send_sms", "send_email", "set_stage", "create_task"] as const;
export type EmployeeAction = (typeof ACTIONS)[number];

/** An AI employee: a role, a voice, and a trust level per action. */
export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  instructions: text("instructions").notNull().default(""),
  trust: jsonb("trust")
    .$type<Record<EmployeeAction, TrustLevel>>()
    .notNull()
    .default({ send_sms: "draft", send_email: "draft", set_stage: "ask", create_task: "act" }),
  approvedCount: integer("approved_count").notNull().default(0),
  editedCount: integer("edited_count").notNull().default(0),
  rejectedCount: integer("rejected_count").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Team memory: how this team works. Fed into every draft. */
export const memories = pgTable("memories", {
  id: serial("id").primaryKey(),
  kind: text("kind").$type<"preference" | "fact" | "playbook" | "correction">().notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const automations = pgTable("automations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** The one-sentence plan the user typed. */
  plan: text("plan").notNull(),
  /** Validated AutomationSpec (see core/automation-spec.ts). */
  spec: jsonb("spec").notNull(),
  employeeId: integer("employee_id").references(() => employees.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: serial("id").primaryKey(),
    automationId: integer("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    dealId: integer("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull().default(0),
    status: text("status").$type<"active" | "done" | "stopped" | "error">().notNull().default("active"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("automation_runs_once").on(t.automationId, t.dealId),
    index("automation_runs_due").on(t.status, t.nextRunAt),
  ],
);

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** Set when an "ask"-level employee proposes an action for a human to OK. */
  proposal: jsonb("proposal").$type<{ action: EmployeeAction; payload: Record<string, unknown> } | null>(),
  employeeId: integer("employee_id"),
  done: boolean("done").notNull().default(false),
  dueAt: timestamp("due_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const importRuns = pgTable("import_runs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  status: text("status").$type<"running" | "ok" | "error">().notNull(),
  fetched: integer("fetched").notNull().default(0),
  created: integer("created").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  subject: text("subject"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
