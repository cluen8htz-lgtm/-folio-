import { count } from "drizzle-orm";
import type { DB } from "./client";
import { employees, memories } from "./schema";

/** First run: one AI employee at "draft" trust and a few starter memories. */
export async function seedDefaults(db: DB) {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(employees);
  if (n > 0) return;
  await db.insert(employees).values({
    name: "Ava",
    role: "Acquisitions assistant",
    instructions: "Find out whether the owner would consider selling, and if so, book a call with the team.",
    trust: { send_sms: "draft", send_email: "draft", set_stage: "ask", create_task: "act" },
  });
  await db.insert(memories).values([
    { kind: "preference", content: "Keep first texts under 160 characters.", source: "seed" },
    { kind: "playbook", content: "If an owner names a price, thank them and offer a call; never counter by text.", source: "seed" },
  ]);
}
