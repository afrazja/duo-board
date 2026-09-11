import { currentAccount } from "@/lib/account";
import { listDeletions } from "@/lib/deletions";

export async function GET() {
  const account = await currentAccount();
  if (!account) return Response.json({ error: "Not signed in" }, { status: 401 });
  try { return Response.json({ deletions: await listDeletions(account.owner) }); }
  catch { return Response.json({ error: "Could not check session cleanup. It has not been confirmed." }, { status: 503 }); }
}
