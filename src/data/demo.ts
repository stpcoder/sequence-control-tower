export type AppPage = 'workbench' | 'tower' | 'inbox' | 'review' | 'console' | 'knowledge' | 'settings'

export type RunStatus = 'pass' | 'fail' | 'review' | 'running' | 'ready' | 'offline'

export interface PipelineRevision {
  id: string
  label: string
  message: string
  status: RunStatus
  author: string
  time: string
  branch: 'main' | 'pattern'
  parent?: string
  verified: boolean
}

export interface IntakeItem {
  id: string
  file: string
  project: string
  family: string
  confidence: number
  status: 'ready' | 'question' | 'processing'
  note: string
  changes: string[]
  question?: string
}

export const revisions: PipelineRevision[] = [
  {
    id: 'SEQ-1042',
    label: 'Baseline',
    message: '25℃ · 0.99V Full Sweep 기준 평가',
    status: 'pass',
    author: '김도현',
    time: '07.19',
    branch: 'main',
    verified: true,
  },
  {
    id: 'SEQ-1048',
    label: 'High temperature',
    message: '105℃ 조건 적용 및 온도 의존성 확인',
    status: 'pass',
    author: '김도현',
    time: '07.22',
    branch: 'main',
    parent: 'SEQ-1042',
    verified: true,
  },
  {
    id: 'SEQ-1051',
    label: 'Low voltage',
    message: 'VDD 0.91V로 변경, 10660에서 최초 Fail',
    status: 'fail',
    author: '박서연',
    time: '07.24',
    branch: 'main',
    parent: 'SEQ-1048',
    verified: true,
  },
  {
    id: 'SEQ-1054',
    label: 'CLK boundary',
    message: '고주파 경계 조건 9600/10000/10660 세분화',
    status: 'fail',
    author: 'Agent draft',
    time: '07.27',
    branch: 'main',
    parent: 'SEQ-1051',
    verified: false,
  },
  {
    id: 'SEQ-1056',
    label: 'Pattern split',
    message: '1190과 6060 Pattern 의존성 분리',
    status: 'review',
    author: 'Agent draft',
    time: '07.28',
    branch: 'pattern',
    parent: 'SEQ-1051',
    verified: false,
  },
  {
    id: 'SEQ-1059',
    label: 'Reproduction',
    message: 'Pattern 6060 · CLK 10660 재현성 3회 확인',
    status: 'running',
    author: '이민재',
    time: '오늘',
    branch: 'main',
    parent: 'SEQ-1054',
    verified: true,
  },
]

export const intakeItems: IntakeItem[] = [
  {
    id: 'IN-0241',
    file: 'SM8750_LP5_105C_CLK_SPLIT_04.seq',
    project: 'Qualcomm · Product A',
    family: 'High-temp / CLK margin',
    confidence: 94,
    status: 'question',
    note: '고온 fail 때문에 clk 나눠본 버전',
    changes: ['Full Sweep → Fixed CLK 9600 / 10000 / 10660', 'Full Pattern → 1190 / 6060', '온도·VDD·ECC 유지'],
    question: '이 변경의 주목적은 CLK 경계 확인인가요, Pattern 의존성 확인인가요?',
  },
  {
    id: 'IN-0242',
    file: 'SM8750_LP5_ECC_OFF_RECHECK.seq',
    project: 'Qualcomm · Product A',
    family: 'ECC comparison',
    confidence: 87,
    status: 'ready',
    note: 'ecc off 재확인',
    changes: ['ECC EN → EF', '나머지 23개 조건 동일'],
  },
  {
    id: 'IN-0243',
    file: '250728_final_final2.seq',
    project: '분류 필요',
    family: 'Unknown',
    confidence: 41,
    status: 'question',
    note: '',
    changes: ['기존 Family에서 찾지 못한 command 6개', '유사 부모 후보 2개'],
    question: '이 Sequence가 사용된 고객사 프로젝트를 알려주세요.',
  },
  {
    id: 'IN-0244',
    file: 'SM8750_ROOM_BASELINE_12.seq',
    project: 'Qualcomm · Product A',
    family: 'Room-temp baseline',
    confidence: 98,
    status: 'processing',
    note: 'baseline update',
    changes: ['파싱 및 fingerprint 생성 중'],
  },
]

