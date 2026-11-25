import { useState, type ReactNode } from "react";
import { trpc } from "./lib/trpc";
import { useRoute } from "./lib/router";
import { Dashboard } from "./pages/Dashboard";
import { Leads } from "./pages/Leads";
import { LeadDetail } from "./pages/LeadDetail";
import { Pipeline } from "./pages/Pipeline";
import { Approvals } from "./pages/Approvals";
import { Automations } from "./pages/Automations";
import { Team } from "./pages/Team";
import { Imports } from "./pages/Imports";

const NAV = [
  ["", "Today"],
  ["leads", "Leads"],
  ["pipeline", "Pipeline"],
  ["approvals", "Approvals"],
  ["automations", "Automations"],
  ["team", "AI team"],
  ["imports", "Data"],
] as const;

export function App() {
  const me = trpc.auth.me.useQuery();
  if (me.isLoading) return null;
  if (!me.data?.authed) return <Login />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  const [page = "", arg] = route;
  const approvals = trpc.messages.approvals.useQuery(undefined, { refetchInterval: 30_000 });
  const utils = trpc.useUtils();
  const logout = trpc.auth.logout.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  let body: ReactNode;
  if (page === "leads" && arg) body = <LeadDetail dealId={Number(arg)} />;
  else if (page === "leads") body = <Leads />;
  else if (page === "pipeline") body = <Pipeline />;
  else if (page === "approvals") body = <Approvals />;
  else if (page === "automations") body = <Automations />;
  else if (page === "team") body = <Team />;
  else if (page === "imports") body = <Imports />;
  else body = <Dashboard />;

  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-line bg-white md:min-h-screen md:w-52 md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 py-3 md:block">
          <div className="text-lg font-semibold tracking-tight">Folio</div>
          <div className="hidden text-xs text-muted md:block">Miami-Dade</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
          {NAV.map(([path, label]) => {
            const active = page === path;
            const count = path === "approvals" ? approvals.data?.length : 0;
            return (
              <a
                key={path}
                href={`#/${path}`}
                className={`flex shrink-0 items-center justify-between rounded-md px-3 py-1.5 text-sm ${active ? "bg-accent-soft font-medium text-teal-900" : "text-slate-700 hover:bg-slate-100"}`}
              >
                {label}
                {count ? <span className="chip ml-2 bg-accent text-white">{count}</span> : null}
              </a>
            );
          })}
          <button className="shrink-0 rounded-md px-3 py-1.5 text-left text-sm text-muted hover:bg-slate-100 md:mt-4" onClick={() => logout.mutate()}>
            Sign out
          </button>
        </nav>
      </aside>
      <main className="mx-auto w-full max-w-6xl p-4 md:p-6">{body}</main>
    </div>
  );
}

function Login() {
  const [password, setPassword] = useState("");
  const utils = trpc.useUtils();
  const login = trpc.auth.login.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        className="card w-full max-w-sm space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate({ password });
        }}
      >
        <h1 className="text-xl font-semibold">Folio</h1>
        <input className="input" type="password" placeholder="Team password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        {login.error && <p className="text-sm text-red-700">{login.error.message}</p>}
        <button className="btn-primary w-full justify-center" disabled={login.isPending}>
          Sign in
        </button>
      </form>
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function ErrorNote({ error }: { error: { message: string } | null | undefined }) {
  return error ? <p className="mt-2 text-sm text-red-700">{error.message}</p> : null;
}
