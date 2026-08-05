import { useEffect, useState } from 'react'
import { ChevronDown, FolderPlus, LoaderCircle, Plus, RefreshCw, Unplug, X } from 'lucide-react'
import type { ProjectLoadResult, ProjectSnapshot } from '../../electron/shared/contracts'

interface ProjectControlProps {
  project: ProjectSnapshot | null
  onLoaded: (result: ProjectLoadResult) => void
  onProjectUpdated: (project: ProjectSnapshot) => void
  onError: (message: string) => void
}

export function ProjectControl({ project, onLoaded, onProjectUpdated, onError }: ProjectControlProps) {
  const api = window.sequenceIntelligence
  const [projects, setProjects] = useState<ProjectSnapshot[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [answers, setAnswers] = useState({ evaluationTarget: '', importantMetadata: '', reuseRules: '' })
  const [metaName, setMetaName] = useState('')
  const [metaDescription, setMetaDescription] = useState('')
  const [equipmentAlias, setEquipmentAlias] = useState('')
  const [templateRevision, setTemplateRevision] = useState('')
  const [presetName, setPresetName] = useState('')

  useEffect(() => {
    setMetaName(project?.name ?? '')
    setMetaDescription(project?.description ?? '')
    setEquipmentAlias(project?.equipmentProfiles[0]?.alias ?? '')
    setTemplateRevision(project?.templatePins[0]?.revision.toString() ?? '')
    setPresetName(project?.exportPresets.find((preset) => !preset.archived)?.name ?? '')
  }, [project])

  const refresh = async () => {
    if (!api?.projects) return
    try {
      const items = await api.projects.list()
      setProjects(items)
      if (!project && items[0]) await load(items[0].id)
    } catch (error) { onError(error instanceof Error ? error.message : '프로젝트 목록을 불러오지 못했습니다.') }
  }
  useEffect(() => { void refresh() }, [])

  const load = async (projectId: string) => {
    setBusy(true)
    try {
      const result = await api.projects.load({ projectId })
      if (result) { onLoaded(result); setOpen(false) }
    } catch (error) { onError(error instanceof Error ? error.message : '프로젝트를 불러오지 못했습니다.') }
    finally { setBusy(false) }
  }

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const created = await api.projects.create({ name, description: description || undefined, onboardingAnswers: answers })
      const result = await api.projects.load({ projectId: created.id })
      if (result) onLoaded(result)
      setShowNew(false); setOpen(false); setName(''); setDescription(''); setAnswers({ evaluationTarget: '', importantMetadata: '', reuseRules: '' })
    } catch (error) { onError(error instanceof Error ? error.message : '프로젝트를 만들지 못했습니다.') }
    finally { setBusy(false) }
  }

  const attach = async () => {
    if (!project) return
    setBusy(true)
    try {
      const result = await api.projects.attachFolder({ projectId: project.id, expectedRevision: project.revision })
      if (!('cancelled' in result)) onLoaded(result)
    } catch (error) { onError(error instanceof Error ? error.message : '폴더를 연결하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const validate = async () => {
    if (!project) return
    setBusy(true)
    try { const folders = await api.projects.validateFolders({ projectId: project.id }); onLoaded({ project: { ...project, folders }, artifacts: [], failures: [], skippedCount: 0 }) }
    catch (error) { onError(error instanceof Error ? error.message : '폴더 상태를 확인하지 못했습니다.') }
    finally { setBusy(false) }
  }
  const detach = async (rootId: string) => {
    if (!project) return
    setBusy(true)
    try { onLoaded({ project: await api.projects.detachFolder({ projectId: project.id, expectedRevision: project.revision, rootId }), artifacts: [], failures: [], skippedCount: 0 }) }
    catch (error) { onError(error instanceof Error ? error.message : '폴더 연결을 해제하지 못했습니다.') }
    finally { setBusy(false) }
  }
  const saveMeta = async () => {
    if (!project || !metaName.trim()) return
    setBusy(true)
    try {
      const stamp = new Date().toISOString()
      let next = await api.projects.save({
        projectId: project.id, expectedRevision: project.revision, name: metaName, description: metaDescription || undefined,
        equipmentProfiles: equipmentAlias ? [{ alias: equipmentAlias, profileId: project.equipmentProfiles[0]?.profileId ?? 'default', updatedAt: stamp }] : project.equipmentProfiles,
        templatePins: templateRevision && Number.isInteger(Number(templateRevision)) ? [{ templateId: project.templatePins[0]?.templateId ?? 'default', revision: Number(templateRevision), pinnedAt: stamp }] : project.templatePins,
      })
      if (presetName) next = await api.projects.saveExportPreset({ projectId: next.id, expectedRevision: next.revision, preset: { id: next.exportPresets[0]?.id, name: presetName, format: next.exportPresets[0]?.format ?? 'csv', options: next.exportPresets[0]?.options ?? {} } })
      onProjectUpdated(next)
    } catch (error) { onError(error instanceof Error ? error.message : '프로젝트 설정을 저장하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const updateAnswer = (key: keyof typeof answers, value: string) => setAnswers((current) => ({ ...current, [key]: value }))
  return <>
    <div className="project-switcher">
      <span className="eyebrow">CURRENT PROJECT</span>
      <button className="project-switch-button" onClick={() => { setOpen((value) => !value); void refresh() }} aria-expanded={open}>
        <span>{project?.name ?? '프로젝트 선택'}</span><ChevronDown size={14} />
      </button>
    </div>
    {open ? <div className="project-popover" role="dialog" aria-label="프로젝트 관리">
      <div className="project-popover-head"><strong>프로젝트</strong><button className="modal-close" onClick={() => setOpen(false)} aria-label="닫기"><X size={16} /></button></div>
      <div className="project-list">{projects.map((item) => <button className={`project-list-item ${item.id === project?.id ? 'active' : ''}`} key={item.id} onClick={() => void load(item.id)} disabled={busy}><span>{item.name}</span><small>{item.folders.length} folders</small></button>)}{!projects.length ? <p className="project-empty">아직 프로젝트가 없습니다.</p> : null}</div>
      {showNew ? <div className="project-form">
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="프로젝트 이름" aria-label="프로젝트 이름" />
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="짧은 설명 (선택)" aria-label="프로젝트 설명" rows={2} />
        <p className="form-hint">첫 분석 전에 세 가지를 메모해 두세요. LLM 호출은 하지 않습니다.</p>
        <input value={answers.evaluationTarget} onChange={(event) => updateAnswer('evaluationTarget', event.target.value)} placeholder="무엇을 평가하나요?" aria-label="평가 대상" />
        <input value={answers.importantMetadata} onChange={(event) => updateAnswer('importantMetadata', event.target.value)} placeholder="중요한 metadata는?" aria-label="중요한 metadata" />
        <input value={answers.reuseRules} onChange={(event) => updateAnswer('reuseRules', event.target.value)} placeholder="기존 규칙을 재사용하나요?" aria-label="기존 규칙 재사용" />
        <button className="project-primary-action" onClick={() => void create()} disabled={busy || !name.trim()}>{busy ? <LoaderCircle className="wb-spin" size={14} /> : <Plus size={14} />}프로젝트 만들기</button>
      </div> : <button className="project-add-action" onClick={() => setShowNew(true)}><Plus size={15} />새 프로젝트</button>}
      {project ? <div className="project-settings-block">
        <div className="project-section-label">프로젝트 정보</div>
        <input className="project-meta-input" value={metaName} onChange={(event) => setMetaName(event.target.value)} aria-label="현재 프로젝트 이름" />
        <textarea className="project-meta-input" value={metaDescription} onChange={(event) => setMetaDescription(event.target.value)} placeholder="설명" aria-label="현재 프로젝트 설명" rows={2} />
        <div className="project-section-label">연결 폴더</div>
        {project.folders.length ? project.folders.map((folder) => <div className="folder-status-line" key={folder.rootId}><span>{folder.displayLabel} · {folder.status === 'available' ? '연결됨' : folder.status === 'permission-denied' ? '권한 없음' : '없음'}</span><button onClick={() => void detach(folder.rootId)} disabled={busy} aria-label={`${folder.displayLabel} 해제`}><Unplug size={13} /></button></div>) : <pre className="folder-status-list">연결된 폴더 없음</pre>}
        <div className="project-row-actions"><button onClick={() => void attach()} disabled={busy}><FolderPlus size={14} />폴더 추가</button><button onClick={() => void validate()} disabled={busy}><RefreshCw size={14} />재검증</button></div>
        {project.folders.filter((folder) => folder.status !== 'available').map((folder) => <div className="folder-warning" key={folder.rootId}>{folder.displayLabel}: {folder.status === 'permission-denied' ? '권한이 없어 건너뜀' : '폴더가 없어 건너뜀'}</div>)}
        <div className="project-section-label">장비 · 템플릿 · Export preset</div>
        <input className="project-meta-input" value={equipmentAlias} onChange={(event) => setEquipmentAlias(event.target.value)} placeholder="장비 별칭" aria-label="장비 별칭" />
        <input className="project-meta-input" value={templateRevision} onChange={(event) => setTemplateRevision(event.target.value)} placeholder="template revision pin" aria-label="template revision pin" inputMode="numeric" />
        <input className="project-meta-input" value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Export preset 이름" aria-label="Export preset 이름" />
        <button className="project-primary-action" onClick={() => void saveMeta()} disabled={busy}>프로젝트 설정 저장</button>
        <p className="project-muted">{project.equipmentProfiles.length} 장비 · {project.templatePins.length} pin · {project.exportPresets.filter((preset) => !preset.archived).length} preset</p>
      </div> : null}
    </div> : null}
  </>
}
