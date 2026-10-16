import { initializeState, persistState, loadApiKey, port, publicUrl } from './config.ts';
import { localPaseo } from './paseo.ts';
import { Coordinator } from './coordinator.ts';
import { voiceServer } from './http.ts';
import { Outbox } from './outbox.ts';
import { Access } from './auth.ts';
import { stateDir } from './config.ts';
import { join } from 'node:path';
import { Settings } from './settings.ts';
import { UsageLedger } from './usage.ts';
import { Telemetry } from './telemetry.ts';

const telemetry = new Telemetry(join(stateDir, 'diagnostics.jsonl'));
const report = telemetry.report;
const paseo = localPaseo();
try { await paseo.connect(); } catch { console.error('Paseo is unavailable; the voice page will show disconnected until the daemon reconnects.'); }
const state = await initializeState();
const outbox = new Outbox(paseo, join(stateDir, 'outbox.json'), report); await outbox.load();
const access = new Access(join(stateDir, 'browser-sessions.json')); await access.load();
const settings = new Settings(join(stateDir, 'settings.json'), loadApiKey);
const usage = new UsageLedger(join(stateDir, 'usage.json')); await usage.load();
report({ event: 'service_started', connection: paseo.getConnectionState().status });
let lastConnection = paseo.getConnectionState().status;
const connectionTimer = setInterval(() => {
  const connection = paseo.getConnectionState().status;
  if (connection !== lastConnection) { lastConnection = connection; report({ event: 'paseo_connection', connection }); }
}, 2000);
const queueTimer = setInterval(() => { void outbox.tick().catch(() => console.error('Outbox update failed; pending messages remain on disk.')); }, 5000);
const server = voiceServer({ ...state, access, settings, usage, telemetry, report, apiKey: null, getApiKey: () => settings.key(), connection: () => paseo.getConnectionState().status, coordinator: new Coordinator(paseo, outbox, report, async () => (await settings.status()).allowWorkspaceRenames), ready: () => paseo.getConnectionState().status === 'connected' });
server.on('error', () => { console.error('Could not start voice server. Check whether its port is already in use.'); process.exitCode = 1; void paseo.close(); });
server.listen(port, '127.0.0.1', () => {
  void persistState(state).then(() => console.log(`Tower listening at ${publicUrl}. Run npm run link for a private launch link.`));
});
let closing = false;
async function close() { if (closing) return; closing = true; clearInterval(queueTimer); clearInterval(connectionTimer); server.close(); await paseo.close(); await outbox.flush(); report({ event: 'service_stopped' }); await telemetry.flush(); }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
