import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings } from '../server/settings.ts';
import { UsageLedger, estimate } from '../server/usage.ts';
import { Telemetry, errorCode, type Diagnostic } from '../server/telemetry.ts';

test('key settings persist privately, preserve existing credentials, and never return secrets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-settings-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'settings.json'); const key = 'sk-test-only-not-a-real-secret'; const admin = 'sk-admin-test-only-not-a-real-secret';
  const settings = new Settings(path, async () => 'sk-existing-fallback-only');
  assert.equal((await settings.status()).source, 'environment_or_key_file');
  await settings.save({ apiKey: key }); await settings.save({ adminApiKey: admin, projectId: 'proj_test' });
  assert.equal(await new Settings(path, async () => null).key(), key);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(root)).mode & 0o777, 0o700);
  const visible = JSON.stringify(await settings.status()); assert.ok(!visible.includes(key)); assert.ok(!visible.includes(admin));
  await assert.rejects(settings.save({ apiKey: 'not a valid key' }));
  let fetches = 0;
  const provider = (async (url: URL, init: RequestInit) => {
    fetches++; assert.equal(url.searchParams.get('project_ids[]'), 'proj_test');
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${admin}`);
    return Response.json({ data: [{ results: [{ amount: { value: 1.25, currency: 'usd' } }] }], has_more: false });
  }) as typeof fetch;
  const billed = await settings.billed(provider) as { amounts: unknown; scope: string };
  assert.deepEqual(billed.amounts, { usd: 1.25 }); assert.equal(billed.scope, 'project');
  await settings.billed(provider); assert.equal(fetches, 1, 'provider costs are cached for five minutes');
});

test('usage prices cached tokens once, persists idempotently, and leaves unknown models unpriced', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-usage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'usage.json'); const ledger = new UsageLedger(path);
  const usage = { input_tokens: 1000, output_tokens: 100, input_token_details: { text_tokens: 400, audio_tokens: 600, cached_tokens: 200, cached_tokens_details: { text_tokens: 100, audio_tokens: 100 } }, output_token_details: { text_tokens: 20, audio_tokens: 80 } };
  const expected = (300*4+500*32+200*0.4+20*24+80*64)/1e6;
  assert.equal(estimate('gpt-realtime-2.1', usage).usd, expected);
  await ledger.record('call', 'gpt-realtime-2.1', { eventId: 'response1', kind: 'realtime', usage });
  const restored = new UsageLedger(path); await restored.load();
  await restored.record('call', 'gpt-realtime-2.1', { eventId: 'response1', kind: 'realtime', usage });
  assert.equal(restored.summary().events, 1); assert.equal(restored.summary().totalUsd, expected);
  await restored.record('call', 'future-model', { eventId: 'response2', kind: 'realtime', usage });
  assert.equal(restored.summary().unpricedEvents, 1);
  await restored.record('call', '', { eventId: 'transcription', kind: 'transcription', usage: { type: 'tokens', input_tokens: 1000, output_tokens: 20 } });
  assert.equal(restored.summary().totalUsd, expected + (1000*1.25+20*5)/1e6);
});

test('diagnostics classify failures without storing raw errors or extra payload fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-diagnostics-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'diagnostics.jsonl'); const telemetry = new Telemetry(path);
  assert.equal(errorCode(new Error('RPC timed out with private content')), 'timeout');
  telemetry.report({ event: 'workspace_tool', operation: 'get_activity', code: 'timeout', secret: 'do-not-store', transcript: 'private conversation' } as Diagnostic);
  await telemetry.flush(); const content = await readFile(path, 'utf8');
  assert.ok(!content.includes('do-not-store')); assert.ok(!content.includes('private conversation')); assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(telemetry.snapshot().events[0].operation, 'get_activity');
});
