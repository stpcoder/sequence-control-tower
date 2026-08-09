import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown } from '../../src/components/AgentMarkdown'

describe('AgentMarkdown', () => {
  it('renders headings, emphasis, code and single-column list semantics safely', () => {
    const markup = renderToStaticMarkup(<AgentMarkdown>{'## 판정\n- **DQ9** 집중\n- `VDD=1.295V`'}</AgentMarkdown>)
    expect(markup).toContain('<h2>판정</h2>')
    expect(markup).toContain('<strong>DQ9</strong>')
    expect(markup).toContain('<code>VDD=1.295V</code>')
    expect(markup).toContain('<ul>')
  })

  it('renders GFM separators, tables, task lists, quotes, links and fenced code', () => {
    const markup = renderToStaticMarkup(<AgentMarkdown>{'# 분석\n\n---\n\n> 확인 필요\n\n| 조건 | 결과 |\n| --- | --- |\n| DQ9 | FAIL |\n\n- [x] 근거 확인\n\n~~추정~~\n\n```text\n@FAIL\n```\n\n[문서](https://example.com)'}</AgentMarkdown>)
    expect(markup).toContain('<hr')
    expect(markup).toContain('<blockquote>')
    expect(markup).toContain('<table>')
    expect(markup).toContain('type="checkbox"')
    expect(markup).toContain('<del>추정</del>')
    expect(markup).toContain('<pre>')
    expect(markup).toContain('target="_blank"')
  })
})
