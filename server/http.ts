import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Access, equalSecret } from './auth.ts';
import { conversation, Coordinator, recordUtterance } from './coordinator.ts';
import type { Conversation } from './coordinator.ts';
import { runtimeConfig } from './runtime-config.ts';
import { z } from 'zod';
import { errorCode, silent, type Reporter, type Telemetry } from './telemetry.ts';
import type { Settings } from './settings.ts';
import type { UsageLedger } from './usage.ts';

export interface ServerOptions {
  controlToken: string;
  publicUrl: string;
  port: number;
  apiKey: string | null;
  coordinator: Coordinator;
  ready: () => boolean;
  fetch?: typeof fetch;
  access?: Access;
  config?: typeof runtimeConfig;
  getApiKey?: () => Promise<string | null>;
  settings?: Settings;
  usage?: UsageLedger;
  telemetry?: Telemetry;
  report?: Reporter;
  connection?: () => string;
}
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
async function body(req: IncomingMessage, max = 100_000): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'Request too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
}
function parseJson(text: string): Record<string, unknown> {
  try { const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== 'object') throw 0; return value; }
  catch { throw new HttpError(400, 'Expected a JSON object'); }
}

export function voiceServer(options: ServerOptions) {
  const access = options.access ?? new Access(); const calls = new Map<string, Conversation>();
  const origins = new Set([new URL(options.publicUrl).origin, `http://localhost:${options.port}`, `http://127.0.0.1:${options.port}`]);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  const providerFetch = options.fetch ?? fetch;
  const getConfig = options.config ?? runtimeConfig;
  const getKey = options.getApiKey ?? (async () => options.apiKey);
  const report = options.report ?? silent;
  const localHosts = new Set([`localhost:${options.port}`, `127.0.0.1:${options.port}`]);
  const diagnosticLimits = new Map<string, { since: number; count: number }>();
  const browserEvent = z.object({ event: z.enum(['api_failure', 'webrtc_state', 'provider_error', 'session_connected', 'session_closed', 'page_hidden', 'page_visible', 'config_applied', 'recovery_attempt', 'recovery_succeeded', 'recovery_stopped', 'microphone_ended', 'audio_interrupted']),
    operation: z.enum(['status', 'config', 'tool', 'transcript', 'session', 'heartbeat', 'usage', 'end', 'pair', 'webrtc', 'page']).optional(),
    status: z.number().int().min(0).max(599).optional(), durationMs: z.number().min(0).max(3600000).optional(),
    code: z.enum(['network', 'invalid_response', 'timeout', 'server_error', 'provider_error', 'missing_call', 'unknown']).optional(),
    connection: z.enum(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']).optional(),
  }).strict();
  let creating = 0;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID(); const started = Date.now();
    let operation = 'unknown_route';
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (!hosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Unrecognized host');
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (['/', '/api/status', '/api/config', '/api/session', '/api/pair', '/api/tool', '/api/transcript', '/api/end', '/api/heartbeat', '/api/usage', '/api/settings', '/api/billing', '/api/diagnostic', '/api/diagnostics', '/api/launch', '/api/launch-status'].includes(path)) operation = path === '/' ? 'page' : path.slice(5);
      if (req.method === 'POST') {
        // A browser must come from our page. Local automation authenticates separately.
        if (req.headers.origin && !origins.has(req.headers.origin)) throw new HttpError(403, 'Unrecognized origin');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request rejected');
      }
      if (req.method === 'GET' && ['/', '/app.js', '/session-state.js', '/style.css', '/settings', '/settings.js'].includes(path)) {
        if (path.startsWith('/settings') && !localHosts.has(req.headers.host!)) throw new HttpError(403, 'Settings are available only on the laptop.');
        const name = path === '/' ? 'index.html' : path === '/settings' ? 'settings.html' : path.slice(1);
        const content = await readFile(new URL(`./web/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript' : 'text/css' });
        res.end(content); return;
      }
      if (req.method === 'POST' && path === '/api/launch') {
        if (!equalSecret(req.headers.authorization ?? '', `Bearer ${options.controlToken}`)) throw new HttpError(401, 'Local control authentication required');
        json(res, 200, { url: `${options.publicUrl}/#${access.ticket()}`, localUrl: `http://localhost:${options.port}/#${access.ticket()}`, settingsUrl: `http://localhost:${options.port}/settings#${options.controlToken}` }); return;
      }
      if (req.method === 'POST' && path === '/api/launch-status') {
        if (!equalSecret(req.headers.authorization ?? '', `Bearer ${options.controlToken}`)) throw new HttpError(401, 'Local control authentication required');
        const data = parseJson(await body(req, 2000));
        if (typeof data.ticket !== 'string' || typeof data.localTicket !== 'string') throw new HttpError(400, 'Invalid launch tickets');
        json(res, 200, { refresh: !access.available(data.ticket) || !access.available(data.localTicket) }); return;
      }
      if (req.method === 'POST' && path === '/api/pair') {
        const data = parseJson(await body(req, 2000));
        const paired = typeof data.ticket === 'string' ? access.pair(data.ticket) : null;
        if (!paired) throw new HttpError(401, 'Link expired or already used. Open a fresh link from Paseo or run npm run link on the laptop.');
        // A fresh link must not change an already-paired browser's queue owner.
        const session = access.valid(req.headers.cookie) ?? paired;
        await access.persist();
        const secure = req.headers.origin?.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('Set-Cookie', `paseo_voice=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
        json(res, 200, { paired: true }); return;
      }
      if (['/api/settings', '/api/billing', '/api/diagnostics'].includes(path)) {
        if (!localHosts.has(req.headers.host!) || !equalSecret(req.headers.authorization ?? '', `Bearer ${options.controlToken}`)) throw new HttpError(403, 'Laptop settings authentication required.');
        if (path === '/api/settings' && options.settings) {
          if (req.method === 'GET') { json(res, 200, { ...await options.settings.status(), usage: options.usage?.summary() }); return; }
          if (req.method === 'POST') {
            const raw = parseJson(await body(req, 3000));
            try { json(res, 200, await options.settings.save(raw)); }
            catch (error) { if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid settings. Enter an OpenAI key beginning with sk-.'); throw error; }
            report({ event: 'settings_saved', requestId }); return;
          }
        }
        if (req.method === 'GET' && path === '/api/billing' && options.settings) { json(res, 200, await options.settings.billed(providerFetch)); return; }
        if (req.method === 'GET' && path === '/api/diagnostics') {
          json(res, 200, { ...options.telemetry?.snapshot(), connection: options.connection?.(), calls: [...calls.values()].map(c => ({ ageSeconds: Math.round((Date.now()-c.createdAt)/1000), lastSeenSeconds: Math.round((Date.now()-c.lastSeen)/1000), utterances: c.transcriptIndex, jobs: c.jobs.size })) }); return;
        }
      }
      const owner = access.valid(req.headers.cookie);
      if (!owner) throw new HttpError(401, 'Open a fresh link from the Paseo plugin or run npm run link on the laptop.');
      if (req.method === 'GET' && path === '/api/status') {
        json(res, 200, { ready: options.ready(), voiceConfigured: Boolean(await getKey()), model: (await getConfig()).session.model, hosting: 'laptop' }); return;
      }
      if (req.method === 'POST' && path === '/api/diagnostic') {
        if (diagnosticLimits.size > 1000) diagnosticLimits.clear();
        const limit = diagnosticLimits.get(owner) ?? { since: Date.now(), count: 0 };
        if (Date.now()-limit.since > 60000) { limit.since = Date.now(); limit.count = 0; }
        if (++limit.count > 60) throw new HttpError(429, 'Diagnostic rate limit'); diagnosticLimits.set(owner, limit);
        const parsed = browserEvent.safeParse(parseJson(await body(req, 2000)));
        if (!parsed.success) throw new HttpError(400, 'Invalid diagnostic event');
        report({ ...parsed.data, event: `browser_${parsed.data.event}`, requestId }); json(res, 200, { recorded: true }); return;
      }
      if (req.method === 'GET' && path === '/api/config') { json(res, 200, await getConfig()); return; }
      if (req.method === 'POST' && path === '/api/session') {
        const apiKey = await getKey();
        if (!apiKey) throw new HttpError(503, 'Open Voice settings on the laptop and configure an OpenAI API key.');
        if (!options.ready()) throw new HttpError(503, 'Paseo is disconnected. Start Paseo and try again.');
        // Bound sessions globally and per browser; the account is personal, not a public voice service.
        for (const [key, call] of calls) if (Date.now() - call.lastSeen > 120_000 || Date.now() - call.createdAt > 60 * 60_000) calls.delete(key);
        const previousId = typeof req.headers['x-previous-call'] === 'string' ? req.headers['x-previous-call'] : undefined;
        const previous = previousId ? calls.get(previousId) : undefined;
        if (previous && previous.owner !== owner) throw new HttpError(403, 'Call belongs to another browser session');
        if (creating || (!previous && (calls.size >= 3 || [...calls.values()].some(c => c.owner === owner)))) throw new HttpError(409, 'A call is already active. End it before starting another.');
        const sdp = await body(req);
        if (!sdp.startsWith('v=0')) throw new HttpError(400, 'Expected a WebRTC offer');
        creating++;
        try {
          const form = new FormData(); form.set('sdp', sdp);
          const config = await getConfig();
          form.set('session', JSON.stringify(config.session));
          const upstream = await providerFetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(30_000) });
          if (!upstream.ok) {
            report({ event: 'provider_session', requestId, outcome: 'error', status: upstream.status, durationMs: Date.now()-started });
            console.error(`Voice provider rejected session (${upstream.status}).`);
            throw new HttpError(502, `Voice provider rejected the call (${upstream.status}). Check the configured key, model access and account balance.`);
          }
          const answer = await upstream.text();
          const callId = previousId && previous ? previousId : randomUUID();
          const resumed = previous ?? conversation(owner); resumed.lastSeen = Date.now(); resumed.model = config.session.model; calls.set(callId, resumed);
          report({ event: 'provider_session', requestId, outcome: previous ? 'resumed' : 'created', durationMs: Date.now()-started });
          res.writeHead(200, { 'Content-Type': 'application/sdp', 'X-Call-Id': callId, 'X-Config-Revision': config.revision }); res.end(answer);
        } finally { creating--; }
        return;
      }
      if (req.method === 'POST' && ['/api/tool', '/api/transcript', '/api/end', '/api/heartbeat', '/api/usage'].includes(path)) {
        const data = parseJson(await body(req));
        const call = typeof data.callId === 'string' ? calls.get(data.callId) : null;
        if (!call || call.owner !== owner) throw new HttpError(404, 'Call session lost, possibly after a service restart. Refresh conversation to reconnect with saved context.');
        call.lastSeen = Date.now();
        if (path === '/api/heartbeat') { json(res, 200, { alive: true }); return; }
        if (path === '/api/usage' && options.usage) {
          const { callId: _callId, ...usage } = data;
          try { json(res, 200, await options.usage.record(data.callId as string, call.model ?? '', usage)); }
          catch (error) { if (error instanceof z.ZodError) throw new HttpError(400, 'Unsupported usage event'); throw error; }
          return;
        }
        if (path === '/api/end') { calls.delete(data.callId as string); json(res, 200, { ended: true }); return; }
        if (path === '/api/transcript') {
          if (typeof data.text !== 'string' || data.text.length > 10000) throw new HttpError(400, 'Invalid transcript');
          recordUtterance(call, data.text); json(res, 200, { recorded: true }); return;
        }
        if (typeof data.invocationId !== 'string' || data.invocationId.length > 200 || typeof data.name !== 'string') throw new HttpError(400, 'Invalid tool invocation');
        const result = await options.coordinator.invoke(call, data.invocationId, data.name, data.args);
        json(res, 200, result); return;
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      report({ event: 'http_failure', requestId, operation, status, code: errorCode(error), durationMs: Date.now()-started, connection: options.connection?.() });
      if (res.headersSent) { res.end(); return; }
      json(res, status, { error: error instanceof HttpError ? error.message : 'Local service operation failed. Check Connection details for the request reference.', requestId, code: errorCode(error) });
    }
  });
  server.requestTimeout = 40_000; server.headersTimeout = 10_000;
  return server;
}
