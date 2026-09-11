"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthShell, authButton, authInput } from "@/components/auth-shell";

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", board_password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const res = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const data = await res.json().catch(() => ({})) as { error?: string; verification_required?: boolean };
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Could not create the account");
    if (data.verification_required) return setSent(true);
    router.replace("/"); router.refresh();
  }
  return <AuthShell title="Create your account" subtitle="Each account gets a private board and separate Codex and Claude Code connections." footer={<>Already have an account? <Link href="/login" className="font-medium text-indigo-300">Sign in</Link></>}>
    {sent ? <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm leading-6 text-emerald-100">Check your email to confirm the account, then sign in.</div> : <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm text-zinc-300">Name<input className={authInput} autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label className="block text-sm text-zinc-300">Email<input className={authInput} type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
      <label className="block text-sm text-zinc-300">Password<input className={authInput} type="password" minLength={8} autoComplete="new-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /><span className="mt-1 block text-xs text-zinc-500">At least 8 characters</span></label>
      <label className="block text-sm text-zinc-300">Current board password <span className="text-zinc-500">(optional)</span><input className={authInput} type="password" autoComplete="off" value={form.board_password} onChange={(e) => setForm({ ...form, board_password: e.target.value })} /><span className="mt-1 block text-xs leading-5 text-zinc-500">Use this once to move your existing conversations and connections into the new account. New users can leave it blank.</span></label>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <button className={authButton} disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
    </form>}
  </AuthShell>;
}
