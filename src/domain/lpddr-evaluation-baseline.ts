export const LPDDR_STANDARD_SKEWS = ['TT', 'SS', 'SF', 'FS', 'FF'] as const
export const LPDDR_TEMPERATURE_CORNERS = ['HOT', 'ROOM', 'COLD'] as const
export const LPDDR_VDD_CORNERS = ['HVDD', 'NVDD', 'LVDD'] as const
export const LPDDR_FOUR_CORNERS = ['HH', 'CH', 'HL', 'CL'] as const

/**
 * Domain baseline shared by the built-in harness and the OpenCode harness.
 * It is deliberately short: project-specific thresholds and command meanings
 * still come from confirmed project memory rather than this static baseline.
 */
export const LPDDR_EVALUATION_AGENT_CONTEXT = `LPDDR 평가 기준:
- 한 프로젝트에는 같은 개발 목표 아래 여러 평가 폴더가 있고, 폴더 하나는 보통 하나의 평가 목적과 연결됩니다.
- 자재와 Sample은 같은 식별자이므로 Sample 하나로 정규화하고, SKEW(TT/SS/SF/FS/FF, 프로젝트별 예외 가능)별 Sample 수를 따로 계산합니다.
- Sequence는 실장기에 보낼 명령과 Grid별 온도, VDD, 주파수, Test Mode를 정합니다. Grid는 한 번 전원 인가해 부팅·Training·테스트 후 종료하는 평가 단위입니다. 로그 파일 1개가 Grid 1개라는 근거가 없으면 동일시하지 않습니다.
- 온도 조건은 Hot/Room/Cold, 전압 조건은 HVDD/NVDD/LVDD로 기록합니다. 4-Corner는 HH=Hot+HVDD, CH=Cold+HVDD, HL=Hot+LVDD, CL=Cold+LVDD이며 명시된 토큰이나 프로젝트 기준이 있을 때만 분류합니다.
- Qualcomm은 전원 인가·Training·UEFI·OS, MediaTek은 전원 인가·Training과 Post-PBL/LK/LK2·OS profile을 사용합니다. Training Fail은 OS 진입 전 실패로 분리합니다.
- 메모리 테스트는 Hdiag 시작, @PASS/@FAIL, Halt/Reboot를 구분합니다. FAIL 주소의 Channel/Sub Channel/CS/BK/RK/BG/Row/Col/WR/RD/DQ/BL 분포를 조건 경향과 별도로 계산합니다.
- 분석 순서는 동일 조건 RT 재현 → 불량 가속 조건 탐색 → Test Mode 등 개선 조건 비교 → 새로운 DQ/BL/Bank 등 Side effect와 전 Sample PASS 안정성 확인입니다.
- 현재 로그 표의 FAIL률은 FAIL 로그 수 / (PASS+FAIL이 확정된 로그 수)입니다. 미확인·진행 중 결과는 분모에서 제외하고 항상 분자와 분모를 함께 말합니다. Grid 경계가 확인된 분석에서는 로그 수와 Grid 수를 구별합니다.`

export type LpddrConditionDimensions = {
  gridId?: string
  temperatureC?: number
  temperatureCorner?: string
  vdd?: number
  vddCorner?: string
  conditionCorner?: string
  frequencyMHz?: number
  testMode?: string
}

export type LpddrFailureAddress = {
  channel?: string
  subChannel?: string
  chipSelect?: string
  bank?: string
  rank?: string
  bankGroup?: string
  row?: string
  column?: string
  writeData?: string
  readData?: string
  dq?: string
  bl?: string
}

const captured = (text: string, expression: RegExp): string | undefined => expression.exec(text)?.[1]?.trim()
const decimal = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value.replace(/[pP]/g, '.'))
  return Number.isFinite(parsed) ? parsed : undefined
}

