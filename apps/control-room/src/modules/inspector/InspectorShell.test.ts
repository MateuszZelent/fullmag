import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { inspectorDisplayId, inspectorDomain } from "./InspectorShell.model";

const source = readFileSync(
  new URL("./InspectorShell.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

describe("InspectorShell scroll lifecycle", () => {
  it("resets scroll only when the inspector descriptor identity changes", () => {
    const resetEffectStart = source.indexOf(
      "useLayoutEffect(() => {\n    resetInspectorScroll",
    );
    const resetEffect = source.slice(
      resetEffectStart,
      source.indexOf("\n\n  return (", resetEffectStart),
    );

    expect(resetEffectStart).toBeGreaterThan(-1);
    expect(resetEffect).toContain("}, [descriptorKey]);");
    expect(resetEffect).not.toContain("descriptor.tabs");
  });

  it("exposes a command-backed icon for hiding the Inspector panel", () => {
    expect(source).toContain("PanelRightClose");
    expect(source).toContain('aria-label="Hide Inspector"');
    expect(source).toContain('data-panel-toggle="inspector"');
    expect(source).toContain("onToggleVisibility");
  });
});

describe("InspectorShell identity header", () => {
  it("renders one identity: domain glyph, kind text, copyable ID and one state pill", () => {
    expect(source).toContain('data-domain={inspectorDomain(descriptor.icon)}');
    expect(source).toContain('className="fm-inspector__kind"');
    expect(source).toContain('className="fm-inspector__id-chip"');
    expect(source).toContain('className="fm-inspector__state"');
    // The kind is plain text, not a badge, and no hidden metadata grid remains.
    expect(source).not.toContain('<Badge variant="secondary">{descriptor.typeLabel}</Badge>');
    expect(source).not.toContain("fm-inspector__metadata-grid");
  });

  it("keeps the full descriptor metadata in a hidden list for browser audits", () => {
    expect(source).toContain(
      '<dl className="fm-inspector__metadata" data-slot="inspector-metadata" hidden>',
    );
    expect(source).toContain('className="fm-inspector__metadata-item"');
    expect(source).toContain("<dd title={item.value}>{item.value}</dd>");
  });

  it("maps every descriptor icon to a domain hue", () => {
    expect(inspectorDomain("object")).toBe("geometry");
    expect(inspectorDomain("airbox")).toBe("mesh");
    expect(inspectorDomain("mesh")).toBe("mesh");
    expect(inspectorDomain("visualization")).toBe("visualization");
    expect(inspectorDomain("mode")).toBe("visualization");
    expect(inspectorDomain("analysis")).toBe("visualization");
    expect(inspectorDomain("study")).toBe("study");
    expect(inspectorDomain("diagnostics")).toBe("definition");
  });

  it("shows the object ID before the Explorer node ID", () => {
    expect(
      inspectorDisplayId([
        { label: "Kind", value: "object.material" },
        { label: "Object", value: "film" },
        { label: "Node", value: "model:object:film:material" },
      ]),
    ).toBe("film");
    expect(inspectorDisplayId([{ label: "Node", value: "model:airbox" }])).toBe("model:airbox");
    expect(inspectorDisplayId([{ label: "Kind", value: "airbox.root" }])).toBeUndefined();
  });
});
