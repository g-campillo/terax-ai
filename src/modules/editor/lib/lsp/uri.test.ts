import { describe, expect, it } from "vitest";
import { fileUriToPath, pathToFileUri } from "./uri";

describe("pathToFileUri", () => {
  it("converts unix paths", () => {
    expect(pathToFileUri("/Users/g/proj/a.ts")).toBe(
      "file:///Users/g/proj/a.ts",
    );
  });
  it("converts windows drive paths in canonical forward-slash form", () => {
    expect(pathToFileUri("C:/Users/g/a.ts")).toBe("file:///C:/Users/g/a.ts");
  });
  it("normalizes backslashes", () => {
    expect(pathToFileUri("C:\\Users\\g\\a.ts")).toBe("file:///C:/Users/g/a.ts");
  });
  it("percent-encodes spaces", () => {
    expect(pathToFileUri("/a b/c.ts")).toBe("file:///a%20b/c.ts");
  });
  it("percent-encodes hash and question mark in segments", () => {
    expect(pathToFileUri("/a#b/c?.ts")).toBe("file:///a%23b/c%3F.ts");
  });
  it("keeps drive colons literal", () => {
    expect(pathToFileUri("C:/a b/c#.ts")).toBe("file:///C:/a%20b/c%23.ts");
  });
});

describe("fileUriToPath", () => {
  it("round-trips unix paths", () => {
    expect(fileUriToPath("file:///Users/g/proj/a.ts")).toBe(
      "/Users/g/proj/a.ts",
    );
  });
  it("strips the leading slash from windows drive paths", () => {
    expect(fileUriToPath("file:///C:/Users/g/a.ts")).toBe("C:/Users/g/a.ts");
  });
  it("decodes percent-encoding", () => {
    expect(fileUriToPath("file:///a%20b/c.ts")).toBe("/a b/c.ts");
  });
  it("handles lowercase encoded drive colons from some servers", () => {
    expect(fileUriToPath("file:///c%3A/Users/g/a.ts")).toBe("c:/Users/g/a.ts");
  });
});
