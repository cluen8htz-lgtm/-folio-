import { eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { contacts, deals, importRuns, properties, signals } from "../db/schema";
import { isAbsentee, scoreProperty } from "../core/scoring";
import { personName } from "../core/normalize";
import type { SignalRecord } from "../connectors/types";
import { enrollDeal } from "../jobs/automations";

/**
 * Upserts properties by folio, adds new signals (re-imports are no-ops),
 * rescoring each touched property, and opens a deal + owner contact the
 * first time a property shows up.
 */
export async function ingest(db: DB, source: string, records: SignalRecord[]) {
  const [run] = await db.insert(importRuns).values({ source, status: "running", fetched: records.length }).returning();
  let created = 0;
  const newDeals: number[] = [];
  try {
    for (const r of records) {
      const [prop] = await db
        .insert(properties)
        .values({
          folio: r.folio,
          address: r.address,
          city: r.city,
          zip: r.zip,
          ownerName: r.ownerName,
          mailingAddress: r.mailingAddress,
        })
        .onConflictDoUpdate({
          target: [properties.county, properties.folio],
          set: {
            address: sql`coalesce(${properties.address}, excluded.address)`,
            city: sql`coalesce(${properties.city}, excluded.city)`,
            zip: sql`coalesce(${properties.zip}, excluded.zip)`,
            ownerName: sql`coalesce(${properties.ownerName}, excluded.owner_name)`,
            mailingAddress: sql`coalesce(${properties.mailingAddress}, excluded.mailing_address)`,
            updatedAt: new Date(),
          },
        })
        .returning();
      const inserted = await db
        .insert(signals)
        .values({
          propertyId: prop!.id,
          type: r.type,
          source: r.source,
          externalId: r.externalId,
          filedOn: r.filedOn,
          amount: r.amount,
          status: r.status,
          details: r.details,
        })
        .onConflictDoNothing()
        .returning({ id: signals.id });
      if (inserted.length === 0) continue;
      created++;
      await rescore(db, prop!.id);
      const dealId = await ensureDeal(db, prop!.id, prop!.ownerName);
      if (dealId) newDeals.push(dealId);
    }
    await db.update(importRuns).set({ status: "ok", created, finishedAt: new Date() }).where(eq(importRuns.id, run!.id));
  } catch (err) {
    await db
      .update(importRuns)
      .set({ status: "error", created, error: String(err), finishedAt: new Date() })
      .where(eq(importRuns.id, run!.id));
    throw err;
  }
  for (const id of newDeals) await enrollDeal(db, id, { type: "deal_created" });
  return { runId: run!.id, fetched: records.length, created, newDeals: newDeals.length };
}

export async function rescore(db: DB, propertyId: number) {
  const [prop] = await db.select().from(properties).where(eq(properties.id, propertyId));
  const sigs = await db.select().from(signals).where(eq(signals.propertyId, propertyId));
  const { score } = scoreProperty(sigs, { absentee: isAbsentee(prop?.address ?? null, prop?.mailingAddress ?? null) });
  await db.update(properties).set({ score }).where(eq(properties.id, propertyId));
  return score;
}

/** Returns the new deal id, or null if the property already had one. */
async function ensureDeal(db: DB, propertyId: number, ownerName: string | null): Promise<number | null> {
  const [existing] = await db.select({ id: deals.id }).from(deals).where(eq(deals.propertyId, propertyId));
  if (existing) return null;
  const [contact] = await db
    .insert(contacts)
    .values({ propertyId, name: personName(ownerName) ?? "Owner" })
    .returning({ id: contacts.id });
  const [deal] = await db
    .insert(deals)
    .values({ propertyId, contactId: contact!.id })
    .onConflictDoNothing()
    .returning({ id: deals.id });
  return deal?.id ?? null;
}