export const slots = [
  {
    id: 'SLOT 01',
    sample: 'A3 · W12-07',
    status: 'running' as RunStatus,
    phase: 'Diagnostic',
    progress: 68,
    detail: '105℃ · 0.91V · CLK 10660',
    eta: '42분 남음',
    signal: '정상 범위',
  },
  {
    id: 'SLOT 02',
    sample: 'A3 · W12-08',
    status: 'ready' as RunStatus,
    phase: 'Preflight complete',
    progress: 0,
    detail: '105℃ · 0.99V · Full Sweep',
    eta: '시작 대기',
    signal: '12/12 확인',
  },
  {
    id: 'SLOT 03',
    sample: 'A3 · W12-09',
    status: 'fail' as RunStatus,
    phase: 'Stopped safely',
    progress: 41,
    detail: 'ADB identity mismatch',
    eta: '확인 필요',
    signal: '실행 차단',
  },
  {
    id: 'SLOT 04',
    sample: '비어 있음',
    status: 'offline' as RunStatus,
    phase: 'No material',
    progress: 0,
    detail: 'COM18 · Agent online',
    eta: '—',
    signal: '장비 정상',
  },
]

export const semanticDiff = [
  { kind: 'context', before: 'temperature: 105', after: 'temperature: 105', note: '유지' },
  { kind: 'context', before: 'vdd: 0.91', after: 'vdd: 0.91', note: '유지' },
  { kind: 'change', before: '/data/clk.sh -lf 0 1 2 3 4;', after: '/data/clk.sh -f 9600 10000 10660;', note: 'Sweep를 고주파 경계 3개로 좁힘' },
  { kind: 'change', before: '/data/hdiag64 -r 1;', after: '/data/hdiag64 -r 1 -p 1190 6060;', note: 'Pattern 의존성을 분리해서 관찰' },
  { kind: 'add', before: '', after: 'repeat 3;', note: '재현성 판단을 위해 3회 반복 추가' },
]

export const logEvidence = [
  { time: '14:02:11.028', tone: 'neutral', text: 'hdiag start pattern=6060 clk=10660' },
  { time: '14:02:12.411', tone: 'good', text: 'training completed · duration=1.38s' },
  { time: '14:03:01.889', tone: 'removed', text: 'hdiag completed PASS' },
  { time: '14:03:02.004', tone: 'bad', text: 'ECC mismatch detected at channel 2' },
  { time: '14:03:02.105', tone: 'bad', text: 'hdiag completed FAIL · code=0x31' },
  { time: '14:03:02.780', tone: 'neutral', text: 'serial prompt recovered normally' },
]

export const knowledgeCases = [
  {
    id: 'CASE-042',
    title: '105℃ · Pattern 6060 단독 Fail',
    scope: 'SM8750 / LPDDR5 / hdiag 2.4.x',
    evidence: 7,
    confidence: 93,
    status: '승인됨',
    summary: '온도와 VDD readback은 정상이나 10660에서 ECC mismatch가 반복됨.',
  },
  {
    id: 'CASE-081',
    title: '고주파 전환 후 completion 누락',
    scope: 'SM8750 / clk.sh 1.8',
    evidence: 4,
    confidence: 78,
    status: '검토 필요',
    summary: 'Clock script 완료 직후 prompt 복귀가 늦어 timeout으로 오판될 가능성.',
  },
  {
    id: 'CASE-093',
    title: 'ADB serial 재할당으로 인한 대상 불일치',
    scope: '4-slot equipment / Windows',
    evidence: 12,
    confidence: 99,
    status: '승인됨',
    summary: 'COM 이름만으로 슬롯을 매핑했을 때 다른 보드에 payload가 전달됨.',
  },
]
