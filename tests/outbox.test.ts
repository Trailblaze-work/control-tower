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
  const entries: { item: object; turnId: string; seqStart: number }[] = [];
  let turnId = '';
  const agent = {
    get status() { return status; }, archivedAt: null, pendingPermissions: [], refresh: async () => ({}),
    send: async (text: string, options: { messageId: string }) => {
      sent.push(text); status = 'running'; turnId = options.messageId;
      entries.push({ item: { type: 'user_message', text, clientMessageId: options.messageId }, turnId, seqStart: entries.length });
    },
    timeline: { refetch: async () => ({ entries }) },
  };
  return { paseo: { agents: { ref: () => agent } } as unknown as PaseoApi, sent,
    idle: () => { status = 'idle'; },
    finish: () => { status = 'idle'; entries.push({ item: { type: 'assistant_message', text: 'Outcome confirmed.' }, turnId, seqStart: entries.length }); },
    unrelated: () => { status = 'running'; entries.push({ item: { type: 'user_message', clientMessageId: 'other-request' }, turnId: 'unrelated-turn', seqStart: entries.length }); },
  };
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
test('queued messages can be cancelled and accepted submissions resume observation after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-outbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'outbox.json'); const w = workspace(); const outbox = new Outbox(w.paseo, path);
  const cancelled = await outbox.enqueue('owner', 'cancel', 'agent', 'Do not deliver');
  await outbox.cancel('owner', cancelled.jobId!); w.idle(); await outbox.tick(); assert.equal(w.sent.length, 0);
  const pending = await outbox.enqueue('owner', 'in-flight', 'agent', 'Already submitted');
  assert.equal(w.sent.length, 1);
  const restored = new Outbox(w.paseo, path); await restored.load(); await restored.tick();
  assert.equal(restored.get('owner', pending.jobId!)?.status, 'waiting'); assert.equal(w.sent.length, 1);
  assert.deepEqual(await restored.enqueue('owner', 'in-flight', 'agent', 'Already submitted'), { jobId: pending.jobId, status: 'waiting', agentId: 'agent' });
  w.finish(); await restored.tick();
  assert.equal(restored.get('owner', pending.jobId!)?.status, 'completed');
  assert.equal(w.sent.length, 1, 'observation after restart never resends');
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

test('a two-minute reply wait is pending, then reconciles only the original turn without replay', async t => {
  const w = workspace(); w.idle();
  const events: { event: string; outcome?: string; jobId?: string }[] = [];
  const outbox = new Outbox(w.paseo, undefined, entry => events.push(entry));
  const job = await outbox.enqueue('owner', 'long-task', 'agent', 'Do work');
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 121_000);
  await outbox.tick();
  assert.equal(outbox.get('owner', job.jobId!)?.status, 'waiting');
  assert.match(outbox.get('owner', job.jobId!)?.note ?? '', /not an execution timeout/);
  assert.ok(events.some(entry => entry.event === 'outbox_reply_wait' && entry.jobId === job.jobId));
  // Even when another turn is currently running, recover the original turn's final reply.
  w.finish(); w.unrelated(); await outbox.tick();
  assert.equal(outbox.get('owner', job.jobId!)?.status, 'completed');
  assert.equal(outbox.get('owner', job.jobId!)?.reply, 'Outcome confirmed.');
  assert.equal(w.sent.length, 1);
});
test('missing request history cannot be replaced with an unrelated idle agent reply', async () => {
  let idle = true;
  const agent = { get status() { return idle ? 'idle' : 'running'; }, pendingPermissions: [], refresh: async () => ({}),
    send: async () => { idle = false; }, timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'Wrong answer' }, turnId: 'other', seqStart: 42 }] }) } };
  const outbox = new Outbox({ agents: { ref: () => agent } } as unknown as PaseoApi);
  const job = await outbox.enqueue('owner', 'correlation', 'agent', 'Question'); idle = true;
  await outbox.tick(); assert.equal(outbox.get('owner', job.jobId!)?.status, 'accepted');
  assert.equal(outbox.get('owner', job.jobId!)?.reply, undefined);
});
test('interrupted submission remains unknown and is never replayed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-outbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'outbox.json'); const w = workspace();
  await writeFile(path, JSON.stringify([{ id: 'submitted-id', owner: 'owner', agentId: 'agent', prompt: 'Already sent?', createdAt: Date.now(), status: 'submitting' }]));
  const outbox = new Outbox(w.paseo, path); await outbox.load(); w.idle(); await outbox.tick();
  assert.equal(outbox.get('owner', 'submitted-id')?.status, 'unknown'); assert.equal(w.sent.length, 0);
});

test('legacy reply timeouts recover a correlated result without resending', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-outbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'outbox.json'); const w = workspace(); w.idle();
  const original = new Outbox(w.paseo, path);
  const job = await original.enqueue('owner', 'legacy-timeout', 'agent', 'Long work');
  const raw = JSON.parse(await readFile(path, 'utf8')); raw[0].status = 'timeout';
  await writeFile(path, JSON.stringify(raw)); w.finish();
  const restored = new Outbox(w.paseo, path); await restored.load(); await restored.tick();
  assert.equal(restored.get('owner', job.jobId!)?.status, 'completed'); assert.equal(w.sent.length, 1);
});
