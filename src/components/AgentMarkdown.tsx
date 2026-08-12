import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Normalize transport artefacts from OpenAI-compatible gateways. */
export function normalizeAgentMarkdown(source: string): string {
  let value = source.replace(/\r\n?/g, '\n').trim()
  if (!value.includes('\n') && /\\n/.test(value)) {
    value = value.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\\t/g, '\t')
  }
  const wrapped = value.match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```$/i)
  value = wrapped?.[1] ?? value
  // Some OpenAI-compatible models put a GFM table directly after a list
  // sentence without the blank line required by CommonMark. Preserve the
  // wording while making the table render as a table instead of pipe text.
  value = value.replace(
    /([^\n])\n(?=[ \t]*\|[^\n]+\|\n[ \t]*\|(?:\s*:?-{3,}:?\s*\|)+)/g,
    '$1\n\n',
  )
  // Korean gateways often leave spaces inside strong delimiters or attach a
  // postposition directly after the closing delimiter. Strict CommonMark
  // otherwise exposes the asterisks instead of rendering emphasis.
  value = value.replace(/\*\*[ \t]+([^*\n]+?)\*\*/g, '**$1**')
  value = value.replace(/\*\*([^*\n]*?\S)[ \t]+\*\*/g, '**$1**')
  // A few gateways attach an opening delimiter to the preceding word. Match
  // the complete emphasis span so a normal closing delimiter is never moved.
  value = value.replace(/([\p{L}\p{N})\]])\*\*([^\s*\n][^*\n]*?)\*\*/gu, '$1 **$2**')
  value = value.replace(/\*\*([^*\n]+?)\*\*([\p{Script=Hangul}]+)/gu, '**$1$2**')
  // OpenAI-compatible models occasionally emit a LaTeX arrow even though
  // this panel intentionally renders Markdown, not a math dialect. Keep the
  // engineering sequence readable without exposing transport notation.
  value = value.replace(/\$?\\(?:rightarrow|to)\$?/g, '→')
  return value.trim()
}

/** Safe CommonMark + GFM renderer. Raw HTML stays disabled. */
export function AgentMarkdown({ children }: { children: string }) {
  return <div className="agent-markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    components={{
      a: ({ href, children: label }) => <a href={href} target="_blank" rel="noreferrer noopener">{label}</a>,
    }}
  >{normalizeAgentMarkdown(children)}</ReactMarkdown></div>
}
