import type { SignalType } from "../../db/schema";
import { normalizeDate, normalizeFolio, parseMoney } from "../../core/normalize";
import { pick } from "../csv";
import type { ParseResult, SignalRecord } from "../types";

/**
 * Column names vary by export (Clerk searches, Tax Collector lists, county
 * open data, list vendors). Each field accepts several common spellings;
 * extend these lists when a new export doesn't map.
 */
export const COLUMNS = {
  folio: ["folio", "folio number", "folio_num", "folionumber", "parcel", "parcel id", "parcel_id", "pid"],
  caseId: ["case number", "case_num", "casenumber", "case no", "case", "cfn", "certificate number", "certificate", "cert no", "violation id", "objectid", "id"],
  address: ["property address", "site address", "situs address", "address", "site_addr", "location", "prop_addr"],
  city: ["property city", "site city", "city", "municipality"],
  zip: ["property zip", "site zip", "zip", "zipcode", "zip code"],
  owner: ["owner", "owner name", "owner_name", "owner1", "defendant", "decedent", "property owner", "name"],
  mailing: ["mailing address", "mail address", "owner address", "mailing_address", "mail_addr"],
  filed: ["filed date", "file date", "filing date", "date filed", "case date", "open date", "date opened", "recording date", "rec date", "sale date", "issue date", "violation date"],
  amount: ["amount", "judgment amount", "final judgment", "face amount", "lien amount", "balance", "amount due", "total due", "opening bid"],
  status: ["status", "case status", "certificate status"],
  description: ["description", "violation", "violation description", "case type", "problem", "doc type", "document type"],
};

export function mapRow(row: Record<string, unknown>, type: SignalType, source: string): SignalRecord | { error: string } {
  const folio = normalizeFolio(pick(row, COLUMNS.folio));
  if (!folio) return { error: "missing or invalid 13-digit folio" };
  const caseId = pick(row, COLUMNS.caseId);
  const filedOn = normalizeDate(pick(row, COLUMNS.filed));
  return {
    folio,
    type,
    source,
    // Without a case id, folio+date+type is the best available dedupe key.
    externalId: caseId ?? `${folio}:${filedOn ?? "nodate"}:${type}`,
    address: pick(row, COLUMNS.address),
    city: pick(row, COLUMNS.city),
    zip: pick(row, COLUMNS.zip),
    ownerName: pick(row, COLUMNS.owner),
    mailingAddress: pick(row, COLUMNS.mailing),
    filedOn,
    amount: parseMoney(pick(row, COLUMNS.amount)),
    status: pick(row, COLUMNS.status),
    details: { description: pick(row, COLUMNS.description) },
  };
}

export function mapRows(rows: Record<string, unknown>[], type: SignalType, source: string): ParseResult {
  const out: ParseResult = { records: [], skipped: [] };
  rows.forEach((row, i) => {
    const r = mapRow(row, type, source);
    if ("error" in r) out.skipped.push({ row: i + 2, reason: r.error }); // +2: header row, 1-based
    else out.records.push(r);
  });
  return out;
}
