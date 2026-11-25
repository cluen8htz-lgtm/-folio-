import type { SignalType } from "../../db/schema";
import { parseCsv } from "../csv";
import { mapRows } from "./mapping";
import type { ParseResult } from "../types";

export { fetchCodeViolations } from "./code-violations";

/**
 * File-based sources. Each one is an export a team member downloads:
 * - foreclosure: Clerk of Court lis pendens / foreclosure case search
 *   export, or the foreclosure auction calendar.
 * - probate: Clerk probate filings search export.
 * - estate_roll: heir / estate-of-record lists built from the Property
 *   Appraiser roll (owner of record still a deceased owner's estate).
 * - tax_lien: Tax Collector tax certificate / tax deed application list.
 * - code_violation: any code compliance export, if the live layer isn't set.
 * CSV or Excel (Excel is converted to CSV in the browser).
 */
export const FILE_SOURCES = {
  foreclosure: { type: "foreclosure", source: "mdc-clerk-foreclosure", label: "Foreclosure / lis pendens (Clerk export)" },
  probate: { type: "probate", source: "mdc-clerk-probate", label: "Probate filings (Clerk export)" },
  estate_roll: { type: "probate", source: "mdc-pa-estate-of-record", label: "Heir / estate-of-record list (Property Appraiser roll)" },
  tax_lien: { type: "tax_lien", source: "mdc-tax-collector", label: "Tax certificates / tax deed applications" },
  code_violation: { type: "code_violation", source: "mdc-code-violations", label: "Code violations (export)" },
} as const satisfies Record<string, { type: SignalType; source: string; label: string }>;

export type FileSourceId = keyof typeof FILE_SOURCES;
export const FILE_SOURCE_IDS = Object.keys(FILE_SOURCES) as [FileSourceId, ...FileSourceId[]];

export function parseSourceCsv(id: FileSourceId, csv: string): ParseResult {
  const s = FILE_SOURCES[id];
  return mapRows(parseCsv(csv), s.type, s.source);
}
