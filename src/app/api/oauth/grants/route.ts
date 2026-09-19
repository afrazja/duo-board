import { z } from "zod";
import { authErrorResponse, requireUser } from "@/lib/account-auth";
import { listGrants, revokeGrant } from "@/lib/oauth";

// The connectors signed in to this board. GET lists them; DELETE {id} signs
// one out; its tokens stop working at once.
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ grants: await listGrants(user.id) });
  } catch (e) {
    return authErrorResponse(e) ?? Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser();
    const parsed = z.object({ id: z.string().uuid() }).safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "id must be a grant id" }, { status: 400 });
    return Response.json({ ok: await revokeGrant(user.id, parsed.data.id) });
  } catch (e) {
    return authErrorResponse(e) ?? Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
