import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/account-auth";
import { getClient, type Client } from "@/lib/oauth";
import { assistantFor, parseAuthorizeRequest, redirectBack } from "@/lib/oauth-core";
import { originFromHeaders } from "@/lib/origin";

// The consent page of the board's sign-in service. A connector (claude.ai,
// ChatGPT, or any MCP client) sends the person here; the proxy makes sure
// they are signed in first. They choose which assistant the connection
// speaks as and allow or deny. The decision posts to /api/oauth/authorize.

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Duo Board</p>
        <h1 className="mb-4 text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const h = await headers();
  const origin = originFromHeaders((n) => h.get(n), "http://localhost");
  const clientId = typeof params.client_id === "string" ? params.client_id : null;

  let client: Client | null = null;
  try {
    client = clientId ? await getClient(clientId) : null;
  } catch (e) {
    return <Shell title="The sign-in service is not set up"><p className="text-sm text-rose-400">{(e as Error).message}</p></Shell>;
  }
  const parsed = parseAuthorizeRequest(params, client, origin);
  if (!parsed.ok) {
    if (parsed.fatal) return <Shell title="This connection request cannot be completed"><p className="text-sm text-zinc-300">{parsed.message}</p></Shell>;
    const back = redirectBack(parsed.redirectUri, { error: parsed.error, error_description: parsed.message, state: parsed.state });
    return (
      <Shell title="This connection request cannot be completed">
        <p className="mb-4 text-sm text-zinc-300">{parsed.message}</p>
        <a href={back} className="text-sm text-indigo-400 hover:underline">Return to {client?.name ?? "the app"}</a>
      </Shell>
    );
  }
  const user = await currentUser();
  if (!user) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (typeof v === "string") query.set(k, v);
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  }
  const { request } = parsed;
  const name = client?.name ?? "An app";
  const suggested = assistantFor(client?.name);
  const hidden: [string, string | null][] = [
    ["client_id", request.clientId],
    ["redirect_uri", request.redirectUri],
    ["state", request.state],
    ["code_challenge", request.codeChallenge],
    ["code_challenge_method", "S256"],
    ["response_type", "code"],
    ["scope", request.scope],
    ["resource", request.resource],
  ];

  return (
    <Shell title={`${name} wants to join your board`}>
      <p className="mb-4 text-sm text-zinc-400">
        It will read the conversations on this board and post replies as the assistant you pick.
        {user.email ? ` Signed in as ${user.email}.` : ""}
      </p>
      <form method="post" action="/api/oauth/authorize">
        {hidden.map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
        <fieldset className="mb-5">
          <legend className="mb-2 text-sm font-medium">This connection speaks as</legend>
          {(["claude", "chatgpt"] as const).map((who) => (
            <label key={who} className="mb-2 flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm has-[:checked]:border-indigo-500">
              <input type="radio" name="assistant" value={who} defaultChecked={who === suggested} className="accent-indigo-500" />
              {who === "claude" ? "Claude" : "ChatGPT"}
            </label>
          ))}
        </fieldset>
        <div className="flex gap-2">
          <button type="submit" name="decision" value="allow" className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500">Allow</button>
          <button type="submit" name="decision" value="deny" className="flex-1 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">Deny</button>
        </div>
      </form>
    </Shell>
  );
}
