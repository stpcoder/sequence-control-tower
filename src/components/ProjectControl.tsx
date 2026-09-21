import { useEffect, useState } from 'react'
import { Beaker, ChevronDown, FolderPlus, LoaderCircle, Plus, Unplug, X } from 'lucide-react'
import type { ProjectLoadResult, ProjectSaveInput, ProjectSnapshot } from '../../electron/shared/contracts'

export const PROJECT_INIT_ITEMS = ['Sample', 'Skew', '온도', 'VDD', '주파수', 'Mode', 'Pattern', '평가 제목', 'Grid', 'PASS/FAIL', 'Reboot/Halt'] as const
export type ProjectInitItem = typeof PROJECT_INIT_ITEMS[number]
export type ProjectInitStep = 1 | 2 | 3
export interface ProjectInitDraft { name: string; purpose: string; reuseProjectId: string; items?: ProjectInitItem[]; custom?: string }

export function serializeOnboardingItems(items: readonly string[], custom = ''): string {
  return [...items, custom.trim()].filter(Boolean).join(' · ')
}

export function deserializeOnboardingItems(value = ''): { items: ProjectInitItem[]; custom: string } {
  const parts = value.split(' · ').map((part) => part.trim()).filter(Boolean)
  const items = parts.filter((part): part is ProjectInitItem => (PROJECT_INIT_ITEMS as readonly string[]).includes(part))
  const custom = parts.filter((part) => !(PROJECT_INIT_ITEMS as readonly string[]).includes(part)).join(' · ')
  return { items, custom }
}

export function isProjectInitStepValid(step: ProjectInitStep, draft: ProjectInitDraft): boolean {
  if (step === 1) return Boolean(draft.name.trim())
  return step === 2 || !draft.reuseProjectId || Boolean(draft.reuseProjectId.trim())
}

export function buildProjectOnboardingAnswers(draft: ProjectInitDraft) {
  return {
    evaluationTarget: draft.purpose.trim(),
    importantMetadata: serializeOnboardingItems(PROJECT_INIT_ITEMS),
    reuseRules: draft.reuseProjectId ? '설정 재사용' : '새로 시작'
  }
}

export function buildProjectClonePlan(source: ProjectSnapshot): Pick<ProjectSaveInput, 'onboardingAnswers' | 'equipmentProfiles' | 'templatePins' | 'exportPresets'> {
  return {
    onboardingAnswers: source.onboardingAnswers ? { ...source.onboardingAnswers } : {},
    equipmentProfiles: source.equipmentProfiles.map((profile) => ({ ...profile })),
    templatePins: source.templatePins.map((pin) => ({ ...pin })),
    exportPresets: source.exportPresets.map((preset) => ({ ...preset, options: structuredClone(preset.options) }))
  }
}

export function applyValidatedFolders(project: ProjectSnapshot, folders: ProjectSnapshot['folders']): ProjectSnapshot {
  return { ...project, folders }
}

export function projectListSecondary(project: ProjectSnapshot): string {
  const target = project.onboardingAnswers?.evaluationTarget?.trim() || project.description?.trim()
  const scope = `평가 ${project.folders.length} · 로그 ${project.artifacts.length}`
  return target ? `${target} · ${scope}` : `${scope} · ${new Date(project.updatedAt).toLocaleDateString('ko-KR')}`
}

export function isPublicSyntheticDemo(project: Pick<ProjectSnapshot, 'description'> | null | undefined): boolean {
  return Boolean(project?.description?.includes('SCT_PUBLIC_SYNTHETIC_DEMO_'))
}

/** Hide only superseded, explicitly marked built-in samples. User projects
 * with the same name remain separate and visible. */
export function visibleProjectList(projects: readonly ProjectSnapshot[]): ProjectSnapshot[] {
  const marker = /^(SCT_(?:SAMPLE|PUBLIC_SYNTHETIC)_.+)_V(\d+)\b/
  const newest = new Map<string, number>()
  projects.forEach((project) => {
    const match = marker.exec(project.description ?? '')
    if (!match) return
    newest.set(match[1], Math.max(newest.get(match[1]) ?? 0, Number(match[2])))
  })
  return projects.filter((project) => {
    const match = marker.exec(project.description ?? '')
    return !match || Number(match[2]) === newest.get(match[1])
  })
}

