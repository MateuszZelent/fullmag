import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { startScreenStore } from "../model/startScreenState";

import { KEY_GROUPS, LEARN_RESOURCES, LearnSection } from "./LearnSection";

afterEach(() => {
  startScreenStore.resetForTests();
});

describe("LearnSection", () => {
  it("lists Documentation (F1) in the keyboard map", () => {
    const startKeys = KEY_GROUPS.find(
      (group) => group.title === "Anywhere on the start screen",
    );
    expect(startKeys?.rows).toContainEqual({
      action: "Documentation",
      keys: "F1",
    });
  });

  it("renders documentation helper resources alongside the keyboard map", () => {
    const html = renderToStaticMarkup(createElement(LearnSection));
    expect(html).toContain("Resources");
    for (const resource of LEARN_RESOURCES) {
      expect(html).toContain(resource.title.replaceAll("&", "&amp;"));
    }
    expect(
      LEARN_RESOURCES.filter((resource) => Boolean(resource.page)).map(
        (resource) => resource.page,
      ),
    ).toEqual([
      "index.html",
      "getting-started/index.html",
      "python-api/index.html",
      "validation/mumag-standard-problems.html",
      "changelog/index.html",
    ]);
  });
});
