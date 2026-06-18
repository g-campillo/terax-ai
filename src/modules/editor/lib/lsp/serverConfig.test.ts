import { describe, expect, it } from "vitest";
import { lspConfigForSection } from "./serverConfig";

describe("lspConfigForSection", () => {
  it("returns curated defaults for a known section", () => {
    const cfg = lspConfigForSection("rust-analyzer") as {
      check?: { command?: string };
    };
    expect(cfg.check?.command).toBe("check");
  });

  it("maps the python section to analysis defaults", () => {
    const cfg = lspConfigForSection("python") as {
      analysis?: { typeCheckingMode?: string };
    };
    expect(cfg.analysis?.typeCheckingMode).toBe("basic");
  });

  it("returns an empty object (never null) for unknown / missing sections", () => {
    expect(lspConfigForSection("nope")).toEqual({});
    expect(lspConfigForSection(undefined)).toEqual({});
  });
});
