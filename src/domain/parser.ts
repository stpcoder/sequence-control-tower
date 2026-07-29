import type {
  LooseText,
  ParseWarning,
  ParsedSequence,
  SequenceBlock,
  SequenceCommand,
  SequenceSource,
  SourceRange,
} from "./types";

interface MutableBlock extends Omit<SequenceBlock, "range"> {
  range: SourceRange;
}

const COMMENT_PREFIXES = ["//", "--"];

function makeBlock(sourceId: string, index: number, header: string, line: number, synthetic = false): MutableBlock {
  return {
    id: `${sourceId}:block:${index}`,
    index,
    header: header.trim() || (synthetic ? "Preamble" : `Block ${index + 1}`),
    rawHeader: synthetic ? "" : `#${header}`,
    synthetic,
    range: { startLine: line, endLine: line },
    commands: [],
    notes: [],
  };
}

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function addLoose(
  block: MutableBlock,
  looseText: LooseText[],
  text: string,
  line: number,
  reason: LooseText["reason"],
): void {
  const item: LooseText = { text: text.trim(), range: { startLine: line, endLine: line }, reason };
  block.notes.push(item);
  looseText.push(item);
}

/**
 * Parses the prevalent `# header` + semicolon-delimited command format while
 * preserving useful loose text. Commands may span lines and more than one
 * command may appear on a line.
 */
export function parseSequence(source: SequenceSource): ParsedSequence {
  const lines = source.content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MutableBlock[] = [];
  const looseText: LooseText[] = [];
  const warnings: ParseWarning[] = [];
  let current: MutableBlock | undefined;
  let commandBuffer = "";
  let commandStartLine = 1;

  const ensureBlock = (line: number): MutableBlock => {
    if (!current) {
      current = makeBlock(source.id, blocks.length, "Preamble", line, true);
      blocks.push(current);
    }
    return current;
  };

  const pushCommand = (raw: string, startLine: number, endLine: number, terminated: boolean): void => {
    const text = raw.trim();
    if (!text) return;
    const block = ensureBlock(startLine);
    const command: SequenceCommand = {
      id: `${source.id}:command:${blocks.reduce((sum, item) => sum + item.commands.length, 0)}`,
      index: blocks.reduce((sum, item) => sum + item.commands.length, 0),
      raw: terminated ? `${text};` : text,
      text,
      terminated,
      range: { startLine, endLine },
    };
    block.commands.push(command);
    block.range.endLine = Math.max(block.range.endLine, endLine);
  };

  const flushUnterminated = (endLine: number): void => {
    const text = commandBuffer.trim();
    if (!text) {
      commandBuffer = "";
      return;
    }
    // Loose one-line text is retained as a note. Command-looking text remains
    // executable evidence, even when its semicolon was omitted.
    const looksLikeCommand = /^(?:@|[A-Za-z_./\\][\w./\\@-]*)(?:\s+|=|$)/.test(text);
    if (looksLikeCommand) {
      pushCommand(text, commandStartLine, endLine, false);
      warnings.push({
        code: "UNTERMINATED_COMMAND",
        message: "Command-like text did not end with a semicolon.",
        range: { startLine: commandStartLine, endLine },
      });
    } else {
      addLoose(ensureBlock(commandStartLine), looseText, text, commandStartLine, "unrecognized");
      warnings.push({
        code: "UNRECOGNIZED_LINE",
        message: "Text could not be classified as a command.",
        range: { startLine: commandStartLine, endLine },
      });
    }
    commandBuffer = "";
  };

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();

    if (/^\s*#/.test(rawLine)) {
      flushUnterminated(lineNumber - 1);
      const header = rawLine.replace(/^\s*#\s?/, "");
      current = makeBlock(source.id, blocks.length, header, lineNumber);
      blocks.push(current);
      if (!header.trim()) {
        warnings.push({
          code: "EMPTY_HEADER",
          message: "A block header was present but had no text.",
          range: { startLine: lineNumber, endLine: lineNumber },
        });
      }
      return;
    }

    if (!trimmed) {
      // A blank line is a natural boundary for loose command syntax.
      flushUnterminated(lineNumber - 1);
      return;
    }

    if (isComment(rawLine)) {
      flushUnterminated(lineNumber - 1);
      const block = ensureBlock(lineNumber);
      addLoose(block, looseText, trimmed, lineNumber, "comment");
      block.range.endLine = Math.max(block.range.endLine, lineNumber);
      return;
    }

    if (!commandBuffer) commandStartLine = lineNumber;
    commandBuffer += `${commandBuffer ? "\n" : ""}${rawLine}`;

    while (commandBuffer.includes(";")) {
      const separator = commandBuffer.indexOf(";");
      const commandText = commandBuffer.slice(0, separator);
      // Count line breaks consumed by this command to retain precise evidence.
      const commandEndLine = commandStartLine + (commandText.match(/\n/g)?.length ?? 0);
      pushCommand(commandText, commandStartLine, commandEndLine, true);
      const consumed = commandBuffer.slice(0, separator + 1);
      commandBuffer = commandBuffer.slice(separator + 1).trimStart();
      commandStartLine += consumed.match(/\n/g)?.length ?? 0;
      if (!commandBuffer) commandStartLine = lineNumber;
    }
  });

  flushUnterminated(lines.length);

  // An entirely empty source is still represented without inventing a block.
  blocks.forEach((block, index) => {
    block.index = index;
    block.range.endLine = Math.max(
      block.range.endLine,
      block.commands.at(-1)?.range.endLine ?? block.notes.at(-1)?.range.endLine ?? block.range.startLine,
    );
  });

  const commands = blocks.flatMap((block) => block.commands);
  return {
    source,
    blocks,
    looseText,
    warnings,
    stats: {
      lineCount: lines.length,
      blockCount: blocks.length,
      commandCount: commands.length,
      terminatedCommandCount: commands.filter((command) => command.terminated).length,
    },
  };
}
