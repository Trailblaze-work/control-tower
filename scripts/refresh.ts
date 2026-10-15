import { readFile } from 'node:fs/promises';
import { stateFile } from '../server/config.ts';
const state = JSON.parse(await readFile(stateFile, 'utf8')) as { supervisorPid?: number };
if (!Number.isInteger(state.supervisorPid) || state.supervisorPid! <= 1) throw new Error('The running service predates app-only refresh. Install/restart the supervisor once to enable it.');
process.kill(state.supervisorPid!, 'SIGUSR2');
console.log('Voice app refresh requested. The existing tunnel address will remain; callers can use Refresh conversation to reconnect with saved context.');
