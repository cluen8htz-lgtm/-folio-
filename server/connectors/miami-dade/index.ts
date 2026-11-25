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
 * - tax_lien: Tax Collector tax certificate / tax deed application list.
 * - code_violation: any code compliance export, if the live layer isn't set.
 */
export const FILE_SOURCES: Record<SignalType, { source: string; label: string }> = {
  foreclosure: { source: "mdc-clerk-foreclosure", label: "Foreclosure / lis pendens (Clerk export)" },
  probate: { source: "mdc-clerk-probate", label: "Probate filings (Clerk export)" },
  tax_lien: { source: "mdc-tax-collector", label: "Tax certificates / tax deed applications" },
  code_violation: { source: "mdc-code-violations", label: "Code violations (export)" },
};

export function parseSourceCsv(type: SignalType, csv: string): ParseResult {
  return mapRows(parseCsv(csv), type, FILE_SOURCES[type].source);
}
