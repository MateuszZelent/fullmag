import { describe, expect, it } from "vitest";

import { describeBuild, parseBuildInfo } from "./buildInfo";

describe("parseBuildInfo", () => {
  it("reads a host record", () => {
    expect(
      parseBuildInfo({
        version: "0.1.0",
        os: "windows",
        arch: "x86_64",
        profile: "debug",
        project_schema: "fullmag.project/1.2",
      }),
    ).toEqual({
      version: "0.1.0",
      os: "windows",
      arch: "x86_64",
      profile: "debug",
      projectSchema: "fullmag.project/1.2",
    });
  });

  it("treats a record without a version as absent", () => {
    expect(parseBuildInfo({ os: "linux" })).toBeNull();
    expect(parseBuildInfo(null)).toBeNull();
    expect(parseBuildInfo([1])).toBeNull();
  });

  it("defaults unknown parts instead of inventing them", () => {
    expect(parseBuildInfo({ version: "1" })).toMatchObject({
      os: "unknown",
      arch: "unknown",
      projectSchema: "unknown",
      profile: "release",
    });
  });
});

describe("describeBuild", () => {
  it("says plainly when there is no build record", () => {
    expect(describeBuild(null)).toBe("not exposed to the renderer");
  });

  it("summarises a record on one line", () => {
    expect(
      describeBuild({
        version: "0.1.0",
        os: "linux",
        arch: "aarch64",
        profile: "release",
        projectSchema: "s",
      }),
    ).toBe("0.1.0 (release), linux/aarch64, project schema s");
  });
});
