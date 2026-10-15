import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { voiceServer } from '../server/http.ts';
import { runtimeConfig } from '../server/runtime-config.ts';
import { Settings } from '../server/settings.ts';
import { UsageLedger } from '../server/usage.ts';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('browser applies prompt updates between turns and preserves history through refresh and reload', { timeout: 30000 }, async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://localhost:${port}`;
  const config = await runtimeConfig();
  const server = voiceServer({
    port, publicUrl: origin, controlToken: 'test-control', apiKey: 'test-key', ready: () => true,
    coordinator: { invoke: async (_call, _id, name) => name === 'request_workspace_rename' ? {
      status: 'requires_user_action', executed: false, kind: 'workspace_rename', requestedTitle: '<img src=x onerror=alert(1)>',
      sdkPlan: { method: 'workspaces.ref(workspaceId).setTitle', workspaceId: 'w', title: '<img src=x onerror=alert(1)>' },
      manualSteps: ['Review the workspace title in Paseo.'], risks: ['Display title only.'],
    } : ({ observed: true }) }, config: async () => structuredClone(config),
    fetch: async () => new Response('v=0\r\ns=synthetic', { status: 201 }),
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ bypassCSP: true });
  await context.addInitScript(() => {
    window.sentEvents = []; window.channels = [];
    const track = { enabled: true, label: 'Silent synthetic microphone', stop() {} };
    navigator.mediaDevices.getUserMedia = async () => ({ getAudioTracks: () => [track], getTracks: () => [track] });
    class Channel {
      readyState = 'connecting';
      emit(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
      send(raw) {
        const event = JSON.parse(raw); window.sentEvents.push(event);
        queueMicrotask(() => {
          if (event.type === 'session.update') this.emit({ type: 'session.updated', session: event.session });
          if (event.type === 'response.create') {
            const item = `reply-${window.sentEvents.length}`;
            this.emit({ type: 'response.created' });
            this.emit({ type: 'response.output_audio_transcript.delta', item_id: item, delta: 'Ready to continue.' });
            this.emit({ type: 'response.output_audio_transcript.done', item_id: item, transcript: 'Ready to continue.' });
            this.emit({ type: 'response.done' }); this.emit({ type: 'output_audio_buffer.stopped' });
          }
        });
      }
      close() { this.readyState = 'closed'; this.onclose?.(); }
    }
    window.RTCPeerConnection = class {
      connectionState = 'new'; localDescription = { sdp: 'v=0\r\ns=synthetic-offer' };
      createDataChannel() { this.channel = new Channel(); window.channels.push(this.channel); return this.channel; }
      addTrack() {} async createOffer() { return this.localDescription; } async setLocalDescription() {}
      async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); this.channel.readyState = 'open'; this.channel.onopen?.(); }
      close() { this.connectionState = 'closed'; this.channel.close(); this.onconnectionstatechange?.(); }
    };
  });
  const page = await context.newPage(); await page.clock.install();
  const link = await (await fetch(`${origin}/api/launch`, { method: 'POST', headers: { Authorization: 'Bearer test-control' } })).json();
  await page.goto(link.url);
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-diagnostic="WebRTC"]')?.textContent === 'connected');
  await page.evaluate(() => window.channels.at(-1).emit({ type: 'response.function_call_arguments.done', call_id: 'rename-draft', name: 'request_workspace_rename', arguments: JSON.stringify({ workspaceId: 'w', title: 'Review', reason: 'Clarity' }) }));
  await page.waitForFunction(() => document.querySelector('#workspace-request-list li'));
  assert.match(await page.locator('#workspace-request-list').textContent(), /<img src=x onerror=alert\(1\)> — not applied/);
  assert.equal(await page.locator('#workspace-request-list img').count(), 0, 'untrusted names render as text, never HTML');
  await page.route('**/api/tool', async route => {
    if (route.request().postDataJSON().invocationId !== 'lost-call') return route.continue();
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Call session lost. Refresh conversation to reconnect with saved context.', requestId: 'safe-diagnostic-reference' }) });
  });
  await page.evaluate(() => window.channels.at(-1).emit({ type: 'response.function_call_arguments.done', call_id: 'lost-call', name: 'get_overview', arguments: '{}' }));
  await page.waitForFunction(() => window.sentEvents.some(e => e.type === 'conversation.item.create' && e.item?.call_id === 'lost-call'));
  const failedTool = await page.evaluate(() => JSON.parse(window.sentEvents.find(e => e.item?.call_id === 'lost-call').item.output));
  assert.match(failedTool.error, /Call session lost/); assert.equal(failedTool.code, 'missing_call');
  assert.equal(await page.locator('[data-diagnostic="Last error reference"]').textContent(), 'safe-diagnostic-reference');
  await page.evaluate(() => window.channels.at(-1).emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'question', transcript: 'Remember the reversible rollout decision.' }));
  config.revision = 'new-prompt'; config.session.instructions += '\nAnswer concisely.';
  await page.clock.runFor(10001);
  await page.waitForFunction(() => window.sentEvents.some(event => event.type === 'session.update'));
  assert.equal(await page.locator('[data-diagnostic="Update"]').textContent(), 'Latest instructions applied without reconnecting.');
  assert.equal(await page.evaluate(() => window.channels.length), 1);
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await page.waitForFunction(() => window.channels.length === 2 && window.sentEvents.some(event => event.item?.content?.[0]?.text?.startsWith('CONVERSATION HANDOFF:')));
  const handoff = await page.evaluate(() => window.sentEvents.find(event => event.item?.content?.[0]?.text?.startsWith('CONVERSATION HANDOFF:')).item.content[0].text);
  assert.match(handoff, /Remember the reversible rollout decision/); assert.match(handoff, /Do not replay earlier tool calls/);
  await page.reload();
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await page.waitForFunction(() => window.sentEvents.some(event => event.item?.content?.[0]?.text?.startsWith('CONVERSATION HANDOFF:')));
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Start conversation', exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('paseo-voice-checkpoint-v1')), null);
});

