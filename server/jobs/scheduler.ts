import type { DB } from "../db/client";
import { env } from "../env";
import { localClock } from "../core/compliance";
import { deliverDue, enrollNoReply, runDueAutomations } from "./automations";
import { fetchCodeViolations } from "../connectors/miami-dade";
import { ingest } from "../services/ingest";

/**
 * In-process scheduler: every minute it advances automations and sends
 * messages whose window opened; once a day it runs the live importers.
 * Run a single server instance (or move these to a queue) to avoid
 * double-processing.
 */
export function startScheduler(db: DB) {
  let busy = false;
  let lastImportDay = "";
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueAutomations(db);
      await deliverDue(db);
      const now = new Date();
      const { hour, minute } = localClock(now, env.TEAM_TIMEZONE);
      const [h, m] = env.IMPORT_DAILY_AT.split(":").map(Number);
      const day = now.toISOString().slice(0, 10);
      if (hour === h && minute >= (m ?? 0) && lastImportDay !== day) {
        lastImportDay = day;
        await runDailyImports(db);
        await enrollNoReply(db);
      }
    } catch (err) {
      console.error("scheduler tick failed", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  void tick();
  return () => clearInterval(timer);
}

export async function runDailyImports(db: DB) {
  if (!env.MDC_CODE_VIOLATIONS_LAYER_URL) return null;
  try {
    const result = await fetchCodeViolations({});
    return ingest(db, "mdc-code-violations", result.records);
  } catch (err) {
    console.error("code violations import failed", err);
    return null;
  }
}
