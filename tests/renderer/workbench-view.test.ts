import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ArtifactRecord, ArtifactSearchResult, ArtifactSourceLocation } from '../../electron/shared/contracts'
import type { PrecomputedDocumentEvidence, RecipeRule } from '../../src/domain/workbench'
import {
  addCurrentReplacement,
  addReplaceAll,
  applyLogDraftLine,
  createLogDraft,
  resetLogDraft,
} from '../../src/state/logDraft'
import {
  artifactFiles,
  advanceBatchGeneration,
  advanceFileRequestGeneration,
  advanceSearchRequestGeneration,
  buildPatternReviewComment,
  canApplyAnalysisUpdate,
  canApplyBatchResult,
  canApplyImportContinuation,
  canApplyLineWindowResult,
  canApplyRevealRequest,
  canApplySearchResult,
  canStartImport,
  canRevealActiveHit,
  chooseNextTabId,
  clampSearchHitIndex,
  clampWorkbenchPaneWidth,
  deferredSearchHitIndex,
  DEFAULT_WORKBENCH_PANE_WIDTHS,
  clauseSpecKey,
  filterUserRecipeRevisions,
  recipeEvidenceSpecs,
  resolveRecipeEvidenceCounts,
  dedupeWorkbenchFiles,
  groupWorkbenchFiles,
  lineWindowEdgeRequestKey,
  mergeLineWindow,
  mergeWorkbenchFiles,
  nextSearchHitIndex,
  omitFileCacheEntry,
  invalidateImportBatchGeneration,
  resolvePrecomputedBatch,
  resolveCurrentReplacementText,
  resolveSearchScopeFiles,
  occurrenceConditionForChoice,
  engineerWorkflowCheckKey,
  moveEngineerWorkflowCheck,
  toggleEngineerWorkflowCheck,
  reorderRuleClausesByObservationIds,
  successfulSearchCounts,
  shouldCancelAnalysisJob,
  patternReviewFailureMessage,
  type WorkbenchFile,
} from '../../src/views/WorkbenchView'

const normalizeNewlines = (source: string) => source.replace(/\r\n?/g, '\n')
const workbenchSource = normalizeNewlines(readFileSync(new URL('../../src/views/WorkbenchView.tsx', import.meta.url), 'utf8'))
const workbenchCss = readFileSync(new URL('../../src/workbench.css', import.meta.url), 'utf8')
const legacyStyles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function cssRule(source: string, selector: string): string {
  return sourceBetween(source, `${selector} {`, '\n}')
}

function artifact(id: string, lastSeenAt: string, rootId?: string): ArtifactRecord {
  return {
    id,
    sha256: id,
    size: 42,
    extension: '.log',
    originalNames: ['sample.log'],
    importedAt: lastSeenAt,
    lastSeenAt,
    importCount: 1,
    sources: [{
      ...(rootId ? { rootId } : {}),
      folderLabel: 'customer-a',
      relativePath: 'lot-01/sample.log',
    } as ArtifactSourceLocation],
  }
}

function rule(id: string, label: RecipeRule['label'], status: RecipeRule['status']): RecipeRule {
  return {
    id,
    label,
    status,
    scope: { kind: 'analysis' },
    clauses: [{
      id: `${id}-done`,
      presence: 'present',
      matcher: { kind: 'literal', pattern: 'DONE', caseSensitive: true, target: 'content' },
      sourceObservationId: `${id}-observation`,
    }],
    priority: 0,
    confidence: 0.9,
    repetition: 1,
    createdFromSourceIds: ['source'],
  }
}

function evidence(sourceId: string, rules: RecipeRule[], count = 1): PrecomputedDocumentEvidence {
  return {
    sourceId,
    rules: rules.map((item) => ({
      ruleId: item.id,
      clauses: item.clauses.map((clause) => ({ clauseId: clause.id, occurrenceCount: count })),
    })),
  }
}

