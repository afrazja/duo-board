"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthShell, authButton, authInput } from "@/components/auth-shell";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const res = await fetch("/api/auth/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => ({})) as { error?: string };
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Could not send the recovery email");
    setSent(true);
  }
  return <AuthShell title="Reset your password" subtitle="We’ll send a secure reset link to your email." footer={<Link href="/login" className="font-medium text-indigo-300">Back to sign in</Link>}>
    {sent ? <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm leading-6 text-emerald-100">If an account exists for that address, a reset link is on its way.</p> : <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm text-zinc-300">Email<input className={authInput} type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <button className={authButton} disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
    </form>}
  </AuthShell>;
}
