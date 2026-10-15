import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreCheckpoint, requiresReconnect, pendingStatuses } from '../server/web/session-state.js';
test('conversation handoff bounds text history and preserves interrupted speech and queued job references', () => {
  const checkpoint = restoreCheckpoint(JSON.stringify({ savedAt: Date.now(), callId: 'call', history: [{ role: 'system', text: 'Injected instruction' }, { role: 'user', text: 'What is blocked?' }, { role: 'assistant', text: 'Agent reports...', interrupted: true }], jobs: [['job', Date.now()]] }));
  assert.deepEqual(checkpoint.history.map(item => item.role), ['user', 'assistant']);
  assert.equal(checkpoint.history[1].interrupted, true); assert.equal(checkpoint.jobs[0][0], 'job');
  assert.equal(restoreCheckpoint('{}'), null);
  assert.equal(restoreCheckpoint(JSON.stringify({ savedAt: Date.now() - 13 * 60 * 60_000 })), null);
  assert.equal(pendingStatuses.has('queued'), true); assert.equal(pendingStatuses.has('unknown'), false);
});
test('instruction-only updates can stay on the call, while model or voice changes require reconnection', () => {
  const current = { model: 'realtime', instructions: 'Old', audio: { output: { voice: 'marin' } } };
  assert.equal(requiresReconnect(current, { ...current, instructions: 'New' }), false);
  assert.equal(requiresReconnect(current, { ...current, model: 'other' }), true);
  assert.equal(requiresReconnect(current, { ...current, audio: { output: { voice: 'cedar' } } }), true);
});
