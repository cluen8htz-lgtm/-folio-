export const SIGNAL_LABEL: Record<string, string> = {
  foreclosure: "Foreclosure",
  probate: "Probate",
  tax_lien: "Tax lien",
  code_violation: "Code violation",
};
export const SIGNAL_COLOR: Record<string, string> = {
  foreclosure: "bg-red-100 text-red-800",
  probate: "bg-violet-100 text-violet-800",
  tax_lien: "bg-amber-100 text-amber-800",
  code_violation: "bg-sky-100 text-sky-800",
};
export const STAGE_LABEL: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  conversation: "In conversation",
  appointment: "Appointment",
  offer: "Offer made",
  under_contract: "Under contract",
  closed: "Closed",
  dead: "Dead",
};
export const STAGES = Object.keys(STAGE_LABEL);

export function money(n: number | null | undefined) {
  return n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
export function when(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function scoreColor(s: number) {
  return s >= 70 ? "bg-red-600 text-white" : s >= 45 ? "bg-amber-500 text-white" : "bg-slate-200 text-slate-700";
}
export function formatFolio(f: string) {
  return f.length === 13 ? `${f.slice(0, 2)}-${f.slice(2, 6)}-${f.slice(6, 9)}-${f.slice(9)}` : f;
}
