import { describe, expect, it } from 'vitest'
import { SctMcpScopeRegistry } from './sct-mcp-server'

describe('SctMcpScopeRegistry', () => {
  it('defaults to the selected evaluation sources and rejects cross-folder source IDs', () => {
    const scopes = new SctMcpScopeRegistry()
    const token = scopes.create('project-a', ['folder-a-log-1', 'folder-a-log-2'])
    expect(scopes.authorize(token, 'project-a')).toEqual(['folder-a-log-1', 'folder-a-log-2'])
    expect(scopes.authorize(token, 'project-a', ['folder-a-log-2'])).toEqual(['folder-a-log-2'])
    expect(() => scopes.authorize(token, 'project-a', ['folder-b-log-1'])).toThrow('MCP 로그 범위를 벗어났습니다.')
    expect(() => scopes.authorize(token, 'project-b')).toThrow('MCP 프로젝트 범위가 일치하지 않습니다.')
  })

  it('cannot be reused after the OpenCode request releases it', () => {
    const scopes = new SctMcpScopeRegistry()
    const token = scopes.create('project-a', ['log-1'])
    scopes.release(token)
    expect(() => scopes.authorize(token, 'project-a')).toThrow('MCP 평가 범위가 만료되었습니다.')
  })

  it('keeps bounded product summaries for the current OpenCode run only', () => {
    const scopes = new SctMcpScopeRegistry()
    const token = scopes.create('project-a', ['log-1'])
    scopes.record(token, {
      name: 'pass_fail_scan', label: 'Pass/Fail 판정', summary: 'PASS 1 · FAIL 1',
      evidenceSourceIds: ['log-1', 'outside'], data: { raw: 'not retained in trace' },
    })
    expect(scopes.traces(token)).toEqual([{
      name: 'pass_fail_scan', label: 'Pass/Fail 판정', summary: 'PASS 1 · FAIL 1', evidenceSourceIds: ['log-1'],
    }])
    scopes.release(token)
    expect(scopes.traces(token)).toEqual([])
  })

  it('streams only the same bounded trace that is retained for the run', () => {
    const scopes = new SctMcpScopeRegistry()
    const token = scopes.create('project-a', ['log-1'])
    const received: unknown[] = []
    const unsubscribe = scopes.subscribe(token, (trace) => received.push(trace))
    scopes.record(token, {
      name: 'log_search', label: '로그 검색', summary: '2개 로그에서 @FAIL 3건',
      evidenceSourceIds: ['log-1', 'outside'], data: { excerpt: 'must not be emitted' },
    })
    unsubscribe()
    scopes.record(token, {
      name: 'pass_fail_scan', label: 'Pass/Fail 판정', summary: 'FAIL 1',
      evidenceSourceIds: ['log-1'], data: {},
    })
    expect(received).toEqual([{
      name: 'log_search', label: '로그 검색', summary: '2개 로그에서 @FAIL 3건', evidenceSourceIds: ['log-1'],
    }])
  })
})