describe('Log Workbench UI data hardening', () => {
  it('lets an engineer select and reorder the exact Ctrl-F procedure to remember', () => {
    const checks = [
      { query: 'POST_PBL', mode: 'literal' as const, caseSensitive: false, expected: 'present' as const, matchCount: 1, stage: 'post-pbl' as const, order: 1 },
      { query: 'LK:', mode: 'literal' as const, caseSensitive: false, expected: 'present' as const, matchCount: 1, stage: 'lk' as const, order: 2 },
      { query: '@PASS', mode: 'literal' as const, caseSensitive: false, expected: 'present' as const, matchCount: 1, stage: 'memory-test' as const, order: 3 },
    ]
    const withoutLk = toggleEngineerWorkflowCheck(checks, checks[1])
    expect(withoutLk.map((item) => item.query)).toEqual(['POST_PBL', '@PASS'])
    expect(toggleEngineerWorkflowCheck(withoutLk, checks[1]).map((item) => item.query)).toEqual(['POST_PBL', '@PASS', 'LK:'])
    expect(moveEngineerWorkflowCheck(checks, engineerWorkflowCheckKey(checks[2]), -1).map((item) => item.query)).toEqual(['POST_PBL', '@PASS', 'LK:'])
  })
  it('projects only user recipes and turns artifact evidence into clause counts', () => {
    const candidate = rule('candidate', 'PASS', 'candidate')
    const internal = { id: 'internal-revision', recipeId: 'active-batch-ruleset', revision: 1, name: 'batch', rules: [candidate], createdAt: 'now' }
    const user = { ...internal, id: 'user-revision', recipeId: 'user-recipe' }
    expect(filterUserRecipeRevisions([internal, user])).toEqual([user])

    const specs = recipeEvidenceSpecs(candidate)
    expect(specs[0]).toMatchObject({ id: candidate.clauses[0].id, query: 'DONE', mode: 'literal', target: 'content' })
    expect(resolveRecipeEvidenceCounts(candidate, {
      sourceId: 'file-1', artifactId: 'a'.repeat(64), fileName: 'sample.log',
      evidence: [{ specId: specs[0].id, occurrenceCount: 3, firstOccurrence: { target: 'content', columnStart: 1, columnEnd: 5, excerpt: 'DONE', excerptTruncated: false } }],
    })).toEqual({ counts: { [candidate.clauses[0].id]: 3 }, unresolvedClauseIds: [] })
  })

  it('fails closed for missing or failed artifact clause evidence', () => {
    const candidate = rule('candidate', 'PASS', 'candidate')
    const failed = resolveRecipeEvidenceCounts(candidate, {
      sourceId: 'file-1', artifactId: 'a'.repeat(64), fileName: 'sample.log', error: 'read failed', evidence: [],
    })
    expect(failed.unresolvedClauseIds).toEqual([candidate.clauses[0].id])
    expect(failed.counts).toEqual({})
  })

  it('keeps automatic observations separate from pinned occurrence rules', () => {
    const observation = {
      id: 'obs-a', sourceId: 'file-a', query: 'PASS', matcherKind: 'literal' as const,
      target: 'content' as const, caseSensitive: false, matched: true, matchCount: 4,
      role: 'search_history' as const, excerpts: [],
    }
    expect(occurrenceConditionForChoice({ kind: 'zero' }, observation)).toEqual({ kind: 'exact', count: 0 })
    expect(occurrenceConditionForChoice({ kind: 'atLeast' }, observation)).toEqual({ kind: 'atLeast', count: 1 })
    expect(occurrenceConditionForChoice({ kind: 'exact', count: 3 }, observation)).toEqual({ kind: 'exact', count: 3 })
  })

  it('creates explicit clause order from the user-selected observation order', () => {
    const base = rule('ordered', 'PASS', 'candidate')
    const clauses = [
      { ...base.clauses[0], id: 'clause-a', sourceObservationId: 'obs-a' },
      { ...base.clauses[0], id: 'clause-b', sourceObservationId: 'obs-b' },
    ]
    const ordered = reorderRuleClausesByObservationIds({ ...base, clauses }, ['obs-b', 'obs-a'])
    expect(ordered.clauses.map((clause) => clause.sourceObservationId)).toEqual(['obs-b', 'obs-a'])
    expect(ordered.clauses[0].order).toBeUndefined()
    expect(ordered.clauses[1].order).toEqual({ afterClauseId: 'clause-b' })
  })

  it('renders the pin, accessible order modal, and opt-in metadata apply affordances', () => {
    expect(workbenchSource).toContain('판정 조건 추가')
    expect(workbenchSource).toContain('role="dialog" aria-modal="true"')
    expect(workbenchSource).toContain('onApplyMetadataSuggestion')
    expect(workbenchSource).toContain('field}</b> {suggestion.value}')
    expect(workbenchSource).toContain('신뢰도')
    expect(workbenchSource).toContain('suggestedTags.slice(0, 6).map')
  })

  it('keeps source text immutable while applying current and scoped replace-all lazily', () => {
    const source = 'lane=1 timeout\nlane=1 timeout\nkeep'
    const draft = createLogDraft([{ id: 'file-a', text: source }])
    const current = addCurrentReplacement(draft, {
      fileId: 'file-a',
      line: 1,
      expected: { start: 7, end: 14, text: 'timeout' },
      replacement: 'retry',
    })
    expect(current.validation.ok).toBe(true)
    expect(source).toBe('lane=1 timeout\nlane=1 timeout\nkeep')
    expect(applyLogDraftLine(current.draft, 'file-a', 1, 'lane=1 timeout').text).toBe('lane=1 retry')
    expect(applyLogDraftLine(current.draft, 'file-a', 2, 'lane=1 timeout').text).toBe('lane=1 timeout')

    const all = addReplaceAll(current.draft, {
      fileIds: ['file-a'],
      pattern: 'lane=1',
      replacement: 'lane=2',
      mode: 'literal',
    })
    expect(all.validation.ok).toBe(true)
    expect(applyLogDraftLine(all.draft, 'file-a', 1, 'lane=1 timeout').text).toBe('lane=2 retry')
    expect(applyLogDraftLine(all.draft, 'file-a', 2, 'lane=1 timeout').text).toBe('lane=2 timeout')
    expect(resetLogDraft(all.draft).operations).toEqual([])
  })

  it('reports draft validation and stale current matches without mutating an accepted draft', () => {
    const draft = createLogDraft()
    expect(addCurrentReplacement(draft, {
      fileId: 'file-a',
      line: 1,
      expected: { start: 0, end: 3, text: 'old' },
      replacement: 'new\nline',
    }).validation).toMatchObject({ ok: false, code: 'NEWLINE_REPLACEMENT' })
    expect(addReplaceAll(draft, {
      fileIds: ['file-a'],
      pattern: '(?=',
      replacement: 'x',
      mode: 'regex',
    }).validation).toMatchObject({ ok: false, code: 'INVALID_REGEX' })
    expect(addReplaceAll(draft, {
      fileIds: ['file-a'],
      pattern: '^',
      replacement: 'x',
      mode: 'regex',
    }).validation).toMatchObject({ ok: false, code: 'ZERO_WIDTH_PATTERN' })

    const accepted = addCurrentReplacement(draft, {
      fileId: 'file-a',
      line: 1,
      expected: { start: 0, end: 3, text: 'old' },
      replacement: 'new',
    })
    expect(accepted.validation.ok).toBe(true)
    const applied = applyLogDraftLine(accepted.draft, 'file-a', 1, 'changed')
    expect(applied.issues[0]?.validation.code).toBe('STALE_CURRENT_MATCH')
    expect(accepted.draft.operations).toHaveLength(1)
  })

  it('rejects current replacement for a switched tab or a backend hit past the displayed line', () => {
    const switchedTab = resolveCurrentReplacementText(
      'file-a',
      { fileId: 'file-b', line: 1, start: 0, end: 3 },
      { lineNumber: 1, text: 'old', truncated: false },
    )
    expect(switchedTab).toEqual({ ok: false, message: '현재 탭과 검색 결과가 다릅니다.' })

    const backendOccurrenceBeyondWindow = resolveCurrentReplacementText(
      'artifact-row',
      { fileId: 'artifact-row', line: 7, start: 20_004, end: 20_010 },
      { lineNumber: 7, text: `${'x'.repeat(20_000)}…`, truncated: true },
    )
    expect(backendOccurrenceBeyondWindow).toEqual({ ok: false, message: '원문 줄이 잘려 현재 바꿀 수 없습니다.' })

    expect(resolveCurrentReplacementText(
      'file-a',
      { fileId: 'file-a', line: 1, start: 0, end: 3 },
      { lineNumber: 1, text: 'old', truncated: false },
    )).toEqual({ ok: true, text: 'old' })
  })

  it('wires replace mode to source hits, scope resolution, lifecycle reset, and shortcuts', () => {
    expect(workbenchSource).toContain("event.key.toLowerCase() === 'h'")
    expect(workbenchSource).toContain("openSearch(searchOpen ? searchScope : 'file', true)")
    expect(workbenchSource).toContain('expected: { start: activeHit.start, end: activeHit.end, text: expected.text }')
    expect(workbenchSource).toContain('if (activeFile.id !== activeHit.fileId)')
    expect(workbenchSource).toContain('resolveCurrentReplacementText(activeFile.id, activeHit, sourceLine)')
    expect(workbenchSource).toContain('applyLogDraftLine(result.draft, activeHit.fileId, activeHit.line, sourceLine.text)')
    expect(workbenchSource).toContain('moveToHit(1)')
    expect(workbenchSource).toContain('resolveSearchScopeFiles(searchScope, files, activeFileId, openFileIds)')
    expect(workbenchSource).toContain("mode: options.regex ? 'regex' : 'literal'")
    expect(workbenchSource).toContain('setLogDraft(resetLogDraft(logDraft))')
    expect(workbenchSource).toContain('Ctrl/Cmd+Enter')
    expect(workbenchSource).toContain('Ctrl/Cmd+Alt+Enter')
    expect(workbenchSource).toContain('수정 초안 · 결과/근거는 원본 기준')
    expect(workbenchSource).toContain('disabled={draftActiveForFile}')
    expect(workbenchSource).toContain('draftActiveForFile ? [] : activeHitsByLine.get(lineNumber) ?? []')
  })

  it('keeps line-window freshness independent per file while rejecting stale same-file results', () => {
    const firstA = advanceFileRequestGeneration(new Map(), 'file-a')
    const firstB = advanceFileRequestGeneration(firstA.generations, 'file-b')
    const secondA = advanceFileRequestGeneration(firstB.generations, 'file-a')

    expect(canApplyLineWindowResult(true, secondA.generations, 'file-a', firstA.generation)).toBe(false)
    expect(canApplyLineWindowResult(true, secondA.generations, 'file-a', secondA.generation)).toBe(true)
    expect(canApplyLineWindowResult(true, secondA.generations, 'file-b', firstB.generation)).toBe(true)
  })

  it('rejects line-window and reveal work after unmount', () => {
    const generations = new Map([['file-a', 1]])
    expect(canApplyLineWindowResult(false, generations, 'file-a', 1)).toBe(false)
    expect(canApplyRevealRequest(false, 2, 2)).toBe(false)
  })

  it('rejects stale and unmounted renderer search completions', () => {
    const first = advanceSearchRequestGeneration(0)
    const second = advanceSearchRequestGeneration(first)

    expect(canApplySearchResult(true, second, first)).toBe(false)
    expect(canApplySearchResult(true, second, second)).toBe(true)
    expect(canApplySearchResult(false, second, second)).toBe(false)
  })

  it('builds a bounded non-empty pattern-review comment from the user and search context', () => {
    const comment = buildPatternReviewComment(
      '  training timeout 반복인지 확인해 주세요. '.repeat(20),
      'lane1 timeout',
      [{
        id: 'obs-1',
        sourceId: 'file-a',
        query: 'TRAINING_FAIL',
        matcherKind: 'literal',
        target: 'content',
        caseSensitive: false,
        matched: true,
        matchCount: 3,
        role: 'search_history',
        excerpts: [],
      }],
    )

    expect(comment.length).toBeLessThanOrEqual(480)
    expect(comment).toContain('사용자 메모:')
    expect(comment).toContain('현재 검색어: lane1 timeout')
    expect(comment).toContain('검색 관찰:')
    expect(buildPatternReviewComment('', '', [])).not.toBe('')
  })

  it('rejects stale, different-job, and unmounted AI review updates', () => {
    expect(canApplyAnalysisUpdate(true, 2, 1, 'job-1', 'job-1')).toBe(false)
    expect(canApplyAnalysisUpdate(true, 1, 1, 'job-1', 'job-2')).toBe(false)
    expect(canApplyAnalysisUpdate(false, 1, 1, 'job-1', 'job-1')).toBe(false)
    expect(canApplyAnalysisUpdate(true, 1, 1, 'job-1', 'job-1')).toBe(true)
  })

  it('only cancels queued or running analysis jobs and never terminal jobs', () => {
    expect(shouldCancelAnalysisJob('queued', 'job-1')).toBe(true)
    expect(shouldCancelAnalysisJob('running', 'job-1')).toBe(true)
    expect(shouldCancelAnalysisJob('completed', 'job-1')).toBe(false)
    expect(shouldCancelAnalysisJob('failed', 'job-1')).toBe(false)
    expect(shouldCancelAnalysisJob('cancelled', 'job-1')).toBe(false)
    expect(shouldCancelAnalysisJob('running', '')).toBe(false)
  })

  it('wires the review UI to the existing analysis lifecycle and keeps it review-only', () => {
    expect(workbenchSource).toContain('api.analysis.start({')
    expect(workbenchSource).toContain('api.analysis.get(started.id)')
    expect(workbenchSource).toContain('api.analysis.cancel(jobId)')
    expect(workbenchSource).toContain('api.analysis.onJobUpdate')
    expect(workbenchSource).toContain("sideMode === 'search' ? '검색 결과'")
    expect(workbenchSource).toContain('className={`search-result ${index === currentHit ? \'active\' : \'\'}`}')
    expect(workbenchSource).toContain('className="search-result-file"')
    expect(workbenchSource).toContain('className="search-result-line"')
    expect(workbenchSource).toContain('<b>Ln {hit.line}</b>')
    expect(workbenchSource).toContain('placeholder="검색어 입력"')
    expect(workbenchSource).toContain('검색어를 입력하세요.')
    expect(workbenchSource).toContain('검색 중…')
    expect(workbenchSource).toContain('find-match-count')
    expect(workbenchSource).toContain('aria-live="polite"')
    expect(workbenchSource).toContain('placeholder="검토 메모 (선택)"')
    expect(workbenchSource).toContain('<SearchCode size={13} /> 검토 실행')
    expect(workbenchSource).not.toContain("patternReviewBusy ? '검토 중' : '검토 실행'")
    expect(workbenchSource).toContain('경고 {patternReview.result.warnings.length}건')
    expect(workbenchSource).not.toContain('검토용 제안 · 판정은 엔지니어가 확정')
    expect(workbenchSource).not.toContain('pattern-review-source')
    expect(workbenchSource).not.toContain('pattern-review-disclaimer')
    expect(workbenchCss).not.toContain('.side-search-summary')
    expect(workbenchCss).toContain('--wb-type-body: 14px;')
    expect(workbenchCss).toContain('--wb-type-secondary: 13px;')
    expect(workbenchCss).toContain('--wb-type-code: 13px;')
    expect(workbenchCss).toContain('--wb-type-body: 14px; --wb-type-secondary: 13px')
    expect(workbenchCss).toContain('font-size: var(--wb-type-body)')
    expect(workbenchCss).toContain('.search-result-line {')
    expect(workbenchCss).toContain('font-size: 13px')
    expect(workbenchSource).toContain('applySuggestedSearch(suggestion)')
  })

  it('resolves current, evaluation-folder, open-tab, and all-log scopes without crossing folders', () => {
    const files: WorkbenchFile[] = [
      { id: 'current', name: 'current.log', rootId: 'evaluation-a' },
      { id: 'same-folder', name: 'same.log', rootId: 'evaluation-a' },
      { id: 'other-folder', name: 'other.log', rootId: 'evaluation-b' },
    ]

    expect(resolveSearchScopeFiles('file', files, 'current', ['current', 'same-folder'])).toEqual([files[0]])
    expect(resolveSearchScopeFiles('folder', files, 'current', ['current'])).toEqual([files[0], files[1]])
    expect(resolveSearchScopeFiles('folder', files, 'current', ['current'])).not.toContain(files[2])
    expect(resolveSearchScopeFiles('open', files, 'current', ['same-folder', 'current'])).toEqual([files[1], files[0]])
    expect(resolveSearchScopeFiles('open', files, 'current', ['current', 'same-folder'])).not.toContain(files[2])
    expect(resolveSearchScopeFiles('workspace', files, 'current', ['current', 'same-folder'])).toEqual(files)
  })

  it('rejects obsolete batch generations after overlap, navigation, or unmount', () => {
    const first = advanceBatchGeneration(0)
    const second = advanceBatchGeneration(first)

    expect(canApplyBatchResult(true, second, first)).toBe(false)
    expect(canApplyBatchResult(true, second, second)).toBe(true)
    expect(canApplyBatchResult(false, second, second)).toBe(false)
  })

  it('invalidates batch work as soon as a folder import starts', () => {
    const first = advanceBatchGeneration(4)
    expect(invalidateImportBatchGeneration(first)).toBe(first + 1)
  })

  it('chooses the next tab deterministically when closing the active tab', () => {
    expect(chooseNextTabId(['a', 'b', 'c'], 'b', 'b')).toBe('c')
    expect(chooseNextTabId(['a', 'b', 'c'], 'c', 'c')).toBe('b')
    expect(chooseNextTabId(['a', 'b', 'c'], 'a', 'b')).toBe('b')
    expect(chooseNextTabId(['a'], 'a', 'a')).toBe('')
  })

  it('claims an import slot immediately and rejects continuations after unmount', () => {
    expect(canStartImport(false)).toBe(true)
    expect(canStartImport(true)).toBe(false)
    expect(canApplyImportContinuation(true)).toBe(true)
    expect(canApplyImportContinuation(false)).toBe(false)
  })

  it('does not allow an older active-hit reveal after the active hit changes', () => {
    expect(canApplyRevealRequest(true, 2, 1, 'file-a:10', 'file-b:20')).toBe(false)
    expect(canApplyRevealRequest(true, 2, 2, 'file-b:20', 'file-b:20')).toBe(true)
  })

  it('does not let a stale workspace hit reselect a switched or closed tab', () => {
    expect(canRevealActiveHit(true, 'file-b', 'file-a', 'hit-a', 'hit-a')).toBe(false)
    expect(canRevealActiveHit(true, 'file-a', 'file-a', 'hit-a', '')).toBe(false)
    expect(canRevealActiveHit(true, undefined, 'file-a', 'hit-a', 'hit-a')).toBe(false)
    expect(canRevealActiveHit(true, 'file-a', 'file-a', 'hit-a', 'hit-a')).toBe(true)
    expect(canRevealActiveHit(false, 'file-a', 'file-a', 'hit-a', 'hit-a')).toBe(false)
  })

  it('preserves exact log whitespace and search-mark helper behavior', () => {
    const searchPattern = sourceBetween(workbenchSource, 'function createSearchPattern(', 'function collectHits(')
    expect(searchPattern).toContain('if (!query) return null')
    expect(searchPattern).toContain('const source = options.regex ? query : escapeRegExp(query)')
    expect(searchPattern).toContain('if (options.regex && isUnsafeRegex(source)) return null')
    expect(searchPattern).toContain('const bounded = options.wholeWord ? wholeTokenPattern(source) : source')
    expect(searchPattern).toContain("`${global ? 'g' : ''}${options.caseSensitive ? '' : 'i'}u`")
    expect(workbenchSource).toContain('wholeTokenPattern(source)')
    expect(workbenchSource).toContain('isUnsafeRegex(source)')
    expect(workbenchSource).toContain('disabled={!query || !searchFiles.length || invalidPattern || searching || Boolean(searchError)}')
    expect(workbenchSource).toContain("setSideMode('files')")
    expect(workbenchSource).toContain("setSearchOpen(false); setReplaceMode(false); setSideMode('files')")

    const highlightedLine = sourceBetween(workbenchSource, 'function renderHighlightedLine(', 'function searchHitKey(')
    expect(highlightedLine).toContain("if (!hits.length) return line || ' '")
    expect(highlightedLine).toContain('nodes.push(line.slice(cursor, hit.start))')
    expect(highlightedLine).toContain("<mark className={active ? 'is-current' : ''}")
    expect(highlightedLine).toContain('{line.slice(hit.start, hit.end)}')
    expect(highlightedLine).toContain('cursor = hit.end')
    expect(workbenchSource).toContain("(activeFile.text ?? '').split(/\\r?\\n/).map((text, index) => ({ lineNumber: index + 1, text, truncated: false }))")
  })

  it('keeps artifact windows bounded and reveal scrolling tied to rendered line data', () => {
    const lineWindow = sourceBetween(workbenchSource, 'const loadLineWindow = useCallback(', 'const scheduleAnimationFrame = useCallback(')
    expect(lineWindow).toContain('Math.max(1, targetLine - 80)')
    expect(lineWindow).toContain('lineCount: 240')
    expect(lineWindow).toContain('while (lineWindowTasks.current.has(file.id))')
    expect(lineWindow).toContain("cached?.lines.some((line) => line.lineNumber === targetLine)")

    expect(workbenchSource).toContain('onScroll={handleEditorScroll}')
    expect(workbenchSource).toContain("lineWindowEdgeRequestKey(file.id, 'before', boundary)")
    expect(workbenchSource).toContain("some((key) => key.startsWith(`${file.id}:`))")
    expect(workbenchSource).not.toContain('이전 구간')
    expect(workbenchSource).not.toContain('다음 구간')
    expect(workbenchSource).toContain('querySelector(`[data-line="${lineNumber}"]`)?.scrollIntoView({ block: \'center\' })')
  })

  it('merges ordered unique edge windows and trims the opposite edge at 1000 lines', () => {
    const current = {
      startLine: 901,
      lines: Array.from({ length: 100 }, (_, index) => ({ lineNumber: 901 + index, text: `${901 + index}`, truncated: false })),
      hasMoreBefore: true,
      hasMoreAfter: true,
    }
    const incoming = {
      startLine: 661,
      lines: Array.from({ length: 300 }, (_, index) => ({ lineNumber: 661 + index, text: `${661 + index}`, truncated: false })),
      hasMoreBefore: true,
      hasMoreAfter: true,
    }
    const prepended = mergeLineWindow(current, incoming, 'before', 1000)
    expect(prepended.lines.map((line) => line.lineNumber)).toEqual(Array.from({ length: 340 }, (_, index) => 661 + index))
    expect(new Set(prepended.lines.map((line) => line.lineNumber)).size).toBe(prepended.lines.length)

    const fullWindow = {
      startLine: 1,
      lines: Array.from({ length: 1000 }, (_, index) => ({ lineNumber: index + 1, text: '', truncated: false })),
      hasMoreBefore: false,
      hasMoreAfter: true,
    }
    const appended = {
      startLine: 1001,
      lines: Array.from({ length: 240 }, (_, index) => ({ lineNumber: 1001 + index, text: '', truncated: false })),
      hasMoreBefore: true,
      hasMoreAfter: false,
    }
    const boundedAfter = mergeLineWindow(fullWindow, appended, 'after', 1000)
    expect(boundedAfter.lines).toHaveLength(1000)
    expect(boundedAfter.lines[0].lineNumber).toBe(241)
    expect(boundedAfter.lines.at(-1)?.lineNumber).toBe(1240)
    expect(boundedAfter.hasMoreBefore).toBe(true)
    expect(boundedAfter.hasMoreAfter).toBe(false)

    const boundedBefore = mergeLineWindow(boundedAfter, fullWindow, 'before', 1000)
    expect(boundedBefore.lines[0].lineNumber).toBe(1)
    expect(boundedBefore.lines.at(-1)?.lineNumber).toBe(1000)
    expect(boundedBefore.hasMoreBefore).toBe(false)
    expect(boundedBefore.hasMoreAfter).toBe(true)
    expect(lineWindowEdgeRequestKey('file-a', 'after', 1000)).toBe('file-a:after:1000')
  })

  it('clamps the selected search hit when opened-tab results shrink', () => {
    expect(clampSearchHitIndex(8, 3)).toBe(2)
    expect(clampSearchHitIndex(-2, 3)).toBe(0)
    expect(clampSearchHitIndex(2, 0)).toBe(0)
  })

  it('starts search navigation at the first hit, then cycles in either direction', () => {
    expect(nextSearchHitIndex(0, 3, 1, false)).toBe(0)
    expect(nextSearchHitIndex(0, 3, -1, false)).toBe(2)
    expect(nextSearchHitIndex(0, 3, 1, true)).toBe(1)
    expect(nextSearchHitIndex(0, 3, -1, true)).toBe(2)
    expect(deferredSearchHitIndex(1, 3)).toBe(0)
    expect(deferredSearchHitIndex(-1, 3)).toBe(2)
  })

  it('resets the undisclosed-first-hit contract before input and async result transitions', () => {
    expect(workbenchSource).toContain('const resetSearchNavigation = useCallback(() => {')
    expect(workbenchSource).toContain('resetSearchNavigation()\n    scheduleAnimationFrame(() => searchInputRef.current?.select())')
    expect(workbenchSource).toContain("onChange={(event) => { resetSearchNavigation(); setQuery(event.target.value) }}")
    expect(workbenchSource).toContain("onClick={() => { resetSearchNavigation(); setOptions((current) => ({ ...current, [option]: !current[option] })) }}")
    expect(workbenchSource).toContain('// Reset synchronously with result invalidation so an Enter pressed before')
    expect(workbenchSource).toContain('resetSearchNavigation()\n    setBackendHits([])')
    expect(workbenchSource).toContain('if (event.key === \'Enter\') {\n      event.preventDefault()\n      moveToHit(event.shiftKey ? -1 : 1)')
  })

  it('bounds persisted pane widths and keeps fallback messages short', () => {
    expect(clampWorkbenchPaneWidth('sidebar', 10)).toBe(180)
    expect(clampWorkbenchPaneWidth('inspector', 9999)).toBe(440)
    expect(clampWorkbenchPaneWidth('sidebar', 9999, 300)).toBe(276)
    expect(DEFAULT_WORKBENCH_PANE_WIDTHS).toEqual({ sidebar: 260, inspector: 310 })
    expect(patternReviewFailureMessage().length).toBeLessThan(120)
  })

  it('keeps the continuous editor structure and avoids legacy per-line sizing', () => {
    const workbenchRootRule = cssRule(workbenchCss, '.log-workbench')
    const legacyLineRule = cssRule(legacyStyles, '.log-line')
    const editorRule = cssRule(workbenchCss, '.log-editor')
    const lineRule = cssRule(workbenchCss, '.log-workbench .log-line')
    const codeRule = cssRule(workbenchCss, '.log-workbench .log-line code')
    const lineNumberRule = cssRule(workbenchCss, '.log-workbench .line-number')

    expect(workbenchRootRule).toContain('--wb-log-type: 13.25px;')
    expect(workbenchRootRule).toContain('--wb-log-line-height: 22px;')
    expect(workbenchRootRule).toContain('--wb-log-row-height: 28px;')
    expect(workbenchRootRule).toContain('--wb-log-marker-gutter: 18px;')
    expect(workbenchRootRule).toContain('--wb-log-number-gutter: 36px;')
    expect(legacyLineRule).toMatch(/border-bottom:\s*(?!0(?:px)?\b)[^;]+;/)
    expect(workbenchCss).not.toMatch(/--wb-log-(?:row-height|line-height):\s*40px/)
    expect(lineRule).not.toMatch(/(?:height|min-height|line-height):\s*40px/)
    expect(lineRule).toContain('border-bottom: 0')
    expect(lineRule).toContain('border-radius: 0')
    expect(lineRule).toContain('width: max-content')
    expect(lineRule).toContain('min-width: 100%')
    expect(editorRule).toContain('overflow: auto')
    expect(editorRule).toContain('padding: 0 0 84px')
    expect(codeRule).toContain('white-space: pre')
    expect(lineNumberRule).toContain('user-select: none')
    expect(workbenchSource).toContain('data-line={lineNumber}')
    expect(workbenchSource).toContain('<code>{renderHighlightedLine(')
    expect(workbenchSource).toContain('<mark className={active ? \'is-current\' : \'\'}')
    expect(workbenchSource).toContain('setPointerCapture(event.pointerId)')
    expect(workbenchSource).toContain('role="separator"')
    expect(cssRule(workbenchCss, '.file-row.active')).not.toContain('box-shadow: inset 2px 0 var(--wb-blue)')
  })

  it('removes closed-tab line-window and evidence cache entries without touching other files', () => {
    expect(omitFileCacheEntry({ 'file-a': 'window-a', 'file-b': 'window-b' }, 'file-a')).toEqual({ 'file-b': 'window-b' })
    expect(omitFileCacheEntry({ 'file-a': [10], 'file-b': [20] }, 'file-a')).toEqual({ 'file-b': [20] })
  })

  it('deduplicates a stable root source to its newest SHA without inheriting the old source id', () => {
    const oldSha = 'a'.repeat(64)
    const newSha = 'b'.repeat(64)
    const oldRow = artifactFiles(artifact(oldSha, '2026-01-01T00:00:00.000Z', 'root-stable'))[0]
    const newRow = artifactFiles(artifact(newSha, '2026-02-01T00:00:00.000Z', 'root-stable'))[0]

    expect(oldRow.sourceKey).toBe(newRow.sourceKey)
    expect(oldRow.id).toContain(oldSha)
    expect(newRow.id).toContain(newSha)
    expect(oldRow.id).not.toBe(newRow.id)
    expect(dedupeWorkbenchFiles([oldRow, newRow])).toEqual([newRow])
  })

  it('keeps legacy rows unique when rootId is unavailable', () => {
    const first = artifactFiles(artifact('c'.repeat(64), '2026-01-01T00:00:00.000Z'))[0]
    const second = artifactFiles(artifact('d'.repeat(64), '2026-02-01T00:00:00.000Z'))[0]

    expect(first.sourceKey).not.toBe(second.sourceKey)
    expect(dedupeWorkbenchFiles([first, second])).toHaveLength(2)
  })

  it('merges a completed import with the latest files and keeps the newest stable source', () => {
    const current: WorkbenchFile = {
      id: 'old-row',
      sourceKey: 'root:root-a\u001flog.log',
      rootId: 'root-a',
      artifactId: 'old-artifact',
      name: 'log.log',
      lastSeenAt: '2026-02-01T00:00:00.000Z',
    }
    const imported: WorkbenchFile = {
      id: 'new-row',
      sourceKey: 'root:root-a\u001flog.log',
      rootId: 'root-a',
      artifactId: 'new-artifact',
      name: 'log.log',
      lastSeenAt: '2026-03-01T00:00:00.000Z',
    }
    const latest = { id: 'latest-row', name: 'latest.log' }

    expect(mergeWorkbenchFiles([current, latest], [imported])).toEqual([imported, latest])
  })

  it('groups same-label roots separately and numbers duplicate labels', () => {
    const first = artifactFiles(artifact('e'.repeat(64), '2026-01-01T00:00:00.000Z', 'root-one'))[0]
    const second = { ...artifactFiles(artifact('f'.repeat(64), '2026-01-01T00:00:00.000Z', 'root-two'))[0], origin: 'logs' }
    first.origin = 'logs'

    expect(groupWorkbenchFiles([first, second])).toEqual([
      expect.objectContaining({ key: 'root:root-one', label: 'logs · 1', files: [first] }),
      expect.objectContaining({ key: 'root:root-two', label: 'logs · 2', files: [second] }),
    ])
  })

  it('keeps duplicate-label ordinals mapped to stable roots when input order changes', () => {
    const first = { id: 'root-one-file', name: 'one.log', origin: 'logs', rootId: 'root-one' }
    const second = { id: 'root-two-file', name: 'two.log', origin: 'logs', rootId: 'root-two' }

    const labels = (rows: WorkbenchFile[]) => Object.fromEntries(
      groupWorkbenchFiles(rows).map((group) => [group.key, group.label]),
    )

    expect(labels([first, second])).toEqual({ 'root:root-one': 'logs · 1', 'root:root-two': 'logs · 2' })
    expect(labels([second, first])).toEqual({ 'root:root-two': 'logs · 2', 'root:root-one': 'logs · 1' })
  })

  it('keeps same-label legacy roots separate while grouping files from each root', () => {
    const firstRootFile = {
      id: 'legacy-one-a',
      name: 'first.log',
      origin: 'logs',
      relativePath: 'first/first.log',
      sourceKey: 'legacy:source-one\u001ffirst/first.log',
    }
    const firstRootOtherFile = {
      id: 'legacy-one-b',
      name: 'second.log',
      origin: 'logs',
      relativePath: 'first/second.log',
      sourceKey: 'legacy:source-one\u001ffirst/second.log',
    }
    const secondRootFile = {
      id: 'legacy-two-a',
      name: 'first.log',
      origin: 'logs',
      relativePath: 'second/first.log',
      sourceKey: 'legacy:source-two\u001fsecond/first.log',
    }

    const groups = groupWorkbenchFiles([firstRootFile, firstRootOtherFile, secondRootFile])

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.label)).toEqual(['logs · 1', 'logs · 2'])
    expect(groups[0].files).toEqual([firstRootFile, firstRootOtherFile])
    expect(groups[1].files).toEqual([secondRootFile])
    expect(groups[0].key).not.toContain('source-one')
    expect(groups[1].key).not.toContain('source-two')
  })

  it('does not turn missing or failed backend results into zero-count evidence', () => {
    const rows: WorkbenchFile[] = [
      { id: 'ok-row', artifactId: 'ok', name: 'ok.log' },
      { id: 'failed-row', artifactId: 'failed', name: 'failed.log' },
      { id: 'missing-row', artifactId: 'missing', name: 'missing.log' },
    ]
    const result: ArtifactSearchResult = {
      query: '@PASS',
      mode: 'literal',
      caseSensitive: false,
      matches: [],
      totalMatchCount: 0,
      truncated: false,
      files: [
        { artifactId: 'ok', fileName: 'ok.log', matchCount: 0, searchedLineCount: 3 },
        { artifactId: 'failed', fileName: 'failed.log', matchCount: 0, searchedLineCount: 0, error: 'read failed' },
      ],
    }

    expect(successfulSearchCounts(rows, result)).toEqual({ 'ok-row': 0 })
  })

  it('deduplicates identical clause search specs independently of rule ids and presence', () => {
    const present = rule('one', 'PASS', 'candidate').clauses[0]
    const absent = { ...rule('two', 'SYSTEM_HALT', 'candidate').clauses[0], presence: 'absent' as const }
    expect(clauseSpecKey(present)).toBe(clauseSpecKey(absent))
  })

  it('uses rule precedence but preserves a conflicting confirmed engineer decision', () => {
    const candidate = rule('candidate', 'TEST_FAIL', 'candidate')
    const verified = { ...rule('verified', 'PASS', 'verified'), scope: { kind: 'project' as const } }
    const file: WorkbenchFile = { id: 'log-1', name: 'sample.log', text: 'DONE' }
    const allRules = [candidate, verified]
    const precomputed = new Map([[file.id, evidence(file.id, allRules)]])

    const normal = resolvePrecomputedBatch([file], allRules, precomputed, {})
    expect(normal).toMatchObject({ outcomes: { 'log-1': 'PASS' }, matched: 1, exceptions: 0, conflicts: 0 })

    const protectedDecision = resolvePrecomputedBatch([file], allRules, precomputed, { 'log-1': 'SYSTEM_HALT' })
    expect(protectedDecision).toMatchObject({
      outcomes: { 'log-1': 'SYSTEM_HALT' },
      matched: 0,
      exceptions: 1,
      conflicts: 1,
    })
  })

  it('fails closed when precomputed evidence is missing', () => {
    const candidate = rule('candidate', 'PASS', 'candidate')
    const file: WorkbenchFile = { id: 'log-2', name: 'sample.log', text: 'DONE' }
    const resolved = resolvePrecomputedBatch([file], [candidate], new Map(), {})
    expect(resolved).toMatchObject({ outcomes: { 'log-2': 'UNKNOWN' }, matched: 0, exceptions: 1 })
  })
})
