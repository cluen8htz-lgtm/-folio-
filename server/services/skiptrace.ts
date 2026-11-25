import { eq, isNull, and, desc } from "drizzle-orm";
import type { DB } from "../db/client";
import { contacts, deals, properties } from "../db/schema";
import { normalizeFolio, normalizePhone } from "../core/normalize";
import { parseCsv, pick } from "../connectors/csv";

/**
 * Skip-trace vendors (PropStream, REISkip, BatchData, DirectSkip, …) all
 * export roughly the same shape: an input property/owner block, then
 * numbered phone slots ("Phone 1", "Phone 1 Type", "Phone 1 DNC", …),
 * numbered emails, and sometimes a litigator flag. Header spellings vary,
 * so every field accepts several names, matched loosely.
 */

export type PhoneType = "mobile" | "landline" | "voip" | "unknown";
export interface TracedPhone {
  number: string;
  type: PhoneType;
  dnc: boolean;
}
export interface TracedRow {
  folio: string | null;
  propertyAddress: string | null;
  propertyZip: string | null;
  phones: TracedPhone[];
  emails: string[];
  litigator: boolean;
}

const MAX_SLOTS = 10;
const YES = /^(y|yes|true|1|x|dnc|on dnc|litigator)$/i;

function phoneType(raw: string | null): PhoneType {
  const t = (raw ?? "").toLowerCase();
  if (/(mobile|wireless|cell)/.test(t)) return "mobile";
  if (/(land|residential|fixed)/.test(t)) return "landline";
  if (/voip/.test(t)) return "voip";
  return "unknown";
}

function slot(n: number, base: string[], suffixes: string[]): string[] {
  const out: string[] = [];
  for (const b of base) {
    for (const s of suffixes) {
      out.push(`${b} ${n}${s ? ` ${s}` : ""}`, `${b}${n}${s ? ` ${s}` : ""}`, `${b}${n}${s}`);
      if (s) out.push(`${b} ${s} ${n}`, `${b}_${n}_${s}`);
    }
  }
  return out;
}

export function parseSkipTraceRow(row: Record<string, string>): TracedRow {
  const phones: TracedPhone[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null, type: string | null, dnc: string | null) => {
    const number = normalizePhone(raw);
    if (!number || seen.has(number)) return;
    seen.add(number);
    phones.push({ number, type: phoneType(type), dnc: YES.test((dnc ?? "").trim()) });
  };

  // Numbered slots: Phone 1 / Phone1 / Mobile 1 / Wireless 1 / Landline 1 …
  const bases = ["phone", "mobile", "wireless", "cell", "landline", "phone number"];
  for (let n = 1; n <= MAX_SLOTS; n++) {
    for (const b of bases) {
      const number = pick(row, slot(n, [b], [""]));
      if (!number) continue;
      const type = pick(row, slot(n, [b], ["type", "line type", "phone type"])) ?? (b === "phone" || b === "phone number" ? null : b);
      const dnc = pick(row, slot(n, [b], ["dnc", "do not call", "dnc status"]));
      add(number, type, dnc);
    }
  }
  // Single-column exports.
  add(pick(row, ["phone", "phone number", "best phone", "mobile", "cell", "cell phone"]), pick(row, ["phone type", "line type"]), pick(row, ["dnc", "phone dnc", "do not call"]));

  const emails: string[] = [];
  for (let n = 0; n <= MAX_SLOTS; n++) {
    const e = n === 0 ? pick(row, ["email", "email address", "best email"]) : pick(row, slot(n, ["email"], [""]));
    if (e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !emails.includes(e.toLowerCase())) emails.push(e.toLowerCase());
  }

  return {
    folio: normalizeFolio(pick(row, ["folio", "folio number", "apn", "parcel", "parcel id", "parcel number", "input apn"])),
    propertyAddress: pick(row, ["property address", "input property address", "property street", "site address", "address", "input address"]),
    propertyZip: pick(row, ["property zip", "input property zip", "property zip code", "zip", "zip code", "input zip"]),
    phones,
    emails,
    litigator: YES.test(pick(row, ["litigator", "tcpa litigator", "known litigator", "litigator flag", "is litigator"]) ?? ""),
  };
}

const TYPE_RANK: Record<PhoneType, number> = { mobile: 0, unknown: 1, voip: 2, landline: 3 };

/** Best number to text: not on DNC, mobile first, vendor order otherwise. */
export function rankPhones(phones: TracedPhone[]): TracedPhone[] {
  return phones
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(a.p.dnc) - Number(b.p.dnc) || TYPE_RANK[a.p.type] - TYPE_RANK[b.p.type] || a.i - b.i)
    .map((x) => x.p);
}

