import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../server/db/client";
import { contacts, deals, messages } from "../server/db/schema";
import { parseSourceCsv } from "../server/connectors/miami-dade";
import { ingest } from "../server/services/ingest";
import { exportForSkipTrace, importSkipTrace, parseSkipTraceRow, rankPhones } from "../server/services/skiptrace";
import { parseCsv } from "../server/connectors/csv";
import { checkCompliance } from "../server/core/compliance";
import { sendManual } from "../server/services/outbox";

const fixture = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

describe("parseSkipTraceRow", () => {
  it("reads numbered phone slots with type and DNC, emails and litigator", () => {
    const [row] = parseCsv(fixture("vendor-skiptrace.csv"));
    const r = parseSkipTraceRow(row!);
    expect(r.phones).toEqual([
      { number: "+13055550300", type: "landline", dnc: false },
      { number: "+13055550301", type: "mobile", dnc: true },
      { number: "+13055550302", type: "mobile", dnc: false },
    ]);
    expect(r.emails).toEqual(["john@example.com", "john2@example.com"]);
    expect(r.litigator).toBe(false);
    expect(r.propertyAddress).toBe('77 SW 8th "A" Ave');
    expect(r.propertyZip).toBe("33130");
  });
  it("handles 'Phone 1' spelling and wireless/landline columns", () => {
    const r = parseSkipTraceRow({ "Wireless 1": "3055550001", "Landline 1": "3055550002", "Phone 2": "3055550003", "Phone 2 Type": "VOIP" });
    expect(r.phones.map((p) => [p.number.slice(-4), p.type])).toEqual([
      ["0001", "mobile"],
      ["0002", "landline"],
      ["0003", "voip"],
    ]);
  });
  it("ranks non-DNC mobiles first", () => {
    const [row] = parseCsv(fixture("vendor-skiptrace.csv"));
    expect(rankPhones(parseSkipTraceRow(row!).phones)[0]!.number).toBe("+13055550302");
  });
});

describe("compliance with litigators", () => {
  it("blocks texts to flagged litigators unless written consent", () => {
    const base = {
      channel: "sms" as const,
      now: new Date("2026-11-25T15:00:00Z"),
      timeZone: "America/New_York",
      consent: "inbound" as const,
      optedOut: false,
      onDncList: false,
      hasAddress: true,
      recentOutboundSms: [],
    };
    expect(checkCompliance({ ...base, isLitigator: true }).kind).toBe("block");
    expect(checkCompliance({ ...base, isLitigator: true, consent: "written" }).kind).toBe("ok");
  });
});

describe("skip-trace round trip", () => {
  let db: DB;
  let close: () => Promise<void>;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-25T15:00:00Z") });
    ({ db, close } = await createDb({ memory: true }));
    await ingest(db, "mdc-clerk-foreclosure", parseSourceCsv("foreclosure", fixture("foreclosures.csv")).records);
  });
  afterAll(async () => {
    vi.useRealTimers();
    await close();
  });

  it("exports leads without phones in vendor upload format", async () => {
    const { csv, count } = await exportForSkipTrace(db, { minScore: 0 });
    expect(count).toBe(2);
    const rows = parseCsv(csv);
    expect(rows[0]).toMatchObject({
      "First Name": "MARIA",
      "Last Name": "GARCIA",
      "Property Address": "123 NW 5TH ST",
      "Property State": "FL",
      // No zip in the source, so the line is left whole rather than guessed at.
      "Mailing Address": "PO BOX 99 ORLANDO FL",
      APN: "0131250340010",
    });
    expect((await exportForSkipTrace(db, { minScore: 80 })).count).toBe(0);
  });

  it("matches results by address+zip, picks the best phone, flags litigators", async () => {
    const r = await importSkipTrace(db, fixture("vendor-skiptrace.csv"));
    expect(r).toEqual({ rows: 3, matched: 2, withPhone: 2, litigators: 1, unmatched: 1 });
    const all = await db.select().from(contacts);
    const smith = all.find((c) => c.name === "John Smith")!;
    expect(smith.phone).toBe("+13055550302");
    expect(smith.phoneType).toBe("mobile");
    expect(smith.onDncList).toBe(false);
    expect(smith.altPhones.map((p) => p.number)).toEqual(["+13055550300", "+13055550301"]);
    expect(smith.email).toBe("john@example.com");
    const garcia = all.find((c) => c.name === "Maria Garcia")!;
    expect(garcia.isLitigator).toBe(true);
    expect((await exportForSkipTrace(db, { minScore: 0 })).count).toBe(0);
  });

  it("never texts a flagged litigator, even manually", async () => {
    const garcia = (await db.select().from(contacts)).find((c) => c.name === "Maria Garcia")!;
    const [deal] = await db.select().from(deals).where(eq(deals.contactId, garcia.id));
    const res = await sendManual(db, { contactId: garcia.id, dealId: deal!.id, channel: "sms", body: "Hi Maria" });
    expect(res).toEqual({ status: "blocked", reason: "Number is flagged as a known TCPA litigator." });
    const [m] = await db.select().from(messages).where(eq(messages.contactId, garcia.id));
    expect(m!.status).toBe("blocked");
  });

  it("keeps a number a person entered and adds results as alternates", async () => {
    const smith = (await db.select().from(contacts)).find((c) => c.name === "John Smith")!;
    await db.update(contacts).set({ phone: "+13055559999" }).where(eq(contacts.id, smith.id));
    await importSkipTrace(db, fixture("vendor-skiptrace.csv"));
    const [after] = await db.select().from(contacts).where(eq(contacts.id, smith.id));
    expect(after!.phone).toBe("+13055559999");
    expect(after!.altPhones[0]!.number).toBe("+13055550302");
  });
});
