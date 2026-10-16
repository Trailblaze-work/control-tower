import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request as rawRequest } from 'node:http';
import type { Coordinator } from '../server/coordinator.ts';
import { voiceServer } from '../server/http.ts';

test('HTTP boundary authenticates sessions, rejects cross-origin requests and isolates calls', async t => {
  let upstreamCalls = 0;
  const server = voiceServer({
    port: 6768, publicUrl: 'https://voice.example', controlToken: 'control-private', apiKey: 'provider-private', ready: () => true,
    coordinator: { invoke: async () => ({ observed: true }) } as unknown as Coordinator,
    fetch: (async (_url, init) => {
      upstreamCalls++;
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer provider-private');
      const form = init?.body as FormData;
      const session = JSON.parse(form.get('session') as string);
      assert.equal(session.audio.input.turn_detection.interrupt_response, true);
      assert.ok(session.tools.some((tool: { name: string }) => tool.name === 'get_overview'));
      return new Response('v=0\r\ns=answer', { status: 201 });
    }) as typeof fetch,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
    const req = rawRequest(url + path, { method: init.method ?? 'GET', headers: { Host: 'voice.example', ...Object.fromEntries(new Headers(init.headers)) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value) for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on('error', reject); req.end(init.body);
  });
  const launch = () => request('/api/launch', { method: 'POST', headers: { Authorization: 'Bearer control-private' } });
  async function pair() {
    const link = await (await launch()).json() as { url: string };
    const result = await request('/api/pair', { method: 'POST', body: JSON.stringify({ ticket: new URL(link.url).hash.slice(1) }) });
    assert.equal(result.status, 200);
    return result.headers.get('set-cookie')!.split(';')[0];
  }
  assert.equal((await request('/api/status')).status, 401);
  assert.equal((await request('/api/launch', { method: 'POST' })).status, 401);
  assert.equal((await request('/api/launch-status', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await request('/api/launch', { method: 'POST', headers: { Authorization: 'Bearer control-private', Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request('/', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request('/settings')).status, 403, 'settings page is not exposed through the public tunnel Host');
  assert.equal((await request('/api/settings', { headers: { Authorization: 'Bearer control-private' } })).status, 403, 'even the control credential cannot use settings through the public Host');
  const cookie = await pair(); const other = await pair();
  const links = await (await launch()).json() as { url: string; localUrl: string };
  const ticket = new URL(links.url).hash.slice(1); const localTicket = new URL(links.localUrl).hash.slice(1);
  const linkStatus = () => request('/api/launch-status', { method: 'POST', headers: { Authorization: 'Bearer control-private' }, body: JSON.stringify({ ticket, localTicket }) });
  assert.deepEqual(await (await linkStatus()).json(), { refresh: false });
  const used = await request('/api/pair', { method: 'POST', body: JSON.stringify({ ticket }) });
  assert.equal(used.status, 200);
  assert.deepEqual(await (await linkStatus()).json(), { refresh: true });
  // Generating replacements must not invalidate an unused local counterpart or
  // a link already opened in a slow-loading browser.
  await launch();
  const counterpart = await request('/api/pair', { method: 'POST', body: JSON.stringify({ ticket: localTicket }) });
  assert.equal(counterpart.status, 200);
  const malformed = await request('/api/session', { method: 'POST', headers: { Cookie: cookie }, body: 'invalid' });
  assert.equal(malformed.status, 400); assert.equal(upstreamCalls, 0);
  const created = await request('/api/session', { method: 'POST', headers: { Cookie: cookie }, body: 'v=0\r\ns=offer' });
  assert.equal(created.status, 200);
  const answer = await created.text(); assert.equal(answer, 'v=0\r\ns=answer'); assert.ok(!answer.includes('private'));
  const callId = created.headers.get('X-Call-Id'); assert.ok(callId);
  const replacementLink = await (await launch()).json() as { url: string };
  const pairedAgain = await request('/api/pair', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ ticket: new URL(replacementLink.url).hash.slice(1) }) });
  assert.equal(pairedAgain.headers.get('set-cookie')!.split(';')[0], cookie, 'a fresh sidebar link preserves existing browser ownership');
  assert.equal((await request('/api/session', { method: 'POST', headers: { Cookie: other, 'X-Previous-Call': callId }, body: 'v=0' })).status, 403);
  const payload = JSON.stringify({ callId, invocationId: 'one', name: 'get_overview', args: {} });
  assert.equal((await request('/api/tool', { method: 'POST', headers: { Cookie: other }, body: payload })).status, 404);
  assert.equal((await request('/api/tool', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example' }, body: payload })).status, 403);
  const result = await request('/api/tool', { method: 'POST', headers: { Cookie: cookie }, body: payload });
  assert.deepEqual(await result.json(), { observed: true });
  assert.equal((await request('/api/session', { method: 'POST', headers: { Cookie: cookie }, body: 'v=0' })).status, 409);
  assert.equal(upstreamCalls, 1);
  const resumed = await request('/api/session', { method: 'POST', headers: { Cookie: cookie, 'X-Previous-Call': callId }, body: 'v=0' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.headers.get('X-Call-Id'), callId, 'reconnect retains the owned coordinator context');
  assert.equal(upstreamCalls, 2);
  assert.equal((await request('/api/end', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ callId }) })).status, 200);
  assert.equal((await request('/api/tool', { method: 'POST', headers: { Cookie: cookie }, body: payload })).status, 404);
});

test('embedding requires an owner-registered parent and uses scoped call credentials without cookies', async t => {
  const server = voiceServer({ port: 6768, publicUrl: 'https://voice.example', controlToken: 'owner-control', apiKey: 'provider-key', ready: () => true, coordinator: { invoke: async () => ({}) } as unknown as Coordinator });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
    const req = rawRequest(url + path, { method: init.method ?? 'GET', headers: { Host: 'voice.example', ...Object.fromEntries(new Headers(init.headers)) } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([,value]) => typeof value === 'string')) as Record<string,string> })));
    }); req.on('error', reject); req.end(init.body);
  });
  assert.match((await request('/')).headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await request('/api/launch', { method: 'POST', body: JSON.stringify({ embedOrigin: 'https://evil.example' }) })).status, 401);
  const launched = await request('/api/launch', { method: 'POST', headers: { Authorization: 'Bearer owner-control' }, body: JSON.stringify({ embedOrigin: 'https://app.paseo.sh' }) });
  const links = await launched.json() as { embedUrl: string };
  const page = await request('/embed');
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors https:\/\/app.paseo.sh/);
  assert.ok(!page.headers.get('content-security-policy')!.includes('evil.example'));
  const paired = await request('/api/pair', { method: 'POST', body: JSON.stringify({ embedded: true, ticket: new URL(links.embedUrl).hash.slice(1) }) });
  const session = await paired.json() as { sessionToken: string };
  assert.ok(session.sessionToken);
  assert.equal((await request('/api/status')).status, 401);
  assert.equal((await request('/api/status', { headers: { Authorization: `Bearer ${session.sessionToken}` } })).status, 200);
  assert.equal((await request('/api/settings', { headers: { Authorization: `Bearer ${session.sessionToken}` } })).status, 403);
  assert.equal((await request('/api/status', { headers: { Authorization: 'Bearer bogus' } })).status, 401);
});
