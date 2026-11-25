import { useState } from "react";
import { trpc, type Outputs } from "../lib/trpc";
import { ErrorNote, PageHeader } from "../App";
import { when } from "../lib/format";

export function Approvals() {
  const { data } = trpc.messages.approvals.useQuery();
  return (
    <div>
      <PageHeader title="Approvals" />
      <p className="mb-4 text-sm text-muted">
        Drafts from your AI team wait here until you approve them. Edits you make are remembered as preferences. Texts to numbers with no consent always come here, whatever the employee's trust level.
      </p>
      {data?.length === 0 && <div className="card p-6 text-center text-muted">Nothing waiting.</div>}
      <div className="space-y-3">{data?.map((m) => <ApprovalCard key={m.id} m={m} />)}</div>
    </div>
  );
}

type Item = Outputs["messages"]["approvals"][number];

function ApprovalCard({ m }: { m: Item }) {
  const [body, setBody] = useState(m.body);
  const [subject, setSubject] = useState(m.subject ?? "");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const utils = trpc.useUtils();
  const done = () => {
    utils.messages.approvals.invalidate();
    utils.dashboard.summary.invalidate();
  };
  const approve = trpc.messages.approve.useMutation({ onSuccess: done });
  const reject = trpc.messages.reject.useMutation({ onSuccess: done });
  const tooLong = m.channel === "sms" && body.length > 320;
  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div>
          <a className="font-medium hover:underline" href={m.dealId ? `#/leads/${m.dealId}` : undefined}>{m.contactName}</a>
          <span className="text-muted"> · {m.channel === "sms" ? "Text" : "Email"} by {m.employeeName ?? "AI"} · {when(m.createdAt)}</span>
        </div>
        {m.channel === "sms" && m.phoneConsent === "none" && <span className="chip bg-amber-100 text-amber-800">First contact: no consent on file</span>}
      </div>
      {m.purpose && <p className="mb-2 text-xs text-muted">Goal: {m.purpose}</p>}
      {m.channel === "email" && <input className="input mb-2" value={subject} onChange={(e) => setSubject(e.target.value)} />}
      <textarea className="input" rows={m.channel === "sms" ? 3 : 7} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="mt-1 text-xs text-muted">
        {body.length} characters{tooLong && <span className="text-red-700"> · long for a text</span>}
        {m.sendAfter && ` · will send after ${when(m.sendAfter)}`}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="btn-primary"
          disabled={approve.isPending || !body.trim()}
          onClick={() => approve.mutate({ messageId: m.id, ...(body !== m.body || subject !== (m.subject ?? "") ? { body, subject: subject || null } : {}) })}
        >
          {body !== m.body ? "Approve edited" : "Approve"}
        </button>
        {!rejecting ? (
          <button className="btn-danger" onClick={() => setRejecting(true)}>Reject</button>
        ) : (
          <>
            <input className="input flex-1" placeholder="Why? (optional, becomes a team rule)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn-danger" onClick={() => reject.mutate({ messageId: m.id, reason: reason || undefined })}>Confirm reject</button>
          </>
        )}
      </div>
      {approve.data && approve.data.status !== "sent" && <p className="mt-2 text-sm text-amber-800">{approve.data.status}: {approve.data.reason}</p>}
      <ErrorNote error={approve.error ?? reject.error} />
    </div>
  );
}