interface ProjectControlProps {
  project: ProjectSnapshot | null
  onLoaded: (result: ProjectLoadResult) => void
  onProjectUpdated: (project: ProjectSnapshot) => void
  onError: (message: string) => void
}

const blankDraft = (): ProjectInitDraft => ({ name: '', purpose: '', reuseProjectId: '' })
const isProjectRevisionConflict = (error: unknown) => error instanceof Error && (error.message.includes('PROJECT_REVISION_CONFLICT') || error.message.includes('최신 revision'))

export function ProjectControl({ project, onLoaded, onProjectUpdated, onError }: ProjectControlProps) {
  const api = window.sequenceIntelligence
  const [projects, setProjects] = useState<ProjectSnapshot[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [draft, setDraft] = useState<ProjectInitDraft>(blankDraft)
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [metaName, setMetaName] = useState('')
  const [metaDescription, setMetaDescription] = useState('')
  const [metaAnswers, setMetaAnswers] = useState({ evaluationTarget: '', importantMetadata: '', reuseRules: '' })
  const [equipmentAlias, setEquipmentAlias] = useState('')

  useEffect(() => {
    setMetaName(project?.name ?? '')
    setMetaDescription(project?.onboardingAnswers?.evaluationTarget ?? project?.description ?? '')
    setMetaAnswers({ evaluationTarget: project?.onboardingAnswers?.evaluationTarget ?? '', importantMetadata: project?.onboardingAnswers?.importantMetadata ?? '', reuseRules: project?.onboardingAnswers?.reuseRules ?? '' })
    setEquipmentAlias(project?.equipmentProfiles[0]?.alias ?? '')
  }, [project])

  const refresh = async () => {
    if (!api?.projects) return
    try {
      const items = visibleProjectList(await api.projects.list()); setProjects(items)
      if (!project && items[0]) await load(items[0].id)
    } catch (error) { onError(error instanceof Error ? error.message : '프로젝트 목록을 불러오지 못했습니다.') }
  }
  useEffect(() => { void refresh() }, [])

  const load = async (projectId: string) => {
    setBusy(true)
    try { const result = await api.projects.load({ projectId }); if (result) { onLoaded(result); setCreatedProjectId(null); setOpen(false) } }
    catch (error) { onError(error instanceof Error ? error.message : '프로젝트를 불러오지 못했습니다.') }
    finally { setBusy(false) }
  }

  const create = async () => {
    if (!isProjectInitStepValid(1, draft)) return
    setBusy(true)
    try {
      const createdProject = await api.projects.create({ name: draft.name.trim(), description: draft.purpose.trim() || undefined, onboardingAnswers: buildProjectOnboardingAnswers(draft) })
      let created = createdProject
      if (draft.reuseProjectId) {
        const source = projects.find((item) => item.id === draft.reuseProjectId)
        if (source) {
          try {
            const clone = buildProjectClonePlan(source)
            created = await api.projects.save({
              projectId: created.id, expectedRevision: created.revision, ...clone,
              onboardingAnswers: { ...clone.onboardingAnswers, ...buildProjectOnboardingAnswers(draft) },
            })
          }
          catch (error) { onError(`프로젝트는 만들어졌지만 설정 재사용에 실패했습니다: ${error instanceof Error ? error.message : '저장 오류'}`) }
          try { await api.nativeAgent.reuseConfirmedKnowledge({ sourceProjectId: source.id, targetProjectId: created.id }) }
          catch (error) { onError(`프로젝트는 만들어졌지만 확정된 분석 절차를 가져오지 못했습니다: ${error instanceof Error ? error.message : '저장 오류'}`) }
        }
      }
      const result = await api.projects.load({ projectId: created.id })
      if (result) { onLoaded(result); setCreatedProjectId(created.id) }
      setShowNew(false); setDraft(blankDraft())
    } catch (error) { onError(error instanceof Error ? error.message : '프로젝트를 만들지 못했습니다.') }
    finally { setBusy(false) }
  }

  const createSample = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await api.projects.createSample()
      onLoaded(result); setCreatedProjectId(null); setOpen(false)
      await refresh()
    } catch (error) { onError(error instanceof Error ? error.message : '샘플 프로젝트를 만들지 못했습니다.') }
    finally { setBusy(false) }
  }

  const attach = async () => {
    const target = project
    if (!target) return
    setBusy(true)
    try {
      const latest = await api.projects.get({ projectId: target.id }) ?? target
      const result = await api.projects.attachFolder({ projectId: latest.id, expectedRevision: latest.revision })
      if (!('cancelled' in result)) { onLoaded(result); setCreatedProjectId(null) }
    }
    catch (error) { onError(error instanceof Error ? error.message : '폴더를 연결하지 못했습니다.') }
    finally { setBusy(false) }
  }
  const detach = async (rootId: string) => {
    if (!project) return; setBusy(true)
    try {
      try { onProjectUpdated(await api.projects.detachFolder({ projectId: project.id, expectedRevision: project.revision, rootId })) }
      catch (error) {
        if (!isProjectRevisionConflict(error)) throw error
        const latest = await api.projects.get({ projectId: project.id })
        if (!latest) throw new Error('프로젝트를 다시 불러오지 못했습니다.')
        onProjectUpdated(await api.projects.detachFolder({ projectId: latest.id, expectedRevision: latest.revision, rootId }))
      }
    }
    catch (error) { onError(error instanceof Error ? error.message : '폴더 연결을 해제하지 못했습니다.') }
    finally { setBusy(false) }
  }
  const saveMeta = async () => {
    if (!project || !metaName.trim()) return; setBusy(true)
    try {
      const stamp = new Date().toISOString()
      const persist = (target: ProjectSnapshot) => api.projects.save({
        projectId: target.id, expectedRevision: target.revision, name: metaName.trim(), description: metaDescription.trim() || undefined,
        onboardingAnswers: { ...metaAnswers, evaluationTarget: metaDescription.trim(), importantMetadata: serializeOnboardingItems(PROJECT_INIT_ITEMS) },
        equipmentProfiles: equipmentAlias ? [{ alias: equipmentAlias, profileId: target.equipmentProfiles[0]?.profileId ?? 'default', updatedAt: stamp }] : target.equipmentProfiles,
      })
      let next: ProjectSnapshot
      try { next = await persist(project) }
      catch (error) {
        if (!isProjectRevisionConflict(error)) throw error
        const latest = await api.projects.get({ projectId: project.id })
        if (!latest) throw new Error('프로젝트를 다시 불러오지 못했습니다.')
        next = await persist(latest)
      }
      onProjectUpdated(next)
    } catch (error) { onError(error instanceof Error ? error.message : '프로젝트 설정을 저장하지 못했습니다.') }
    finally { setBusy(false) }
  }

  return <>
    <div className="project-switcher">
      <button className="project-switch-button" onClick={() => { setOpen((value) => !value); void refresh() }} aria-expanded={open}><span>{project?.name ?? '프로젝트 선택'}</span><ChevronDown size={14} /></button>
      {isPublicSyntheticDemo(project) ? <span className="public-demo-badge" title="실제 고객·자재·장비 정보를 포함하지 않는 합성 데이터입니다.">공개 합성 데이터</span> : null}
    </div>
    {open ? <div className="project-popover" role="dialog" aria-label="프로젝트 관리">
      <div className="project-popover-head"><strong>{showNew ? '새 프로젝트' : '프로젝트'}</strong><button className="modal-close" onClick={() => setOpen(false)} aria-label="닫기"><X size={16} /></button></div>
      {!showNew ? <div className="project-list">{projects.map((item) => <button className={`project-list-item ${item.id === project?.id ? 'active' : ''}`} key={item.id} onClick={() => void load(item.id)} disabled={busy} title={`${item.name}\n${projectListSecondary(item)}`}><strong>{item.name}</strong><small>{projectListSecondary(item)}</small></button>)}{!projects.length ? <p className="project-empty">아직 프로젝트가 없습니다.</p> : null}</div> : null}
      {showNew ? <div className="project-form">
        <label className="project-create-field"><span>프로젝트 이름</span><input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="예: LPDDR6 4-Corner 평가" aria-label="프로젝트 이름" /></label>
        <label className="project-create-field"><span>개발 목표</span><textarea value={draft.purpose} onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} placeholder="예: LPDDR6 제품의 불량 재현 및 개선 평가" aria-label="프로젝트 개발 목표" rows={3} /></label>
        <label className="project-create-field"><span>설정 가져오기</span><select value={draft.reuseProjectId} onChange={(event) => setDraft({ ...draft, reuseProjectId: event.target.value })} aria-label="재사용할 기존 프로젝트"><option value="">가져오지 않음</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="project-form-actions"><button className="project-cancel-action" onClick={() => { setShowNew(false); setDraft(blankDraft()) }}>취소</button><button className="project-primary-action" onClick={() => void create()} disabled={busy || !draft.name.trim()}>{busy ? <LoaderCircle className="wb-spin" size={15} /> : null}프로젝트 만들기</button></div>
      </div> : <div className="project-create-actions"><button className="project-add-action" onClick={() => setShowNew(true)}><Plus size={15} />새 프로젝트</button>{project ? <button className="project-folder-action" onClick={() => void attach()} disabled={busy}><FolderPlus size={14} />평가 폴더 추가</button> : null}{!projects.length ? <button className="project-sample-action" onClick={() => void createSample()} disabled={busy} aria-label="공개 합성 데모 열기" title="공개 합성 데모 열기">{busy ? <LoaderCircle className="wb-spin" size={14} /> : <Beaker size={14} />}데모 열기</button> : null}</div>}
      {project && !showNew ? <div className="project-settings-block">
        <details className="project-folders"><summary>평가 폴더 <span>{project.folders.length}</span></summary><div className="project-folder-content">
          {project.folders.length ? project.folders.map((folder) => <div className="folder-status-line" key={folder.rootId}><span>{folder.displayLabel}<small>{folder.status === 'available' ? '연결됨' : folder.status === 'permission-denied' ? '권한 없음' : '없음'}</small></span><button onClick={() => void detach(folder.rootId)} disabled={busy} aria-label={`${folder.displayLabel} 해제`}><Unplug size={13} /></button></div>) : <p className="project-empty">연결된 폴더가 없습니다.</p>}
          {project.folders.filter((folder) => folder.status !== 'available').map((folder) => <div className="folder-warning" key={folder.rootId}>{folder.displayLabel}: {folder.status === 'permission-denied' ? '권한 없음' : '폴더 없음'}</div>)}
        </div></details>
        <details className="project-details"><summary>프로젝트 정보 수정</summary><div className="project-advanced-content">
          <label className="project-field"><span>프로젝트 이름</span><input className="project-meta-input" value={metaName} onChange={(event) => setMetaName(event.target.value)} aria-label="현재 프로젝트 이름" /></label>
          <label className="project-field"><span>개발 목표</span><textarea className="project-meta-input" value={metaDescription} onChange={(event) => setMetaDescription(event.target.value)} placeholder="예: LPDDR6 제품의 불량 재현 및 개선 평가" aria-label="현재 프로젝트 설명" rows={2} /></label>
          <label className="project-field"><span>실장기 명</span><input className="project-meta-input" value={equipmentAlias} onChange={(event) => setEquipmentAlias(event.target.value)} placeholder="예: Synthetic SM-9999 #1" aria-label="실장기 명" /></label>
          <button className="project-primary-action" onClick={() => void saveMeta()} disabled={busy}>변경사항 저장</button>
        </div></details>
      </div> : null}
    </div> : null}
  </>
}
