import { useEffect, useState } from "react";
import { trpc, type Outputs } from "../lib/trpc";
import { ErrorNote, PageHeader } from "../App";
import { SIGNAL_COLOR, SIGNAL_LABEL, STAGE_LABEL, STAGES, formatFolio, money, scoreColor, when } from "../lib/format";

const STATUS_STYLE: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-sky-100 text-sky-800",
  blocked: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
  rejected: "bg-slate-200 text-slate-700",
};

export function LeadDetail({ dealId }: { dealId: number }) {
  const utils = trpc.useUtils();
  const { data, error } = trpc.leads.get.useQuery({ dealId });
  const employees = trpc.employees.list.useQuery();
  const refresh = () => {
    utils.leads.get.invalidate({ dealId });
    utils.messages.approvals.invalidate();
  };
  const setStage = trpc.leads.setStage.useMutation({ onSuccess: refresh });
  const updateDeal = trpc.leads.updateDeal.useMutation({ onSuccess: refresh });

  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const { deal, property, contact } = data;

  return (
    <div>
      <a href="#/leads" className="text-sm text-muted hover:underline">← Leads</a>
      <PageHeader title={property.address ?? formatFolio(property.folio)}>
        <span className={`chip ${scoreColor(property.score)} self-center`}>Score {property.score}</span>
        <select className="input w-auto" value={deal.stage} onChange={(e) => setStage.mutate({ dealId, stage: e.target.value as never })}>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Conversation dealId={dealId} messages={data.messages} contact={contact} employees={employees.data ?? []} onChange={refresh} />
        </div>
        <div className="space-y-4">
          <section className="card p-4 text-sm">
            <h2 className="mb-2 font-medium">Property</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted">Folio</dt><dd>{formatFolio(property.folio)}</dd>
              <dt className="text-muted">City</dt><dd>{[property.city, property.zip].filter(Boolean).join(" ") || "—"}</dd>
              <dt className="text-muted">Owner</dt><dd>{property.ownerName ?? "—"}</dd>
              <dt className="text-muted">Mails to</dt><dd>{property.mailingAddress ?? "—"}</dd>
            </dl>
            <h3 className="mt-3 mb-1 font-medium">Public records</h3>
            <ul className="space-y-1.5">
              {data.signals.map((s) => (
                <li key={s.id}>
                  <span className={`chip ${SIGNAL_COLOR[s.type]}`}>{SIGNAL_LABEL[s.type]}</span>{" "}
                  <span className="text-muted">
                    {s.filedOn ?? "no date"} · {s.externalId}
                    {s.amount ? ` · ${money(s.amount)}` : ""}
                    {s.status ? ` · ${s.status}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card p-4 text-sm">
            <h2 className="mb-2 font-medium">Deal</h2>
            <MoneyField label="Asking" value={deal.askingPrice} onSave={(v) => updateDeal.mutate({ dealId, askingPrice: v })} />
            <MoneyField label="Our offer" value={deal.offerPrice} onSave={(v) => updateDeal.mutate({ dealId, offerPrice: v })} />
            <MoneyField label="ARV" value={deal.arv} onSave={(v) => updateDeal.mutate({ dealId, arv: v })} />
          </section>
          {contact && <ContactCard contact={contact} onChange={refresh} />}
          {(data.tasks.length > 0 || data.runs.length > 0) && (
            <section className="card p-4 text-sm">
              {data.tasks.length > 0 && (
                <>
                  <h2 className="mb-1 font-medium">Open tasks</h2>
                  <ul className="mb-3 list-disc pl-5">{data.tasks.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
                </>
              )}
              {data.runs.length > 0 && (
                <>
                  <h2 className="mb-1 font-medium">Automations</h2>
                  <ul>{data.runs.map((r) => <li key={r.id}>{r.name}: {r.status}{r.status === "active" ? `, next ${when(r.nextRunAt)}` : ""}</li>)}</ul>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function MoneyField({ label, value, onSave }: { label: string; value: number | null; onSave: (v: number | null) => void }) {
  const [v, setV] = useState(value?.toString() ?? "");
  useEffect(() => setV(value?.toString() ?? ""), [value]);
  return (
    <label className="mb-2 flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <input
        className="input w-36 text-right"
        inputMode="numeric"
        value={v}
        placeholder="—"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = v.trim() === "" ? null : Number(v.replace(/[$,]/g, ""));
          if (n === null || Number.isFinite(n)) onSave(n);
        }}
      />
    </label>
  );
}

type Contact = Outputs["leads"]["get"]["contact"];

function ContactCard({ contact, onChange }: { contact: NonNullable<Contact>; onChange: () => void }) {
  const [form, setForm] = useState({ name: contact.name, phone: contact.phone ?? "", email: contact.email ?? "" });
  const update = trpc.leads.updateContact.useMutation({ onSuccess: onChange });
  useEffect(() => setForm({ name: contact.name, phone: contact.phone ?? "", email: contact.email ?? "" }), [contact]);
  return (
    <section className="card space-y-2 p-4 text-sm">
      <h2 className="font-medium">Contact</h2>
      <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input className="input" placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <input className="input" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <button
        className="btn-ghost"
        onClick={() => update.mutate({ contactId: contact.id, name: form.name, phone: form.phone || null, email: form.email || null })}
      >
        Save
      </button>
      <ErrorNote error={update.error} />
      <label className="label mt-2">Text consent</label>
      <select className="input" value={contact.phoneConsent} onChange={(e) => update.mutate({ contactId: contact.id, phoneConsent: e.target.value as never })}>
        <option value="none">None (public record / skip trace)</option>
        <option value="inbound">They contacted us or replied</option>
        <option value="written">Written consent on file</option>
      </select>
      <div className="flex flex-wrap gap-3 pt-1">
        <Toggle label="On DNC list" checked={contact.onDncList} onChange={(v) => update.mutate({ contactId: contact.id, onDncList: v })} />
        <Toggle label="Opted out (text)" checked={contact.optedOutSms} onChange={(v) => update.mutate({ contactId: contact.id, optedOutSms: v })} />
        <Toggle label="Opted out (email)" checked={contact.optedOutEmail} onChange={(v) => update.mutate({ contactId: contact.id, optedOutEmail: v })} />
      </div>
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

type Msg = Outputs["leads"]["get"]["messages"][number];

function Conversation(props: {
  dealId: number;
  messages: Msg[];
  contact: Contact;
  employees: { id: number; name: string }[];
  onChange: () => void;
}) {
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [body, setBody] = useState("");
  const [goal, setGoal] = useState("");
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const send = trpc.messages.sendManual.useMutation({ onSuccess: () => { setBody(""); props.onChange(); } });
  const draft = trpc.messages.requestDraft.useMutation({ onSuccess: () => { setGoal(""); props.onChange(); } });
  const empId = employeeId ?? props.employees[0]?.id;

  return (
    <section className="card flex flex-col">
      <div className="border-b border-line p-4">
        <h2 className="font-medium">Conversation</h2>
        <p className="text-xs text-muted">{props.contact?.name} · {props.contact?.phone ?? "no phone"} · {props.contact?.email ?? "no email"}</p>
      </div>
      <div className="max-h-[28rem] space-y-2 overflow-y-auto p-4">
        {props.messages.length === 0 && <p className="text-sm text-muted">No messages yet.</p>}
        {props.messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === "inbound" ? "justify-start" : "justify-end"}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.direction === "inbound" ? "bg-slate-100" : "bg-teal-50"}`}>
              {m.subject && <div className="font-medium">{m.subject}</div>}
              <div className="whitespace-pre-wrap">{m.body || <em className="text-muted">({m.purpose})</em>}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                {m.channel} · {when(m.sentAt ?? m.createdAt)}
                {!["sent", "delivered", "received"].includes(m.status) && (
                  <span className={`chip ${STATUS_STYLE[m.status] ?? "bg-slate-100"}`}>{m.status.replace("_", " ")}</span>
                )}
                {m.blockedReason && <span className="text-red-700">{m.blockedReason}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-3 border-t border-line p-4">
        <div className="flex gap-2">
          <select className="input w-auto" value={channel} onChange={(e) => setChannel(e.target.value as "sms" | "email")}>
            <option value="sms">Text</option>
            <option value="email">Email</option>
          </select>
          <textarea className="input min-h-10" rows={2} placeholder="Write a message yourself…" value={body} onChange={(e) => setBody(e.target.value)} />
          <button
            className="btn-primary self-end"
            disabled={!body.trim() || !props.contact || send.isPending}
            onClick={() => props.contact && send.mutate({ contactId: props.contact.id, dealId: props.dealId, channel, body })}
          >
            Send
          </button>
        </div>
        {send.data && send.data.status !== "sent" && (
          <p className="text-sm text-amber-800">{send.data.status}: {send.data.reason}</p>
        )}
        <ErrorNote error={send.error} />
        <div className="flex flex-wrap gap-2">
          <select className="input w-auto" value={empId ?? ""} onChange={(e) => setEmployeeId(Number(e.target.value))}>
            {props.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <input className="input flex-1" placeholder="…or ask your AI employee to draft one (e.g. offer a call Thursday)" value={goal} onChange={(e) => setGoal(e.target.value)} />
          <button
            className="btn-ghost"
            disabled={goal.trim().length < 3 || !empId || draft.isPending}
            onClick={() => empId && draft.mutate({ dealId: props.dealId, employeeId: empId, channel, goal })}
          >
            {draft.isPending ? "Drafting…" : "Draft for approval"}
          </button>
        </div>
        <ErrorNote error={draft.error} />
      </div>
    </section>
  );
}
