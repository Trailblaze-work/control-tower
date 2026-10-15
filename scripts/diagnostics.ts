import { readFile } from 'node:fs/promises';
import { stateFile } from '../server/config.ts';
const state = JSON.parse(await readFile(stateFile, 'utf8')) as { port: number; controlToken: string };
const response = await fetch(`http://localhost:${state.port}/api/diagnostics`, { headers: { Authorization: `Bearer ${state.controlToken}` }, signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error(`Diagnostics unavailable (${response.status}).`);
console.log(JSON.stringify(await response.json(), null, 2));
