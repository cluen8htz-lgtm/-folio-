import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env";
import { AutomationSpecSchema, type AutomationSpec } from "../core/automation-spec";
import { DEAL_STAGES } from "../db/schema";

/**
 * Claude does language work only: drafting, compiling plans, reading
 * replies. What actually happens (compliance, trust, sending, stage moves)
 * is decided by ordinary code that never trusts model output unvalidated.
 */
const MODEL = "claude-opus-5-5";

let client: Anthropic | null = null;
export function aiEnabled(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}
function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

async function structured<T extends z.ZodType>(opts: {
  schema: T;
  system: string;
  prompt: string;
  effort?: "low" | "medium" | "high";
}): Promise<z.infer<T>> {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    // If a safety classifier declines, the API retries on a fallback model.
    fallbacks: "default",
    system: opts.system,
    output_config: { effort: opts.effort ?? "medium", format: zodOutputFormat(opts.schema) },
    messages: [{ role: "user", content: opts.prompt }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error("Claude's response was incomplete.");
  }
  return response.parsed_output as z.infer<T>;
}

// ---------------------------------------------------------------- drafting

export interface DraftContext {
  employee: { name: string; role: string; instructions: string };
  teamName: string;
  memories: string[];
  contact: { name: string };
  property: { address: string | null; city: string | null; signals: string[] };
  history: { direction: "inbound" | "outbound"; channel: string; body: string; at: string }[];
  channel: "sms" | "email";
  goal: string;
}

const DraftSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
});

const DRAFT_SYSTEM = `You write outreach for a real estate investment team that buys houses directly from owners.

Rules that always apply:
- Be honest and plain. Never pretend to be a neighbor, a government office, a lender or the owner's attorney. Never invent facts, offers or deadlines.
- Never mention foreclosure, probate, liens, code violations, death, debt or any hardship from public records. Owners find that invasive. Ask about the property, not their situation.
- Write like a real person on the team: short, warm, no hype, no emojis unless the owner used them.
- SMS: one or two sentences, under 300 characters, no links. Identify the team by first name and team name in a first message.
- Email: a short subject and three or fewer short paragraphs. Do not add a signature or unsubscribe line; the system appends the required footer.
- If the conversation shows they declined or asked not to be contacted, write a brief, polite closing note and nothing more.`;

export async function draftMessage(ctx: DraftContext): Promise<{ subject: string | null; body: string }> {
  if (!aiEnabled()) return templateDraft(ctx);
  const history = ctx.history.length
    ? ctx.history.map((m) => `[${m.at}] ${m.direction === "inbound" ? "OWNER" : "US"} (${m.channel}): ${m.body}`).join("\n")
    : "(no messages yet: this is the first contact)";
  const prompt = `You are ${ctx.employee.name}, ${ctx.employee.role} at ${ctx.teamName}.
${ctx.employee.instructions ? `Your instructions from the team:\n${ctx.employee.instructions}\n` : ""}
How this team works (follow these):
${ctx.memories.length ? ctx.memories.map((m) => `- ${m}`).join("\n") : "- (nothing recorded yet)"}

Owner: ${ctx.contact.name}
Property: ${[ctx.property.address, ctx.property.city].filter(Boolean).join(", ") || "unknown address"}
Internal notes on the property (never mention these to the owner): ${ctx.property.signals.join("; ") || "none"}

Conversation so far:
${history}

Write the next ${ctx.channel === "sms" ? "text message" : "email"}. Its goal: ${ctx.goal}`;
  const out = await structured({ schema: DraftSchema, system: DRAFT_SYSTEM, prompt, effort: "low" });
  return { subject: ctx.channel === "email" ? (out.subject ?? "About your property") : null, body: out.body.trim() };
}

export function templateDraft(ctx: DraftContext): { subject: string | null; body: string } {
  const first = ctx.contact.name.split(/\s+/)[0] ?? "there";
  const where = ctx.property.address ? ` on ${ctx.property.address}` : "";
  const firstContact = ctx.history.length === 0;
  const body = firstContact
    ? `Hi ${first}, this is ${ctx.employee.name} with ${ctx.teamName}. Would you consider an offer for your property${where}?`
    : `Hi ${first}, ${ctx.employee.name} again with ${ctx.teamName}. Just following up: is selling the property${where} something you'd consider?`;
  return { subject: ctx.channel === "email" ? "About your property" : null, body };
}

// ------------------------------------------------------- plan compilation

const PLAN_SYSTEM = `You convert a real estate team's one-sentence follow-up plan into an automation spec.

Triggers:
- deal_created: a new lead/deal appears. signalTypes narrows by public-record signal (foreclosure, probate, tax_lien, code_violation); [] means all.
- stage_entered: a deal moves into a pipeline stage (${DEAL_STAGES.join(", ")}).
- no_reply: we messaged and they haven't answered for N days.
minScore: a motivation score threshold 0-100 if the plan mentions one ("hot", "high score" ≈ 60), else 0.

Steps: wait (hours), send (channel sms|email + goal: what the message should accomplish, not the message text), stop_if_replied, set_stage, create_task (title).
Unused fields are null.

Rules:
- Put stop_if_replied before every send after the first, unless the plan clearly says otherwise. Conversations with a person who replied are handled by a human or a reply flow, not a drip.
- "Every N days for M weeks" expands into explicit wait/send pairs.
- Never schedule messages less than a day apart.
- If part of the plan can't be expressed (calls, mail, other tools), leave it out and list it in unsupported.
- summary: a plain-English read-back of what will happen, in 1-3 sentences.`;

export async function compilePlan(plan: string): Promise<AutomationSpec> {
  if (!aiEnabled()) throw new Error("Turning a sentence into an automation needs ANTHROPIC_API_KEY.");
  return structured({
    schema: AutomationSpecSchema,
    system: PLAN_SYSTEM,
    prompt: `Plan: ${plan}`,
    effort: "medium",
  });
}

// ---------------------------------------------------------- reading replies

export const InboundReadSchema = z.object({
  intent: z.enum([
    "interested",
    "maybe_later",
    "not_interested",
    "wrong_number",
    "question",
    "wants_appointment",
    "hostile",
    "other",
  ]),
  /** Stage the deal should probably move to; null = leave it. */
  suggestedStage: z.enum(DEAL_STAGES).nullable(),
  askingPrice: z.number().nullable(),
  summary: z.string(),
});
export type InboundRead = z.infer<typeof InboundReadSchema>;

export async function readInbound(body: string, history: string): Promise<InboundRead | null> {
  if (!aiEnabled()) return null;
  return structured({
    schema: InboundReadSchema,
    system:
      "You read a property owner's reply to a real estate investor and classify it. Extract an asking price only if they state a number. summary: one short sentence for the team.",
    prompt: `Earlier conversation:\n${history || "(none)"}\n\nNew reply from the owner:\n${body}`,
    effort: "low",
  });
}

// -------------------------------------------------------- learning by edit

const LessonSchema = z.object({ lesson: z.string().nullable() });

/** When a person edits a draft before approving, distill the preference. */
export async function lessonFromEdit(draft: string, final: string): Promise<string | null> {
  if (!aiEnabled() || draft.trim() === final.trim()) return null;
  const out = await structured({
    schema: LessonSchema,
    system:
      "A team member edited an AI-written message before sending it. If the edit shows a reusable preference about tone, wording, length or approach, state it as one short imperative sentence (e.g. 'Never use the word \"cash\" in a first text.'). If it's a one-off factual fix, return null.",
    prompt: `Draft:\n${draft}\n\nSent:\n${final}`,
    effort: "low",
  });
  return out.lesson?.trim() || null;
}
