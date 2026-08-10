import { useEffect, useState } from 'react'
import { Beaker, ChevronDown, FolderPlus, LoaderCircle, Plus, RefreshCw, Unplug, X } from 'lucide-react'
import type { ProjectLoadResult, ProjectSaveInput, ProjectSnapshot } from '../../electron/shared/contracts'

export const PROJECT_INIT_ITEMS = ['Sample', '온도', 'Mode', 'Grid', 'PASS/FAIL', 'Reboot/Halt'] as const
export type ProjectInitItem = typeof PROJECT_INIT_ITEMS[number]
export type ProjectInitStep = 1 | 2 | 3
export interface ProjectInitDraft { name: string; purpose: string; items: ProjectInitItem[]; custom: string; reuseProjectId: string }

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
  if (step === 2) return draft.items.length > 0 || Boolean(draft.custom.trim())
  return !draft.reuseProjectId || Boolean(draft.reuseProjectId.trim())
}

export function buildProjectOnboardingAnswers(draft: ProjectInitDraft) {
  return {
    evaluationTarget: draft.purpose.trim(),
    importantMetadata: serializeOnboardingItems(draft.items, draft.custom),
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
  const scope = `로그 ${project.artifacts.length} · 폴더 ${project.folders.length}`
  return target ? `${target} · ${scope}` : `${scope} · ${new Date(project.updatedAt).toLocaleDateString('ko-KR')}`
}

interface ProjectControlProps {
  project: ProjectSnapshot | null
  onLoaded: (result: ProjectLoadResult) => void
  onProjectUpdated: (project: ProjectSnapshot) => void
  onError: (message: string) => void
}

const blankDraft = (): ProjectInitDraft => ({ name: '', purpose: '', items: [], custom: '', reuseProjectId: '' })
const isProjectRevisionConflict = (error: unknown) => error instanceof Error && (error.message.includes('PROJECT_REVISION_CONFLICT') || error.message.includes('최신 revision'))

export function ProjectControl({ project, onLoaded, onProjectUpdated, onError }: ProjectControlProps) {
  const api = window.sequenceIntelligence
  const [projects, setProjects] = useState<ProjectSnapshot[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [step, setStep] = useState<ProjectInitStep>(1)
  const [draft, setDraft] = useState<ProjectInitDraft>(blankDraft)
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [metaName, setMetaName] = useState('')
  const [metaDescription, setMetaDescription] = useState('')
  const [metaAnswers, setMetaAnswers] = useState({ evaluationTarget: '', importantMetadata: '', reuseRules: '' })
  const [metaAnswerItems, setMetaAnswerItems] = useState<ProjectInitItem[]>([])
  const [metaCustom, setMetaCustom] = useState('')
  const [equipmentAlias, setEquipmentAlias] = useState('')
  const [templateRevision, setTemplateRevision] = useState('')

  useEffect(() => {
    setMetaName(project?.name ?? '')
    setMetaDescription(project?.onboardingAnswers?.evaluationTarget ?? project?.description ?? '')
    setMetaAnswers({ evaluationTarget: project?.onboardingAnswers?.evaluationTarget ?? '', importantMetadata: project?.onboardingAnswers?.importantMetadata ?? '', reuseRules: project?.onboardingAnswers?.reuseRules ?? '' })
    const parsed = deserializeOnboardingItems(project?.onboardingAnswers?.importantMetadata)
    setMetaAnswerItems(parsed.items); setMetaCustom(parsed.custom)
    setEquipmentAlias(project?.equipmentProfiles[0]?.alias ?? '')
    setTemplateRevision(project?.templatePins[0]?.revision.toString() ?? '')
  }, [project])

  const refresh = async () => {
    if (!api?.projects) return
    try {
      const items = await api.projects.list(); setProjects(items)
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
    if (!isProjectInitStepValid(1, draft) || !isProjectInitStepValid(2, draft) || !isProjectInitStepValid(3, draft)) return
    setBusy(true)
    try {
      const createdProject = await api.projects.create({ name: draft.name.trim(), description: draft.purpose.trim() || undefined, onboardingAnswers: buildProjectOnboardingAnswers(draft) })
      let created = createdProject
      if (draft.reuseProjectId) {
        const source = projects.find((item) => item.id === draft.reuseProjectId)
        if (source) {
          try { created = await api.projects.save({ projectId: created.id, expectedRevision: created.revision, ...buildProjectClonePlan(source) }) }
          catch (error) { onError(`프로젝트는 만들어졌지만 설정 재사용에 실패했습니다: ${error instanceof Error ? error.message : '저장 오류'}`) }
          try { await api.nativeAgent.reuseConfirmedKnowledge({ sourceProjectId: source.id, targetProjectId: created.id }) }
          catch (error) { onError(`프로젝트는 만들어졌지만 확정된 분석 절차를 가져오지 못했습니다: ${error instanceof Error ? error.message : '저장 오류'}`) }
        }
      }
      const result = await api.projects.load({ projectId: created.id })
      if (result) { onLoaded(result); setCreatedProjectId(created.id) }
      setShowNew(false); setStep(1); setDraft(blankDraft())
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
  const validate = async () => {
    if (!project) return; setBusy(true)
    try { const folders = await api.projects.validateFolders({ projectId: project.id }); onProjectUpdated(applyValidatedFolders(project, folders)) }
    catch (error) { onError(error instanceof Error ? error.message : '폴더 상태를 확인하지 못했습니다.') }
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
        onboardingAnswers: { ...metaAnswers, evaluationTarget: metaDescription.trim(), importantMetadata: serializeOnboardingItems(metaAnswerItems, metaCustom) },
        equipmentProfiles: equipmentAlias ? [{ alias: equipmentAlias, profileId: target.equipmentProfiles[0]?.profileId ?? 'default', updatedAt: stamp }] : target.equipmentProfiles,
        templatePins: templateRevision && Number.isInteger(Number(templateRevision)) ? [{ templateId: target.templatePins[0]?.templateId ?? 'default', revision: Number(templateRevision), pinnedAt: stamp }] : target.templatePins,
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

  const toggleItem = (item: ProjectInitItem, current: ProjectInitItem[], setter: (items: ProjectInitItem[]) => void) => setter(current.includes(item) ? current.filter((value) => value !== item) : [...current, item])
  const canAdvance = isProjectInitStepValid(step, draft)

  return <>
    <div className="project-switcher">
      <button className="project-switch-button" onClick={() => { setOpen((value) => !value); void refresh() }} aria-expanded={open}><span>{project?.name ?? '프로젝트 선택'}</span><ChevronDown size={14} /></button>
    </div>
    {open ? <div className="project-popover" role="dialog" aria-label="프로젝트 관리">
      <div className="project-popover-head"><strong>프로젝트</strong><button className="modal-close" onClick={() => setOpen(false)} aria-label="닫기"><X size={16} /></button></div>
      <div className="project-list">{projects.map((item) => <button className={`project-list-item ${item.id === project?.id ? 'active' : ''}`} key={item.id} onClick={() => void load(item.id)} disabled={busy} title={`${item.name}\n${projectListSecondary(item)}`}><strong>{item.name}</strong><small>{projectListSecondary(item)}</small></button>)}{!projects.length ? <p className="project-empty">아직 프로젝트가 없습니다.</p> : null}</div>
      {showNew ? <div className="project-form">
        <div className="project-step-head"><span>새 프로젝트 · {step}/3</span><button onClick={() => { setShowNew(false); setStep(1); setDraft(blankDraft()) }}>취소</button></div>
        {step === 1 ? <><input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="프로젝트 이름" aria-label="프로젝트 이름" /><textarea value={draft.purpose} onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} placeholder="짧은 목적 (선택)" aria-label="프로젝트 목적" rows={2} /></> : null}
        {step === 2 ? <><div className="project-question">무엇을 추출·결정할까요?</div><div className="project-chips">{PROJECT_INIT_ITEMS.map((item) => <button type="button" className={draft.items.includes(item) ? 'selected' : ''} key={item} onClick={() => toggleItem(item, draft.items, (items) => setDraft({ ...draft, items }))}>{item}</button>)}</div><input value={draft.custom} onChange={(event) => setDraft({ ...draft, custom: event.target.value })} placeholder="직접 입력 (선택)" aria-label="추출 또는 결정할 항목 직접 입력" /></> : null}
        {step === 3 ? <><div className="project-question">설정 시작점</div><div className="project-choice-row"><button className={!draft.reuseProjectId ? 'selected' : ''} onClick={() => setDraft({ ...draft, reuseProjectId: '' })}>빈 프로젝트</button><select value={draft.reuseProjectId} onChange={(event) => setDraft({ ...draft, reuseProjectId: event.target.value })} aria-label="재사용할 기존 프로젝트"><option value="">기존 설정 재사용…</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name} — {projectListSecondary(item)}</option>)}</select></div></> : null}
        <div className="project-step-actions">{step > 1 ? <button onClick={() => setStep((step - 1) as ProjectInitStep)}>이전</button> : <span />}{step < 3 ? <button className="project-primary-action" onClick={() => canAdvance && setStep((step + 1) as ProjectInitStep)} disabled={!canAdvance}>다음</button> : <button className="project-primary-action" onClick={() => void create()} disabled={busy || !canAdvance}>{busy ? <LoaderCircle className="wb-spin" size={14} /> : <Plus size={14} />}프로젝트 만들기</button>}</div>
      </div> : <div className="project-create-actions"><button className="project-add-action" onClick={() => { setShowNew(true); setStep(1) }}><Plus size={15} />새 프로젝트</button>{project ? <button className="project-folder-action" onClick={() => void attach()} disabled={busy}><FolderPlus size={14} />폴더 추가</button> : null}{!projects.length ? <button className="project-sample-action" onClick={() => void createSample()} disabled={busy} aria-label="LPDDR6 샘플 열기" title="LPDDR6 샘플 열기">{busy ? <LoaderCircle className="wb-spin" size={14} /> : <Beaker size={14} />}</button> : null}</div>}
      {project && !showNew ? <div className="project-settings-block">
        <details className="project-folders"><summary>폴더 <span>{project.folders.length}</span></summary><div className="project-folder-content">
          {project.folders.length ? project.folders.map((folder) => <div className="folder-status-line" key={folder.rootId}><span>{folder.displayLabel}<small>{folder.status === 'available' ? '연결됨' : folder.status === 'permission-denied' ? '권한 없음' : '없음'}</small></span><button onClick={() => void detach(folder.rootId)} disabled={busy} aria-label={`${folder.displayLabel} 해제`}><Unplug size={13} /></button></div>) : <p className="project-empty">연결된 폴더가 없습니다.</p>}
          <button className="project-validate-action" onClick={() => void validate()} disabled={busy}><RefreshCw size={13} />상태 확인</button>
          {project.folders.filter((folder) => folder.status !== 'available').map((folder) => <div className="folder-warning" key={folder.rootId}>{folder.displayLabel}: {folder.status === 'permission-denied' ? '권한 없음' : '폴더 없음'}</div>)}
        </div></details>
        <details><summary>설정</summary><div className="project-advanced-content">
          <input className="project-meta-input" value={metaName} onChange={(event) => setMetaName(event.target.value)} aria-label="현재 프로젝트 이름" /><textarea className="project-meta-input" value={metaDescription} onChange={(event) => setMetaDescription(event.target.value)} placeholder="짧은 목적" aria-label="현재 프로젝트 설명" rows={2} />
          <div className="project-section-label">분석 항목</div><div className="project-chips">{PROJECT_INIT_ITEMS.map((item) => <button type="button" className={metaAnswerItems.includes(item) ? 'selected' : ''} key={item} onClick={() => toggleItem(item, metaAnswerItems, setMetaAnswerItems)}>{item}</button>)}</div><input className="project-meta-input" value={metaCustom} onChange={(event) => setMetaCustom(event.target.value)} placeholder="직접 입력" aria-label="현재 프로젝트 항목 직접 입력" />
          <div className="project-section-label">장비</div><input className="project-meta-input" value={equipmentAlias} onChange={(event) => setEquipmentAlias(event.target.value)} placeholder="장비 별칭" aria-label="장비 별칭" /><input className="project-meta-input" value={templateRevision} onChange={(event) => setTemplateRevision(event.target.value)} placeholder="템플릿 버전" aria-label="템플릿 버전" inputMode="numeric" /><button className="project-primary-action" onClick={() => void saveMeta()} disabled={busy}>저장</button>
        </div></details>
      </div> : null}
    </div> : null}
  </>
}
