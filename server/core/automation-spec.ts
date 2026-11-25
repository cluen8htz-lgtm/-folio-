import { z } from "zod";
import { DEAL_STAGES, SIGNAL_TYPES } from "../db/schema";

/**
 * The format a one-sentence plan compiles to. Claude writes it; this schema
 * and validateSpec() decide whether it's runnable. The engine only ever runs
 * specs that passed both.
 */
export const TriggerSchema = z.object({
  type: z.enum(["deal_created", "stage_entered", "no_reply"]),
  /** deal_created: only for these signal types (empty = all). */
  signalTypes: z.array(z.enum(SIGNAL_TYPES)),
  /** stage_entered: the stage. */
  stage: z.enum(DEAL_STAGES).nullable(),
  /** no_reply: days since our last outbound with no inbound since. */
  days: z.number().int().min(1).max(365).nullable(),
  /** Minimum motivation score (0 = any). */
  minScore: z.number().int().min(0).max(100),
});

export const StepSchema = z.object({
  type: z.enum(["wait", "send", "stop_if_replied", "set_stage", "create_task"]),
  /** wait: hours. */
  hours: z.number().min(0).max(24 * 365).nullable(),
  /** send: channel and what the message should accomplish. */
  channel: z.enum(["sms", "email"]).nullable(),
  goal: z.string().nullable(),
  /** set_stage. */
  stage: z.enum(DEAL_STAGES).nullable(),
  /** create_task. */
  title: z.string().nullable(),
});

export const AutomationSpecSchema = z.object({
  name: z.string(),
  trigger: TriggerSchema,
  steps: z.array(StepSchema),
  /** Plain-English read-back shown to the user before they enable it. */
  summary: z.string(),
  /** Anything in the plan that couldn't be expressed; empty if none. */
  unsupported: z.array(z.string()),
});

export type AutomationSpec = z.infer<typeof AutomationSpecSchema>;
export type Step = z.infer<typeof StepSchema>;

export function validateSpec(spec: AutomationSpec): string[] {
  const errors: string[] = [];
  const t = spec.trigger;
  if (t.type === "stage_entered" && !t.stage) errors.push("Trigger 'stage_entered' needs a stage.");
  if (t.type === "no_reply" && !t.days) errors.push("Trigger 'no_reply' needs a number of days.");
  if (spec.steps.length === 0) errors.push("The automation has no steps.");
  if (spec.steps.length > 40) errors.push("At most 40 steps.");
  spec.steps.forEach((s, i) => {
    const n = `Step ${i + 1}`;
    if (s.type === "wait" && !(s.hours && s.hours > 0)) errors.push(`${n}: wait needs hours > 0.`);
    if (s.type === "send") {
      if (!s.channel) errors.push(`${n}: send needs a channel.`);
      if (!s.goal?.trim()) errors.push(`${n}: send needs a goal.`);
    }
    if (s.type === "set_stage" && !s.stage) errors.push(`${n}: set_stage needs a stage.`);
    if (s.type === "create_task" && !s.title?.trim()) errors.push(`${n}: create_task needs a title.`);
  });
  const sends = spec.steps.filter((s) => s.type === "send").length;
  const waits = spec.steps.filter((s) => s.type === "wait").reduce((h, s) => h + (s.hours ?? 0), 0);
  if (sends > 1 && waits / (sends - 1) < 24) {
    errors.push("Space messages at least a day apart on average.");
  }
  return errors;
}

export function describeStep(s: Step): string {
  switch (s.type) {
    case "wait":
      return (s.hours ?? 0) % 24 === 0 ? `Wait ${(s.hours ?? 0) / 24} day(s)` : `Wait ${s.hours} hour(s)`;
    case "send":
      return `Send ${s.channel === "email" ? "an email" : "a text"}: ${s.goal}`;
    case "stop_if_replied":
      return "Stop if they've replied";
    case "set_stage":
      return `Move deal to "${s.stage}"`;
    case "create_task":
      return `Create task: ${s.title}`;
  }
}
