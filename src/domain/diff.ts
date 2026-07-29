import { normalizeCommand, normalizeDynamicTokens } from "./normalizer";
import type {
  BlockChange,
  CommandChange,
  DnaChange,
  SemanticDiff,
  SequenceAnalysis,
  SequenceBlock,
  SequenceCommand,
  SequenceDNA,
} from "./types";

function jaccard(left: Iterable<string>, right: Iterable<string>): number {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / (a.size + b.size - intersection);
}

function wordTokens(text: string): string[] {
  return text.toLocaleLowerCase("en-US").match(/[a-z_][\w.-]*|-?\d+(?:\.\d+)?/g) ?? [];
}

function blockSimilarity(left: SequenceBlock, right: SequenceBlock): number {
  const normalizedHeaderLeft = normalizeDynamicTokens(left.header, { lowercase: true }).text;
  const normalizedHeaderRight = normalizeDynamicTokens(right.header, { lowercase: true }).text;
  const headerScore = jaccard(wordTokens(normalizedHeaderLeft), wordTokens(normalizedHeaderRight));
  const commandScore = jaccard(left.commands.map(normalizeCommand), right.commands.map(normalizeCommand));
  if (left.synthetic && right.synthetic) return commandScore;
  return headerScore * 0.4 + commandScore * 0.6;
}

function alignCommands(before: SequenceCommand[], after: SequenceCommand[]): CommandChange[] {
  const a = before.map(normalizeCommand);
  const b = after.map(normalizeCommand);
  const matrix = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let left = a.length - 1; left >= 0; left -= 1) {
    for (let right = b.length - 1; right >= 0; right -= 1) {
      matrix[left][right] = a[left] === b[right]
        ? matrix[left + 1][right + 1] + 1
        : Math.max(matrix[left + 1][right], matrix[left][right + 1]);
    }
  }

  const anchors: Array<{ left: number; right: number }> = [];
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    if (a[left] === b[right]) {
      anchors.push({ left, right });
      left += 1;
      right += 1;
    } else if (matrix[left + 1][right] >= matrix[left][right + 1]) {
      left += 1;
    } else {
      right += 1;
    }
  }
  anchors.push({ left: a.length, right: b.length });

  const changes: CommandChange[] = [];
  let previousLeft = 0;
  let previousRight = 0;
  anchors.forEach((anchor, anchorIndex) => {
    const removed = before.slice(previousLeft, anchor.left);
    const added = after.slice(previousRight, anchor.right);
    const paired = Math.min(removed.length, added.length);
    for (let index = 0; index < paired; index += 1) {
      changes.push({
        kind: "changed",
        before: removed[index],
        after: added[index],
        normalizedBefore: normalizeCommand(removed[index]),
        normalizedAfter: normalizeCommand(added[index]),
      });
    }
    removed.slice(paired).forEach((command) =>
      changes.push({ kind: "removed", before: command, normalizedBefore: normalizeCommand(command) }),
    );
    added.slice(paired).forEach((command) =>
      changes.push({ kind: "added", after: command, normalizedAfter: normalizeCommand(command) }),
    );

    if (anchorIndex < anchors.length - 1) {
      changes.push({
        kind: "unchanged",
        before: before[anchor.left],
        after: after[anchor.right],
        normalizedBefore: a[anchor.left],
        normalizedAfter: b[anchor.right],
      });
      previousLeft = anchor.left + 1;
      previousRight = anchor.right + 1;
    }
  });
  return changes;
}

function alignBlocks(before: SequenceBlock[], after: SequenceBlock[]): BlockChange[] {
  const available = new Set(before.map((_, index) => index));
  const result: BlockChange[] = [];
  for (const target of after) {
    let bestIndex = -1;
    let bestScore = -1;
    for (const index of available) {
      const score = blockSimilarity(before[index], target);
      // A small locality preference breaks ties without masking semantic similarity.
      const locality = Math.max(0, 1 - Math.abs(index - target.index) / Math.max(1, before.length, after.length));
      const adjusted = score + locality * 0.025;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = index;
      }
    }
    const semanticScore = bestIndex >= 0 ? blockSimilarity(before[bestIndex], target) : 0;
    if (bestIndex < 0 || semanticScore < 0.28) {
      result.push({
        kind: "added",
        after: target,
        similarity: 0,
        commandChanges: target.commands.map((command) => ({
          kind: "added",
          after: command,
          normalizedAfter: normalizeCommand(command),
        })),
        important: true,
      });
      continue;
    }
    available.delete(bestIndex);
    const source = before[bestIndex];
    const commandChanges = alignCommands(source.commands, target.commands);
    const changed =
      normalizeDynamicTokens(source.header, { lowercase: true }).text !==
        normalizeDynamicTokens(target.header, { lowercase: true }).text ||
      commandChanges.some((change) => change.kind !== "unchanged");
    result.push({
      kind: changed ? "changed" : "unchanged",
      before: source,
      after: target,
      similarity: semanticScore,
      commandChanges,
      important: commandChanges.some(
        (change) =>
          change.kind !== "unchanged" &&
          /\b(?:temp|tf|vdd|vcc|ecc|clk|clock|pattern|hdiag|diag|flash)\b/i.test(
            `${change.before?.text ?? ""} ${change.after?.text ?? ""}`,
          ),
      ),
    });
  }
  for (const index of available) {
    const source = before[index];
    result.push({
      kind: "removed",
      before: source,
      similarity: 0,
      commandChanges: source.commands.map((command) => ({
        kind: "removed",
        before: command,
        normalizedBefore: normalizeCommand(command),
      })),
      important: true,
    });
  }
  return result;
}

