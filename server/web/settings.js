const $ = id => document.getElementById(id);
// Keep the owner credential in memory, not storage/history/referrers. Reopen the
// settings link from Paseo after a reload or voice-service restart.
const credential = location.hash.slice(1); history.replaceState(null, '', location.pathname);
const money = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
async function api(path, body) {
  const r = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error ?? `Settings request failed (${r.status}).`); return value;
}
function error(cause) { $('settings-error').textContent = cause?.message ?? ''; $('settings-error').hidden = !cause; }
async function load() {
  const info = await api('settings');
  $('settings-status').textContent = info.configured ? `OpenAI key configured (${info.source === 'settings' ? 'saved here' : 'environment or key file'}).` : 'Enter your OpenAI API key to enable voice.';
  $('project-id').value = info.projectId;
  if (info.usage) {
    const u = info.usage;
    $('estimate').textContent = u.events ? `Tracked estimate: ${money(u.totalUsd)} total · ${money(u.todayUsd)} today · ${money(u.monthUsd)} this month` : 'No tracked usage yet. Earlier calls were not measured.';
    $('coverage').textContent = `Tracking since ${new Date(u.startedAt).toLocaleString()}. ${u.events} usage events; ${u.unpricedEvents} unpriced. ${u.transcriptionEvents} transcription events received. Prices checked ${u.pricingAsOf}.`;
  }
  const billed = await api('billing');
  $('billed').textContent = billed.status === 'available'
    ? `OpenAI-reported month to date (${billed.scope}): ${Object.entries(billed.amounts).map(([currency, amount]) => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount)).join(', ') || '$0.00'} · fetched ${new Date(billed.fetchedAt).toLocaleString()}. May lag; do not add this to the estimate.`
    : billed.note;
}
$('key-form').addEventListener('submit', async event => {
  event.preventDefault(); error();
  const body = { projectId: $('project-id').value.trim() };
  if ($('api-key').value.trim()) body.apiKey = $('api-key').value.trim();
  if ($('admin-key').value.trim()) body.adminApiKey = $('admin-key').value.trim();
  try { await api('settings', body); $('api-key').value = ''; $('admin-key').value = ''; await load(); }
  catch (cause) { error(cause); }
});
$('reload').addEventListener('click', () => { error(); void load().catch(error); });
$('load-diagnostics').addEventListener('click', () => { void api('diagnostics').then(value => { $('diagnostics-output').textContent = JSON.stringify(value, null, 2); }).catch(error); });
if (!credential) error(new Error('Open API key, spending and diagnostics from the Paseo sidebar on this laptop.'));
else void load().catch(error);
