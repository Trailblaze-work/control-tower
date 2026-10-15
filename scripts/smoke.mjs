// Opt-in integration check. Creates a real, billable Realtime session with silent
// synthetic microphone input. Never opens the user's physical microphone.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { launchVoice } from '../server/launch.ts';

const links = await launchVoice();
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio'],
});
const evidence = { localReady: false, remoteReady: false, webRtcConnected: false, tools: [], transcriptReceived: false, callEnded: false };
try {
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      const source = audio.createConstantSource(); source.offset.value = 0;
      const destination = audio.createMediaStreamDestination(); source.connect(destination); source.start();
      window.__testAudio = audio;
      return destination.stream;
    };
  });
  const remote = await context.newPage();
  await remote.goto(links.url);
  await remote.waitForFunction(() => !document.querySelector('#start').disabled || !document.querySelector('#error').hidden);
  await remote.getByRole('button', { name: 'Start conversation', exact: true }).waitFor();
  assert.equal(await remote.getByRole('button', { name: 'Start conversation', exact: true }).isEnabled(), true);
  evidence.remoteReady = true;
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await remote.screenshot({ path: new URL('../evidence/phone-ready.png', import.meta.url).pathname, fullPage: true });
  const local = await context.newPage();
  local.on('request', req => {
    if (!req.url().endsWith('/api/tool')) return;
    try { const name = req.postDataJSON().name; if (!evidence.tools.includes(name)) evidence.tools.push(name); } catch {}
  });
  await local.goto(links.localUrl);
  await local.waitForFunction(() => !document.querySelector('#start').disabled || !document.querySelector('#error').hidden);
  const start = local.getByRole('button', { name: 'Start conversation', exact: true });
  await start.waitFor(); assert.equal(await start.isEnabled(), true); evidence.localReady = true;
  const overview = local.waitForResponse(res => res.url().endsWith('/api/tool') && res.request().postDataJSON()?.name === 'get_overview' && res.ok(), { timeout: 60_000 });
  await start.click();
  await local.waitForFunction(() => document.querySelector('[data-diagnostic="WebRTC"]')?.textContent === 'connected' || !document.querySelector('#error').hidden, {}, { timeout: 45_000 });
  const error = await local.locator('#error').textContent();
  assert.equal(await local.locator('#error').isHidden(), true, error ?? 'Voice failed');
  evidence.webRtcConnected = true;
  await local.waitForFunction(() => document.querySelector('#transcript').textContent.includes('Coordinator:'), {}, { timeout: 45_000 });
  evidence.transcriptReceived = true;
  await overview;
  await local.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  assert.equal(await local.getByRole('button', { name: 'Unmute microphone', exact: true }).getAttribute('aria-pressed'), 'true');
  await local.getByRole('button', { name: 'End call', exact: true }).click();
  assert.equal(await start.isVisible(), true); evidence.callEnded = true;
  await local.reload();
  await local.waitForFunction(() => !document.querySelector('#start').disabled || !document.querySelector('#error').hidden);
  await start.waitFor(); assert.equal(await start.isEnabled(), true);
  await writeFile(new URL('../evidence/smoke.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
