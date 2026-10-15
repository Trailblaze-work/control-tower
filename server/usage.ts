import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

const tokens = z.number().int().min(0).max(10_000_000).default(0);
const modalities = z.object({ text_tokens: tokens, audio_tokens: tokens, image_tokens: tokens }).strip();
const usageSchema = z.object({ input_tokens: tokens, output_tokens: tokens,
  input_token_details: z.object({ text_tokens: tokens, audio_tokens: tokens, image_tokens: tokens, cached_tokens: tokens, cached_tokens_details: modalities.optional() }).strip(),
  output_token_details: z.object({ text_tokens: tokens, audio_tokens: tokens }).strip(),
}).strip();
export const usageInput = z.object({ eventId: z.string().min(1).max(200), kind: z.enum(['realtime', 'transcription']), usage: z.unknown() }).strict();
type Record = { id: string; at: string; model: string; kind: string; usd: number | null; input: number; output: number };
const rates: { [model: string]: { audioIn: number; textIn: number; audioOut: number; textOut: number; audioCache: number; textCache: number } } = {
  'gpt-realtime-2.1': { audioIn: 32, textIn: 4, audioOut: 64, textOut: 24, audioCache: 0.4, textCache: 0.4 },
  'gpt-realtime-2.1-mini': { audioIn: 10, textIn: 0.6, audioOut: 20, textOut: 2.4, audioCache: 0.3, textCache: 0.06 },
};
export function estimate(model: string, raw: unknown) {
  const u = usageSchema.parse(raw); const r = rates[model]; const i = u.input_token_details; const o = u.output_token_details;
  if (!r || i.image_tokens || (i.cached_tokens && !i.cached_tokens_details)) return { usd: null, input: u.input_tokens, output: u.output_tokens };
  const cache = i.cached_tokens_details ?? { text_tokens: 0, audio_tokens: 0, image_tokens: 0 };
  if (cache.text_tokens > i.text_tokens || cache.audio_tokens > i.audio_tokens || cache.image_tokens ||
      cache.text_tokens + cache.audio_tokens !== i.cached_tokens || i.text_tokens + i.audio_tokens !== u.input_tokens || o.text_tokens + o.audio_tokens !== u.output_tokens) return { usd: null, input: u.input_tokens, output: u.output_tokens };
  return { usd: ((i.text_tokens-cache.text_tokens)*r.textIn+(i.audio_tokens-cache.audio_tokens)*r.audioIn+cache.text_tokens*r.textCache+cache.audio_tokens*r.audioCache+o.text_tokens*r.textOut+o.audio_tokens*r.audioOut)/1_000_000, input: u.input_tokens, output: u.output_tokens };
}
export class UsageLedger {
  private records: Record[] = [];
  private startedAt = new Date().toISOString();
  private writes = Promise.resolve();
  private path: string;
  constructor(path: string) { this.path = path; }
  async load() {
    const saved = await readPrivateJson(this.path);
    if (saved === undefined) return;
    const parsed = z.object({ startedAt: z.string(), records: z.array(z.object({ id: z.string(), at: z.string(), model: z.string(), kind: z.string(), usd: z.number().nullable(), input: z.number(), output: z.number() })) }).parse(saved);
    this.startedAt = parsed.startedAt; this.records = parsed.records;
  }
  async record(callId: string, model: string, raw: unknown) {
    const event = usageInput.parse(raw); const id = `${callId}:${event.kind}:${event.eventId}`;
    if (this.records.some(record => record.id === id)) return this.summary();
    if (this.records.length >= 100_000) throw new Error('Usage ledger capacity reached');
    // Transcription duration is reported by the provider, not wall-clock mic time.
    const amount = event.kind === 'realtime' ? estimate(model, event.usage) : (() => {
      const u = z.discriminatedUnion('type', [
        z.object({ type: z.literal('duration'), seconds: z.number().min(0).max(3600) }),
        z.object({ type: z.literal('tokens'), input_tokens: tokens, output_tokens: tokens }),
      ]).parse(event.usage);
      return u.type === 'duration' ? { usd: u.seconds / 60 * 0.003, input: 0, output: 0 }
        : { usd: (u.input_tokens * 1.25 + u.output_tokens * 5) / 1_000_000, input: u.input_tokens, output: u.output_tokens };
    })();
    this.records.push({ id, at: new Date().toISOString(), model: event.kind === 'realtime' ? model : 'gpt-4o-mini-transcribe', kind: event.kind, ...amount });
    const snapshot = { startedAt: this.startedAt, records: [...this.records] };
    this.writes = this.writes.catch(() => {}).then(() => writePrivateJson(this.path, snapshot)); await this.writes;
    return this.summary();
  }
  summary() {
    const now = new Date().toISOString(); const month = now.slice(0, 7); const today = now.slice(0, 10);
    const sum = (prefix: string) => this.records.filter(r => r.at.startsWith(prefix)).reduce((n, r) => n + (r.usd ?? 0), 0);
    return { source: 'browser_reported_provider_usage', estimated: true, startedAt: this.startedAt, totalUsd: sum(''), monthUsd: sum(month), todayUsd: sum(today), events: this.records.length,
      unpricedEvents: this.records.filter(r => r.usd === null).length,
      transcriptionEvents: this.records.filter(r => r.kind === 'transcription').length,
      pricingAsOf: '2026-10-15', pricingUrl: 'https://developers.openai.com/api/docs/pricing',
      note: 'Estimate from received provider usage events since tracking began; missing events, earlier calls, workspace-agent costs, discounts and taxes are not included. Browser reports are not a billing ledger.' };
  }
}
