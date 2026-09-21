import { z } from "zod";
import { requireUser } from "@/lib/account-auth";
import { createHelperPairing } from "@/lib/helper-pairing";

export async function POST(request: Request) {
  try {
    const origin = new URL(request.url).origin;
    if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ error: "Cross-site helper changes are not allowed" }, { status: 403 });
    }
    const user = await requireUser();
    const parsed = z.object({ thread_id: z.string().uuid() }).strict().safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "Open a conversation before connecting the helper" }, { status: 400 });
    const pairing = await createHelperPairing(user.id, parsed.data.thread_id, origin);
    return Response.json({ pairing_code: pairing.code, expires_at: pairing.expiresAt, installer_url: "/downloads/DuoBoardHelperSetup.exe?v=0.3.0" }, {
      status: 201,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    if ((error as Error).message === "AUTH_REQUIRED") return Response.json({ error: "Not signed in" }, { status: 401 });
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
