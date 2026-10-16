#!/usr/bin/env node
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stateDir, stateFile } from '../server/config.ts';
import { launchTower } from '../server/launch.ts';

export async function findExecutable(candidates: string[]) {
  for (const candidate of candidates) {
    if (candidate.includes('/')) { try { await access(candidate, 1); return candidate; } catch { continue; } }
    const found = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}
export async function downloadHelper(destination: string, consent: () => Promise<boolean>, request: typeof fetch = fetch) {
  // Consent precedes network access, temporary files or installation.
  if (!await consent()) return false;
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Automatic helper installation supports macOS. Install cloudflared yourself on other platforms.');
  const release = await request('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { signal: AbortSignal.timeout(15000) });
  if (!release.ok) throw new Error('Could not look up the official Cloudflare helper. Install cloudflared, then rerun setup.');
  const data = await release.json() as { assets?: { name: string; digest?: string; browser_download_url: string }[] };
  const name = `cloudflared-darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  const asset = data.assets?.find(asset => asset.name === name);
  if (!asset?.digest?.match(/^sha256:[a-f0-9]{64}$/) || !asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) throw new Error('The official release has no verifiable helper for this Mac. Install cloudflared manually.');
  const response = await request(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Cloudflare helper download failed. Rerun setup to retry.');
  const content = Buffer.from(await response.arrayBuffer());
  if (`sha256:${createHash('sha256').update(content).digest('hex')}` !== asset.digest) throw new Error('Cloudflare helper checksum mismatch; nothing was installed.');
  const scratch = await mkdtemp(join(tmpdir(), 'control-tower-setup-'));
  try {
    const archive = join(scratch, 'helper.tgz'); await writeFile(archive, content, { mode: 0o600 });
    const result = spawnSync('tar', ['-xzf', archive, '-C', scratch, 'cloudflared'], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error('Could not unpack the verified Cloudflare helper.');
    await mkdir(join(stateDir, 'bin'), { recursive: true, mode: 0o700 });
    await chmod(join(scratch, 'cloudflared'), 0o700);
    await rename(join(scratch, 'cloudflared'), destination);
    return true;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const paseo = await findExecutable([process.env.PASEO_CLI ?? 'paseo', '/Applications/Paseo.app/Contents/Resources/bin/paseo']);
  let cloudflared = await findExecutable([process.env.CLOUDFLARED_BIN ?? 'cloudflared', join(stateDir, 'bin/cloudflared'), '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']);
  let pluginsEnabled = false;
  try { pluginsEnabled = JSON.parse(await readFile(join(homedir(), '.paseo/config.json'), 'utf8')).pluginsEnabled === true; } catch {}
  let running = false;
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const r = await fetch(`http://127.0.0.1:${state.port}/api/diagnostics`, { headers: { Authorization: `Bearer ${state.controlToken}` }, signal: AbortSignal.timeout(2000) });
    running = r.ok;
  } catch {}
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ platform: process.platform, nodeSupported: Number(process.versions.node.split('.')[0]) >= 24, paseoAvailable: Boolean(paseo), cloudflaredAvailable: Boolean(cloudflared), pluginsEnabled, serviceRunning: running })); return;
  }
  if (process.platform !== 'darwin') throw new Error('Automatic background setup currently supports macOS. See docs/operations.md for foreground use on other systems.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node 24 or newer, then rerun setup.');
  if (!paseo) throw new Error('Install Paseo first, then rerun setup.');
  if (!pluginsEnabled) throw new Error('In Paseo, turn on Settings → Plugins → Enable plugins, then rerun setup. This global switch requires your explicit authorization.');
  if (!cloudflared) {
    const destination = join(stateDir, 'bin/cloudflared');
    const installed = await downloadHelper(destination, async () => {
      console.log('Phone access needs cloudflared. Setup can download the official Cloudflare helper from GitHub and verify its SHA-256 digest. No Cloudflare account is needed.');
      if (!process.stdin.isTTY) return false;
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { return /^(y|yes)$/i.test((await prompt.question('Download and install the Cloudflare helper? [y/N] ')).trim()); }
      finally { prompt.close(); }
    });
    if (!installed) throw new Error('No helper was installed. Install cloudflared yourself, then rerun setup.');
    cloudflared = destination;
  }
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CLOUDFLARED_BIN: cloudflared! } });
    if (result.status !== 0) throw new Error('Setup stopped. Correct the reported prerequisite and rerun npm run setup.');
  };
  run(paseo, ['plugin', 'install', root]);
  if (!running) run(process.execPath, ['scripts/install-service.ts']);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const links = await launchTower();
      if (!process.argv.includes('--no-open')) spawnSync('open', [links.settingsUrl], { stdio: 'ignore' });
      console.log('Control Tower is ready. Enter your OpenAI key in the settings page, then open Control Tower in Paseo.'); return;
    } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  throw new Error('The service is still starting. Run npm run settings shortly, or inspect ~/.paseo/voice/service.log.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) void main().catch(error => { console.error(error.message); process.exitCode = 1; });
