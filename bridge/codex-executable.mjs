import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Desktop updates remove versioned binaries even while the helper is open. */
export function resolveCodexExecutable(executable, { platform = process.platform, localAppData = process.env.LOCALAPPDATA } = {}) {
  if (platform !== "win32" || !localAppData || existsSync(executable)) return executable;
  const root = path.resolve(localAppData, "OpenAI", "Codex", "bin");
  const prefix = `${root}${path.sep}`.toLowerCase();
  if (!path.isAbsolute(executable) || !path.resolve(executable).toLowerCase().startsWith(prefix)) return executable;
  try {
    const candidates = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
      const file = path.join(root, entry.name, "codex.exe");
      try { const info = statSync(file); return info.isFile() ? [{ file, modified: info.mtimeMs }] : []; }
      catch { return []; }
    });
    candidates.sort((a, b) => b.modified - a.modified);
    return candidates[0]?.file ?? executable;
  } catch { return executable; }
}
