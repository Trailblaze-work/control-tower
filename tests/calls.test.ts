import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Coordinator } from '../server/coordinator.ts';
import { conversation, recordUtterance } from '../server/coordinator.ts';
import { Calls } from '../server/calls.ts';
import { Access } from '../server/auth.ts';
import { voiceServer } from '../server/http.ts';

test('a service restart preserves call ownership and usage model without restoring speech authorization', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-calls-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'calls.json'); const original = new Calls(path); const id = randomUUID();
  const access = new Access(); const owner = access.pair(access.ticket())!; const other = access.pair(access.ticket())!;
  const call = conversation(owner); call.model = 'gpt-realtime-2.1-mini';
  recordUtterance(call, 'Private spoken rename authorization'); call.knownAgents.add('cached-agent');
  original.entries.set(id, call); await original.save();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(path, 'utf8')).includes('Private spoken'));
  const restored = new Calls(path); await restored.load();
  const loaded = restored.entries.get(id)!;
  assert.equal(loaded.owner, owner); assert.equal(loaded.model, 'gpt-realtime-2.1-mini');
  assert.equal(loaded.lastUtterance, ''); assert.equal(loaded.lastUtteranceAt, undefined);
  assert.equal(loaded.knownAgents.size, 0); assert.equal(loaded.invocations.size, 0);
  let providerCalls = 0;
  const server = voiceServer({ port: 6768, publicUrl: 'https://voice.example', controlToken: 'test-control', apiKey: null, ready: () => true, access,
    calls: restored.entries, saveCalls: () => restored.save(), coordinator: { invoke: async () => ({ observed: true }) } as unknown as Coordinator,
    fetch: async () => { providerCalls++; throw new Error('No new provider session should be created'); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = (path: string, token: string): Promise<{ status: number; data: Record<string, unknown> }> => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: 'POST', headers: { Host: 'voice.example', Cookie: `paseo_voice=${token}`, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(JSON.stringify({ callId: id, invocationId: 'new-question', name: 'get_overview', args: {} }));
  });
  assert.equal((await post('/api/heartbeat', owner)).status, 200);
  assert.equal((await post('/api/tool', owner)).status, 200);
  const refused = await post('/api/heartbeat', other); assert.equal(refused.status, 404); assert.equal(refused.data.code, 'missing_call');
  assert.equal((await post('/api/end', other)).status, 404);
  assert.equal((await post('/api/end', owner)).status, 200);
  const afterEnd = new Calls(path); await afterEnd.load(); assert.equal(afterEnd.entries.size, 0);
  assert.equal(providerCalls, 0, 'restoring the laptop handle leaves direct voice transport alone');
});

test('expired call handles cannot be resurrected by a restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-calls-expired-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'calls.json'); const calls = new Calls(path); const call = conversation('test-owner');
  calls.entries.set(randomUUID(), call); await calls.save();
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 121_000);
  const restored = new Calls(path); await restored.load(); assert.equal(restored.entries.size, 0);
});
