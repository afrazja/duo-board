import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCodexExecutable } from '../bridge/codex-executable.mjs';

test('desktop updates are resolved again for each launch without replacing custom paths', async t => {
  const localAppData = await mkdtemp(path.join(tmpdir(), 'duo-codex-path-'));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const old = path.join(bin, 'old', 'codex.exe');
  const current = path.join(bin, 'current', 'codex.exe');
  await mkdir(path.dirname(current), { recursive: true });
  await writeFile(current, 'fixture');
  const options = { platform: 'win32', localAppData };
  assert.equal(resolveCodexExecutable(old, options), current);
  assert.equal(resolveCodexExecutable(current, options), current);
  assert.equal(resolveCodexExecutable('codex', options), 'codex');
  const custom = path.join(localAppData, 'custom', 'codex.exe');
  assert.equal(resolveCodexExecutable(custom, options), custom);
  assert.equal(resolveCodexExecutable(old, { ...options, platform: 'linux' }), old);
  await rm(current);
  assert.equal(resolveCodexExecutable(old, options), old);
  const next = path.join(bin, 'next', 'codex.exe');
  await mkdir(path.dirname(next)); await writeFile(next, 'fixture');
  assert.equal(resolveCodexExecutable(old, options), next);
});
