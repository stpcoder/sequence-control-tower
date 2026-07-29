import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { WikiEntryInput, WikiEntryRecord } from '../shared/contracts'
import { ArtifactService } from './artifact-service'
import { AtomicJsonStore } from './json-store'

interface WikiDatabase {
  schemaVersion: 1
  entries: Record<
    string,
    {
      record: WikiEntryRecord
      /** Structured source of the generated Markdown; keeps purpose/decision queryable. */
      knowledge: WikiEntryInput
      /** Append-only edit history for purpose/decision changes. */
      revisions: Array<{ savedAt: string; knowledge: WikiEntryInput }>
    }
  >
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' '))
}

function slug(value: string): string {
  const result = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
  return result || 'sequence-entry'
}

function safeInput(input: WikiEntryInput): WikiEntryInput {
  const artifactId = clean(input?.artifactId, 64)
  const parentArtifactId = clean(input?.parentArtifactId, 64) || undefined
  if (!/^[a-f0-9]{64}$/.test(artifactId)) throw new Error('잘못된 아티팩트 ID입니다.')
  if (parentArtifactId && !/^[a-f0-9]{64}$/.test(parentArtifactId)) {
    throw new Error('잘못된 부모 아티팩트 ID입니다.')
  }
  const project = clean(input?.project, 200)
  const title = clean(input?.title, 240)
  if (!project || !title) throw new Error('프로젝트와 제목은 필수입니다.')
  if (input?.analysis && JSON.stringify(input.analysis).length > 1_000_000) {
    throw new Error('Agent Review 데이터가 너무 큽니다.')
  }
  const allowedStatuses = new Set(['extracted', 'inferred', 'verified', 'unknown'])
  return {
    ...input,
    artifactId,
    parentArtifactId,
    project,
    title,
    purpose: clean(input?.purpose, 4_000) || undefined,
    userComment: clean(input?.userComment, 4_000) || undefined,
    engineerDecision: clean(input?.engineerDecision, 8_000) || undefined,
    status:
      typeof input?.status === 'string' && allowedStatuses.has(input.status)
        ? input.status
        : 'unknown',
    tags: [
      ...new Set(
        (input?.tags ?? []).slice(0, 100)
          .map((tag) => clean(tag, 60).toLowerCase().replace(/\s+/g, '-'))
          .filter(Boolean)
      )
    ].slice(0, 30)
  }
}

export class WikiService {
  private readonly store: AtomicJsonStore<WikiDatabase>
  private readonly vaultRoot: string

  constructor(
    dataRoot: string,
    private readonly artifacts: ArtifactService
  ) {
    this.vaultRoot = join(dataRoot, 'wiki')
    this.store = new AtomicJsonStore(join(dataRoot, 'metadata', 'wiki.json'), {
      schemaVersion: 1,
      entries: {}
    })
  }

  async initialize(): Promise<void> {
    await Promise.all([mkdir(this.vaultRoot, { recursive: true }), this.store.initialize()])
  }

  async save(rawInput: WikiEntryInput): Promise<WikiEntryRecord> {
    const input = safeInput(rawInput)
    const artifact = await this.artifacts.require(input.artifactId)
    if (input.parentArtifactId) await this.artifacts.require(input.parentArtifactId)
    const id = createHash('sha256')
      .update(`${input.project}\0${input.artifactId}`)
      .digest('hex')
      .slice(0, 20)
    const previous = (await this.store.read()).entries[id]?.record
    const now = new Date().toISOString()
    const relativeFileName = join(slug(input.project), `${slug(input.title)}--${id.slice(0, 8)}.md`)
    const record: WikiEntryRecord = {
      id,
      artifactId: input.artifactId,
      title: input.title,
      project: input.project,
      status: input.status,
      relativeFileName,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    }
    const markdown = await this.renderMarkdown(input, record, artifact.originalNames[0] ?? artifact.id)
    const destination = join(this.vaultRoot, relativeFileName)
    await mkdir(join(this.vaultRoot, slug(input.project)), { recursive: true })
    await writeFile(destination, markdown, { encoding: 'utf8', mode: 0o600 })
    await this.store.update((draft) => {
      const existing = draft.entries[id]
      draft.entries[id] = {
        record,
        knowledge: input,
        revisions: [
          ...(existing?.revisions ?? []),
          ...(existing ? [{ savedAt: existing.record.updatedAt, knowledge: existing.knowledge }] : [])
        ].slice(-100)
      }
    })
    return record
  }

