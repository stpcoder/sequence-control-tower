import { describe, expect, it } from 'vitest'
import { AsyncActionGate } from './asyncActionGate'

describe('UI action ownership', () => {
  it('blocks repeated clicks synchronously and allows nested work by the owner', () => {
    const gate = new AsyncActionGate()
    const send = gate.begin()!
    expect(gate.begin()).toBeNull()
    expect(gate.owns(send)).toBe(true)
    gate.finish(send)
    expect(gate.begin()).not.toBeNull()
  })
  it('does not let an old folder completion unlock a new action after A → B → A', () => {
    const gate = new AsyncActionGate()
    const first = gate.begin()!
    gate.reset()
    const second = gate.begin()!
    gate.finish(first)
    expect(gate.pending).toBe(true)
    expect(gate.begin()).toBeNull()
    gate.finish(second)
    expect(gate.pending).toBe(false)
  })
})

it('keeps cancellation locked even if a superseded send completes first', () => {
  const gate = new AsyncActionGate()
  const send = gate.begin()!
  const cancel = gate.replace()
  gate.finish(send)
  expect(gate.begin()).toBeNull()
  gate.finish(cancel)
  expect(gate.pending).toBe(false)
})
