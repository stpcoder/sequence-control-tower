/** A synchronous lock for UI actions. An old completion cannot release a
 * newer action after navigation, even when React has not rendered yet. */
export class AsyncActionGate {
  private active: symbol | null = null
  get pending(): boolean { return this.active !== null }
  begin(): symbol | null {
    if (this.active) return null
    return this.active = Symbol('action')
  }
  owns(token: symbol): boolean { return this.active === token }
  replace(): symbol { return this.active = Symbol('replacement') }
  finish(token: symbol): void { if (this.owns(token)) this.active = null }
  reset(): void { this.active = null }
}
