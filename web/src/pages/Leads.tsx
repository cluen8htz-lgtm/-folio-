import { useState } from "react";
import { trpc } from "../lib/trpc";
import { PageHeader } from "../App";
import { SIGNAL_COLOR, SIGNAL_LABEL, STAGE_LABEL, formatFolio, scoreColor } from "../lib/format";

type Signal = "foreclosure" | "probate" | "tax_lien" | "code_violation";
type Stage = keyof typeof STAGE_LABEL;

export function Leads() {
  const [search, setSearch] = useState("");
  const [signal, setSignal] = useState<Signal | "">("");
  const [stage, setStage] = useState<Stage | "">("");
  const [minScore, setMinScore] = useState(0);
  const [phone, setPhone] = useState<"" | "yes" | "no">("");
  const [page, setPage] = useState(0);
  const limit = 50;
  const { data, isFetching } = trpc.leads.list.useQuery({
    search: search || undefined,
    signal: signal || undefined,
    stage: (stage || undefined) as never,
    minScore,
    hasPhone: phone === "" ? undefined : phone === "yes",
    limit,
    offset: page * limit,
  });

  return (
    <div>
      <PageHeader title="Leads" />
      <div className="card mb-3 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-6">
        <input className="input sm:col-span-2" placeholder="Address, owner or folio" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
        <select className="input" value={signal} onChange={(e) => { setSignal(e.target.value as Signal); setPage(0); }}>
          <option value="">All signals</option>
          {Object.entries(SIGNAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" value={stage} onChange={(e) => { setStage(e.target.value as Stage); setPage(0); }}>
          <option value="">All stages</option>
          {Object.entries(STAGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" value={minScore} onChange={(e) => { setMinScore(Number(e.target.value)); setPage(0); }}>
            <option value={0}>Any score</option>
            <option value={40}>40+</option>
            <option value={60}>60+</option>
            <option value={80}>80+</option>
        </select>
        <select className="input" value={phone} onChange={(e) => { setPhone(e.target.value as "" | "yes" | "no"); setPage(0); }}>
            <option value="">Phone: any</option>
            <option value="yes">Has phone</option>
            <option value="no">Needs skip trace</option>
        </select>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="p-2.5">Score</th>
              <th className="p-2.5">Property</th>
              <th className="p-2.5">Owner</th>
              <th className="p-2.5">Signals</th>
              <th className="p-2.5">Stage</th>
            </tr>
          </thead>
          <tbody className={isFetching ? "opacity-60" : ""}>
            {data?.map((r) => (
              <tr key={r.dealId} className="cursor-pointer border-b border-line last:border-0 hover:bg-slate-50" onClick={() => (window.location.hash = `#/leads/${r.dealId}`)}>
                <td className="p-2.5"><span className={`chip ${scoreColor(r.score)}`}>{r.score}</span></td>
                <td className="p-2.5">
                  <div className="font-medium">{r.address ?? "—"}</div>
                  <div className="text-xs text-muted">{r.city ?? ""} · {formatFolio(r.folio)}</div>
                </td>
                <td className="p-2.5">
                  <div>{r.owner ?? "—"}</div>
                  <div className="text-xs text-muted">{r.phone ?? "no phone"}</div>
                </td>
                <td className="p-2.5">
                  <div className="flex flex-wrap gap-1">
                    {r.signals.map((s) => <span key={s} className={`chip ${SIGNAL_COLOR[s]}`}>{SIGNAL_LABEL[s]}</span>)}
                  </div>
                </td>
                <td className="p-2.5 whitespace-nowrap">{STAGE_LABEL[r.stage]}</td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-muted">No leads match. Import data under Data.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <button className="btn-ghost" disabled={(data?.length ?? 0) < limit} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
