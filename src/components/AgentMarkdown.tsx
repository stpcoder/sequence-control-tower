import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Normalize transport artefacts from OpenAI-compatible gateways. */
export function normalizeAgentMarkdown(source: string): string {
  let value = source.replace(/\r\n?/g, '\n').trim()
  if (!value.includes('\n') && /\\n/.test(value)) {
    value = value.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\\t/g, '\t')
  }
  const wrapped = value.match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```$/i)
  return (wrapped?.[1] ?? value).trim()
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
