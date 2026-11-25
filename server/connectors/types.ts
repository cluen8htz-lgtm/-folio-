import type { SignalType } from "../db/schema";

/** One normalized distress record, ready to ingest. */
export interface SignalRecord {
  folio: string;
  type: SignalType;
  source: string;
  externalId: string;
  address: string | null;
  city: string | null;
  zip: string | null;
  ownerName: string | null;
  mailingAddress: string | null;
  filedOn: string | null;
  amount: number | null;
  status: string | null;
  details: Record<string, unknown>;
}

export interface ParseResult {
  records: SignalRecord[];
  skipped: { row: number; reason: string }[];
}
