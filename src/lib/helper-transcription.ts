import { createHash } from "node:crypto";
import { db } from "./db";

export const TRANSCRIPTION_BUCKET = "helper-audio";
export const MAX_TRANSCRIPTION_BYTES = 20 * 1024 * 1024;
let bucketReady: Promise<void> | null = null;

async function ensureBucket() {
  if (!bucketReady) bucketReady = (async () => {
    const { data } = await db().storage.getBucket(TRANSCRIPTION_BUCKET);
    if (data) return;
    const { error } = await db().storage.createBucket(TRANSCRIPTION_BUCKET, {
      public: false,
      fileSizeLimit: MAX_TRANSCRIPTION_BYTES,
      allowedMimeTypes: ["audio/wav"],
    });
    if (error && !/already exists|duplicate/i.test(error.message)) throw error;
  })().catch((error) => { bucketReady = null; throw error; });
  return bucketReady;
}

export function audioPath(ownerId: string, requestId: string) {
  return `${ownerId}/${requestId}.wav`;
}

export async function storeTranscriptionAudio(ownerId: string, requestId: string, bytes: Uint8Array) {
  await ensureBucket();
  const path = audioPath(ownerId, requestId);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { error } = await db().storage.from(TRANSCRIPTION_BUCKET).upload(path, bytes, {
    contentType: "audio/wav",
    upsert: false,
    cacheControl: "no-store",
  });
  if (error) throw error;
  return { path, sha256, bytes: bytes.byteLength };
}

export async function removeTranscriptionAudio(path: string | null | undefined) {
  if (!path) return;
  await ensureBucket();
  const { error } = await db().storage.from(TRANSCRIPTION_BUCKET).remove([path]);
  if (error && !/not found/i.test(error.message)) throw error;
}

export async function prepareTranscriptionRequests(ownerId: string, result: Record<string, unknown>) {
  const requests = Array.isArray(result.requests) ? result.requests : [];
  const prepared = await Promise.all(requests.map(async (value) => {
    const request = value as Record<string, unknown>;
    if (request.action !== "transcribe") return request;
    const requestId = String(request.id ?? "");
    const path = String(request.prompt ?? "");
    if (path !== audioPath(ownerId, requestId)) throw new Error("Invalid transcription audio path");
    await ensureBucket();
    const { data, error } = await db().storage.from(TRANSCRIPTION_BUCKET).createSignedUrl(path, 10 * 60);
    if (error || !data?.signedUrl) throw error ?? new Error("Could not sign transcription audio");
    return { ...request, prompt: null, audio_url: data.signedUrl };
  }));
  return { ...result, requests: prepared };
}

export async function cleanupFinishedTranscription(requestId: string) {
  const { data, error } = await db().from("helper_requests").select("action,prompt").eq("id", requestId).maybeSingle();
  if (error) throw error;
  if (data?.action === "transcribe") await removeTranscriptionAudio(data.prompt);
}
