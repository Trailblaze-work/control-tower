import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import { Outbox } from '../server/outbox.ts';
import { Access } from '../server/auth.ts';

function workspace() {
  let status = 'running'; const sent: string[] = [];
  let complete: (result: { status: 'idle'; lastMessage: string }) => void = () => {};
  const agent = {
    get status() { return status; }, archivedAt: null, pendingPermissions: [], refresh: async () => ({}),
    send: async (text: string) => { sent.push(text); },
    waitForFinish: () => new Promise(resolve => { complete = resolve; }),
  };
  return { paseo: { agents: { ref: () => agent } } as unknown as PaseoApi, sent, idle: () => { status = 'idle'; }, finish: () => complete({ status: 'idle', lastMessage: 'Outcome confirmed.' }) };
}
test('busy messages survive restart, deliver FIFO only when idle, and stay private to their owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-outbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'outbox.json'); const w = workspace(); const original = new Outbox(w.paseo, path);
  const first = await original.enqueue('owner', 'request-1', 'agent', 'First update');
  const second = await original.enqueue('owner', 'request-2', 'agent', 'Second update');
  assert.equal(first.status, 'queued'); assert.equal(w.sent.length, 0);
  assert.equal(original.get('other', first.jobId!), undefined);
  assert.deepEqual(await original.enqueue('owner', 'request-1', 'agent', 'First update'), first);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const restored = new Outbox(w.paseo, path); await restored.load(); await restored.tick(); assert.equal(w.sent.length, 0);
  w.idle(); await restored.tick(); assert.deepEqual(w.sent, ['First update']);
  await restored.tick(); assert.deepEqual(w.sent, ['First update']);
  w.finish(); await new Promise(resolve => setImmediate(resolve));
  await restored.tick(); assert.deepEqual(w.sent, ['First update', 'Second update']);
  assert.equal(restored.get('owner', first.jobId!)?.status, 'completed');
  assert.equal(restored.get('owner', second.jobId!)?.status, 'accepted');
  w.finish(); await new Promise(resolve => setImmediate(resolve));
  await restored.flush();
});
test('queued messages can be cancelled and uncertain submissions are never replayed after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-outbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'outbox.json'); const w = workspace(); const outbox = new Outbox(w.paseo, path);
  const cancelled = await outbox.enqueue('owner', 'cancel', 'agent', 'Do not deliver');
  await outbox.cancel('owner', cancelled.jobId!); w.idle(); await outbox.tick(); assert.equal(w.sent.length, 0);
  const pending = await outbox.enqueue('owner', 'in-flight', 'agent', 'Already submitted');
  assert.equal(w.sent.length, 1);
  const restored = new Outbox(w.paseo, path); await restored.load(); await restored.tick();
  assert.equal(restored.get('owner', pending.jobId!)?.status, 'unknown'); assert.equal(w.sent.length, 1);
  assert.deepEqual(await restored.enqueue('owner', 'in-flight', 'agent', 'Already submitted'), { jobId: pending.jobId, status: 'unknown', agentId: 'agent' });
  w.finish(); await new Promise(resolve => setImmediate(resolve));
  await outbox.flush();
});
test('expired queued messages are not delivered', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-outbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'outbox.json'); const w = workspace(); const outbox = new Outbox(w.paseo, path);
  const job = await outbox.enqueue('owner', 'old', 'agent', 'Stale update');
  const raw = JSON.parse(await readFile(path, 'utf8')); raw[0].createdAt -= 31 * 60_000; await writeFile(path, JSON.stringify(raw));
  const restored = new Outbox(w.paseo, path); await restored.load(); w.idle(); await restored.tick();
  assert.equal(restored.get('owner', job.jobId!)?.status, 'expired'); assert.equal(w.sent.length, 0);
});
test('browser pairing survives an app restart while launch tickets remain single-use', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'sessions.json'); const first = new Access(path);
  const ticket = first.ticket(); const session = first.pair(ticket); await first.persist();
  const restored = new Access(path); await restored.load();
  assert.equal(restored.valid(`paseo_voice=${session}`), session);
  assert.equal(restored.pair(ticket), null); assert.equal((await stat(path)).mode & 0o777, 0o600);
});
