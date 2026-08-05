import { describe, expect, it } from 'vitest'
import {
  addCurrentReplacement,
  addReplaceAll,
  applyLogDraftLine,
  applyLogDraftToText,
  createLogDraft,
  filterLogDraftByFileIds,
  resetLogDraft,
  type LogDraft,
} from '../../src/state/logDraft'

function current(draft: LogDraft, overrides: Partial<Parameters<typeof addCurrentReplacement>[1]> = {}) {
  return addCurrentReplacement(draft, {
    fileId: 'a.log',
    line: 1,
    expected: { start: 0, end: 3, text: 'old' },
    replacement: 'new',
    ...overrides,
  })
}

function all(draft: LogDraft, overrides: Partial<Parameters<typeof addReplaceAll>[1]> = {}) {
  return addReplaceAll(draft, {
    fileIds: ['a.log'],
    pattern: 'old',
    replacement: 'new',
    ...overrides,
  })
}

describe('log replacement draft', () => {
  it('applies one current match and replace-all lazily across selected lines', () => {
    let draft = createLogDraft()
    draft = current(draft).draft
    draft = all(draft, { pattern: 'tail', replacement: 'done' }).draft

    expect(applyLogDraftToText(draft, 'a.log', 'old tail\nold tail').text).toBe('new done\nold done')
    expect(draft.operations).toHaveLength(2)
  })

  it('scopes replace-all operations by file id', () => {
    const draft = all(createLogDraft(), { fileIds: ['a.log', 'c.log'] }).draft
    expect(applyLogDraftToText(draft, 'a.log', 'old').text).toBe('new')
    expect(applyLogDraftToText(draft, 'b.log', 'old').text).toBe('old')
    expect(applyLogDraftToText(draft, 'c.log', 'old').text).toBe('new')
  })

  it('supports literal case, whole-word, and regex capture replacement', () => {
    const literal = all(createLogDraft(), {
      pattern: 'Foo',
      replacement: 'X',
      caseSensitive: false,
      wholeWord: true,
    }).draft
    expect(applyLogDraftToText(literal, 'a.log', 'foo food FOO').text).toBe('X food X')

    const captured = all(createLogDraft(), {
      pattern: String.raw`(?<key>ERR)-(?<number>\d+)`,
      replacement: '$<number>:$<key>',
      mode: 'regex',
    }).draft
    expect(applyLogDraftToText(captured, 'a.log', 'ERR-42 ERR-7').text).toBe('42:ERR 7:ERR')

    const unicode = all(createLogDraft(), {
      pattern: String.raw`\p{L}+`,
      replacement: 'WORD',
      mode: 'regex',
    }).draft
    expect(applyLogDraftToText(unicode, 'a.log', '한글 abc 123').text).toBe('WORD WORD 123')

    const koreanToken = all(createLogDraft(), {
      pattern: '한글',
      replacement: 'KOR',
      wholeWord: true,
    }).draft
    expect(applyLogDraftToText(koreanToken, 'a.log', '한글 한글자 x한글 한글_2').text).toBe('KOR 한글자 x한글 한글_2')
  })

  it('supports empty replacement and sequential operations', () => {
    let draft = all(createLogDraft(), { pattern: 'remove', replacement: '' }).draft
    draft = all(draft, { pattern: 'old', replacement: 'new' }).draft
    expect(applyLogDraftToText(draft, 'a.log', 'remove old').text).toBe(' new')
  })

  it('guards a stale current match without corrupting the source line', () => {
    const draft = current(createLogDraft()).draft
    const result = applyLogDraftLine(draft, 'a.log', 1, 'changed')
    expect(result.text).toBe('changed')
    expect(result.issues[0]?.validation).toMatchObject({ ok: false, code: 'STALE_CURRENT_MATCH' })
  })

  it('returns explicit validation results for newline, invalid, and zero-width requests', () => {
    const draft = createLogDraft()
    expect(all(draft, { replacement: 'line\nbreak' }).validation).toMatchObject({
      ok: false,
      code: 'NEWLINE_REPLACEMENT',
    })
    expect(all(draft, { mode: 'regex', pattern: '[' }).validation).toMatchObject({
      ok: false,
      code: 'INVALID_REGEX',
    })
    expect(all(draft, { mode: 'regex', pattern: '^' }).validation).toMatchObject({
      ok: false,
      code: 'ZERO_WIDTH_PATTERN',
    })
    for (const pattern of ['(a+)+', '.*a.*b.*', String.raw`(a)\1`]) {
      expect(all(draft, { mode: 'regex', pattern }).validation).toMatchObject({
        ok: false,
        code: 'UNSAFE_REGEX',
      })
    }
    expect(all(draft, { pattern: '' }).validation).toMatchObject({
      ok: false,
      code: 'EMPTY_PATTERN',
    })
  })

  it('keeps the source text unchanged and offers reset/filter helpers', () => {
    const source = 'old old'
    let draft = all(createLogDraft([{ id: 'a.log', text: source }])).draft
    const originalOperations = draft.operations
    const applied = applyLogDraftToText(draft, 'a.log', source)

    expect(applied.text).toBe('new new')
    expect(source).toBe('old old')
    expect(draft.operations).toBe(originalOperations)

    draft = addReplaceAll(draft, { fileIds: ['b.log'], pattern: 'x', replacement: 'y' }).draft
    expect(filterLogDraftByFileIds(draft, ['a.log']).operations).toHaveLength(1)
    expect(resetLogDraft(draft).operations).toHaveLength(0)
  })
})
