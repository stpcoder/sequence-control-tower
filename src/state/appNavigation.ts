export type AppPage = 'workbench' | 'results' | 'patterns' | 'history' | 'settings'

export const APP_PAGES: readonly AppPage[] = ['workbench', 'results', 'patterns', 'history', 'settings']

export function isAppPage(value: string | null): value is AppPage {
  return value !== null && APP_PAGES.includes(value as AppPage)
}
