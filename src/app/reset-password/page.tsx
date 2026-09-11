"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthShell, authButton, authInput } from "@/components/auth-shell";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const access = params.get("access_token");
    const refresh = params.get("refresh_token");
    if (!access || !refresh) { queueMicrotask(() => setReady(true)); return; }
    void fetch("/api/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: access, refresh_token: refresh }) })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "This reset link is invalid or expired");
        history.replaceState(null, "", location.pathname); setReady(true);
      }).catch((cause) => { setError((cause as Error).message); setReady(true); });
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const res = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await res.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Could not update the password");
    router.replace("/"); router.refresh();
  }
  return <AuthShell title="Choose a new password" subtitle="Use at least 8 characters.">
    {!ready ? <p className="py-8 text-center text-sm text-zinc-300">Checking reset link…</p> : <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm text-zinc-300">New password<input className={authInput} type="password" minLength={8} autoComplete="new-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <button className={authButton} disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
    </form>}
  </AuthShell>;
}
