import { trpc } from "../lib/trpc";
import { PageHeader } from "../App";
import { STAGE_LABEL, scoreColor, when } from "../lib/format";

export function Dashboard() {
  const { data } = trpc.dashboard.summary.useQuery();
  const tasks = trpc.tasks.list.useQuery();
  const utils = trpc.useUtils();
  const complete = trpc.tasks.complete.useMutation({ onSuccess: () => utils.tasks.list.invalidate() });
  const accept = trpc.tasks.acceptProposal.useMutation({
    onSuccess: () => {
      utils.tasks.list.invalidate();
      utils.messages.approvals.invalidate();
    },
  });
  if (!data) return null;
  const s = data.setup;
  const setupGaps = [
    !s.ai && "Add ANTHROPIC_API_KEY so your AI team can write messages and build automations (template drafts are used until then).",
    !s.twilio && "Add your Twilio credentials and an A2P 10DLC-registered number to send texts.",
    s.twilio && s.twilioDryRun && "TWILIO_DRY_RUN is on: texts are logged, not sent.",
    !s.postalAddress && "Set BUSINESS_POSTAL_ADDRESS (required in commercial email).",
    !s.liveCodeViolations && "Set MDC_CODE_VIOLATIONS_LAYER_URL for the daily code-violation pull.",
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-5">
      <PageHeader title="Today" />
      {setupGaps.length > 0 && (
        <div className="card border-amber-200 bg-amber-50 p-4 text-sm">
          <div className="mb-1 font-medium">Finish setup</div>
          <ul className="list-disc space-y-0.5 pl-5">{setupGaps.map((g) => <li key={g}>{g}</li>)}</ul>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Waiting for approval" value={data.pendingApprovals} href="#/approvals" />
        <Stat label="Messages sent (24h)" value={data.sentLast24h} />
        <Stat label="In conversation" value={data.byStage.conversation ?? 0} href="#/pipeline" />
        <Stat label="Open tasks" value={data.openTasks} />
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-2 font-medium">To do</h2>
          {tasks.data?.length === 0 && <p className="text-sm text-muted">Nothing waiting on you.</p>}
          <ul className="divide-y divide-line">
            {tasks.data?.slice(0, 12).map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <a href={t.dealId ? `#/leads/${t.dealId}` : undefined} className="hover:underline">{t.title}</a>
                <div className="flex shrink-0 gap-1">
                  {t.proposal && <button className="btn-primary" onClick={() => accept.mutate({ id: t.id })}>Draft it</button>}
                  <button className="btn-ghost" onClick={() => complete.mutate({ id: t.id })}>{t.proposal ? "Skip" : "Done"}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <h2 className="mb-2 font-medium">Most motivated new leads</h2>
          <ul className="divide-y divide-line">
            {data.hot.map((h) => (
              <li key={h.dealId} className="flex items-center justify-between py-2 text-sm">
                <a className="hover:underline" href={`#/leads/${h.dealId}`}>{h.address ?? "Unknown address"}</a>
                <span className={`chip ${scoreColor(h.score)}`}>{h.score}</span>
              </li>
            ))}
            {data.hot.length === 0 && <p className="text-sm text-muted">Import county data under Data to see leads.</p>}
          </ul>
        </section>
        <section className="card p-4 md:col-span-2">
          <h2 className="mb-2 font-medium">Pipeline</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            {Object.entries(STAGE_LABEL).map(([k, v]) => (
              <span key={k} className="chip bg-slate-100 text-slate-700">{v}: {data.byStage[k] ?? 0}</span>
            ))}
          </div>
          <h2 className="mt-4 mb-2 font-medium">Recent imports</h2>
          <ul className="text-sm text-muted">
            {data.recentImports.map((r) => (
              <li key={r.id}>{when(r.startedAt)} · {r.source} · {r.status} · {r.created} new of {r.fetched}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const inner = (
    <div className="card p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
  return href ? <a href={href}>{inner}</a> : inner;
}
