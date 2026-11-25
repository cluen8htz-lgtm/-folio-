import { useState } from "react";
import { trpc, type Outputs } from "../lib/trpc";
import { ErrorNote, PageHeader } from "../App";

const ACTION_LABEL = { send_sms: "Send texts", send_email: "Send emails", set_stage: "Move deals", create_task: "Create tasks" } as const;
const LEVELS = [
  ["ask", "Ask first"],
  ["draft", "Draft for approval"],
  ["act", "Act on its own"],
] as const;
type Trust = Record<keyof typeof ACTION_LABEL, "ask" | "draft" | "act">;

export function Team() {
  const employees = trpc.employees.list.useQuery();
  return (
    <div className="space-y-5">
      <PageHeader title="AI team" />
      <p className="text-sm text-muted">
        Each employee starts by asking, moves to drafting, and acts on its own only when you promote it. Promotion suggestions appear once its approval record earns them. "Act on its own" never applies to texts to numbers without consent; those always wait for you.
      </p>
      {employees.data?.map((e) => <EmployeeCard key={e.id} e={e} />)}
      <EmployeeCard />
      <Memory />
    </div>
  );
}

type Emp = Outputs["employees"]["list"][number];

function EmployeeCard({ e }: { e?: Emp }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    name: e?.name ?? "",
    role: e?.role ?? "",
    instructions: e?.instructions ?? "",
    trust: (e?.trust ?? { send_sms: "ask", send_email: "ask", set_stage: "ask", create_task: "draft" }) as Trust,
  });
  const save = trpc.employees.upsert.useMutation({
    onSuccess: () => {
      utils.employees.list.invalidate();
      if (!e) setForm({ name: "", role: "", instructions: "", trust: form.trust });
    },
  });
  const reviewed = e ? e.approvedCount + e.editedCount + e.rejectedCount : 0;
  return (
    <section className="card p-4 text-sm">
      <h2 className="mb-3 font-medium">{e ? e.name : "Add an employee"}</h2>
      <div className="grid gap-2 md:grid-cols-2">
        <input className="input" placeholder="Name" value={form.name} onChange={(x) => setForm({ ...form, name: x.target.value })} />
        <input className="input" placeholder="Role (e.g. Acquisitions assistant)" value={form.role} onChange={(x) => setForm({ ...form, role: x.target.value })} />
        <textarea className="input md:col-span-2" rows={2} placeholder="What should they focus on?" value={form.instructions} onChange={(x) => setForm({ ...form, instructions: x.target.value })} />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(Object.keys(ACTION_LABEL) as (keyof Trust)[]).map((a) => {
          const suggestion = e?.suggestions.find((s) => s.action === a)?.suggestion;
          return (
            <label key={a} className="flex flex-col gap-1">
              <span className="label">{ACTION_LABEL[a]}</span>
              <select className="input" value={form.trust[a]} onChange={(x) => setForm({ ...form, trust: { ...form.trust, [a]: x.target.value as Trust[typeof a] } })}>
                {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {suggestion && (
                <span className="text-xs text-teal-800">
                  Ready for "{LEVELS.find(([v]) => v === suggestion.to)?.[1]}": {suggestion.why}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {e && (
        <p className="mt-2 text-xs text-muted">
          Track record: {e.approvedCount} approved, {e.editedCount} edited, {e.rejectedCount} rejected ({reviewed} reviewed)
        </p>
      )}
      <button className="btn-primary mt-3" disabled={!form.name || !form.role || save.isPending} onClick={() => save.mutate({ id: e?.id, ...form, active: true })}>
        {e ? "Save" : "Add employee"}
      </button>
      <ErrorNote error={save.error} />
    </section>
  );
}

function Memory() {
  const utils = trpc.useUtils();
  const list = trpc.memory.list.useQuery();
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<"preference" | "fact" | "playbook">("preference");
  const add = trpc.memory.add.useMutation({ onSuccess: () => { setContent(""); utils.memory.list.invalidate(); } });
  const remove = trpc.memory.remove.useMutation({ onSuccess: () => utils.memory.list.invalidate() });
  return (
    <section className="card p-4 text-sm">
      <h2 className="font-medium">How your team works</h2>
      <p className="mb-3 text-muted">Every draft follows these. Edits and rejection reasons in Approvals add to this list automatically.</p>
      <div className="mb-3 flex flex-wrap gap-2">
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="preference">Preference</option>
          <option value="playbook">Playbook</option>
          <option value="fact">Fact</option>
        </select>
        <input className="input flex-1" placeholder="e.g. We close in 14 days and pay all closing costs." value={content} onChange={(e) => setContent(e.target.value)} />
        <button className="btn-primary" disabled={content.trim().length < 3} onClick={() => add.mutate({ kind, content })}>Add</button>
      </div>
      <ul className="divide-y divide-line">
        {list.data?.map((m) => (
          <li key={m.id} className="flex items-start justify-between gap-3 py-2">
            <span><span className="chip mr-2 bg-slate-100 text-slate-700">{m.kind}</span>{m.content}</span>
            <button className="text-xs text-muted hover:text-red-700" onClick={() => remove.mutate({ id: m.id })}>Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
