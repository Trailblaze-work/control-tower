import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Diagnostic = { event: string; requestId?: string; operation?: string; outcome?: string; status?: number; durationMs?: number; code?: string; connection?: string; count?: number };
export type Reporter = (event: Diagnostic) => void;
export const silent: Reporter = () => {};
export function errorCode(error: unknown): string {
  // Classify without persisting arbitrary error messages, URLs or payloads.
  const e = error as { name?: string; message?: string; code?: string } | undefined;
  const text = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.code ?? ''}`.toLowerCase();
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (/disconnect|closed|econn|network|fetch failed/.test(text)) return 'connection_lost';
  if (/permission|unauthor|authentic/.test(text)) return 'authentication';
  if (/not found|unavailable|archived/.test(text)) return 'unavailable';
  if (/zod|validat|parse|json/.test(text)) return 'invalid_data';
  return 'unexpected';
}
export class Telemetry {
  private writes = Promise.resolve();
  private recent: (Diagnostic & { at: string })[] = [];
  readonly bootId = randomUUID();
  private path: string;
  constructor(path: string) { this.path = path; }
  report: Reporter = entry => {
    // Explicit allow-list: never serialize caller objects, request bodies, errors,
    // credentials, cookies, SDP, transcripts, agent titles or filesystem paths.
    const value = { at: new Date().toISOString(), bootId: this.bootId,
      event: entry.event.slice(0, 80), requestId: entry.requestId?.slice(0, 80),
      operation: entry.operation?.slice(0, 80), outcome: entry.outcome?.slice(0, 40),
      status: entry.status, durationMs: entry.durationMs, code: entry.code?.slice(0, 80), connection: entry.connection?.slice(0, 40), count: entry.count };
    this.recent.push(value); this.recent = this.recent.slice(-100);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try { if ((await stat(this.path)).size > 2_000_000) await rename(this.path, `${this.path}.1`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await appendFile(this.path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await chmod(this.path, 0o600);
    }).catch(() => { console.error('Diagnostic log write failed.'); });
  };
  snapshot() { return { bootId: this.bootId, events: [...this.recent] }; }
  async flush() { await this.writes; }
}
