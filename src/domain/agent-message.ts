/** Agent requests must contain at least one Unicode letter or number. This
 * rejects focus/IME/automation debris such as `,         .` before it can be
 * persisted or spend an LLM request, while preserving Korean and tokens such
 * as @FAIL, DQ=9, SM-8975 and regular-expression text containing letters. */
export function hasMeaningfulAgentMessage(value: unknown): boolean {
  return typeof value === 'string' && /[\p{L}\p{N}]/u.test(value.trim())
}
