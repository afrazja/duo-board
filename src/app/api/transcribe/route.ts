import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authErrorResponse, requireUser } from "@/lib/account-auth";
import { db } from "@/lib/db";
import { cleanupFinishedTranscription, MAX_TRANSCRIPTION_BYTES, removeTranscriptionAudio, storeTranscriptionAudio } from "@/lib/helper-transcription";

export const runtime = "nodejs";
export const maxDuration = 60;

const id = z.string().uuid();
const terminal = new Set(["completed", "stopped", "failed", "attention", "cancelled"]);

function failure(cause: unknown) {
  const auth = authErrorResponse(cause);
  if (auth) return auth;
  console.error("[api/transcribe] helper transcription failure", { message: (cause as Error).message });
  return Response.json({ error: "The local transcription request could not be prepared. Please try again." }, { status: 503 });
}

function isPcmWav(bytes: Uint8Array) {
  if (bytes.byteLength < 44) return false;
  const tag = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  return tag(0) === "RIFF" && tag(8) === "WAVE";
}

export async function POST(request: Request) {
  let uploadedPath: string | null = null;
  try {
    const user = await requireUser();
    const form = await request.formData();
    const threadId = id.parse(form.get("thread_id"));
    const audio = form.get("audio");
    if (!(audio instanceof File) || !audio.size) return Response.json({ error: "An audio recording is required." }, { status: 400 });
    if (audio.size > MAX_TRANSCRIPTION_BYTES) return Response.json({ error: "This recording is too large. Please split it into shorter parts." }, { status: 413 });
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (!isPcmWav(bytes)) return Response.json({ error: "This recording could not be converted for local transcription." }, { status: 415 });

    const { data: status, error: statusError } = await db().rpc("helper_user", { p_owner: user.id, p_action: "status", p_args: {} });
    if (statusError) throw statusError;
    const capabilities = Array.isArray(status?.capabilities) ? status.capabilities : [];
    if (!status?.configured || !capabilities.includes("local_transcription")) {
      return Response.json({ error: "Update the Duo Board helper once to enable private local voice transcription.", code: "helper_update_required" }, { status: 409 });
    }
    if (!status?.connected) return Response.json({ error: "Open the Duo Board helper on your computer, then try again.", code: "helper_offline" }, { status: 503 });

    const requestId = randomUUID();
    const stored = await storeTranscriptionAudio(user.id, requestId, bytes);
    uploadedPath = stored.path;
    const { data, error } = await db().rpc("helper_user", {
      p_owner: user.id,
      p_action: "enqueue",
      p_args: { id: requestId, thread_id: threadId, action: "transcribe", audio_path: stored.path, audio_sha256: stored.sha256, audio_bytes: stored.bytes },
    });
    if (error) throw error;
    return Response.json({ id: requestId, status: data.status }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (uploadedPath) await removeTranscriptionAudio(uploadedPath).catch(() => {});
    return failure(cause);
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const requestId = id.parse(new URL(request.url).searchParams.get("id"));
    const { data, error } = await db().from("helper_requests").select("status,result,error").eq("id", requestId).eq("owner_id", user.id).eq("action", "transcribe").maybeSingle();
    if (error) throw error;
    if (!data) return Response.json({ error: "Transcription request not found." }, { status: 404 });
    if (terminal.has(data.status)) await cleanupFinishedTranscription(requestId).catch(() => {});
    return Response.json({ status: data.status, text: data.status === "completed" ? data.result : undefined, error: data.error ?? undefined }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) { return failure(cause); }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const requestId = id.parse(new URL(request.url).searchParams.get("id"));
    const { data, error } = await db().from("helper_requests").update({ status: "cancelled", finished_at: new Date().toISOString(), result: null }).eq("id", requestId).eq("owner_id", user.id).eq("action", "transcribe").in("status", ["pending", "received"]).select("prompt").maybeSingle();
    if (error) throw error;
    if (data?.prompt) await removeTranscriptionAudio(data.prompt).catch(() => {});
    return new Response(null, { status: 204 });
  } catch (cause) { return failure(cause); }
}
