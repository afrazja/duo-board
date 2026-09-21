import { transcribe } from "ai";
import { authErrorResponse, requireUser } from "@/lib/account-auth";

export const maxDuration = 300;

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

type ProviderFailure = Error & {
  statusCode?: number;
  responseBody?: string;
  cause?: unknown;
};

function transcriptionErrorResponse(cause: unknown): Response {
  const auth = authErrorResponse(cause);
  if (auth) return auth;

  const failure = cause as ProviderFailure;
  const details = [failure.message, failure.responseBody, String(failure.cause ?? "")].join(" ");
  console.error("[api/transcribe] provider failure", {
    name: failure.name,
    message: failure.message,
    statusCode: failure.statusCode,
    cause: String(failure.cause ?? ""),
  });

  if (/valid credit card|customer_verification_required/i.test(details)) {
    return Response.json({
      error: "Voice transcription is not activated for this app yet. The Vercel AI Gateway requires a payment card before it unlocks its free credits.",
      code: "gateway_payment_required",
    }, { status: 503 });
  }
  if (failure.name === "NoTranscriptGeneratedError") {
    return Response.json({ error: "No speech was detected in this recording." }, { status: 422 });
  }
  return Response.json({ error: "The transcription service could not process this recording. Please try again." }, { status: 502 });
}

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
    return transcriptionErrorResponse(cause);
  }
}
