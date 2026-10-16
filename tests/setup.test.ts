import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadHelper } from '../scripts/setup.ts';

test('declining the optional helper download makes no network request or installation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'control-tower-consent-')); t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'cloudflared');
  assert.equal(await downloadHelper(destination, async () => false, (() => { throw new Error('Network access before consent'); }) as typeof fetch), false);
  await assert.rejects(access(destination));
});
test('helper checksum failure never installs the downloaded executable', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'control-tower-digest-')); t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'cloudflared');
  let requests = 0;
  const request = (async () => ++requests === 1 ? Response.json({ assets: [{ name: `cloudflared-darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`, digest: 'sha256:'+'0'.repeat(64), browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/test/cloudflared.tgz' }] }) : new Response('corrupted archive')) as typeof fetch;
  await assert.rejects(downloadHelper(destination, async () => true, request), /checksum mismatch/);
  await assert.rejects(access(destination));
});
