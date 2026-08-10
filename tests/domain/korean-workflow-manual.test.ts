import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve('docs/manual')
const summaryPath = resolve(root, 'SUMMARY.md')

describe('current Korean operator manual', () => {
  it('keeps every GitBook summary link resolvable', async () => {
    const summary = await readFile(summaryPath, 'utf8')
    const links = [...summary.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)].map((match) => match[1])
    expect(links).toHaveLength(9)
    await Promise.all(links.map((target) => access(resolve(root, target))))
  })

  it('documents current search scopes, shortcuts, decisions, and immutable logs', async () => {
    const manual = await readFile(resolve(root, '02-검색과-판정.md'), 'utf8')
    for (const label of ['현재 평가 폴더', '열린 탭', '전체 로그', 'PASS', 'DIAG_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT']) expect(manual).toContain(`\`${label}\``)
    for (const shortcut of ['Ctrl+F', '⌘F', 'Ctrl+Alt+F', '⌘⌥F', 'Ctrl+Shift+F', '⌘⇧F']) expect(manual).toContain(`\`${shortcut}\``)
    expect(manual).toContain('원본 파일은 수정하지 않습니다')
  })

  it('documents background Agent progress, bounded evidence, proactive questions, and history provenance', async () => {
    const agent = await readFile(resolve(root, '05-Agent.md'), 'utf8')
    const history = await readFile(resolve(root, '06-평가-이력.md'), 'utf8')
    expect(agent).toContain('최대 24줄')
    expect(agent).toContain('Agent가 먼저 묻는 경우')
    expect(agent).toContain('분석은 백그라운드에서 계속')
    expect(agent).toContain('대화 기록')
    expect(history).toContain('AI 작성 · 엔지니어 확인')
    expect(history).toContain('연결 폴더 하나를 평가 하나')
  })

  it('contains no retired screenshots or obsolete manual links', async () => {
    const files = ['README.md', '01-설치와-프로젝트.md', '02-검색과-판정.md', '03-분석-규칙.md', '04-결과-정리.md', '05-Agent.md', '06-평가-이력.md', '07-LLM-OpenCode.md', '08-문제-해결.md']
    const content = (await Promise.all(files.map((file) => readFile(resolve(root, file), 'utf8')))).join('\n')
    expect(content).not.toMatch(/manual-v0(?:9|98)|manual-lw-|manual-wf-/)
    expect(content).not.toContain('ㅇㅇ')
  })
})
