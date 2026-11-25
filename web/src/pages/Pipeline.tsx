import { useState } from "react";
import { trpc } from "../lib/trpc";
import { PageHeader } from "../App";
import { STAGE_LABEL, STAGES, money, scoreColor } from "../lib/format";

export function Pipeline() {
  const { data } = trpc.leads.board.useQuery();
  const utils = trpc.useUtils();
  const setStage = trpc.leads.setStage.useMutation({ onSuccess: () => utils.leads.board.invalidate() });
  const [over, setOver] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Pipeline" />
      <p className="mb-3 text-sm text-muted">Drag a card to change its stage. "New" shows leads scoring 40+.</p>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {STAGES.map((stage) => {
          const cards = data?.filter((d) => d.stage === stage) ?? [];
          return (
            <div
              key={stage}
              className={`w-64 shrink-0 rounded-lg border p-2 ${over === stage ? "border-accent bg-accent-soft" : "border-line bg-slate-100"}`}
              onDragOver={(e) => { e.preventDefault(); setOver(stage); }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                setOver(null);
                const id = Number(e.dataTransfer.getData("text/plain"));
                if (id) setStage.mutate({ dealId: id, stage: stage as never });
              }}
            >
              <div className="mb-2 flex justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted">
                {STAGE_LABEL[stage]} <span>{cards.length}</span>
              </div>
              <div className="space-y-2">
                {cards.map((c) => (
                  <a
                    key={c.dealId}
                    href={`#/leads/${c.dealId}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", String(c.dealId))}
                    className="card block p-2.5 text-sm hover:border-accent"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium">{c.address ?? "—"}</span>
                      <span className={`chip ${scoreColor(c.score)}`}>{c.score}</span>
                    </div>
                    <div className="text-xs text-muted">{c.owner ?? ""}</div>
                    {c.askingPrice ? <div className="mt-1 text-xs">Asking {money(c.askingPrice)}</div> : null}
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
