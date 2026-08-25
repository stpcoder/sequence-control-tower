import { inferCommandFamily } from './dna'

export type ConsoleLineRole = 'input' | 'output' | 'status' | 'ambiguous'
export type ConsolePromptKind = 'uefi' | 'os-root' | 'os-user' | 'bootloader' | 'transport' | 'bare-root' | 'bare-user'
export type ConsoleStatusKind = 'at-pass' | 'at-fail' | 'stress-pass' | 'diag-start' | 'training-fail' | 'reboot' | 'halt' | 'fast-fail' | 'normal-end'

export interface ConsolePromptDecision {
  promptSignature: string
  role: 'input' | 'output'
}

export interface ConsoleInputLine {
  lineNumber: number
  promptKind: ConsolePromptKind
  promptSignature: string
  prompt: string
  command: string
  commandSignature: string
  confidence: number
}

export interface ConsoleAmbiguousLine extends Omit<ConsoleInputLine, 'commandSignature'> {
  commandSignature?: string
}

export interface ConsoleStatusSignal {
  lineNumber: number
  kind: ConsoleStatusKind
  text: string
}

export interface ConsoleTranscriptAnalysis {
  lineCount: number
  inputCount: number
  outputCount: number
  ambiguousCount: number
  inputs: ConsoleInputLine[]
  ambiguous: ConsoleAmbiguousLine[]
  statusSignals: ConsoleStatusSignal[]
  statusCounts: Partial<Record<ConsoleStatusKind, number>>
  promptKinds: ConsolePromptKind[]
}

