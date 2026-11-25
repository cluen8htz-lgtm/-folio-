import { useState } from "react";
import { trpc } from "../lib/trpc";
import { ErrorNote, PageHeader } from "../App";

const EXAMPLES = [
  "Text every new foreclosure lead scoring 60+, then follow up every 3 days for two weeks unless they reply.",
  "When a deal moves to appointment, create a task to pull comps and text them a confirmation.",
  "If someone hasn't replied in 10 days, send one friendly check-in email.",
];

export function Automations() {
  const utils = trpc.useUtils();
  const list = trpc.automations.list.useQuery();
  const employees = trpc.employees.list.useQuery();
  const [plan, setPlan] = useState("");
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const compile = trpc.automations.compile.useMutation();
  const create = trpc.automations.create.useMutation({
    onSuccess: () => {
      compile.reset();
      setPlan("");
      utils.automations.list.invalidate();
    },
  });
  const toggle = trpc.automations.setEnabled.useMutation({ onSuccess: () => utils.automations.list.invalidate() });
  const remove = trpc.automations.remove.useMutation({ onSuccess: () => utils.automations.list.invalidate() });
  const preview = compile.data;

  return (
    <div className="space-y-5">
      <PageHeader title="Automations" />
      <section className="card p-4">
        <label className="label">Describe the follow-up in one sentence</label>
        <textarea className="input" rows={2} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder={EXAMPLES[0]} />
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {EXAMPLES.map((e) => (
            <button key={e} className="rounded-full border border-line px-2 py-0.5 text-muted hover:bg-slate-100" onClick={() => setPlan(e)}>{e.slice(0, 48)}…</button>
          ))}
        </div>
        <button className="btn-primary mt-3" disabled={plan.trim().length < 8 || compile.isPending} onClick={() => compile.mutate({ plan })}>
          {compile.isPending ? "Building…" : "Build automation"}
        </button>
        <ErrorNote error={compile.error} />
        {preview && (
          <div className="mt-4 rounded-md border border-line bg-slate-50 p-3 text-sm">
            <div className="font-medium">{preview.spec.name}</div>
            <p className="mb-2 text-muted">{preview.spec.summary}</p>
            <ol className="list-decimal space-y-0.5 pl-5">{preview.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            {preview.spec.unsupported.length > 0 && (
              <p className="mt-2 text-amber-800">Not automated: {preview.spec.unsupported.join("; ")}</p>
            )}
            {preview.errors.length > 0 && <p className="mt-2 text-red-700">{preview.errors.join(" ")}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-muted">Sends as</span>
              <select className="input w-auto" value={employeeId ?? employees.data?.[0]?.id ?? ""} onChange={(e) => setEmployeeId(Number(e.target.value))}>
                {employees.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
              <button
                className="btn-primary"
                disabled={preview.errors.length > 0 || create.isPending}
                onClick={() => create.mutate({ plan, spec: preview.spec, employeeId: employeeId ?? employees.data?.[0]?.id ?? null })}
              >
                Save (off)
              </button>
            </div>
            <ErrorNote error={create.error} />
          </div>
        )}
      </section>
      <div className="space-y-3">
        {list.data?.map((a) => (
          <section key={a.id} className="card p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-medium">{a.name}</div>
                <div className="text-muted">"{a.plan}"</div>
              </div>
              <div className="flex gap-2">
                <button className={a.enabled ? "btn-ghost" : "btn-primary"} onClick={() => toggle.mutate({ id: a.id, enabled: !a.enabled })}>
                  {a.enabled ? "Turn off" : "Turn on"}
                </button>
                <button className="btn-danger" onClick={() => confirm("Delete this automation?") && remove.mutate({ id: a.id })}>Delete</button>
              </div>
            </div>
            <ol className="mt-2 list-decimal pl-5 text-slate-700">{a.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            <div className="mt-2 text-xs text-muted">
              {a.enabled ? "On" : "Off"} · running {a.runs.active ?? 0} · finished {a.runs.done ?? 0} · stopped {a.runs.stopped ?? 0}
              {a.runs.error ? ` · errors ${a.runs.error}` : ""}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
