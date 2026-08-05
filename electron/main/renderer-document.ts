/**
 * Renderer navigation keeps the same immutable HTML document while changing
 * only application state in the query string or fragment.
 */
export function isSameRendererDocument(actualUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl)
    const expected = new URL(expectedUrl)
    actual.search = ''
    actual.hash = ''
    expected.search = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch {
    return false
  }
}
