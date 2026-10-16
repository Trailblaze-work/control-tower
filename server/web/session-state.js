export const pendingStatuses = new Set(['queued', 'submitting', 'accepted', 'waiting']);
export function restoreCheckpoint(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.savedAt !== 'number' || Date.now() - value.savedAt > 12 * 60 * 60_000) return null;
    const history = Array.isArray(value.history) ? value.history.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').slice(-40).map(item => ({ role: item.role, text: item.text.slice(-4000), interrupted: Boolean(item.interrupted) })) : [];
    const jobs = Array.isArray(value.jobs) ? value.jobs.filter(item => Array.isArray(item) && typeof item[0] === 'string' && item[0].length <= 200 && typeof item[1] === 'number').slice(-30) : [];
    return { history, jobs, callId: typeof value.callId === 'string' ? value.callId : undefined };
  } catch { return null; }
}
export function requiresReconnect(current, next) {
  return current.model !== next.model || current.audio.output.voice !== next.audio.output.voice;
}
