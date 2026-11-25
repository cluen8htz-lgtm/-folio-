import { describe, expect, it } from "vitest";
import { checkCompliance, classifyKeyword, nextWindowStart, type ComplianceInput } from "../server/core/compliance";
import { decide, promotionSuggestion } from "../server/core/trust";
import { isAbsentee, scoreProperty } from "../server/core/scoring";
import { normalizeDate, normalizeFolio, normalizePhone, parseMoney } from "../server/core/normalize";
import { validateSpec, type AutomationSpec } from "../server/core/automation-spec";
import { parseCsv, pick } from "../server/connectors/csv";
import { computeTwilioSignature, verifyTwilioSignature } from "../server/services/twilio";

const TZ = "America/New_York";
// 2026-11-25 15:00 UTC = 10:00 in Miami (EST, UTC-5)
const MORNING = new Date("2026-11-25T15:00:00Z");
const NIGHT = new Date("2026-11-26T02:30:00Z"); // 21:30 local

const base: ComplianceInput = {
  channel: "sms",
  now: MORNING,
  timeZone: TZ,
  consent: "inbound",
  optedOut: false,
  onDncList: false,
  hasAddress: true,
  recentOutboundSms: [],
  businessPostalAddress: "1 Main St, Miami FL",
};

describe("compliance", () => {
  it("allows a conversational text in the daytime without a human", () => {
    expect(checkCompliance(base)).toEqual({ kind: "ok", requiresHuman: false, notes: [] });
  });
  it("requires a human for numbers with no consent", () => {
    const r = checkCompliance({ ...base, consent: "none" });
    expect(r.kind === "ok" && r.requiresHuman).toBe(true);
  });
  it("blocks opted-out contacts and DNC numbers without consent", () => {
    expect(checkCompliance({ ...base, optedOut: true }).kind).toBe("block");
    expect(checkCompliance({ ...base, consent: "none", onDncList: true }).kind).toBe("block");
    expect(checkCompliance({ ...base, consent: "written", onDncList: true }).kind).toBe("ok");
  });
  it("defers texts after 8pm to 8am local", () => {
    const r = checkCompliance({ ...base, now: NIGHT });
    expect(r.kind).toBe("defer");
    if (r.kind === "defer") expect(r.until.toISOString()).toBe("2026-11-26T13:00:00.000Z");
  });
  it("enforces 3 texts per 24h", () => {
    const sent = [1, 2, 3].map((h) => new Date(MORNING.getTime() - h * 3600_000));
    const r = checkCompliance({ ...base, recentOutboundSms: sent });
    expect(r.kind).toBe("defer");
    if (r.kind === "defer") expect(r.until.getTime()).toBeGreaterThan(MORNING.getTime() + 20 * 3600_000);
  });
  it("requires a postal address for email", () => {
    expect(checkCompliance({ ...base, channel: "email", businessPostalAddress: null }).kind).toBe("block");
    expect(checkCompliance({ ...base, channel: "email", now: NIGHT }).kind).toBe("ok");
  });
  it("computes the next window from early morning", () => {
    const early = new Date("2026-11-25T10:15:00Z"); // 05:15 local
    expect(nextWindowStart(early, TZ).toISOString()).toBe("2026-11-25T13:00:00.000Z");
  });
  it("recognizes opt-out and opt-in keywords", () => {
    expect(classifyKeyword(" STOP ")).toBe("stop");
    expect(classifyKeyword("Unsubscribe.")).toBe("stop");
    expect(classifyKeyword("please remove me from your list")).toBe("stop");
    expect(classifyKeyword("START")).toBe("start");
    expect(classifyKeyword("Maybe, what would you offer?")).toBeNull();
    expect(classifyKeyword("don't stop believing")).toBeNull();
  });
});

describe("trust", () => {
  it("maps levels to decisions and never auto-sends when a human is required", () => {
    expect(decide("ask", { requiresHuman: false })).toBe("propose");
    expect(decide("draft", { requiresHuman: false })).toBe("draft");
    expect(decide("act", { requiresHuman: false })).toBe("execute");
    expect(decide("act", { requiresHuman: true })).toBe("draft");
  });
  it("suggests promotion only with a clean record", () => {
    expect(promotionSuggestion("draft", { approvedCount: 10, editedCount: 0, rejectedCount: 0 })).toBeNull();
    expect(promotionSuggestion("draft", { approvedCount: 28, editedCount: 2, rejectedCount: 0 })?.to).toBe("act");
    expect(promotionSuggestion("draft", { approvedCount: 20, editedCount: 8, rejectedCount: 2 })).toBeNull();
    expect(promotionSuggestion("act", { approvedCount: 100, editedCount: 0, rejectedCount: 0 })).toBeNull();
  });
});

