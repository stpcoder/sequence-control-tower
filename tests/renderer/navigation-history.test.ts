import { describe, expect, it } from 'vitest'
import { APP_PAGES, isAppPage } from '../../src/state/appNavigation'

describe('evaluation history navigation', () => {
  it('recognizes the durable evaluation-history page while retaining the workbench pages', () => {
    expect(APP_PAGES).toEqual(['workbench', 'results', 'patterns', 'history', 'settings'])
    expect(isAppPage('history')).toBe(true)
    expect(isAppPage('unknown')).toBe(false)
  })
})
