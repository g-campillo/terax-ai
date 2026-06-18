import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { lspEditsToChanges } from "./format";

const docOf = (text: string) => EditorState.create({ doc: text }).doc;

describe("lspEditsToChanges", () => {
  it("maps line/character ranges to document offsets", () => {
    const doc = docOf("const x=1\nconst y=2\n");
    const changes = lspEditsToChanges(doc, [
      {
        range: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 8 },
        },
        newText: " = ",
      },
    ]);
    expect(changes).toEqual([{ from: 7, to: 8, insert: " = " }]);
  });

  it("sorts edits into document order", () => {
    const doc = docOf("a\nb\nc\n");
    const changes = lspEditsToChanges(doc, [
      {
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 1 },
        },
        newText: "C",
      },
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        newText: "A",
      },
    ]);
    expect(changes.map((c) => c.insert)).toEqual(["A", "C"]);
    expect(changes[0].from).toBeLessThan(changes[1].from);
  });

  it("clamps an end position past the document to the document end", () => {
    const doc = docOf("x\n");
    const changes = lspEditsToChanges(doc, [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 99, character: 0 },
        },
        newText: "y\n",
      },
    ]);
    expect(changes[0]).toEqual({ from: 0, to: doc.length, insert: "y\n" });
  });
});
