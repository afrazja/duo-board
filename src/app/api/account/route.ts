import { accountsEnabled, currentAccount } from "@/lib/account";

// Who is signed in, and how sign-in works on this deployment. Open to signed-out
// callers so the page can decide whether to show the account sign-in or the
// shared-password form.
export async function GET() {
  const mode = accountsEnabled() ? "accounts" : "password";
  try {
    const account = await currentAccount();
    return Response.json({ mode, signed_in: !!account, user: account && account.mode === "accounts" ? { id: account.owner, email: account.email } : null });
  } catch (e) {
    return Response.json({ mode, signed_in: false, user: null, error: (e as Error).message }, { status: 500 });
  }
}
