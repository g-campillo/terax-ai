import { describe, expect, it } from "vitest";
import { htmlFromMarkdown } from "./markdownRenderer";

// htmlFromMarkdown is the DOM-free half of renderLspMarkdown (marked + the
// file-link rewrite); the sanitization wrapper is exercised in the running app.
describe("htmlFromMarkdown", () => {
  it("renders markdown emphasis, code, and lists to HTML", () => {
    const html = htmlFromMarkdown(
      "Associates a `key`.\n\n* **Parameters:**\n* **key** the key",
    );
    expect(html).toContain("<code>key</code>");
    expect(html).toContain("<strong>Parameters:</strong>");
    expect(html).toContain("<li>");
    // The raw markdown markers should not survive as literal text.
    expect(html).not.toContain("**Parameters:**");
  });

  it("rewrites a Source: file:// link into an inert navigable marker", () => {
    const html = htmlFromMarkdown(
      "Source: [DodAhUtil](file:///Users/x/src/DodAhUtil.java#25)",
    );
    expect(html).toContain('class="cm-lsp-file-link"');
    expect(html).toContain(
      'data-file-uri="file:///Users/x/src/DodAhUtil.java#25"',
    );
    // The live file:// href must be gone so it can't trigger OS navigation.
    expect(html).not.toContain('href="file://');
  });

  it("leaves http links untouched", () => {
    const html = htmlFromMarkdown("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("cm-lsp-file-link");
  });
});