describe("scoring", () => {
  const now = new Date("2026-11-25");
  it("stacks distinct signals and caps at 100", () => {
    const one = scoreProperty([{ type: "code_violation", filedOn: "2020-01-01", amount: null }], { absentee: false, now });
    expect(one.score).toBe(10);
    const stacked = scoreProperty(
      [
        { type: "foreclosure", filedOn: "2026-10-02", amount: 212400 },
        { type: "tax_lien", filedOn: "2025-06-01", amount: 4120 },
        { type: "code_violation", filedOn: null, amount: null },
        { type: "probate", filedOn: null, amount: null },
      ],
      { absentee: true, now },
    );
    expect(stacked.score).toBe(100);
    expect(stacked.reasons.join(" ")).toContain("absentee");
  });
  it("detects absentee owners", () => {
    expect(isAbsentee("123 NW 5TH ST", "PO BOX 99 ORLANDO FL")).toBe(true);
    expect(isAbsentee("123 NW 5TH ST", "123 NW 5th St, Miami FL")).toBe(false);
    expect(isAbsentee(null, "x")).toBe(false);
  });
});

describe("normalize", () => {
  it("handles folios, phones, dates and money", () => {
    expect(normalizeFolio("01-3125-034-0010")).toBe("0131250340010");
    expect(normalizeFolio("131250340010")).toBe("0131250340010");
    expect(normalizeFolio("123")).toBeNull();
    expect(normalizePhone("(305) 555-0101")).toBe("+13055550101");
    expect(normalizePhone("1-305-555-0101")).toBe("+13055550101");
    expect(normalizePhone("555-0101")).toBeNull();
    expect(normalizeDate("10/2/2026")).toBe("2026-10-02");
    expect(normalizeDate("2026-10-02T00:00:00")).toBe("2026-10-02");
    expect(parseMoney("$212,400.00")).toBe(212400);
  });
});

describe("csv", () => {
  it("parses quotes, escaped quotes and CRLF", () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2');
    expect(rows).toEqual([{ a: "x, y", b: 'say "hi"' }, { a: "1", b: "2" }]);
  });
  it("picks columns by loose name", () => {
    expect(pick({ "Folio Number": "1" }, ["folio_number"])).toBe("1");
    expect(pick({ FOLIO: "" , Parcel: "2" }, ["folio", "parcel"])).toBe("2");
  });
});

describe("automation spec validation", () => {
  const step = { hours: null, channel: null, goal: null, stage: null, title: null };
  const spec = (steps: AutomationSpec["steps"]): AutomationSpec => ({
    name: "t",
    trigger: { type: "deal_created", signalTypes: [], stage: null, days: null, minScore: 0 },
    steps,
    summary: "",
    unsupported: [],
  });
  it("accepts a spaced drip", () => {
    expect(
      validateSpec(
        spec([
          { ...step, type: "send", channel: "sms", goal: "intro" },
          { ...step, type: "wait", hours: 72 },
          { ...step, type: "stop_if_replied" },
          { ...step, type: "send", channel: "sms", goal: "follow up" },
        ]),
      ),
    ).toEqual([]);
  });
  it("rejects missing fields and rapid-fire sends", () => {
    const errs = validateSpec(
      spec([
        { ...step, type: "send", channel: "sms", goal: "a" },
        { ...step, type: "wait", hours: 1 },
        { ...step, type: "send", channel: null, goal: "" },
      ]),
    );
    expect(errs.some((e) => e.includes("channel"))).toBe(true);
    expect(errs.some((e) => e.includes("a day apart"))).toBe(true);
  });
});

describe("twilio signature", () => {
  it("verifies its own signature and rejects tampering", () => {
    const params = { From: "+13055550101", Body: "Hi", MessageSid: "SM1" };
    const url = "https://example.com/webhooks/twilio/inbound";
    const sig = computeTwilioSignature("token", url, params);
    expect(verifyTwilioSignature("token", url, params, sig)).toBe(true);
    expect(verifyTwilioSignature("token", url, { ...params, Body: "Hi!" }, sig)).toBe(false);
    expect(verifyTwilioSignature("other", url, params, sig)).toBe(false);
    expect(verifyTwilioSignature("token", url, params, undefined)).toBe(false);
  });
});

import { personName } from "../server/core/normalize";
describe("personName", () => {
  it("reorders people and leaves entities whole", () => {
    expect(personName("GARCIA, MARIA")).toBe("Maria Garcia");
    expect(personName("MCDONALD, JOHN R & MARY")).toBe("John McDonald");
    expect(personName("SUNSET HOLDINGS LLC")).toBe("Sunset Holdings LLC");
    expect(personName("ESTATE OF JOHN SMITH")).toBe("Estate of John Smith");
    expect(personName("  ")).toBeNull();
  });
});
