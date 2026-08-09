import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Safe CommonMark + GFM renderer. Raw HTML stays disabled. */
export function AgentMarkdown({ children }: { children: string }) {
  return <div className="agent-markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    components={{
      a: ({ href, children: label }) => <a href={href} target="_blank" rel="noreferrer noopener">{label}</a>,
    }}
  >{children}</ReactMarkdown></div>
}
