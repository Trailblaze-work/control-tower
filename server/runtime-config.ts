import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tools } from './coordinator.ts';

const schema = z.object({
  instructions: z.string().min(1).max(40000), model: z.string().min(1), voice: z.string().min(1),
  maxOutputTokens: z.number().int().min(64).max(4096),
});
export async function runtimeConfig() {
  const policy = schema.parse(JSON.parse(await readFile(new URL('./voice-policy.json', import.meta.url), 'utf8')));
  const session = {
    type: 'realtime', model: process.env.PASEO_VOICE_MODEL ?? policy.model, instructions: policy.instructions,
    audio: {
      input: { noise_reduction: { type: 'far_field' }, transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true } },
      output: { voice: policy.voice },
    },
    tools, tool_choice: 'auto', max_output_tokens: policy.maxOutputTokens,
  };
  return { revision: createHash('sha256').update(JSON.stringify(session)).digest('hex'), session };
}
