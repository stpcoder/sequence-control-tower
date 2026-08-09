import type { ReactNode } from 'react'

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    return part
  })
}

/** Small, safe renderer for the Markdown subset used by the native Agent. */
export function AgentMarkdown({ children }: { children: string }) {
  const lines = children.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index += 1; continue }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      blocks.push(level === 1 ? <h2 key={index}>{inline(heading[2])}</h2> : level === 2 ? <h3 key={index}>{inline(heading[2])}</h3> : <h4 key={index}>{inline(heading[2])}</h4>)
      index += 1
      continue
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line)
    if (unordered || ordered) {
      const items: ReactNode[] = []
      const isOrdered = Boolean(ordered)
      while (index < lines.length) {
        const match = isOrdered ? /^\d+[.)]\s+(.+)$/.exec(lines[index]) : /^[-*]\s+(.+)$/.exec(lines[index])
        if (!match) break
        items.push(<li key={index}>{inline(match[1])}</li>)
        index += 1
      }
      blocks.push(isOrdered ? <ol key={`ol-${index}`}>{items}</ol> : <ul key={`ul-${index}`}>{items}</ul>)
      continue
    }
    blocks.push(<p key={index}>{inline(line)}</p>)
    index += 1
  }
  return <div className="agent-markdown">{blocks}</div>
}
