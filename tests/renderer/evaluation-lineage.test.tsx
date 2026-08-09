import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EvaluationLineage } from '../../src/components/EvaluationLineage'
import type { EvaluationMemory } from '../../src/domain/evaluation-memory'

const memory: EvaluationMemory = {
  project: { id: 'p-1', name: 'Product A' },
  hypotheses: [{ id: 'h-1', projectId: 'p-1', title: 'CLK 10660 boundary', origin: 'ai-proposed' }],
  nodes: [
    { id: 'EV-01', projectId: 'p-1', name: 'Baseline', branchId: 'main', status: 'pass', dimensions: { temperatureC: 25, vdd: .99, pattern: '1190', dq: 0 } },
    { id: 'EV-02', projectId: 'p-1', parentId: 'EV-01', hypothesisId: 'h-1', name: 'CLK boundary', branchId: 'issue-10660', status: 'fail', dimensions: { temperatureC: 105, vdd: .91, pattern: '6060', dq: 'ECC mismatch' } },
  ],
  evidence: [{ id: 'e-1', projectId: 'p-1', evaluationNodeId: 'EV-02', status: 'fail' }],
}

describe('EvaluationLineage', () => {
  it('renders confirmed/proposed relationships and only essential selected evaluation facts', () => {
    const markup = renderToStaticMarkup(<EvaluationLineage memory={memory} selectedNodeId="EV-02" />)

    expect(markup).toContain('evaluation-lineage__edge--proposed')
    expect(markup).toContain('AI 제안')
    expect(markup).toContain('100%')
    expect(markup).toContain('실패율')
    expect(markup).not.toContain('불량률')
    expect(markup).toContain('ECC mismatch')
    expect(markup).not.toContain('브랜치')
    expect(markup).not.toContain('평가 흐름')
  })
})
