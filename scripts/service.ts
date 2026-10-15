import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = process.env.PASEO_VOICE_PORT ?? '6768';
let app: ChildProcess | undefined;
let stopping = false;
let logBuffer = '';
let tunnelUrl: string | undefined;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
const tunnel = spawn(process.env.CLOUDFLARED_BIN ?? '/opt/homebrew/bin/cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
function stop(code = 0) {
  if (stopping) return;
  stopping = true; clearTimeout(startupTimeout); clearTimeout(restartTimer);
  tunnel.kill('SIGTERM'); app?.kill('SIGTERM');
  setTimeout(() => { tunnel.kill('SIGKILL'); app?.kill('SIGKILL'); process.exit(code); }, 3000).unref();
}
function startApp() {
  if (stopping || app || !tunnelUrl) return;
  app = spawn(process.execPath, ['server/main.ts'], { cwd: root, env: { ...process.env, PASEO_VOICE_URL: tunnelUrl, PASEO_VOICE_SUPERVISOR_PID: String(process.pid) }, stdio: ['ignore', 'inherit', 'inherit'] });
  app.on('error', () => { console.error('Could not start local voice service.'); stop(1); });
  app.on('exit', () => {
    app = undefined;
    if (!stopping) { console.log('Restarting local voice service; keeping the tunnel address.'); restartTimer = setTimeout(startApp, 1000); }
  });
}
const startupTimeout = setTimeout(() => { console.error('Temporary tunnel did not become available. The service will retry.'); stop(1); }, 60_000);
tunnel.stderr?.on('data', (data: Buffer) => {
  logBuffer = (logBuffer + data.toString('utf8')).slice(-20000);
  const url = logBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!url || tunnelUrl || stopping) return;
  clearTimeout(startupTimeout); tunnelUrl = url[0];
  console.log('Temporary Cloudflare tunnel created. Starting local voice service.'); startApp();
});
tunnel.on('error', () => { console.error('Could not start cloudflared. Install it or set CLOUDFLARED_BIN.'); stop(1); });
tunnel.on('exit', () => { if (!stopping) { console.error('Temporary tunnel stopped. Restarting both services.'); stop(1); } });
process.on('SIGUSR2', () => { if (!stopping) app?.kill('SIGTERM'); });
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
