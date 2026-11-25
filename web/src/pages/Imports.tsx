import { useState } from "react";
import { trpc } from "../lib/trpc";
import { ErrorNote, PageHeader } from "../App";
import { SIGNAL_LABEL, formatFolio, when } from "../lib/format";

type SignalType = "foreclosure" | "probate" | "tax_lien" | "code_violation";

export function Imports() {
  const utils = trpc.useUtils();
  const sources = trpc.imports.sources.useQuery();
  const runs = trpc.imports.runs.useQuery();
  const summary = trpc.dashboard.summary.useQuery();
  const [type, setType] = useState<SignalType>("foreclosure");
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const preview = trpc.imports.preview.useMutation();
  const refresh = () => {
    utils.imports.runs.invalidate();
    utils.dashboard.summary.invalidate();
    utils.leads.list.invalidate();
  };
  const upload = trpc.imports.uploadCsv.useMutation({ onSuccess: () => { setCsv(null); preview.reset(); refresh(); } });
  const skip = trpc.imports.skipTrace.useMutation({ onSuccess: refresh });
  const live = trpc.imports.runLive.useMutation({ onSuccess: refresh });

  const readFile = (f: File | undefined, then: (text: string) => void) => {
    if (!f) return;
    setFileName(f.name);
    f.text().then(then);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Data" />
      <section className="card p-4 text-sm">
        <h2 className="mb-1 font-medium">Miami-Dade public records</h2>
        <p className="mb-3 text-muted">
          Upload an export (CSV) from the Clerk of Court, Tax Collector or code compliance. Columns are matched by name; rows need a 13-digit folio. Re-uploading the same file adds nothing twice.
        </p>
        <div className="flex flex-wrap gap-2">
          <select className="input w-auto" value={type} onChange={(e) => { setType(e.target.value as SignalType); preview.reset(); }}>
            {sources.data?.map((s) => <option key={s.type} value={s.type}>{s.label}</option>)}
          </select>
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={(e) => readFile(e.target.files?.[0], (text) => { setCsv(text); preview.mutate({ type, csv: text }); })}
          />
        </div>
        {preview.data && (
          <div className="mt-3 rounded-md border border-line bg-slate-50 p-3">
            <p>
              <b>{fileName}</b>: {preview.data.valid} usable rows as {SIGNAL_LABEL[type]}, {preview.data.skippedCount} skipped.
            </p>
            {preview.data.sample.length > 0 && (
              <ul className="mt-1 text-xs text-muted">
                {preview.data.sample.map((r) => (
                  <li key={r.externalId}>{formatFolio(r.folio)} · {r.address ?? "no address"} · {r.ownerName ?? "no owner"} · {r.filedOn ?? "no date"}</li>
                ))}
              </ul>
            )}
            {preview.data.skipped.length > 0 && (
              <p className="mt-1 text-xs text-amber-800">
                Skipped rows: {preview.data.skipped.slice(0, 8).map((s) => `${s.row} (${s.reason})`).join(", ")}
              </p>
            )}
            <button className="btn-primary mt-2" disabled={!csv || preview.data.valid === 0 || upload.isPending} onClick={() => csv && upload.mutate({ type, csv })}>
              {upload.isPending ? "Importing…" : `Import ${preview.data.valid} records`}
            </button>
          </div>
        )}
        {upload.data && <p className="mt-2 text-teal-800">Imported: {upload.data.created} new records, {upload.data.newDeals} new leads.</p>}
        <ErrorNote error={preview.error ?? upload.error} />
        <div className="mt-4 border-t border-line pt-3">
          <button className="btn-ghost" disabled={!summary.data?.setup.liveCodeViolations || live.isPending} onClick={() => live.mutate()}>
            {live.isPending ? "Pulling…" : "Pull code violations now"}
          </button>
          <span className="ml-2 text-xs text-muted">
            {summary.data?.setup.liveCodeViolations ? "Also runs daily." : "Set MDC_CODE_VIOLATIONS_LAYER_URL to enable."}
          </span>
          <ErrorNote error={live.error} />
        </div>
      </section>
      <section className="card p-4 text-sm">
        <h2 className="mb-1 font-medium">Skip-trace results</h2>
        <p className="mb-3 text-muted">
          Upload your skip-trace vendor's CSV (folio, phone, email, DNC flag). Numbers from skip tracing have no consent, so first texts to them always go through Approvals.
        </p>
        <input type="file" accept=".csv,text/csv" className="text-sm" onChange={(e) => readFile(e.target.files?.[0], (text) => skip.mutate({ csv: text }))} />
        {skip.data && <p className="mt-2 text-teal-800">{skip.data.matched} of {skip.data.rows} rows matched a lead ({skip.data.unmatched} folios not found).</p>}
        <ErrorNote error={skip.error} />
      </section>
      <section className="card p-4 text-sm">
        <h2 className="mb-2 font-medium">Import history</h2>
        <ul className="space-y-1 text-muted">
          {runs.data?.map((r) => (
            <li key={r.id}>{when(r.startedAt)} · {r.source} · <span className={r.status === "error" ? "text-red-700" : ""}>{r.status}</span> · {r.created} new of {r.fetched}{r.error ? ` · ${r.error}` : ""}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
