"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthShell, authButton, authInput } from "@/components/auth-shell";

type ResetState = "checking" | "ready" | "invalid";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [resetState, setResetState] = useState<ResetState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function checkResetSession() {
      try {
        const params = new URLSearchParams(location.hash.slice(1));
        const access = params.get("access_token");
        const refresh = params.get("refresh_token");
        if (access && refresh) {
          const res = await fetch("/api/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: access, refresh_token: refresh }) });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "This reset link is invalid or expired");
          history.replaceState(null, "", location.pathname);
        } else {
          const res = await fetch("/api/auth/session", { cache: "no-store" });
          const data = await res.json().catch(() => ({})) as { signed_in?: boolean };
          if (!res.ok || !data.signed_in) throw new Error("This reset session is missing or expired.");
        }
        if (active) setResetState("ready");
      } catch (cause) {
        if (!active) return;
        setError((cause as Error).message);
        setResetState("invalid");
      }
    }
    void checkResetSession();
    return () => { active = false; };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const res = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await res.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      if (res.status === 401) {
        setResetState("invalid");
        return setError("This reset session is missing or expired.");
      }
      return setError(data.error ?? "Could not update the password");
    }
    router.replace("/"); router.refresh();
  }
  return <AuthShell title="Choose a new password" subtitle="Use at least 6 characters.">
    {resetState === "checking" ? <p className="py-8 text-center text-sm text-zinc-300">Checking reset link…</p> : resetState === "invalid" ? <div className="space-y-4">
      <p role="alert" className="text-sm text-rose-300">{error}</p>
      <a href="/forgot-password" className={authButton}>Request a new reset link</a>
    </div> : <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm text-zinc-300">New password<input className={authInput} type="password" minLength={6} autoComplete="new-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <button className={authButton} disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
    </form>}
  </AuthShell>;
}
