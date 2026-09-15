import { z } from "zod";
import { consumeHelperPairing } from "@/lib/helper-pairing";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = z.object({ code: z.string().regex(/^duo_pair_[A-Za-z0-9_-]{43}$/) }).strict().safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "The installer pairing code is invalid" }, { status: 400 });
  const pairing = await consumeHelperPairing(parsed.data.code);
  if (!pairing) return Response.json({ error: "The installer pairing code is invalid, expired, or already used" }, { status: 401 });
  return Response.json(pairing, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