const SIGNIFICANCE: Record<keyof SequenceDNA, DnaChange["significance"]> = {
  conditions: "medium",
  temperaturesC: "critical",
  voltages: "critical",
  ecc: "high",
  clocks: "high",
  patterns: "high",
  blockCount: "medium",
  commandCount: "low",
  commandFamilies: "medium",
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if (value && typeof value === "object") {
    return JSON.stringify(
      Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))),
    );
  }
  return JSON.stringify(value);
}

function describeDnaField(field: keyof SequenceDNA): string {
  return {
    conditions: "추가 조건",
    temperaturesC: "온도",
    voltages: "전압",
    ecc: "ECC",
    clocks: "CLK",
    patterns: "Pattern",
    blockCount: "Block 수",
    commandCount: "Command 수",
    commandFamilies: "Command 계열",
  }[field];
}

function diffDna(before: SequenceDNA, after: SequenceDNA): DnaChange[] {
  return (Object.keys(SIGNIFICANCE) as Array<keyof SequenceDNA>).map((field) => {
    const left = before[field].value;
    const right = after[field].value;
    let kind: DnaChange["kind"];
    if (canonical(left) === canonical(right)) kind = "unchanged";
    else if (left === null || (Array.isArray(left) && !left.length)) kind = "added";
    else if (right === null || (Array.isArray(right) && !right.length)) kind = "removed";
    else kind = "changed";
    const label = describeDnaField(field);
    return {
      field,
      kind,
      before: left,
      after: right,
      significance: kind === "unchanged" ? "none" : SIGNIFICANCE[field],
      explanation:
        kind === "unchanged"
          ? `${label} 조건은 유지되었습니다.`
          : kind === "added"
            ? `${label} 조건이 새로 명시되었습니다.`
            : kind === "removed"
              ? `${label} 조건이 제거되었거나 확인할 수 없습니다.`
              : `${label} 조건이 변경되었습니다.`,
    };
  });
}

function makeSummary(dnaChanges: DnaChange[], blockChanges: BlockChange[]): string {
  const meaningful = dnaChanges.filter((change) => change.significance === "critical" || change.significance === "high");
  const changedBlocks = blockChanges.filter((change) => change.kind === "changed").length;
  const addedBlocks = blockChanges.filter((change) => change.kind === "added").length;
  const removedBlocks = blockChanges.filter((change) => change.kind === "removed").length;
  const conditionSummary = meaningful.length
    ? meaningful.map((change) => `${describeDnaField(change.field)} ${change.kind}`).join(", ")
    : "핵심 평가 조건 유지";
  return `${conditionSummary}; Block 변경 ${changedBlocks}개, 추가 ${addedBlocks}개, 제거 ${removedBlocks}개.`;
}

export function semanticDiff(base: SequenceAnalysis, target: SequenceAnalysis): SemanticDiff {
  const dnaChanges = diffDna(base.dna, target.dna);
  const blockChanges = alignBlocks(base.parsed.blocks, target.parsed.blocks);
  const commandChanges = blockChanges.flatMap((block) => block.commandChanges);
  const statistics = {
    blocksAdded: blockChanges.filter((change) => change.kind === "added").length,
    blocksRemoved: blockChanges.filter((change) => change.kind === "removed").length,
    blocksChanged: blockChanges.filter((change) => change.kind === "changed").length,
    commandsAdded: commandChanges.filter((change) => change.kind === "added").length,
    commandsRemoved: commandChanges.filter((change) => change.kind === "removed").length,
    commandsChanged: commandChanges.filter((change) => change.kind === "changed").length,
  };
  return {
    baseSourceId: base.parsed.source.id,
    targetSourceId: target.parsed.source.id,
    summary: makeSummary(dnaChanges, blockChanges),
    dnaChanges,
    blockChanges,
    statistics,
  };
}
