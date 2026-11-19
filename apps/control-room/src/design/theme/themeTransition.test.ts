import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { THEME_SWITCHING_ATTRIBUTE, applyWithoutTransitions } from "./themeTransition";

function fakeDocument() {
  const attributes = new Map<string, string>();
  const events: string[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const root = {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } as unknown as Element;
  const view = {
    getComputedStyle: () => {
      events.push(`flush:${attributes.has(THEME_SWITCHING_ATTRIBUTE)}`);
      return { color: "rgb(0, 0, 0)" } as CSSStyleDeclaration;
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  } as unknown as Window;
  const runFrame = () => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(0);
  };
  return { attributes, events, root, view, runFrame };
}

describe("applyWithoutTransitions", () => {
  it("flushes the palette change with transitions off and restores them after a styled frame", () => {
    const doc = fakeDocument();

    applyWithoutTransitions(doc.root, doc.view, () => {
      doc.events.push(`change:${doc.attributes.has(THEME_SWITCHING_ATTRIBUTE)}`);
    });

    expect(doc.events).toEqual(["change:true", "flush:true"]);
    doc.runFrame();
    expect(doc.attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(true);
    doc.runFrame();
    expect(doc.attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(false);
  });

  it("keeps transitions off when a second switch lands before the first restore", () => {
    const doc = fakeDocument();

    applyWithoutTransitions(doc.root, doc.view, () => undefined);
    doc.runFrame();
    applyWithoutTransitions(doc.root, doc.view, () => undefined);
    doc.runFrame();
    expect(doc.attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(true);
    doc.runFrame();
    expect(doc.attributes.has(THEME_SWITCHING_ATTRIBUTE)).toBe(false);
  });

  it("is backed by a theme.css rule that disables every transition", () => {
    const themeCss = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../styles/theme.css"),
      "utf8",
    );

    expect(themeCss).toContain(`:root[${THEME_SWITCHING_ATTRIBUTE}] *,`);
    expect(themeCss).toMatch(
      new RegExp(`\\[${THEME_SWITCHING_ATTRIBUTE}\\] \\*::after \\{\\s*transition: none !important;`),
    );
  });
});
