import { createElement } from 'react';
// Browser access stays here; Paseo also loads this plugin on native clients.
export function embeddingOrigin() {
  const location = (globalThis as unknown as { location?: { origin: string; protocol: string } }).location;
  if (!location) return undefined;
  if (location.protocol === 'file:') return 'file:';
  return /^https?:\/\//.test(location.origin) ? location.origin : undefined;
}
export function CallFrame({ url }: { url: string }) {
  return createElement('iframe', { src: url, title: 'Control Tower live conversation', allow: 'microphone; autoplay', sandbox: 'allow-scripts allow-same-origin', referrerPolicy: 'no-referrer', style: { width: '100%', height: '100%', minHeight: 520, border: 0, borderRadius: 16, background: '#111827' } });
}
