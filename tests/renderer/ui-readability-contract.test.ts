import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve('.')
const normalizeNewlines = (source: string) => source.replace(/\r\n?/g, '\n')

describe('UI readability contract', () => {
  it('keeps the desktop floor aligned with Electron and avoids blue edge markers', async () => {
    const [styles, dataViews, workbench, manual] = (await Promise.all([
      readFile(resolve(root, 'src/styles.css'), 'utf8'),
      readFile(resolve(root, 'src/data-views.css'), 'utf8'),
      readFile(resolve(root, 'src/workbench.css'), 'utf8'),
      readFile(resolve(root, 'docs/manual/02-로그-분석-규칙.md'), 'utf8'),
    ])).map(normalizeNewlines)

    expect(styles).toContain('min-width: 1100px;')
    expect(styles).toContain('.nav-item.active')
    expect(styles).toContain('box-shadow: none;')
    expect(styles).toContain('.status-dot')
    expect(styles).toContain('font-size: 12px;')
    expect(styles).not.toContain('box-shadow: inset 2px 0 var(--lime);')
    expect(styles).not.toContain('box-shadow: inset 2px 0 var(--blue);')
    expect(dataViews).toContain('flex-wrap: wrap;')
    expect(workbench).toContain('.file-row.active { color: var(--wb-text) !important; background: #2a2f38; box-shadow: none; }')
    expect(manual).not.toContain('파란색 왼쪽 선')
  })

  it('keeps select surfaces dark', async () => {
    const [styles, dataViews, workbench] = (await Promise.all([
      readFile(resolve(root, 'src/styles.css'), 'utf8'),
      readFile(resolve(root, 'src/data-views.css'), 'utf8'),
      readFile(resolve(root, 'src/workbench.css'), 'utf8'),
    ])).map(normalizeNewlines)

    expect(styles).toContain('option {\n  color: var(--text);\n  background: #171a20;')
    expect(dataViews).toContain('.data-view option')
    expect(workbench).toContain('.log-workbench option')
  })

  it('keeps the Agent mouse entry point visible', async () => {
    const styles = normalizeNewlines(await readFile(resolve(root, 'src/styles.css'), 'utf8'))
    const rule = styles.slice(styles.indexOf('.agent-fab {'), styles.indexOf('}', styles.indexOf('.agent-fab {')))
    expect(rule).toContain('display: inline-flex;')
    expect(rule).not.toContain('display: none;')
  })

  it('keeps the same logo and Korean navigation labels on the log workbench', async () => {
    const styles = normalizeNewlines(await readFile(resolve(root, 'src/styles.css'), 'utf8'))
    expect(styles).not.toContain('.workbench-is-open .nav-item > span')
    expect(styles).not.toContain('.workbench-is-open .brand > div:last-child')
    expect(styles).toContain('.workbench-is-open {\n  --sidebar: 78px;')
  })

  it('uses one full-width evidence row and hides verbose paused-agent copy', async () => {
    const [styles, panel] = (await Promise.all([
      readFile(resolve(root, 'src/styles.css'), 'utf8'),
      readFile(resolve(root, 'src/components/AgentPanel.tsx'), 'utf8'),
    ])).map(normalizeNewlines)
    const evidenceRule = styles.slice(styles.indexOf('.native-agent-tools > div {'), styles.indexOf('}', styles.indexOf('.native-agent-tools > div {')))
    expect(evidenceRule).toContain('display: block;')
    expect(evidenceRule).not.toContain('grid-template-columns')
    expect(panel).not.toContain('nativeSession.failure ??')
    expect(panel).toContain('className="agent-stage retry-only"')
  })

  it('removes duplicate page copy and uses direct grid directions', async () => {
    const [patterns, memory, project] = (await Promise.all([
      readFile(resolve(root, 'src/views/PatternsView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/views/EvaluationMemoryView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/components/ProjectControl.tsx'), 'utf8'),
    ])).map(normalizeNewlines)
    expect(patterns).toContain('<h1>결과 정리</h1>')
    expect(patterns).not.toContain('뚜렷한 집중 없음')
    expect(patterns).toContain('<span>세로</span>')
    expect(patterns).toContain('<span>가로</span>')
    expect(memory).not.toContain('프로젝트 평가 이력')
    expect(project).not.toContain('<summary>프로젝트 고급 설정</summary>')
    expect(project).not.toContain('>재검증</button>')
    expect(normalizeNewlines(await readFile(resolve(root, 'src/styles.css'), 'utf8'))).not.toContain('.project-list-item.active { border-left-color')
  })

  it('keeps setup copy concise and separates SKEW from numeric timing offset', async () => {
    const [settings, memory, tools] = (await Promise.all([
      readFile(resolve(root, 'src/views/SettingsView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/views/EvaluationMemoryView.tsx'), 'utf8'),
      readFile(resolve(root, 'electron/main/lpddr-agent-tools.ts'), 'utf8'),
    ])).map(normalizeNewlines)
    expect(settings).not.toContain('<small>sec</small>')
    expect(settings).not.toContain('응답 예약 1,200 토큰')
    expect(settings).toContain("? '연결됨' : '로컬 분석'")
    expect(memory).toContain("['skew', 'SKEW', 'text']")
    expect(memory).toContain("['timingSkewPs', 'Timing SKEW (ps)', 'number']")
    expect(memory).not.toContain("['sku', 'SKU', 'text']")
    expect(tools).not.toContain("{ SKEW: sku }")
  })

  it('uses the log decision control palette for result organization and history inputs', async () => {
    const [dataViews, memoryStyles] = (await Promise.all([
      readFile(resolve(root, 'src/data-views.css'), 'utf8'),
      readFile(resolve(root, 'src/views/evaluation-memory-view.css'), 'utf8'),
    ])).map(normalizeNewlines)
    expect(dataViews).toContain('border: 1px solid var(--sct-line-strong);')
    expect(dataViews).toContain('background: var(--sct-control);')
    expect(memoryStyles).toContain('border: 1px solid var(--sct-line-strong);')
    expect(memoryStyles).toContain('background: var(--sct-control);')
  })

  it('keeps result stages concise and history in a resizable qualitative workspace', async () => {
    const [results, patterns, memory, memoryStyles, lineageStyles] = (await Promise.all([
      readFile(resolve(root, 'src/views/ResultsView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/views/PatternsView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/views/EvaluationMemoryView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/views/evaluation-memory-view.css'), 'utf8'),
      readFile(resolve(root, 'src/components/evaluation-lineage.css'), 'utf8'),
    ])).map(normalizeNewlines)
    expect(results).toContain('RESULT_STAGE_GROUP_LABEL')
    expect(results).not.toContain('폴더 범위')
    expect(results).toContain('FAIL만')
    expect(results).toContain('검토 필요만')
    expect(patterns).not.toContain('className="stage-summary"')
    expect(patterns).not.toContain('미승인 후보로 계산한 미리보기입니다')
    expect(memory).toContain('로그 기반 경향')
    expect(memory).toContain('나머지 {remainingTrends.length}개')
    expect(memory).not.toContain('evaluation-memory-view__agent-composer')
    expect(memory).toContain('role="separator"')
    expect(memoryStyles).toContain('var(--evaluation-editor-width')
    expect(lineageStyles).not.toContain('box-shadow: inset 2px 0 #75a7ff')
  })
})
