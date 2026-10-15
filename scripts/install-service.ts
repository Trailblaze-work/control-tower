import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stateDir } from '../server/config.ts';

if (process.platform !== 'darwin') throw new Error('The background installer currently supports macOS. Use npm run serve on other systems.');
const directory = join(homedir(), 'Library/LaunchAgents');
const destination = join(directory, 'dev.paseo.voice.plist');
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
await mkdir(directory, { recursive: true });
await mkdir(stateDir, { recursive: true, mode: 0o700 }); await chmod(stateDir, 0o700);
const log = join(stateDir, 'service.log'); await writeFile(log, '', { flag: 'a', mode: 0o600 }); await chmod(log, 0o600);
await writeFile(destination, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.paseo.voice</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root, 'scripts/service.ts'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>`, { mode: 0o600 });
const domain = `gui/${process.getuid!()}`;
spawnSync('launchctl', ['bootout', domain, destination], { stdio: 'ignore' });
const result = spawnSync('launchctl', ['bootstrap', domain, destination], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Could not register the background service. Run npm run serve to start it in a terminal.');
console.log('Paseo Voice background service installed. Its temporary tunnel address updates automatically.');
