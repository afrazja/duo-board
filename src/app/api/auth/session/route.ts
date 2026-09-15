import { currentUser } from "@/lib/account-auth";

export async function GET() {
  return Response.json({ signed_in: Boolean(await currentUser()) });
}
