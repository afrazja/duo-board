import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

async function exists(file) {
  try { return (await stat(file)).isFile(); }
  catch { return false; }
}

async function download(url, expectedBytes, expectedHash, signal) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new Error("The board returned an unsafe audio address");
  const response = await fetch(parsed, { redirect: "error", signal });
  if (!response.ok || !response.body) throw new Error("The temporary recording could not be downloaded");
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_AUDIO_BYTES) { await reader.cancel(); throw new Error("The temporary recording is too large"); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, length);
  if (length !== expectedBytes || createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("The temporary recording failed its integrity check");
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") throw new Error("The temporary recording is not a WAV file");
  return bytes;
}

function run(executable, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < 8_000) stderr += chunk.toString("utf8"); });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { signal.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
      else if (code === 0) resolve();
      else reject(new Error(`Whisper exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export class LocalTranscriber {
  constructor({ executable, model, directory }) {
    this.executable = path.resolve(executable);
    this.model = path.resolve(model);
    this.directory = path.resolve(directory);
  }
  async ready() { return (await exists(this.executable)) && (await exists(this.model)); }
  async transcribe({ id, audioUrl, audioBytes, audioSha256, signal }) {
    if (!(await this.ready())) throw new Error("Local Whisper is not installed. Run Repair Duo Board Helper.");
    await mkdir(this.directory, { recursive: true });
    const input = path.join(this.directory, `${id}.wav`);
    const output = path.join(this.directory, `${id}-result`);
    try {
      const bytes = await download(audioUrl, audioBytes, audioSha256, signal);
      await writeFile(input, bytes, { flag: "wx" }).catch(async (error) => {
        if (error.code !== "EEXIST") throw error;
        await rm(input, { force: true }); await writeFile(input, bytes, { flag: "wx" });
      });
      const threads = Math.max(2, Math.min(8, availableParallelism() - 1));
      await run(this.executable, ["-m", this.model, "-f", input, "-l", "auto", "-t", String(threads), "-nt", "-otxt", "-of", output, "-np"], signal);
      const text = (await readFile(`${output}.txt`, "utf8")).trim();
      if (!text) throw new Error("No speech was detected in this recording");
      return text;
    } finally {
      await Promise.allSettled([rm(input, { force: true }), rm(`${output}.txt`, { force: true })]);
    }
  }
}
