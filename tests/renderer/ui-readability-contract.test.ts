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
      readFile(resolve(root, 'docs/manual/03-분석-규칙.md'), 'utf8'),
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
    const [styles, workbench] = (await Promise.all([
      readFile(resolve(root, 'src/styles.css'), 'utf8'),
      readFile(resolve(root, 'src/views/WorkbenchView.tsx'), 'utf8'),
    ])).map(normalizeNewlines)
    const start = styles.indexOf('\n.agent-fab {')
    const rule = styles.slice(start, styles.indexOf('}', start))
    expect(rule).toContain('display: inline-flex;')
    expect(rule).not.toContain('display: none;')
    expect(styles).not.toContain('.workbench-is-open .agent-fab { display: none; }')
    expect(workbench).not.toContain('<Sparkles size={14} />Agent')
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
    expect(panel).toContain("disabled={busy}>조건별 불량 경향")
    expect(panel).toContain("disabled={busy}>과거 사례와 다음 평가")
    expect(panel).toContain('대화 불러오는 중')
    expect(panel).toContain('folderScopeRequired || nativeSessionsLoading || busy')
    expect(panel).toContain('<Wrench size={12} />확인 과정')
    expect(panel).not.toContain('<Wrench size={12} />근거 {evidenceTools.length}')
  })

  it('keeps review and rule surfaces concise', async () => {
    const [results, workbench] = (await Promise.all([
      readFile(resolve(root, 'src/views/ResultsView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/views/WorkbenchView.tsx'), 'utf8'),
    ])).map(normalizeNewlines)
    expect(results).not.toContain('<span title={row.fileName}>{row.fileName}</span>')
    expect(workbench).not.toContain('검색 {searchHistory[activeFile.id]?.length ?? 0} · 근거')
    expect(workbench).not.toContain('그러면 <b>')
    expect(workbench).toContain('<strong>검색 절차 저장</strong>')
    expect(workbench).toContain('A rule is the deterministic automation')
    expect(workbench).toContain('<strong>판정 규칙</strong><span>판정에 사용할 검색을 선택하세요</span>')
    expect(workbench).toContain('줄 바꿈 <kbd>Alt Z</kbd>')
    expect(workbench).toContain('줄 이동 <kbd>Ctrl G</kbd>')
    expect(workbench).toContain('!workflowReview && !recipeVisible')
    expect(workbench).toContain('{!workflowReview && recipeVisible && draft ? (')
  })

  it('removes duplicate page copy and uses direct grid directions', async () => {
    const [patterns, memory, project] = (await Promise.all([
      readFile(resolve(root, 'src/views/PatternsView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/views/EvaluationMemoryView.tsx'), 'utf8'),
      readFile(resolve(root, 'src/components/ProjectControl.tsx'), 'utf8'),
    ])).map(normalizeNewlines)
    expect(patterns).toContain('<h1>결과 정리</h1>')
    expect(patterns).not.toContain('뚜렷한 집중 없음')
    expect(patterns).toContain('group="rows" label="왼쪽 축"')
    expect(patterns).toContain('group="columns" label="상단 축"')
    expect(patterns).toContain('>축 바꾸기</button>')
    expect(patterns).toContain('>평가 결과 CSV</b>')
    expect(patterns).toContain('>Fail 주소 CSV</b>')
    expect(patterns).toContain("{ value: 'pass_fail', label: '판정 결과' }")
    expect(patterns).not.toContain("{ value: 'count', label: '파일 수' }")
    expect(patterns).not.toContain('trend-summary')
    expect(patterns).not.toContain('pattern-metric-note')
    expect(patterns).toContain('현재 표 분석')
    expect(patterns).not.toContain('Agent에게 묻기')
    expect(memory).not.toContain('프로젝트 평가 이력')
    expect(project).not.toContain('<summary>프로젝트 고급 설정</summary>')
    expect(project).toContain('<summary>프로젝트 정보 수정</summary>')
    expect(project).toContain('결과에 표시할 항목')
    expect(project).toContain('분석표와 CSV에 우선 표시됩니다.')
    expect(project).toContain('실장기 명')
    expect(project).not.toContain('폴더 상태 확인')
    expect(project).not.toContain('템플릿 버전')
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

  it('keeps result stages concise and history in a folder-scoped qualitative workspace', async () => {
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
    expect(memory).toContain('groupEvaluationFolders')
    expect(memory).toContain('evaluationFolderFlow')
    expect(memory).toContain('불량 이슈별 평가 이력')
    expect(memory).not.toContain("'최초 불량'")
    expect(memory).toContain('분류 대기')
    expect(memory).toContain('평가 상세 닫기')
    expect(memory).toContain('조건별 FAIL 경향')
    expect(memory).toContain('이 평가의 로그')
    expect(memory).toContain('평가 정리')
    expect(memory).toContain('현재 평가 분석')
    expect(memory).toContain('직접 수정')
    expect(memory).not.toContain('>AI 맥락</button>')
    expect(memory).toContain('나머지 {trends.length - 6}개')
    expect(memory).toContain('AI 작성 · 엔지니어 확인')
    expect(memory).not.toContain('<summary>직접 추가</summary>')
    expect(memory).not.toContain('evaluation-memory-view__agent-composer')
    expect(memory).not.toContain('role="separator"')
    expect(memory).not.toContain('evaluation-memory-view__folders')
    expect(memoryStyles).toContain('grid-template-columns: minmax(420px,1fr) 360px')
    expect(memoryStyles).toContain('grid-template-columns: 240px max-content;')
    expect(memoryStyles).toContain('flex: 0 0 212px;')
    expect(memoryStyles).toContain('font-size: 14px;')
    expect(memoryStyles).toContain('background: var(--em-editor);')
    expect(memoryStyles).not.toContain('var(--evaluation-editor-width')
    expect(lineageStyles).not.toContain('box-shadow: inset 2px 0 #75a7ff')
  })
})
