import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { contactNameForOwner, parseOwner } from "../server/core/owners";
import { parseSourceCsv } from "../server/connectors/miami-dade";
import { createDb, type DB } from "../server/db/client";
import { seedDefaults } from "../server/db/seed";
import { contacts, deals, employees, properties, signals } from "../server/db/schema";
import { ingest } from "../server/services/ingest";
import { buildDraftContext } from "../server/services/outbox";
import { templateDraft } from "../server/services/ai";
import { rowsToCsv } from "../web/src/lib/sheet";
import { parseCsv } from "../server/connectors/csv";

const fixture = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

describe("owner of record parsing", () => {
  it("separates deceased, living and trust parties", () => {
    expect(parseOwner("ALBERT TESTER EST OF & ROSA TESTER")).toEqual({
      deceased: ["Albert Tester"],
      living: ["Rosa Tester"],
      entities: [],
      isEstate: true,
    });
    const t = parseOwner("PAT EXAMPLE TRS & THE EXAMPLE FAMILY TRUST & LOU EXAMPLE EST OF");
    expect(t.living).toEqual(["Pat Example"]);
    expect(t.entities).toEqual(["The Example Family Trust"]);
    expect(t.deceased).toEqual(["Lou Example"]);
  });
  it("never picks the deceased owner as the contact", () => {
    expect(contactNameForOwner("ALBERT TESTER EST OF & ROSA TESTER")).toBe("Rosa Tester");
    expect(contactNameForOwner("JUAN TESTER JR & ANA TESTER EST OF")).toBe("Juan Tester Jr");
    expect(contactNameForOwner("HENRY SAMPLE EST OF")).toBe("Estate of Henry Sample");
    expect(contactNameForOwner("ESTATE OF HENRY SAMPLE")).toBe("Estate of Henry Sample");
  });
  it("still handles Clerk-style names and plain owners", () => {
    expect(contactNameForOwner("GARCIA, MARIA")).toBe("Maria Garcia");
    expect(contactNameForOwner("JOHN & MARY DOE")).toBe("John Doe");
    expect(parseOwner("JOHN DOE & MARY DOE").living).toEqual(["John Doe", "Mary Doe"]);
    expect(contactNameForOwner("SUNSET HOLDINGS LLC")).toBe("Sunset Holdings LLC");
  });
});

describe("estate-of-record list import", () => {
  it("maps the Property Appraiser curative list columns", () => {
    const r = parseSourceCsv("estate_roll", fixture("estate-roll.csv"));
    expect(r.skipped).toEqual([]);
    expect(r.records).toHaveLength(3);
    expect(r.records[0]).toMatchObject({
      folio: "3021340050120",
      type: "probate",
      source: "mdc-pa-estate-of-record",
      address: "77 SW 8TH AVE",
      zip: "33130",
      ownerName: "ALBERT TESTER EST OF & ROSA TESTER",
      mailingAddress: "12 ELM ST, NEWARK, NJ 07102",
      details: { description: "ESTATE OF RECORD", absentee: "Out-of-state absentee", countyId: "123456", listSource: "Synthetic test data" },
    });
    // No case number in this list: the dedupe key falls back to folio+type.
    expect(r.records[0]!.externalId).toBe("3021340050120:nodate:probate");
  });

  let db: DB;
  let close: () => Promise<void>;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-25T15:00:00Z") });
    ({ db, close } = await createDb({ memory: true }));
    await seedDefaults(db);
  });
  afterAll(async () => {
    vi.useRealTimers();
    await close();
  });

  it("creates leads addressed to the living co-owner, and never greets the deceased", async () => {
    const { records } = parseSourceCsv("estate_roll", fixture("estate-roll.csv"));
    const res = await ingest(db, "mdc-pa-estate-of-record", records);
    expect(res).toMatchObject({ created: 3, newDeals: 3 });
    expect((await ingest(db, "mdc-pa-estate-of-record", records)).created).toBe(0);

    const names = (await db.select({ name: contacts.name }).from(contacts)).map((c) => c.name).sort();
    expect(names).toEqual(["Estate of Henry Sample", "Pat Example", "Rosa Tester"]);

    const [ava] = await db.select().from(employees);
    const rows = await db.select({ deal: deals, contact: contacts }).from(deals).innerJoin(contacts, eq(contacts.id, deals.contactId));
    for (const { deal, contact } of rows) {
      const { ctx } = await buildDraftContext(db, { dealId: deal.id, employeeId: ava!.id, channel: "sms", goal: "intro" });
      expect(ctx.estate).toBe(true);
      const { body } = templateDraft(ctx);
      for (const dead of ["Albert", "Henry", "Lou"]) expect(body).not.toContain(dead);
      if (contact.name.startsWith("Estate of")) expect(body).toMatch(/^Hi, .*right person/);
      else expect(body.startsWith(`Hi ${contact.name.split(" ")[0]},`)).toBe(true);
      expect(body).not.toMatch(/\byour property\b/);
    }
  });

  it("scores the estate signal with absentee owners", async () => {
    const [p] = await db.select().from(properties).where(eq(properties.folio, "3021340050120"));
    // probate 25 + absentee 10 (mailing address differs)
    expect(p!.score).toBe(35);
    const [s] = await db.select().from(signals).where(eq(signals.propertyId, p!.id));
    expect(s!.details).toMatchObject({ tier: expect.stringContaining("TIER 1") });
  });
});

describe("spreadsheet to CSV", () => {
  it("round-trips cells, dates and commas", () => {
    const csv = rowsToCsv([
      ["Parcel ID (PIN)", "County REID", "Owner of Record", "Date"],
      ["01-3125-034-0010", 98765, 'A "B", C', new Date("2026-11-24T00:00:00Z")],
      [null, undefined, true, ""],
    ]);
    expect(parseCsv(csv)).toEqual([
      { "Parcel ID (PIN)": "01-3125-034-0010", "County REID": "98765", "Owner of Record": 'A "B", C', Date: "2026-11-24" },
      { "Parcel ID (PIN)": "", "County REID": "", "Owner of Record": "true", Date: "" },
    ]);
  });
});
