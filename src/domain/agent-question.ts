import type { NativeAgentQuestionView } from '../../electron/shared/contracts'

/** Model-authored choices; never infer choices from prose or supply canned answers. */
export function normalizeAgentQuestion(value: unknown): Omit<Extract<NativeAgentQuestionView, { kind: 'agent' }>, 'id'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 2_000) return undefined
  if (raw.choices !== undefined && (!Array.isArray(raw.choices) || raw.choices.length > 8
    || raw.choices.some((choice) => typeof choice !== 'string' || !choice.trim() || choice.length > 240))) return undefined
  return { kind: 'agent', prompt: raw.prompt.trim(), choices: [...new Set((raw.choices as string[] | undefined ?? []).map((choice) => choice.trim()))] }
}

/** OpenCode returns the same structured question in its ordinary reply. */
export function extractAgentQuestion(content: string) {
  let question: ReturnType<typeof normalizeAgentQuestion>
  const visible = content.replace(/<sct-question>([\s\S]*?)<\/sct-question>/g, (_, json: string) => {
    try { question ??= normalizeAgentQuestion(JSON.parse(json)) } catch { /* Ignore malformed metadata, preserve the readable reply. */ }
    return ''
  }).trim()
  return { content: visible, question }
}