export function explicitLpddrConditions(text: string): LpddrConditionDimensions {
  const upper = text.toUpperCase()
  const temperatureCorner = captured(upper, /(?:^|[^A-Z0-9])(?:TEMP(?:ERATURE)?[_ -]?CORNER[=:_ -]?)?(HOT|ROOM|COLD)(?=[^A-Z0-9]|$)/)
  const vddCorner = captured(upper, /(?:^|[^A-Z0-9])(HVDD|NVDD|LVDD)(?=[^A-Z0-9]|$)/)
  const explicitCorner = captured(upper, /(?:^|[^A-Z0-9])(?:4?CORNER[=:_ -]?)(HH|CH|HL|CL)(?=[^A-Z0-9]|$)/)
  const derivedCorner = temperatureCorner && vddCorner && temperatureCorner !== 'ROOM' && vddCorner !== 'NVDD'
    ? `${temperatureCorner === 'HOT' ? 'H' : 'C'}${vddCorner === 'HVDD' ? 'H' : 'L'}`
    : undefined
  const gridId = captured(text, /(?:^|[^A-Z0-9])GRID(?:[_ -]?(?:START|BEGIN))?[_ -]+(?:ID|NO)[=:_ -]+([A-Z0-9.-]+)/i)
    ?? captured(text, /(?:^|[^A-Z0-9])GRID\s*[#:=]\s*([A-Z0-9.-]+)/i)
  const temperatureC = decimal(captured(text, /(?:^|[^A-Z0-9])(?:TEMP(?:ERATURE)?|T)[=:_ ]+(-?\d{1,3})(?:\s*°?C)?(?=[^A-Z0-9]|$)/i))
  const vdd = decimal(captured(text, /(?:^|[^A-Z0-9])VDD[=:_ -]+(\d+(?:[p.]\d+)?)(?:\s*V)?(?=[^A-Z0-9]|$)/i))
  const frequencyMHz = decimal(captured(text, /(?:^|[^A-Z0-9])(?:FREQ(?:UENCY)?|DDRCLK|CLK)[=:_ -]+(\d{3,5})(?:\s*(?:MHZ|MT))?/i)
    ?? captured(text, /(?:^|[^A-Z0-9])SETDDRCLK\s+(\d{3,5})/i))
  const testMode = captured(text, /(?:^|[^A-Z0-9])(?:TM|TEST[_ -]?MODE|MODE)[=:_ -]+([A-Z0-9-]+)/i)?.toUpperCase()
  return {
    ...(gridId ? { gridId } : {}),
    ...(temperatureC !== undefined ? { temperatureC } : {}),
    ...(temperatureCorner ? { temperatureCorner } : {}),
    ...(vdd !== undefined ? { vdd } : {}),
    ...(vddCorner ? { vddCorner } : {}),
    ...((explicitCorner ?? derivedCorner) ? { conditionCorner: explicitCorner ?? derivedCorner } : {}),
    ...(frequencyMHz !== undefined ? { frequencyMHz } : {}),
    ...(testMode ? { testMode } : {}),
  }
}

const addressValue = '([A-Fa-f0-9xX]+(?:\\s*[,/|+-]\\s*[A-Fa-f0-9xX]+)*)'
const address = (line: string, aliases: string): string | undefined => captured(line, new RegExp(`(?:^|[^A-Z0-9])(?:${aliases})\\s*[=:]\\s*${addressValue}`, 'i'))?.replace(/\s+/g, '')

/** Extracts only explicit Hdiag/diagnostic fail-address fields. */
export function extractLpddrFailureAddress(line: string): LpddrFailureAddress | null {
  const value: LpddrFailureAddress = {
    channel: address(line, 'CH|CHANNEL'),
    subChannel: address(line, 'SUBCH|SUBCHANNEL|SUB[_ ]?CHANNEL'),
    chipSelect: address(line, 'CS|CHIP[_ ]?SELECT'),
    bank: address(line, 'BK|BANK'),
    rank: address(line, 'RK|RANK'),
    bankGroup: address(line, 'BG|BANK[_ ]?GROUP'),
    row: address(line, 'ROW'),
    column: address(line, 'COL|COLUMN'),
    writeData: address(line, 'WR|WRITE'),
    readData: address(line, 'RD|READ'),
    dq: address(line, 'DQ'),
    bl: address(line, 'BL'),
  }
  return Object.values(value).some(Boolean) ? value : null
}

export type LpddrGridLineEvent = {
  boundary: boolean
  boundaryKind?: 'grid' | 'power-on'
  conditions: LpddrConditionDimensions
  command?: string
  result?: 'PASS' | 'FAIL' | 'TRAINING_FAIL' | 'SYSTEM_HALT' | 'SYSTEM_REBOOT'
}

/** Parses only stable grid/condition/result markers; unknown commands remain unclassified. */
export function extractLpddrGridLineEvent(line: string): LpddrGridLineEvent | null {
  const conditions = explicitLpddrConditions(line)
  const gridBoundary = /(?:^|[^A-Z0-9])GRID(?:[_ -]?(?:START|BEGIN|ID|NO)|\s*[#:=]\s*[A-Z0-9])/i.test(line)
  const powerBoundary = /(?:^|[^A-Z0-9])(?:POWER[_ -]?ON|PWR[_ -]?ON)(?=[^A-Z0-9]|$)/i.test(line)
  const command = captured(line, /(?:^|[>#*$]\s*)(setddrclk\b[^\r\n]*|clk\.sh\b[^\r\n]*|dtvs\b[^\r\n]*|erase\s+ddr\b[^\r\n]*|reset\b[^\r\n]*|hdiag\b[^\r\n]*)/i)
  const result = /TRAINING[ _:-]*FAIL/i.test(line) ? 'TRAINING_FAIL'
    : /(?:WATCHDOG|SYSTEM[ _-]*REBOOT|REBOOT_REASON)/i.test(line) ? 'SYSTEM_REBOOT'
      : /(?:SYSTEM[ _-]*HALT|CPU[ _-]*HALT|KERNEL PANIC|FATAL EXCEPTION)/i.test(line) ? 'SYSTEM_HALT'
        : /@FAIL\b/i.test(line) ? 'FAIL'
          : /@PASS\b/i.test(line) ? 'PASS' : undefined
  if (!gridBoundary && !powerBoundary && !command && !result && !Object.values(conditions).some((item) => item !== undefined)) return null
  return {
    boundary: gridBoundary || powerBoundary,
    ...(gridBoundary ? { boundaryKind: 'grid' as const } : powerBoundary ? { boundaryKind: 'power-on' as const } : {}),
    conditions,
    ...(command ? { command } : {}),
    ...(result ? { result } : {}),
  }
}
