import { describe, expect, it } from "vitest";

import {
  isDefaultObjectName,
  primitiveDraftBaseName,
  resolveDraftObjectName,
  uniqueObjectName,
} from "./uniqueObjectName";

function scene(...objects: Array<{ name: string; region_name?: string | null }>) {
  return { objects: objects.map((object, index) => ({ id: `obj_${index}`, ...object })), revision: 1 };
}

describe("uniqueObjectName", () => {
  it("keeps the base name in an empty or missing scene", () => {
    expect(uniqueObjectName("New sphere", scene())).toBe("New sphere");
    expect(uniqueObjectName("New sphere", null)).toBe("New sphere");
  });

  it("numbers repeated defaults like the region-name validator compares them", () => {
    expect(uniqueObjectName("New sphere", scene({ name: "New sphere" }))).toBe("New sphere 2");
    expect(
      uniqueObjectName("New sphere", scene({ name: "new SPHERE " }, { name: "New sphere 2" })),
    ).toBe("New sphere 3");
  });

  it("treats an explicit region name as taken", () => {
    expect(
      uniqueObjectName("New sphere", scene({ name: "Disk", region_name: "New sphere" })),
    ).toBe("New sphere 2");
  });

  it("fills the first gap in the sequence", () => {
    expect(
      uniqueObjectName("New box", scene({ name: "New box" }, { name: "New box 3" })),
    ).toBe("New box 2");
  });
});

describe("resolveDraftObjectName", () => {
  it("keeps a free default and renames a taken one", () => {
    expect(resolveDraftObjectName("New sphere 2", "New sphere", scene({ name: "New sphere" })))
      .toBe("New sphere 2");
    expect(resolveDraftObjectName("New sphere", "New sphere", scene({ name: "New sphere" })))
      .toBe("New sphere 2");
  });

  it("never renames a name the user typed", () => {
    expect(resolveDraftObjectName("Disk", "New sphere", scene({ name: "Disk" }))).toBe("Disk");
  });
});

describe("default name helpers", () => {
  it("recognizes generated default names only", () => {
    expect(isDefaultObjectName("New sphere", "New sphere")).toBe(true);
    expect(isDefaultObjectName("New sphere 12", "New sphere")).toBe(true);
    expect(isDefaultObjectName("New sphere 0", "New sphere")).toBe(false);
    expect(isDefaultObjectName("New sphere left", "New sphere")).toBe(false);
  });

  it("maps draft node ids to default bases", () => {
    expect(primitiveDraftBaseName("geometry:draft:sphere")).toBe("New sphere");
    expect(primitiveDraftBaseName("geometry:draft:cylinder")).toBe("New cylinder");
    expect(primitiveDraftBaseName("geometry:draft:thin-film")).toBe("New thin film");
    expect(primitiveDraftBaseName("geometry:draft:box")).toBe("New box");
    expect(primitiveDraftBaseName(null)).toBe("New box");
  });
});
