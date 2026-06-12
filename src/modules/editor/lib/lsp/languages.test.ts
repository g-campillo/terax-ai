import { describe, expect, it } from "vitest";
import { lspLanguageFor } from "./languages";

describe("lspLanguageFor", () => {
  it("maps the typescript family with react variants", () => {
    expect(lspLanguageFor("/r/a.ts")).toEqual({ server: "typescript", languageId: "typescript" });
    expect(lspLanguageFor("/r/a.tsx")).toEqual({ server: "typescript", languageId: "typescriptreact" });
    expect(lspLanguageFor("/r/a.js")).toEqual({ server: "typescript", languageId: "javascript" });
    expect(lspLanguageFor("/r/a.jsx")).toEqual({ server: "typescript", languageId: "javascriptreact" });
  });

  it("maps the remaining launch languages", () => {
    expect(lspLanguageFor("/r/a.py")?.server).toBe("python");
    expect(lspLanguageFor("/r/a.rs")?.server).toBe("rust");
    expect(lspLanguageFor("/r/a.go")?.server).toBe("go");
    expect(lspLanguageFor("/r/A.java")?.server).toBe("java");
    expect(lspLanguageFor("/r/a.swift")?.server).toBe("swift");
    expect(lspLanguageFor("/r/a.kt")?.server).toBe("kotlin");
  });

  it("is case-insensitive on the extension", () => {
    expect(lspLanguageFor("/r/A.TS")?.languageId).toBe("typescript");
  });

  it("returns null for unsupported files and windows paths work", () => {
    expect(lspLanguageFor("/r/readme.md")).toBeNull();
    expect(lspLanguageFor("C:\\r\\a.rs")?.server).toBe("rust");
  });
});