interface PromptMatch {
  promptKind: ConsolePromptKind
  promptSignature: string
  prompt: string
  command: string
  confidence: number
  ambiguous?: boolean
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const MAX_COMMAND_CHARS = 500
const MAX_EXAMPLES = 200
const timestampPrefix = /^(?:(?:\[[0-9T:./ _+-]{4,40}\]|\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+|\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*)+/
const loggerPrefix = /^(?:\[(?:TRACE|DEBUG|INFO|WARN|ERROR)\]|(?:TRACE|DEBUG|INFO|WARN|ERROR)\s*[:|>-])\s*/i

function cleanLine(value: string): string {
  return value.replace(ANSI, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 4_000)
}

function withoutCapturePrefix(value: string): string {
  let line = cleanLine(value).trimStart()
  for (let index = 0; index < 2; index += 1) {
    const next = line.replace(timestampPrefix, '').replace(loggerPrefix, '')
    if (next === line) break
    line = next.trimStart()
  }
  return line
}

function validCommand(value: string): string | null {
  const command = value.trim().replace(/\s+/g, ' ').slice(0, MAX_COMMAND_CHARS)
  if (!command || /^[@!]?(?:PASS|FAIL)\b/i.test(command)) return null
  if (/^(?:INFO|DEBUG|WARN|ERROR|TRACE)\b/i.test(command)) return null
  if (/^(?:SYNTHETIC(?:_[A-Z0-9]+)+|META(?:DATA)?\b|CORPUS\b|FIXTURE\b)/i.test(command)) return null
  return command
}

function promptMatch(raw: string): PromptMatch | null {
  const line = withoutCapturePrefix(raw)
  const patterns: Array<{ expression: RegExp; kind: ConsolePromptKind; signature: string; confidence: number; promptGroup: number; commandGroup: number; ambiguous?: boolean }> = [
    { expression: /^((?:UEFI|EDK2|Shell|FS\d+:\\?)\s*(?:>|\]))[ \t]*(.+)$/i, kind: 'uefi', signature: 'uefi-firmware-prompt', confidence: 0.99, promptGroup: 1, commandGroup: 2 },
    { expression: /^((?:LK2?|PBL|XBL|ABL|BOOTLOADER)\s*>)[ \t]*(.+)$/i, kind: 'bootloader', signature: 'bootloader-angle', confidence: 0.98, promptGroup: 1, commandGroup: 2 },
    { expression: /^((?:root|shell)@[A-Za-z0-9._-]+(?::[^#$\s]*)?\s*#)[ \t]+(.+)$/i, kind: 'os-root', signature: 'os-root-host', confidence: 0.99, promptGroup: 1, commandGroup: 2 },
    { expression: /^([A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?::[^$\s]*)?\s*\$)[ \t]+(.+)$/i, kind: 'os-user', signature: 'os-user-host', confidence: 0.99, promptGroup: 1, commandGroup: 2 },
    { expression: /^([A-Za-z0-9._-]+:\/[^#\s]*\s*#)[ \t]+(.+)$/i, kind: 'os-root', signature: 'android-root', confidence: 0.98, promptGroup: 1, commandGroup: 2 },
    { expression: /^((?:console|uart|serial)\s*:\s*#)[ \t]*(.+)$/i, kind: 'os-root', signature: 'console-root', confidence: 0.99, promptGroup: 1, commandGroup: 2 },
    { expression: /^((?:TX|SEND|CMD|INPUT)\s*(?:>|:))[ \t]*(.+)$/i, kind: 'transport', signature: 'transport-command', confidence: 0.95, promptGroup: 1, commandGroup: 2 },
    { expression: /^(=>)[ \t]+(.+)$/, kind: 'bootloader', signature: 'bootloader-arrow', confidence: 0.96, promptGroup: 1, commandGroup: 2 },
    { expression: /^(#)[ \t]+(.+)$/, kind: 'bare-root', signature: 'bare-root-hash', confidence: 0.62, promptGroup: 1, commandGroup: 2, ambiguous: true },
    { expression: /^(\$)[ \t]+(.+)$/, kind: 'bare-user', signature: 'bare-user-dollar', confidence: 0.7, promptGroup: 1, commandGroup: 2, ambiguous: true },
  ]
  for (const pattern of patterns) {
    const match = pattern.expression.exec(line)
    if (!match) continue
    const command = validCommand(match[pattern.commandGroup])
    if (!command) return null
    return {
      promptKind: pattern.kind,
      promptSignature: pattern.signature,
      prompt: match[pattern.promptGroup].trim(),
      command,
      confidence: pattern.confidence,
      ambiguous: pattern.ambiguous,
    }
  }
  return null
}

const STATUS_PATTERNS: Array<{ kind: ConsoleStatusKind; expression: RegExp }> = [
  { kind: 'at-pass', expression: /(?:^|\s)@PASS(?:\s|$)/i },
  { kind: 'at-fail', expression: /(?:^|\s)@FAIL(?:\s|$)/i },
  { kind: 'training-fail', expression: /\b(?:TRAINING|TRAIN)[ _:-]*FAIL(?:ED|URE)?\b/i },
  { kind: 'reboot', expression: /\b(?:SYSTEM[ _-]*REBOOT|WATCHDOG|REBOOT_REASON)\b/i },
  { kind: 'halt', expression: /\b(?:SYSTEM[ _-]*HALT|CPU[ _-]*HALT|FATAL EXCEPTION|KERNEL PANIC)\b/i },
  { kind: 'fast-fail', expression: /\b(?:FAST[ _-]*FAIL|FAIL[ _-]*FAST|EARLY[ _-]*EXIT)\b/i },
  { kind: 'stress-pass', expression: /\bstressapp(?:test)?\b.{0,100}\bPASS\b/i },
  { kind: 'diag-start', expression: /\b(?:HIDAG|HI_DIAG|DIAG(?:NOSTIC)?)\b.{0,100}\b(?:START|BEGIN|RUN)\b/i },
  { kind: 'normal-end', expression: /\b(?:TEST|SEQUENCE|RUN)[ _:-]*(?:COMPLETE|END|DONE)\b/i },
]

export function consolePromptSearchPattern(): string {
  return '(?:UEFI|EDK2|Shell|FS\\d+:\\\\?|LK2?|PBL|XBL|ABL|BOOTLOADER)\\s*(?:>|\\])|[A-Za-z0-9._-]+:/[^#\\n]{0,80}#|(?:console|uart|serial)\\s*:\\s*#|(?:root|shell)@[A-Za-z0-9._-]+[^#\\n]{0,80}#|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+[^$\\n]{0,80}\\$|(?:TX|SEND|CMD|INPUT)\\s*(?:>|:)|^\\s*(?:#|\\$|=>)\\s+'
}

export function classifyConsoleLine(raw: string, decisions: readonly ConsolePromptDecision[] = []): { role: ConsoleLineRole; prompt?: PromptMatch; statuses: ConsoleStatusKind[] } {
  const statuses = STATUS_PATTERNS.filter((pattern) => pattern.expression.test(raw)).map((pattern) => pattern.kind)
  const prompt = promptMatch(raw)
  if (!prompt) return { role: statuses.length ? 'status' : 'output', statuses }
  const decision = decisions.find((item) => item.promptSignature === prompt.promptSignature)
  if (decision?.role === 'output') return { role: statuses.length ? 'status' : 'output', prompt, statuses }
  if (decision?.role === 'input') return { role: 'input', prompt: { ...prompt, confidence: 1, ambiguous: false }, statuses }
  if (prompt.ambiguous) return { role: 'ambiguous', prompt, statuses }
  return { role: 'input', prompt, statuses }
}

export function analyzeConsoleTranscript(text: string, decisions: readonly ConsolePromptDecision[] = []): ConsoleTranscriptAnalysis {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const inputs: ConsoleInputLine[] = []
  const ambiguous: ConsoleAmbiguousLine[] = []
  const statusSignals: ConsoleStatusSignal[] = []
  const statusCounts: Partial<Record<ConsoleStatusKind, number>> = {}
  const promptKinds = new Set<ConsolePromptKind>()
  let inputCount = 0
  let outputCount = 0
  let ambiguousCount = 0

  lines.forEach((raw, index) => {
    const classified = classifyConsoleLine(raw, decisions)
    classified.statuses.forEach((kind) => {
      statusCounts[kind] = (statusCounts[kind] ?? 0) + 1
      if (statusSignals.length < MAX_EXAMPLES) statusSignals.push({ lineNumber: index + 1, kind, text: cleanLine(raw).trim().slice(0, 500) })
    })
    if (classified.role === 'input' && classified.prompt) {
      inputCount += 1
      promptKinds.add(classified.prompt.promptKind)
      if (inputs.length < MAX_EXAMPLES) {
        const family = inferCommandFamily(classified.prompt.command)
        inputs.push({
          lineNumber: index + 1,
          promptKind: classified.prompt.promptKind,
          promptSignature: classified.prompt.promptSignature,
          prompt: classified.prompt.prompt,
          command: classified.prompt.command,
          commandSignature: `${family.family}:${family.executable}`,
          confidence: classified.prompt.confidence,
        })
      }
    } else if (classified.role === 'ambiguous' && classified.prompt) {
      ambiguousCount += 1
      promptKinds.add(classified.prompt.promptKind)
      if (ambiguous.length < MAX_EXAMPLES) {
        const family = inferCommandFamily(classified.prompt.command)
        ambiguous.push({ ...classified.prompt, lineNumber: index + 1, commandSignature: `${family.family}:${family.executable}` })
      }
    } else {
      outputCount += 1
    }
  })

  return {
    lineCount: lines.length,
    inputCount,
    outputCount,
    ambiguousCount,
    inputs,
    ambiguous,
    statusSignals,
    statusCounts,
    promptKinds: [...promptKinds],
  }
}

export function looksLikeConsoleTranscript(fileName: string, text: string): boolean {
  if (/\.(?:log|txt|out|console)$/i.test(fileName)) return true
  const sample = text.slice(0, 128_000)
  const strongPrompts = sample.match(/(?:UEFI|EDK2|Shell|LK2?|PBL|XBL|ABL)\s*(?:>|\])|[\w.-]+:\/[^#\n]{0,80}#|(?:console|uart|serial)\s*:\s*#|(?:root|shell)@[\w.-]+[^#\n]{0,80}#/gi)?.length ?? 0
  const statusMarkers = sample.match(/@(?:PASS|FAIL)|TRAIN(?:ING)?[_ :-]*FAIL|SYSTEM[_ -]*(?:HALT|REBOOT)/gi)?.length ?? 0
  return strongPrompts >= 2 || statusMarkers >= 2
}
