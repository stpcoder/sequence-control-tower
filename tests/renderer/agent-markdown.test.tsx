import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown } from '../../src/components/AgentMarkdown'

describe('AgentMarkdown', () => {
  it('renders headings, emphasis, code and single-column list semantics safely', () => {
    const markup = renderToStaticMarkup(<AgentMarkdown>{'## 판정\n- **DQ9** 집중\n- `VDD=1.295V`'}</AgentMarkdown>)
    expect(markup).toContain('<h3>판정</h3>')
    expect(markup).toContain('<strong>DQ9</strong>')
    expect(markup).toContain('<code>VDD=1.295V</code>')
    expect(markup).toContain('<ul>')
  })
})
