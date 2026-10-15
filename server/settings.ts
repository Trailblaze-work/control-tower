import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

const key = z.string().trim().min(20).max(512).regex(/^sk-[A-Za-z0-9_-]+$/);
const savedSchema = z.object({ apiKey: key.optional(), adminApiKey: key.optional(), projectId: z.string().max(200).regex(/^[A-Za-z0-9_-]*$/).optional(), allowWorkspaceRenames: z.boolean().optional() }).strict();
export const keyInput = savedSchema.refine(value => Object.keys(value).length > 0);
export class Settings {
  private billingCache?: { at: number; value: unknown };
  private path: string; private fallback: () => Promise<string | null>;
  constructor(path: string, fallback: () => Promise<string | null>) { this.path = path; this.fallback = fallback; }
  async key() {
    const saved = await readPrivateJson(this.path);
    if (saved !== undefined && savedSchema.parse(saved).apiKey) return savedSchema.parse(saved).apiKey!;
    return this.fallback();
  }
  async status() {
    const saved = savedSchema.parse((await readPrivateJson(this.path)) ?? {});
    return { configured: Boolean(await this.key()), source: saved.apiKey ? 'settings' : 'environment_or_key_file', billingConfigured: Boolean(saved.adminApiKey), projectId: saved.projectId ?? '', allowWorkspaceRenames: saved.allowWorkspaceRenames ?? false };
  }
  async save(raw: unknown) {
    const update = keyInput.parse(raw);
    const saved = savedSchema.parse((await readPrivateJson(this.path)) ?? {});
    await writePrivateJson(this.path, { ...saved, ...update }); this.billingCache = undefined;
    return this.status();
  }
  async billed(providerFetch: typeof fetch = fetch) {
    if (this.billingCache && Date.now() - this.billingCache.at < 300_000) return this.billingCache.value;
    const saved = savedSchema.parse((await readPrivateJson(this.path)) ?? {});
    if (!saved.adminApiKey) return { status: 'not_configured', note: 'Optional OpenAI Admin key required for provider-reported costs.' };
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const amounts: Record<string, number> = {}; let page: string | undefined;
    for (let count = 0; count < 10; count++) {
      const url = new URL('https://api.openai.com/v1/organization/costs');
      url.searchParams.set('start_time', String(Math.floor(start.getTime() / 1000)));
      url.searchParams.set('bucket_width', '1d'); url.searchParams.set('limit', '31');
      if (saved.projectId) url.searchParams.set('project_ids[]', saved.projectId);
      if (page) url.searchParams.set('page', page);
      const response = await providerFetch(url, { headers: { Authorization: `Bearer ${saved.adminApiKey}` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return { status: 'unavailable', providerStatus: response.status, note: 'OpenAI rejected the billing query. Check the Admin key and project access.' };
      const body = z.object({ data: z.array(z.object({ results: z.array(z.object({ amount: z.object({ value: z.number(), currency: z.string() }) })) })), has_more: z.boolean(), next_page: z.string().nullish() }).parse(await response.json());
      for (const bucket of body.data) for (const result of bucket.results) amounts[result.amount.currency] = (amounts[result.amount.currency] ?? 0) + result.amount.value;
      if (!body.has_more) {
        const value = { status: 'available', amounts, from: start.toISOString(), fetchedAt: new Date().toISOString(), scope: saved.projectId ? 'project' : 'organization', note: 'Provider-reported month-to-date costs in daily buckets; may lag. This is separate from the plugin estimate and can include other applications.' };
        this.billingCache = { at: Date.now(), value }; return value;
      }
      if (!body.next_page) throw new Error('Invalid costs pagination'); page = body.next_page;
    }
    throw new Error('Costs pagination limit exceeded');
  }
}
