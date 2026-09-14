import { watch } from "node:fs";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicJson, acquireWorkerLock, keyFor, prepareDirectory, StateStore } from "./storage.mjs";
import { BackgroundWorker } from "./worker.mjs";
import { RemoteConnection } from "./remote.mjs";

export async function startService({ directory, workerOptions = {}, remoteConfig = null, remoteOptions = {}, onFatal = () => {} }) {
  const root = await prepareDirectory(directory);
  const release = await acquireWorkerLock(root);
  let watcher;
  let scanTimer;
  let worker;
  let remote;
  let closed = false;
  let closing = null;
  let scanning = null;
  const fatal = (error) => { onFatal(error); void close().catch(onFatal); };
  async function scan() {
    if (closed) return;
    if (scanning) return scanning;
    scanning = (async () => {
      const inbox = path.join(root, "inbox");
      for (const name of (await readdir(inbox)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort()) {
        if (closed) break;
        const file = path.join(inbox, name);
        let receipt;
        try {
          const info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 150_000) throw new Error("Inbox request is not a supported local command file");
          const command = JSON.parse(await readFile(file, "utf8"));
          if (name !== `${keyFor(command.id)}.json`) throw new Error("Inbox command ID does not match its filename");
          receipt = { ok: true, result: await worker.handle(command) };
        } catch (error) {
          // Storage errors are service failures, not permanently rejected requests.
          if (["ENOSPC", "EIO", "EROFS", "EACCES", "EPERM"].includes(error.code)) throw error;
          receipt = { ok: false, error: error.message };
        }
        await atomicJson(path.join(root, "receipts", name), receipt);
        await unlink(file);
      }
    })().finally(() => { scanning = null; });
    return scanning;
  }
  function close() {
    if (!closing) closing = shutdown();
    return closing;
  }
  async function shutdown() {
    closed = true;
    watcher?.close(); clearInterval(scanTimer);
    try {
      await scanning?.catch(() => {});
      if (remote) await remote.close();
      if (worker) await worker.close();
      await atomicJson(path.join(root, "service.json"), { status: "stopped", stoppedAt: new Date().toISOString() });
    } finally { await release(); }
  }
  try {
    const store = await new StateStore(root).load();
    if (store.state.remote && !remoteConfig) throw new Error("This helper is paired with a board. Its remote configuration is required before resuming saved work.");
    worker = new BackgroundWorker(store, { ...workerOptions, ...(remoteConfig ? { dispatchAllowed: false } : {}) });
    worker.on("fatal", fatal);
    await worker.start();
    if (remoteConfig) { remote = new RemoteConnection(worker, remoteConfig, remoteOptions); await remote.start(); }
    // No Codex process/model is started until a local request is queued.
    watcher = watch(path.join(root, "inbox"), () => { void scan().catch(fatal); });
    watcher.on("error", fatal);
    // Recover missed filesystem notifications; this never calls a model or reads a board session.
    scanTimer = setInterval(() => { void scan().catch(fatal); }, 2000);
    await atomicJson(path.join(root, "service.json"), { status: "ready", pid: process.pid, startedAt: new Date().toISOString() });
    await scan();
    return { worker, store, remote, directory: root, close };
  } catch (error) { await close(); throw error; }
}
