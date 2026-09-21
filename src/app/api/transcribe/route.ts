import { transcribe } from "ai";
import { authErrorResponse, requireUser } from "@/lib/account-auth";

export const maxDuration = 300;

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File) || !audio.size) {
      return Response.json({ error: "An audio recording is required." }, { status: 400 });
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "This recording is too large. Please split it into shorter parts." }, { status: 413 });
    }
    if (audio.type && !audio.type.startsWith("audio/")) {
      return Response.json({ error: "The uploaded file is not an audio recording." }, { status: 415 });
    }

    const result = await transcribe({
      model: "fish-audio/transcribe-1",
      audio: new Uint8Array(await audio.arrayBuffer()),
      abortSignal: AbortSignal.timeout(240_000),
      providerOptions: { gateway: { user: user.id, tags: ["feature:dictation"] } },
    });
    const text = result.text.trim();
    if (!text) return Response.json({ error: "No speech was detected in this recording." }, { status: 422 });
    return Response.json({ text, language: result.language, duration: result.durationInSeconds });
  } catch (cause) {
    return authErrorResponse(cause)
      ?? Response.json({ error: "Could not transcribe this recording. Please try again." }, { status: 502 });
  }
}
