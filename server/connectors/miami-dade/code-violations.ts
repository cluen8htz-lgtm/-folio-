import { env } from "../../env";
import { mapRows } from "./mapping";
import type { ParseResult } from "../types";

/**
 * Live pull from an ArcGIS REST layer (the county publishes code compliance
 * data through ArcGIS). Uses the standard /query endpoint with paging.
 * The layer URL is configuration because the county reorganizes its
 * services; confirm the current one on its open data portal.
 */
export async function fetchCodeViolations(opts: {
  layerUrl?: string;
  sinceDays?: number;
  dateField?: string;
  fetchImpl?: typeof fetch;
  pageSize?: number;
}): Promise<ParseResult & { fetched: number }> {
  const layerUrl = opts.layerUrl ?? env.MDC_CODE_VIOLATIONS_LAYER_URL;
  if (!layerUrl) throw new Error("Set MDC_CODE_VIOLATIONS_LAYER_URL to the county's code violations ArcGIS layer.");
  const doFetch = opts.fetchImpl ?? fetch;
  const pageSize = opts.pageSize ?? 1000;
  let where = "1=1";
  if (opts.sinceDays && opts.dateField) {
    const since = new Date(Date.now() - opts.sinceDays * 86400_000).toISOString().slice(0, 10);
    where = `${opts.dateField} >= DATE '${since}'`;
  }
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 200_000; offset += pageSize) {
    const qs = new URLSearchParams({
      where,
      outFields: "*",
      returnGeometry: "false",
      f: "json",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      orderByFields: "OBJECTID",
    });
    const res = await doFetch(`${layerUrl.replace(/\/$/, "")}/query?${qs}`);
    if (!res.ok) throw new Error(`ArcGIS ${res.status} for ${layerUrl}`);
    const json = (await res.json()) as {
      features?: { attributes: Record<string, unknown> }[];
      exceededTransferLimit?: boolean;
      error?: { message?: string };
    };
    if (json.error) throw new Error(`ArcGIS error: ${json.error.message ?? "unknown"}`);
    const page = json.features ?? [];
    rows.push(...page.map((f) => f.attributes));
    if (page.length < pageSize && !json.exceededTransferLimit) break;
  }
  return { ...mapRows(rows, "code_violation", "mdc-code-violations"), fetched: rows.length };
}
