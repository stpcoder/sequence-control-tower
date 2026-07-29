import { describe, expect, it } from "vitest";
import { parseSequence } from "../../src/domain";

describe("parseSequence", () => {
  it("parses headers, multiline commands, and multiple commands per line", () => {
    const parsed = parseSequence({
      id: "parser-1",
      filename: "sample.seq",
      content: `intro command;
# First block
@TF set
105;
vdd2h 910; ecc enable;
// operator note
# Second block
hdiag64 --pattern 6060;
`,
    });

    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[0].synthetic).toBe(true);
    expect(parsed.blocks[1].header).toBe("First block");
    expect(parsed.blocks[1].commands.map((command) => command.text)).toEqual([
      "@TF set\n105",
      "vdd2h 910",
      "ecc enable",
    ]);
    expect(parsed.stats.commandCount).toBe(5);
    expect(parsed.looseText[0].reason).toBe("comment");
  });

  it("keeps command-like loose syntax and reports that it was unterminated", () => {
    const parsed = parseSequence({
      id: "parser-2",
      filename: "loose.txt",
      content: "# Loose\nclock 10660\n",
    });
    expect(parsed.blocks[0].commands[0].terminated).toBe(false);
    expect(parsed.warnings[0].code).toBe("UNTERMINATED_COMMAND");
  });
});
