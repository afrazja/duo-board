import { listDeletions } from "@/lib/deletions";
import { authErrorResponse, requireUser } from "@/lib/account-auth";

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ deletions: await listDeletions(user.id) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: "Could not check session cleanup. It has not been confirmed." }, { status: 503 });
  }
}
