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
      readFile(resolve(root, 'docs/manual/20-로그-워크벤치.md'), 'utf8'),
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
})
