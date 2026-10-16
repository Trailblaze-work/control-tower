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

test('browser preserves audio capture and context across reception loss, updates, refresh and reload', { timeout: 30000 }, async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const origin = `http://localhost:${port}`;
  const config = await runtimeConfig();
  const diagnostics = [];
  let jobState = 'waiting';
  const server = voiceServer({
    report: entry => diagnostics.push(entry),
    port, publicUrl: origin, controlToken: 'test-control', apiKey: 'test-key', ready: () => true,
    coordinator: { invoke: async (_call, _id, name, args) => name === 'send_message' ? { jobId: 'slow-job', status: 'accepted' } : name === 'get_job' ? { status: jobState, reply: jobState === 'completed' ? 'The requested change is complete.' : undefined } : name === 'request_workspace_rename' && args.title === 'Applied title' ? { status: 'completed', kind: 'workspace_rename', executed: true, workspaceId: 'w', title: 'Applied title' } : name === 'request_workspace_rename' ? {
      status: 'requires_user_action', executed: false, kind: 'workspace_rename', workspaceId: 'w', requestedTitle: '<img src=x onerror=alert(1)>',
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
    window.sentEvents = []; window.channels = []; window.peers = []; window.microphoneRequests = window.microphoneStops = 0;
    window.systemActions = {}; window.rejectHangup = false;
    Object.defineProperty(navigator, 'mediaSession', { value: {
      setActionHandler(action, callback) { if (action === 'hangup' && window.rejectHangup) throw new DOMException('Unsupported', 'NotSupportedError'); window.systemActions[action] = callback; },
      setMicrophoneActive(active) { this.microphoneActive = active; }, playbackState: 'none', metadata: null,
    } });
    function microphone() {
      const track = Object.assign(new EventTarget(), { enabled: true, muted: false, readyState: 'live', label: 'Silent synthetic microphone', stop() { this.readyState = 'ended'; window.microphoneStops++; } });
      window.microphoneTrack = track; return track;
    }
    let track = microphone();
    navigator.mediaDevices.getUserMedia = async () => { window.microphoneRequests++; if (track.readyState === 'ended') track = microphone(); return { getAudioTracks: () => [track], getTracks: () => [track] }; };
    Object.defineProperty(navigator, 'audioSession', { value: Object.assign(new EventTarget(), { state: 'active', type: 'auto' }) });
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
      constructor() { window.peers.push(this); }
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
  assert.equal(await page.evaluate(() => typeof window.systemActions.hangup), 'function');
  await page.waitForFunction(() => /^[a-f0-9]{12}$/.test(document.querySelector('[data-diagnostic="Page revision"]')?.textContent));
  await page.waitForTimeout(50);
  assert.ok(diagnostics.some(entry => entry.event === 'browser_client_loaded' && /^[a-f0-9]{12}$/.test(entry.clientRevision)));
  assert.ok(diagnostics.some(entry => entry.event === 'browser_system_control' && entry.action === 'hangup' && entry.outcome === 'registered'));
  await page.evaluate(() => document.querySelector('#speaker').dispatchEvent(new Event('pause')));
  assert.equal(await page.getByRole('button', { name: 'End call', exact: true }).isVisible(), true, 'generic audio pause does not end calls');
  await page.evaluate(() => window.channels.at(-1).emit({ type: 'response.function_call_arguments.done', call_id: 'rename-draft', name: 'request_workspace_rename', arguments: JSON.stringify({ workspaceId: 'w', title: 'Review', reason: 'Clarity' }) }));
  await page.waitForFunction(() => document.querySelector('#workspace-request-list li'));
  assert.match(await page.locator('#workspace-request-list').textContent(), /<img src=x onerror=alert\(1\)> — not applied/);
  assert.equal(await page.locator('#workspace-request-list img').count(), 0, 'untrusted names render as text, never HTML');
  await page.evaluate(() => window.channels.at(-1).emit({ type: 'response.function_call_arguments.done', call_id: 'rename-applied', name: 'request_workspace_rename', arguments: JSON.stringify({ workspaceId: 'w', title: 'Applied title', reason: 'User request' }) }));
  await page.waitForFunction(() => document.querySelector('#workspace-request-list').textContent.includes('Renamed to: Applied title'));
  assert.equal(await page.locator('#workspace-request-list li').count(), 1, 'success replaces the obsolete pending rename card');
  await page.evaluate(() => window.channels.at(-1).emit({ type: 'response.function_call_arguments.done', call_id: 'slow-request', name: 'send_message', arguments: '{}' }));
  await page.waitForFunction(() => window.sentEvents.some(e => e.item?.call_id === 'slow-request'));
  await page.clock.runFor(8001);
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.sentEvents.some(e => e.item?.content?.[0]?.text?.includes('BACKGROUND TOOL EVIDENCE'))), false, 'pending observation never produces a false failure announcement');
  jobState = 'completed'; await page.clock.runFor(8001);
  await page.waitForFunction(() => window.sentEvents.some(e => e.item?.content?.[0]?.text?.includes('The requested change is complete.')));
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
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.mediaSession.microphoneActive), false);
  await page.evaluate(() => { const p = window.peers.at(-1); p.connectionState = 'disconnected'; p.onconnectionstatechange(); });
  await page.clock.runFor(4000);
  assert.equal(await page.evaluate(() => window.peers.length), 1, 'brief drops retain the existing peer');
  await page.evaluate(() => { const p = window.peers.at(-1); p.connectionState = 'connected'; p.onconnectionstatechange(); });
  await page.clock.runFor(6000);
  assert.equal(await page.evaluate(() => window.peers.length), 1, 'a recovered peer cancels the replacement timer');
  await context.setOffline(true);
  await page.evaluate(() => { const p = window.peers.at(-1); p.connectionState = 'failed'; p.onconnectionstatechange(); });
  await page.clock.runFor(15000);
  assert.equal(await page.evaluate(() => window.microphoneStops), 0, 'weak reception does not tear down capture');
  assert.equal(await page.getByRole('button', { name: 'End call', exact: true }).isVisible(), true);
  await context.setOffline(false); await page.clock.runFor(1);
  await page.waitForFunction(() => window.peers.length === 2 && window.sentEvents.some(event => event.item?.content?.[0]?.text?.startsWith('CONVERSATION HANDOFF:')));
  assert.equal(await page.evaluate(() => window.microphoneRequests), 1, 'automatic recovery reuses microphone permission/capture');
  assert.equal(await page.evaluate(() => window.microphoneStops), 0);
  assert.equal(await page.getByRole('button', { name: 'Unmute microphone', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await page.waitForFunction(() => window.channels.length === 3 && window.sentEvents.some(event => event.item?.content?.[0]?.text?.startsWith('CONVERSATION HANDOFF:')));
  const handoff = await page.evaluate(() => window.sentEvents.find(event => event.item?.content?.[0]?.text?.startsWith('CONVERSATION HANDOFF:')).item.content[0].text);
  assert.match(handoff, /Remember the reversible rollout decision/); assert.match(handoff, /Do not replay earlier tool calls/);
  let rejectConfig = true;
  await page.route('**/api/config', route => rejectConfig ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary connection failure' }) }) : route.continue());
  await page.evaluate(() => { const p = window.peers.at(-1); p.connectionState = 'failed'; p.onconnectionstatechange(); });
  await page.clock.runFor(2001);
  await page.waitForFunction(() => document.querySelector('[data-diagnostic="Recovery"]')?.textContent === 'Connection attempt failed');
  assert.equal(await page.evaluate(() => window.microphoneStops), 0, 'a failed recovery request still retains capture');
  rejectConfig = false;
  await page.clock.runFor(4001);
  await page.waitForFunction(() => window.peers.length === 4 && window.peers.at(-1).connectionState === 'connected');
  assert.equal(await page.evaluate(() => window.microphoneRequests), 1, 'retry uses backoff and the original microphone');
  await context.setOffline(true);
  await page.evaluate(() => { const p = window.peers.at(-1); p.connectionState = 'failed'; p.onconnectionstatechange(); });
  await page.clock.runFor(120001);
  assert.equal(await page.getByRole('button', { name: 'Resume conversation', exact: true }).isVisible(), true, 'a prolonged outage stops recovery and leaves a clear manual fallback');
  assert.equal(await page.evaluate(() => window.microphoneStops), 1, 'capture is released after the bounded recovery window');
  const peersAfterTimeout = await page.evaluate(() => window.peers.length);
  await context.setOffline(false); await page.clock.runFor(1000);
  assert.equal(await page.evaluate(() => window.peers.length), peersAfterTimeout, 'network return does not revive a call after recovery was stopped');
  await page.reload();
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await page.waitForFunction(() => window.sentEvents.some(event => event.item?.content?.[0]?.text?.startsWith('CONVERSATION HANDOFF:')));
  await page.evaluate(() => { const p = window.peers.at(-1); p.connectionState = 'failed'; p.onconnectionstatechange(); });
  await page.evaluate(() => window.systemActions.hangup());
  const peersAtEnd = await page.evaluate(() => window.peers.length);
  await page.clock.runFor(20000);
  assert.equal(await page.evaluate(() => window.peers.length), peersAtEnd, 'system hangup cancels pending automatic recovery');
  assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), 'none');
  assert.equal(await page.evaluate(() => navigator.mediaSession.microphoneActive), false);
  assert.equal(await page.evaluate(() => window.systemActions.hangup), null);
  assert.equal(await page.getByRole('button', { name: 'Start conversation', exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('paseo-voice-checkpoint-v1')), null);
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.waitForFunction(() => window.peers.length === 2 && window.peers.at(-1).connectionState === 'connected');
  await page.evaluate(() => window.systemActions.stop());
  assert.equal(await page.getByRole('button', { name: 'Start conversation', exact: true }).isVisible(), true, 'explicit stop still ends a call when the browser supports call controls');
  await page.evaluate(() => { window.rejectHangup = true; });
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await page.waitForFunction(() => window.peers.length === 3 && window.peers.at(-1).connectionState === 'connected');
  assert.match(await page.locator('[data-diagnostic="Car controls"]').textContent(), /Native browser controls/);
  assert.equal(await page.evaluate(() => window.systemActions.stop), null, 'unsupported hangup leaves default Safari commands untouched');
  assert.equal(await page.evaluate(() => navigator.mediaSession.microphoneActive), false, 'native mode does not override browser capture state');
  await page.evaluate(() => {
    window.microphoneTrack.muted = true; window.microphoneTrack.dispatchEvent(new Event('mute'));
    navigator.audioSession.state = 'interrupted'; navigator.audioSession.dispatchEvent(new Event('statechange'));
  });
  assert.equal(await page.getByRole('button', { name: 'End call', exact: true }).isVisible(), true, 'temporary microphone mute and interruption are not hangups');
  await page.evaluate(() => { window.microphoneTrack.muted = false; window.microphoneTrack.dispatchEvent(new Event('unmute')); });
  await page.evaluate(() => { const p = window.peers.at(-1); p.connectionState = 'failed'; p.onconnectionstatechange(); });
  const capturesBeforeSystemEnd = await page.evaluate(() => window.microphoneRequests);
  await page.evaluate(() => { window.microphoneTrack.readyState = 'ended'; window.microphoneTrack.dispatchEvent(new Event('ended')); });
  await page.clock.runFor(20000);
  assert.equal(await page.evaluate(() => window.microphoneRequests), capturesBeforeSystemEnd, 'capture ending cancels recovery instead of reopening the microphone');
  assert.equal(await page.getByRole('button', { name: 'Resume conversation', exact: true }).isVisible(), true);
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(entry => entry.event === 'browser_system_hangup'));
  assert.ok(diagnostics.some(entry => entry.event === 'browser_system_control' && entry.action === 'media_session' && entry.outcome === 'native'));
  assert.ok(diagnostics.some(entry => entry.event === 'browser_microphone_ended'));
  assert.ok(diagnostics.some(entry => entry.event === 'browser_microphone_muted'));
  assert.ok(diagnostics.some(entry => entry.event === 'browser_microphone_unmuted'));
  assert.ok(diagnostics.some(entry => entry.event === 'browser_end_cleaned' && entry.count === 1));
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await page.waitForFunction(() => window.peers.length === 4 && window.peers.at(-1).connectionState === 'connected');
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Start conversation', exact: true }).isVisible(), true);
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
  await page.getByLabel('Allow voice requests to rename workspace display titles').check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#settings-status').textContent.includes('saved here'));
  assert.equal(await page.getByLabel('OpenAI API key', { exact: true }).inputValue(), '');
  assert.equal(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).apiKey, key);
  assert.equal(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).allowWorkspaceRenames, true);
  const visible = await (await fetch(origin+'/api/settings', { headers: { Authorization: 'Bearer owner-control' } })).text();
  assert.ok(!visible.includes(key));
  const links = await (await fetch(origin+'/api/launch', { method: 'POST', headers: { Authorization: 'Bearer owner-control' } })).json();
  const paired = await fetch(origin+'/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(links.url).hash.slice(1) }) });
  assert.equal((await fetch(origin+'/api/settings', { headers: { Cookie: paired.headers.get('set-cookie').split(';')[0] } })).status, 403);
});
