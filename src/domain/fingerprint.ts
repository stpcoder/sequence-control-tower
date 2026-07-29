import { extractSequenceDNA, inferCommandFamily } from "./dna";
import { normalizeCommand, normalizeDynamicTokens } from "./normalizer";
import type { ParsedSequence, SequenceDNA, SequenceFingerprint } from "./types";

/** Fast, deterministic, dependency-free content hash (two mixed 32-bit lanes). */
export function stableHash(input: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 0x01000193);
    right ^= code + index;
    right = Math.imul(right, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function tokenize(input: string): string[] {
  return (
    input
      .toLocaleLowerCase("en-US")
      .match(/<[^>]+>|@?[a-z_][\w./@-]*|-?\d+(?:\.\d+)?|[=,:]/g) ?? []
  );
}

function shingles(tokens: string[], size = 3): string[] {
  if (tokens.length < size) return tokens.length ? [tokens.join(" ")] : [];
  const result: string[] = [];
  for (let index = 0; index <= tokens.length - size; index += 1) {
    result.push(stableHash(tokens.slice(index, index + size).join(" ")));
  }
  return [...new Set(result)];
}

export function fingerprintSequence(parsed: ParsedSequence, dna: SequenceDNA = extractSequenceDNA(parsed)): SequenceFingerprint {
  const normalizedBlocks = parsed.blocks.map((block) => {
    const header = normalizeDynamicTokens(block.header, {
      lowercase: true,
      collapseWhitespace: true,
      preserveLineBreaks: false,
    }).text;
    const commands = block.commands.map(normalizeCommand);
    return { header, commands };
  });
  const normalizedText = normalizedBlocks
    .map((block) => [`# ${block.header}`, ...block.commands.map((command) => `${command};`)].join("\n"))
    .join("\n");
  const tokens = tokenize(normalizedText);
  const familyHistogram: Record<string, number> = {};
  for (const command of parsed.blocks.flatMap((block) => block.commands)) {
    const { family } = inferCommandFamily(command.text);
    familyHistogram[family] = (familyHistogram[family] ?? 0) + 1;
  }
  const blockSignatures = normalizedBlocks.map((block) =>
    stableHash(`${block.header}|${block.commands.map((command) => stableHash(command)).join("|")}`),
  );
  const structuralPayload = JSON.stringify({
    blocks: normalizedBlocks.map((block) => ({
      headerTokens: tokenize(block.header).filter((token) => !/^-?\d/.test(token)),
      families: block.commands.map((command) => inferCommandFamily(command).family),
      commandCount: block.commands.length,
    })),
    dna: {
      blockCount: dna.blockCount.value,
      families: dna.commandFamilies.value?.map(({ family, count }) => [family, count]),
    },
  });
  return {
    sourceId: parsed.source.id,
    exactHash: stableHash(normalizedText),
    structuralHash: stableHash(structuralPayload),
    normalizedText,
    tokens: [...new Set(tokens)],
    shingles: shingles(tokens),
    blockSignatures,
    familyHistogram,
  };
}