/** Street key for matching rows without a folio: "123 NW 5TH ST" → "123NW5THST". */
function streetKey(s: string | null): string | null {
  if (!s) return null;
  const k = s.toUpperCase().split(",")[0]!.replace(/[^A-Z0-9]/g, "");
  return k.length >= 5 ? k : null;
}

export async function importSkipTrace(db: DB, csv: string) {
  const rows = parseCsv(csv);
  let matched = 0;
  let withPhone = 0;
  let litigators = 0;
  let unmatched = 0;

  // Address index for exports that carry no folio/APN.
  const all = await db.select({ id: properties.id, address: properties.address, zip: properties.zip }).from(properties);
  const byStreet = new Map<string, number[]>();
  for (const p of all) {
    const k = streetKey(p.address);
    if (k) byStreet.set(k, [...(byStreet.get(k) ?? []), p.id]);
  }

  for (const raw of rows) {
    const r = parseSkipTraceRow(raw);
    let propertyId: number | undefined;
    if (r.folio) {
      [{ id: propertyId } = { id: undefined }] = await db.select({ id: properties.id }).from(properties).where(eq(properties.folio, r.folio));
    }
    if (!propertyId) {
      const candidates = byStreet.get(streetKey(r.propertyAddress) ?? "") ?? [];
      const zip = r.propertyZip?.slice(0, 5);
      const narrowed = zip ? candidates.filter((id) => all.find((p) => p.id === id)?.zip?.slice(0, 5) === zip) : candidates;
      const pool = narrowed.length ? narrowed : candidates;
      if (pool.length === 1) propertyId = pool[0];
    }
    if (!propertyId) {
      unmatched++;
      continue;
    }
    const [contact] = await db.select().from(contacts).where(eq(contacts.propertyId, propertyId)).orderBy(desc(contacts.id)).limit(1);
    if (!contact) continue;
    matched++;

    const ranked = rankPhones(r.phones);
    const best = ranked[0];
    // Keep a number a person already entered; new results go to alternates.
    const keepExisting = Boolean(contact.phone);
    const primary = keepExisting ? null : best;
    const alts = ranked.filter((p) => p.number !== (contact.phone ?? primary?.number));
    if (primary || contact.phone) withPhone++;
    if (r.litigator) litigators++;

    await db
      .update(contacts)
      .set({
        ...(primary ? { phone: primary.number, phoneType: primary.type, onDncList: contact.onDncList || primary.dnc } : {}),
        altPhones: alts,
        email: contact.email ?? r.emails[0] ?? null,
        isLitigator: contact.isLitigator || r.litigator,
      })
      .where(eq(contacts.id, contact.id));
  }
  return { rows: rows.length, matched, withPhone, litigators, unmatched };
}

function csvCell(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Splits "123 MAIN ST MIAMI FL 33101"-style mailing lines when possible. */
function splitMailing(line: string | null): { street: string; city: string; state: string; zip: string } {
  const m = /^(.*?)[,\s]+([A-Z .'-]+?)[,\s]+([A-Z]{2})[,\s]+(\d{5})(?:-\d{4})?$/i.exec((line ?? "").trim());
  return m ? { street: m[1]!, city: m[2]!, state: m[3]!.toUpperCase(), zip: m[4]! } : { street: line ?? "", city: "", state: "", zip: "" };
}

/**
 * Leads without a phone, in the column layout skip-trace vendors accept
 * for bulk upload (owner first/last, property address, mailing address).
 */
export async function exportForSkipTrace(db: DB, opts: { minScore: number }) {
  const rows = await db
    .select({ folio: properties.folio, owner: properties.ownerName, address: properties.address, city: properties.city, zip: properties.zip, mailing: properties.mailingAddress, score: properties.score })
    .from(deals)
    .innerJoin(properties, eq(properties.id, deals.propertyId))
    .innerJoin(contacts, eq(contacts.id, deals.contactId))
    .where(and(isNull(contacts.phone)))
    .orderBy(desc(properties.score));
  const header = ["First Name", "Last Name", "Property Address", "Property City", "Property State", "Property Zip", "Mailing Address", "Mailing City", "Mailing State", "Mailing Zip", "APN"];
  const lines = [header.join(",")];
  let count = 0;
  for (const r of rows) {
    if (r.score < opts.minScore) continue;
    const [last = "", rest = ""] = (r.owner ?? "").split(/,\s*/, 2);
    const first = rest.split(/\s*(?:&|\bAND\b)\s*/i)[0]?.split(" ")[0] ?? "";
    const m = splitMailing(r.mailing);
    lines.push([first, rest ? last : r.owner ?? "", r.address, r.city ?? "Miami", "FL", r.zip, m.street, m.city, m.state, m.zip, r.folio].map(csvCell).join(","));
    count++;
  }
  return { csv: lines.join("\n") + "\n", count };
}
