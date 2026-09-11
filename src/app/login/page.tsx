"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthShell, authButton, authInput } from "@/components/auth-shell";

export default function LoginPage() {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);

  useEffect(() => {
    queueMicrotask(() => setConfirmed(new URLSearchParams(location.search).get("confirmed") === "1"));
    const params = new URLSearchParams(location.hash.slice(1));
    const access = params.get("access_token");
    const refresh = params.get("refresh_token");
    if (!access || !refresh) return;
    queueMicrotask(() => setLinkBusy(true));
    void fetch("/api/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: access, refresh_token: refresh }) })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "This link is invalid or expired");
        history.replaceState(null, "", location.pathname + location.search);
        router.replace(params.get("type") === "recovery" ? "/reset-password" : "/");
        router.refresh();
      })
      .catch((cause) => { setError((cause as Error).message); setLinkBusy(false); });
  }, [router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const data = await res.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Could not sign in");
    router.replace("/"); router.refresh();
  }

  return <AuthShell title="Welcome back" subtitle="Sign in to your private board and assistant connections." footer={<>New here? <Link href="/signup" className="font-medium text-indigo-300 hover:text-indigo-200">Create an account</Link></>}>
    {confirmed && <p role="status" className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">Email confirmed. Sign in to continue.</p>}
    {linkBusy ? <p className="py-8 text-center text-sm text-zinc-300">Finishing sign in…</p> : <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm text-zinc-300">Email<input className={authInput} type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="block text-sm text-zinc-300">Password<input className={authInput} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <div className="text-right"><Link href="/forgot-password" className="text-sm text-indigo-300 hover:text-indigo-200">Forgot password?</Link></div>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <button className={authButton} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>}
  </AuthShell>;
}
