"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ControlPopover } from "./control-popover";

type Assistant = "chatgpt" | "claude";
interface Account {
  id: string;
  email: string;
  display_name: string;
  connections: { assistant: Assistant; configured: boolean; token_last_four: string | null; created_at: string | null }[];
}

const LABEL: Record<Assistant, string> = { chatgpt: "Codex", claude: "Claude Code" };

export function AccountMenu() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Assistant | null>(null);
  const [command, setCommand] = useState<{ assistant: Assistant; value: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetch("/api/account").then(async (res) => {
      if (res.status === 401) { router.replace("/login"); return; }
      const data = await res.json() as { account?: Account; error?: string };
      if (!res.ok || !data.account) throw new Error(data.error ?? "Could not load account");
      setAccount(data.account);
    }).catch((cause) => setError((cause as Error).message));
  }, [router]);

  async function connect(assistant: Assistant) {
    setBusy(assistant); setError(""); setCommand(null); setCopied(false);
    try {
      const res = await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assistant }) });
      const data = await res.json() as { account?: Account; command?: string; error?: string };
      if (!res.ok || !data.account || !data.command) throw new Error(data.error ?? "Could not create connection");
      setAccount(data.account); setCommand({ assistant, value: data.command });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); }
  }

  async function copyCommand() {
    if (!command) return;
    await navigator.clipboard.writeText(command.value);
    setCopied(true);
  }

  async function logOut() {
    await fetch("/api/auth/login", { method: "DELETE" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  const initial = account?.display_name.trim().charAt(0).toUpperCase() || account?.email.charAt(0).toUpperCase() || "?";
  return <ControlPopover label="Account" panelClass="!w-[min(360px,calc(100vw-32px))]" buttonClass="!h-10 !w-10 !rounded-full !border-indigo-400/50 !bg-indigo-500/15 !p-0 !font-semibold !text-indigo-100" trigger={initial}>
    <div className="mb-4 border-b border-zinc-700 pb-4">
      <p className="truncate text-sm font-semibold text-zinc-100">{account?.display_name ?? "Your account"}</p>
      <p className="mt-1 truncate text-xs text-zinc-400">{account?.email ?? "Loading…"}</p>
    </div>
    <h2 className="text-sm font-semibold text-zinc-100">Connect assistants</h2>
    <p className="mb-3 mt-1 text-xs leading-5 text-zinc-400">Each connection can reach only this account. Creating a new one replaces the old token.</p>
    <div className="space-y-2">
      {(["chatgpt", "claude"] as Assistant[]).map((assistant) => {
        const connection = account?.connections.find((item) => item.assistant === assistant);
        return <div key={assistant} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-sm font-medium text-zinc-200">{LABEL[assistant]}</p><p className="mt-0.5 text-xs text-zinc-500">{connection?.configured ? `Connected · ends ${connection.token_last_four}` : "Not connected"}</p></div>
            <button type="button" disabled={busy !== null} onClick={() => void connect(assistant)} className="min-h-9 rounded-lg border border-zinc-700 px-2.5 text-xs text-zinc-200 hover:border-zinc-500 disabled:opacity-50">{busy === assistant ? "Creating…" : connection?.configured ? "Replace" : "Connect"}</button>
          </div>
        </div>;
      })}
    </div>
    {command && <div className="mt-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3">
      <p className="text-xs font-semibold text-indigo-100">New {LABEL[command.assistant]} command</p>
      <p className="my-2 text-xs leading-5 text-indigo-100/70">Copy it now. The secret is shown only once.</p>
      <code className="block max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-2 text-[11px] leading-5 text-zinc-200">{command.value}</code>
      <button type="button" onClick={() => void copyCommand()} className="mt-2 min-h-9 rounded-lg bg-indigo-500 px-3 text-xs font-semibold text-white hover:bg-indigo-400">{copied ? "Copied" : "Copy command"}</button>
    </div>}
    {error && <p role="alert" className="mt-3 text-xs text-rose-300">{error}</p>}
    <button type="button" onClick={() => void logOut()} className="mt-4 min-h-10 w-full rounded-lg border border-zinc-700 text-sm font-medium text-zinc-200 hover:bg-zinc-800">Log out</button>
  </ControlPopover>;
}
