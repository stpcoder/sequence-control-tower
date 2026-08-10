import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_COLUMNS, EVIDENCE_EXPORT_COLUMNS } from '../../src/state/logRecords'

describe('manual and product contract', () => {
  it('documents configurable result fields without exposing retired candidate columns', async () => {
    const manual = await readFile(resolve('docs/manual/04-결과-정리.md'), 'utf8')
    expect(manual).toContain('열 선택')
    expect(manual).toContain('근거 개수')
    expect(manual).not.toContain('sample_candidate')
    expect(DEFAULT_EXPORT_COLUMNS.length).toBeGreaterThan(5)
    expect(EVIDENCE_EXPORT_COLUMNS.length).toBeGreaterThan(0)
  })

  it('documents provider limits and background recovery without presenting implementation defaults as required input', async () => {
    const manual = await readFile(resolve('docs/manual/07-LLM-OpenCode.md'), 'utf8')
    for (const label of ['RPM', 'TPM', '응답 제한 시간', '재시도 횟수']) expect(manual).toContain(label)
    expect(manual).toContain('분석은 백그라운드에서 실행합니다')
    expect(manual).toContain('내장 Agent로 전환합니다')
  })

  it('builds a GitBook-compatible and GitHub Pages-compatible manual', async () => {
    const [gitbook, config, workflow] = await Promise.all([
      readFile('.gitbook.yaml', 'utf8'),
      readFile('docs/manual/.vitepress/config.mts', 'utf8'),
      readFile('.github/workflows/docs.yml', 'utf8'),
    ])
    expect(gitbook).toContain('summary: SUMMARY.md')
    expect(config).toContain("base: '/sequence-control-tower/'")
    expect(workflow).toContain('actions/deploy-pages@v4')
  })
})
