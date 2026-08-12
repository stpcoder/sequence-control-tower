import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown, normalizeAgentMarkdown } from '../../src/components/AgentMarkdown'

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

  it('renders italic examples and separators from escaped gateway responses', () => {
    const transported = '```markdown\\n*예: VDD 1.315V 개선 확인 노드(sample-n-vdd-up)에 대해 4개의 PASS 로그 근거 확인.*\\n\\n---\\n\\n다음 평가\\n```'
    const normalized = normalizeAgentMarkdown(transported)
    const markup = renderToStaticMarkup(<AgentMarkdown>{transported}</AgentMarkdown>)
    expect(normalized).not.toContain('```markdown')
    expect(markup).toContain('<em>예: VDD 1.315V 개선 확인 노드(sample-n-vdd-up)에 대해 4개의 PASS 로그 근거 확인.</em>')
    expect(markup).toContain('<hr')
    expect(markup).not.toContain('\\n')
  })

  it('repairs a model table placed directly after a list sentence', () => {
    const source = '* **정확한 분석 순서**:\n| 순서 | 검색어 |\n| --- | --- |\n| 1 | `set_rail` |'
    const normalized = normalizeAgentMarkdown(source)
    const markup = renderToStaticMarkup(<AgentMarkdown>{source}</AgentMarkdown>)
    expect(normalized).toContain('분석 순서**:\n\n| 순서')
    expect(markup).toContain('<table>')
    expect(markup).toContain('<code>set_rail</code>')
  })

  it('renders model-generated LaTeX sequence arrows as plain readable arrows', () => {
    expect(normalizeAgentMarkdown('PBL $\\rightarrow$ LK \\to OS')).toBe('PBL → LK → OS')
  })

  it('repairs Korean strong emphasis with inner spaces or a joined postposition', () => {
    const markup = renderToStaticMarkup(<AgentMarkdown>{'thermal은 **판정 규칙이 아닌 단순 탐색**으로 분류됩니다.\n\n** POST_PBL → LK → @PASS **'}</AgentMarkdown>)
    expect(markup).toContain('<strong>판정 규칙이 아닌 단순 탐색으로</strong>')
    expect(markup).toContain('<strong>POST_PBL → LK → @PASS</strong>')
    expect(markup).not.toContain('**')
  })

  it('repairs emphasis attached to the preceding word in real model responses', () => {
    const markup = renderToStaticMarkup(<AgentMarkdown>{'핵심** 불량**은 DQ9입니다.\n\n최종**@FAIL** 상태'}</AgentMarkdown>)
    expect(markup).toContain('핵심 <strong>불량은</strong> DQ9입니다.')
    expect(markup).toContain('최종 <strong>@FAIL</strong> 상태')
    expect(markup).not.toContain('**')
  })
})
