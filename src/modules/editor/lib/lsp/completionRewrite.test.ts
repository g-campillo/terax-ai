// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures are LSP snippet strings that intentionally contain ${n} placeholders
import { describe, expect, it } from "vitest";
import { rewriteCompletionResult, rewriteSnippet } from "./completionRewrite";

// The user wants accepting a function completion to insert `name(│)` — empty
// parens with the cursor between them — instead of the server's
// `name(${1:a}, ${2:b})` placeholder snippet, for every language.
describe("rewriteSnippet", () => {
  it("collapses call arguments to a single $0 cursor", () => {
    expect(
      rewriteSnippet(
        "requireMultiValueField(${1:fieldName}, ${2:values}, ${3:etk})",
      ),
    ).toBe("requireMultiValueField($0)");
  });

  it("preserves generic type arguments before the call parens", () => {
    expect(rewriteSnippet("List<String> foo(${1:x})")).toBe(
      "List<String> foo($0)",
    );
  });

  it("collapses nested parens inside placeholder defaults", () => {
    expect(rewriteSnippet("wrap(${1:inner()})")).toBe("wrap($0)");
  });

  it("keeps trailing text after the call and strips stray tab stops", () => {
    expect(rewriteSnippet("println(${1:x});$0")).toBe("println($0);");
  });

  it("leaves snippets without call parens unchanged", () => {
    expect(rewriteSnippet("${1:name}: ${2:type}")).toBe("${1:name}: ${2:type}");
  });

  it("puts the cursor inside an empty arg list", () => {
    expect(rewriteSnippet("now()")).toBe("now($0)");
  });
});

describe("rewriteCompletionResult", () => {
  const snippetItem = () => ({
    label: "foo(...)",
    insertTextFormat: 2,
    insertText: "foo(${1:a}, ${2:b})",
  });

  it("rewrites snippet items in a CompletionList", () => {
    const out = rewriteCompletionResult({
      isIncomplete: false,
      items: [snippetItem()],
    }) as { isIncomplete: boolean; items: { insertText: string }[] };
    expect(out.items[0]?.insertText).toBe("foo($0)");
    expect(out.isIncomplete).toBe(false);
  });

  it("rewrites snippet items in a bare array", () => {
    const out = rewriteCompletionResult([snippetItem()]) as {
      insertText: string;
    }[];
    expect(out[0]?.insertText).toBe("foo($0)");
  });

  // marimo inserts textEdit.newText raw (no snippet expansion), so we drop the
  // textEdit and move the rewritten snippet to insertText, forcing marimo's
  // snippet path where `$0` becomes the cursor.
  it("rewrites from textEdit.newText and drops the textEdit", () => {
    const out = rewriteCompletionResult([
      {
        label: "foo",
        insertTextFormat: 2,
        insertText: "foo(${1:a})",
        textEdit: { range: {}, newText: "foo(${1:a}, ${2:b})" },
      },
    ]) as { insertText: string; textEdit?: unknown }[];
    expect(out[0]?.insertText).toBe("foo($0)");
    expect(out[0]?.textEdit).toBeUndefined();
  });

  it("leaves plain-text items (insertTextFormat !== 2) untouched", () => {
    const out = rewriteCompletionResult([
      { label: "foo", insertTextFormat: 1, insertText: "foo(${1:a})" },
    ]) as { insertText: string }[];
    expect(out[0]?.insertText).toBe("foo(${1:a})");
  });

  it("does not touch additionalTextEdits (auto-imports)", () => {
    const out = rewriteCompletionResult([
      {
        label: "foo",
        insertTextFormat: 2,
        insertText: "foo(${1:a})",
        additionalTextEdits: [{ range: {}, newText: "import x;\n" }],
      },
    ]) as {
      insertText: string;
      additionalTextEdits: { newText: string }[];
    }[];
    expect(out[0]?.insertText).toBe("foo($0)");
    expect(out[0]?.additionalTextEdits[0]?.newText).toBe("import x;\n");
  });

  it("passes through null", () => {
    expect(rewriteCompletionResult(null)).toBeNull();
  });
});