test('laptop settings save write-only keys, display measured usage, and reject shared-call access', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-settings-browser-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://localhost:${port}`;
  const settings = new Settings(join(root, 'settings.json'), async () => null);
  const usage = new UsageLedger(join(root, 'usage.json'));
  await usage.record('earlier', 'gpt-realtime-2.1', { eventId: 'response', kind: 'realtime', usage: { input_tokens: 1000, output_tokens: 100, input_token_details: { audio_tokens: 1000 }, output_token_details: { audio_tokens: 100 } } });
  const server = voiceServer({ port, publicUrl: origin, controlToken: 'owner-control', apiKey: null, settings, usage, getApiKey: () => settings.key(), ready: () => true, coordinator: { invoke: async () => ({}) } });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await fetch(origin+'/api/settings')).status, 403);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(origin+'/settings#owner-control');
  await page.waitForFunction(() => document.querySelector('#settings-status').textContent.includes('Enter your OpenAI'));
  assert.match(await page.locator('#estimate').textContent(), /Tracked estimate/);
  assert.equal(new URL(page.url()).hash, '');
  const key = 'sk-browser-test-only-not-a-real-secret';
  await page.getByLabel('OpenAI API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#settings-status').textContent.includes('saved here'));
  assert.equal(await page.getByLabel('OpenAI API key', { exact: true }).inputValue(), '');
  assert.equal(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).apiKey, key);
  const visible = await (await fetch(origin+'/api/settings', { headers: { Authorization: 'Bearer owner-control' } })).text();
  assert.ok(!visible.includes(key));
  const links = await (await fetch(origin+'/api/launch', { method: 'POST', headers: { Authorization: 'Bearer owner-control' } })).json();
  const paired = await fetch(origin+'/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(links.url).hash.slice(1) }) });
  assert.equal((await fetch(origin+'/api/settings', { headers: { Cookie: paired.headers.get('set-cookie').split(';')[0] } })).status, 403);
});
