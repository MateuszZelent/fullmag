import assert from "node:assert/strict";
import { test } from "vitest";

import { readViewportInspectorState } from "./viewport-export-browser-qa.mjs";

function makePage({ context, open, selectedTab }) {
  const button = {
    getAttribute(name) {
      if (name === "data-active") return "true";
      if (name === "aria-pressed") return String(open);
      return null;
    },
  };
  const rail = {
    querySelector(selector) {
      return selector === `[data-rail-item="${context}"]` ? button : null;
    },
  };
  const tabs = {
    async count() {
      return 1;
    },
    first() {
      return {
        async innerText() {
          return selectedTab;
        },
      };
    },
  };
  const region = {
    async waitFor({ state }) {
      assert.equal(state, "attached");
    },
    locator(selector) {
      assert.equal(selector, '[role="tab"][aria-selected="true"]');
      return tabs;
    },
  };
  return {
    locator(selector) {
      if (selector === '.fm-side-rail[data-side="right"]') {
        return { waitFor: async () => undefined };
      }
      assert.ok(selector === '[aria-label="3D Export"]' || selector === '[aria-label="3D View Settings"]');
      return region;
    },
    async evaluate(callback, selector) {
      const previousDocument = globalThis.document;
      globalThis.document = {
        querySelector(query) {
          assert.equal(query, selector);
          return rail;
        },
      };
      try {
        return callback(selector);
      } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
      }
    },
  };
}

test("readViewportInspectorState preserves the selected export mode while the panel is collapsed", async () => {
  const state = await readViewportInspectorState(
    makePage({ context: "export", open: false, selectedTab: "3D model" }),
  );

  assert.deepEqual(state, { context: "export", open: false, section: "3D model" });
});

test("readViewportInspectorState preserves the selected view section while the panel is collapsed", async () => {
  const state = await readViewportInspectorState(
    makePage({ context: "view", open: false, selectedTab: "Appearance" }),
  );

  assert.deepEqual(state, { context: "view", open: false, section: "Appearance" });
});