  async list(): Promise<WikiEntryRecord[]> {
    return Object.values((await this.store.read()).entries).map((entry) => entry.record).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )
  }

  async get(id: string): Promise<WikiEntryRecord | null> {
    if (!/^[a-f0-9]{20}$/.test(id)) return null
    return (await this.store.read()).entries[id]?.record ?? null
  }

  async source(id: string): Promise<{ suggestedName: string; markdown: string }> {
    const record = await this.get(id)
    if (!record) throw new Error('Wiki 항목을 찾을 수 없습니다.')
    return {
      suggestedName: basename(record.relativeFileName),
      markdown: await readFile(join(this.vaultRoot, record.relativeFileName), 'utf8')
    }
  }

  private async renderMarkdown(
    input: WikiEntryInput,
    record: WikiEntryRecord,
    originalName: string
  ): Promise<string> {
    const entries = await this.list()
    const parentEntry = input.parentArtifactId
      ? entries.find((entry) => entry.artifactId === input.parentArtifactId)
      : undefined
    const tags = [...new Set([...(input.tags ?? []), ...(input.analysis?.suggestedTags ?? [])])]
    const lines: string[] = [
      '---',
      `sequence_id: ${yamlString(record.id)}`,
      `artifact_sha256: ${yamlString(input.artifactId)}`,
      `source_file: ${yamlString(originalName)}`,
      `project: ${yamlString(input.project)}`,
      `status: ${yamlString(input.status)}`,
      `created_at: ${yamlString(record.createdAt)}`,
      `updated_at: ${yamlString(record.updatedAt)}`,
      `parent: ${yamlString(parentEntry ? `[[${parentEntry.title}]]` : input.parentArtifactId ?? '')}`,
      'tags:',
      ...(tags.length ? tags.map((tag) => `  - ${yamlString(tag)}`) : ['  - sequence']),
      '---',
      '',
      `# ${input.title}`,
      '',
      '> [!info] 지식 상태',
      `> **${input.status.toUpperCase()}** · 원본 SHA-256 \`${input.artifactId}\``,
      '',
      '## 평가 목적',
      '',
      input.purpose ?? '> [!question] 확인 필요\n> 평가 목적이 아직 확인되지 않았습니다.',
      ''
    ]

    if (input.userComment) {
      lines.push('## 엔지니어 코멘트', '', input.userComment, '')
    }
    if (input.analysis) {
      lines.push(
        '## Agent Review',
        '',
        `> 분석 방식: **${input.analysis.source}**${input.analysis.model ? ` · ${input.analysis.model}` : ''}`,
        '',
        input.analysis.summary,
        '',
        '### 파일에서 확인된 사실',
        ''
      )
      if (input.analysis.facts.length) {
        input.analysis.facts.forEach((item) => {
          lines.push(`- **${item.label}:** ${item.value} · \`EXTRACTED\``)
          if (item.evidence) lines.push(`  - 근거 L${item.line ?? '?'}: \`${item.evidence.replace(/`/g, '\\`')}\``)
        })
      } else {
        lines.push('- 조건 사실을 자동 추출하지 못함')
      }
      lines.push('', '### 부모 대비 변경', '', '```diff')
      if (input.analysis.changes.length) {
        input.analysis.changes.forEach((change) => {
          if (change.kind !== 'added') lines.push(`- ${change.label}: ${change.before}`)
          if (change.kind !== 'removed') lines.push(`+ ${change.label}: ${change.after}`)
        })
      } else {
        lines.push('  부모 Sequence가 없거나 의미 변경이 감지되지 않음')
      }
      lines.push('```', '', '### 추론 · 아직 확인되지 않음', '')
      if (input.analysis.inferences.length) {
        input.analysis.inferences.forEach((item) => {
          lines.push(`- **${item.title}** (${Math.round(item.confidence * 100)}%): ${item.detail}`)
        })
      } else {
        lines.push('- 저장된 추론 없음')
      }
      if (input.analysis.questions.length) {
        lines.push('', '### 엔지니어에게 확인할 점', '')
        input.analysis.questions.forEach((item) => {
          lines.push(`- [ ] ${item.question}`)
          lines.push(`  - 이유: ${item.why}`)
          if (item.choices?.length) lines.push(`  - 선택지: ${item.choices.join(' / ')}`)
        })
      }
      if (input.analysis.warnings.length) {
        lines.push('', '> [!warning] 분석 제약')
        input.analysis.warnings.forEach((warning) => lines.push(`> - ${warning}`))
      }
      lines.push('')
    }
    if (input.engineerDecision) {
      lines.push('## 엔지니어 판정', '', input.engineerDecision, '')
    }
    lines.push(
      '## 관련',
      '',
      `- 부모 Sequence: ${parentEntry ? `[[${parentEntry.title}]]` : input.parentArtifactId ? `\`${input.parentArtifactId}\`` : '없음'}`,
      `- 원본 파일: \`${originalName}\``,
      `- 원본 무결성: \`sha256:${input.artifactId}\``,
      ''
    )
    return `${lines.join('\n')}\n`
  }
}
