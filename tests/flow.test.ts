import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../server/db/client";
import { seedDefaults } from "../server/db/seed";
import { automationRuns, automations, contacts, deals, employees, messages, properties, signals } from "../server/db/schema";
import { parseSourceCsv } from "../server/connectors/miami-dade";
import { fetchCodeViolations } from "../server/connectors/miami-dade/code-violations";
import { ingest } from "../server/services/ingest";
import { importSkipTrace } from "../server/services/skiptrace";
import { approveMessage, requestOutreach } from "../server/services/outbox";
import { deliverDue, runDueAutomations } from "../server/jobs/automations";
import { handleInboundSms } from "../server/services/inbound";
import type { AutomationSpec } from "../server/core/automation-spec";

const fixture = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
// 10:00 in Miami.
const MORNING = new Date("2026-11-25T15:00:00Z");

let db: DB;
let close: () => Promise<void>;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: MORNING });
  ({ db, close } = await createDb({ memory: true }));
  await seedDefaults(db);
});
afterAll(async () => {
  vi.useRealTimers();
  await close();
});

describe("lead → outreach → reply", () => {
  it("imports foreclosure and tax lien exports, dedupes, and scores stacked signals", async () => {
    const fc = parseSourceCsv("foreclosure", fixture("foreclosures.csv"));
    expect(fc.records).toHaveLength(2);
    expect(fc.skipped).toEqual([{ row: 4, reason: "missing or invalid 13-digit folio" }]);
    expect(fc.records[1]!.address).toBe('77 SW 8TH "A" AVE');

    const r1 = await ingest(db, "mdc-clerk-foreclosure", fc.records);
    expect(r1).toMatchObject({ fetched: 2, created: 2, newDeals: 2 });
    const again = await ingest(db, "mdc-clerk-foreclosure", fc.records);
    expect(again.created).toBe(0);

    await ingest(db, "mdc-tax-collector", parseSourceCsv("tax_lien", fixture("tax-certs.csv")).records);
    const [garcia] = await db.select().from(properties).where(eq(properties.folio, "0131250340010"));
    // foreclosure 35 + tax lien 15 + recent 10 + $216k owed 15 + absentee 10
    expect(garcia!.score).toBe(85);
    expect(await db.select().from(signals).where(eq(signals.propertyId, garcia!.id))).toHaveLength(2);
    expect(await db.select().from(deals)).toHaveLength(2);
  });

  it("attaches skip-traced phones and DNC flags", async () => {
    const r = await importSkipTrace(db, fixture("skiptrace.csv"));
    expect(r).toEqual({ rows: 3, matched: 2, withPhone: 2, litigators: 0, unmatched: 1 });
    const all = await db.select().from(contacts);
    const smith = all.find((c) => c.name === "John Smith")!;
    expect(smith.phone).toBe("+13055550199");
    expect(smith.onDncList).toBe(true);
    expect(smith.phoneConsent).toBe("none");
  });

  it("blocks DNC numbers and forces a human on cold numbers even at 'act' trust", async () => {
    const [ava] = await db.select().from(employees);
    await db.update(employees).set({ trust: { ...ava!.trust, send_sms: "act" } }).where(eq(employees.id, ava!.id));
    const rows = await db.select({ deal: deals, contact: contacts }).from(deals).innerJoin(contacts, eq(contacts.id, deals.contactId));
    const smith = rows.find((r) => r.contact.name === "John Smith")!;
    const garcia = rows.find((r) => r.contact.name === "Maria Garcia")!;

    const blocked = await requestOutreach(db, { dealId: smith.deal.id, employeeId: ava!.id, channel: "sms", goal: "intro" });
    expect(blocked.outcome).toBe("blocked");

    const cold = await requestOutreach(db, { dealId: garcia.deal.id, employeeId: ava!.id, channel: "sms", goal: "intro" });
    expect(cold.outcome).toBe("queued_for_approval");
  });

  it("runs an automation: first text waits for approval, then sends; reply stops the drip", async () => {
    const step = { hours: null, channel: null, goal: null, stage: null, title: null };
    const spec: AutomationSpec = {
      name: "Foreclosure drip",
      trigger: { type: "deal_created", signalTypes: ["foreclosure"], stage: null, days: null, minScore: 50 },
      steps: [
        { ...step, type: "send", channel: "sms", goal: "Ask if they'd consider an offer" },
        { ...step, type: "wait", hours: 72 },
        { ...step, type: "stop_if_replied" },
        { ...step, type: "send", channel: "sms", goal: "Gentle follow-up" },
      ],
      summary: "",
      unsupported: [],
    };
    const [auto] = await db.insert(automations).values({ name: spec.name, plan: "test", spec, enabled: true }).returning();
    const [prop] = await db
      .insert(properties)
      .values({ folio: "3011110000010", address: "9 NE 1ST AVE", ownerName: "LEE, ANN", score: 0 })
      .returning();
    const records = parseSourceCsv(
      "foreclosure",
      `Case Number,Folio,Address,Owner,Filed Date,Amount\nX-1,3011110000010,9 NE 1ST AVE,"LEE, ANN",11/01/2026,300000`,
    ).records;
    await ingest(db, "mdc-clerk-foreclosure", records);
    const [deal] = await db.select().from(deals).where(eq(deals.propertyId, prop!.id));
    const [run] = await db.select().from(automationRuns).where(eq(automationRuns.dealId, deal!.id));
    expect(run!.automationId).toBe(auto!.id);

    // Give them a phone; consent stays "none", so the AI's first text needs approval.
    await db.update(contacts).set({ phone: "+13055550123" }).where(eq(contacts.id, deal!.contactId!));
    await runDueAutomations(db);
    const pending = await db.select().from(messages).where(eq(messages.dealId, deal!.id));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending_approval");
    expect(pending[0]!.body).toContain("Hi Ann,"); // template draft (no API key in tests)

    const sent = await approveMessage(db, pending[0]!.id, { body: "Hi Ann, this is Ava. Would you consider an offer on 9 NE 1st Ave?" });
    expect(sent.status).toBe("sent");
    expect((await db.select().from(deals).where(eq(deals.id, deal!.id)))[0]!.stage).toBe("contacted");

    // They reply before the follow-up is due.
    vi.setSystemTime(new Date(MORNING.getTime() + 3600_000));
    await handleInboundSms(db, "(305) 555-0123", "Maybe. What would you offer?", "SMin1");
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, deal!.contactId!));
    expect(contact!.phoneConsent).toBe("inbound");
    expect((await db.select().from(deals).where(eq(deals.id, deal!.id)))[0]!.stage).toBe("conversation");

    vi.setSystemTime(new Date(MORNING.getTime() + 73 * 3600_000));
    await runDueAutomations(db);
    const [after] = await db.select().from(automationRuns).where(eq(automationRuns.id, run!.id));
    expect(after!.status).toBe("stopped");
    expect(await db.select().from(messages).where(eq(messages.dealId, deal!.id))).toHaveLength(2); // 1 out, 1 in
  });

  it("holds approved texts until 8am and honors STOP", async () => {
    vi.setSystemTime(new Date("2026-11-29T02:00:00Z")); // 21:00 local
    const [deal] = await db.select().from(deals).innerJoin(contacts, eq(contacts.id, deals.contactId)).where(eq(contacts.phone, "+13055550123"));
    const [ava] = await db.select().from(employees);
    const r = await requestOutreach(db, { dealId: deal!.deals.id, employeeId: ava!.id, channel: "sms", goal: "Offer a call time" });
    expect(r.outcome).toBe("scheduled"); // act trust + inbound consent, but after hours
    await deliverDue(db);
    const id = (r as { messageId: number }).messageId;
    expect((await db.select().from(messages).where(eq(messages.id, id)))[0]!.status).toBe("approved");

    await handleInboundSms(db, "+13055550123", "STOP", "SMin2");
    vi.setSystemTime(new Date("2026-11-29T14:00:00Z")); // 9:00 local
    await deliverDue(db);
    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    expect(m!.status).toBe("blocked");
    expect(m!.blockedReason).toContain("opted out");
  });
});

describe("code violations connector", () => {
  it("pages through an ArcGIS layer", async () => {
    const pages = [
      { features: [{ attributes: { FOLIO: "0131250340010", CASE_NUM: "CV-1", ADDRESS: "123 NW 5TH ST", STATUS: "OPEN" } }, { attributes: { FOLIO: "", CASE_NUM: "CV-2" } }], exceededTransferLimit: true },
      { features: [{ attributes: { FOLIO: "3021340050120", CASE_NUM: "CV-3", OPEN_DATE: 1764000000000 } }] },
    ];
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(pages[urls.length - 1] ?? { features: [] }));
    }) as unknown as typeof fetch;
    const r = await fetchCodeViolations({ layerUrl: "https://example.test/arcgis/rest/services/X/FeatureServer/0", fetchImpl, pageSize: 2 });
    expect(r.fetched).toBe(3);
    expect(r.records.map((x) => x.externalId)).toEqual(["CV-1", "CV-3"]);
    expect(r.records[1]!.filedOn).toBe("2025-11-24");
    expect(urls[1]).toContain("resultOffset=2");
  });
});
