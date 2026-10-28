import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "@/design/theme/ThemeProvider";

import { startScreenStore } from "../model/startScreenState";

import { DocsSection } from "./DocsSection";

afterEach(() => {
  startScreenStore.resetForTests();
});

describe("DocsSection", () => {
  it("renders the documentation search bar, Search action, Contents button, and Open online link", () => {
    startScreenStore.requestDocs("python-api/index.html");
    const html = renderToStaticMarkup(
      createElement(ThemeProvider, null, createElement(DocsSection)),
    );

    expect(html).toContain('aria-label="Search the documentation"');
    expect(html).toContain(">Search<");
    expect(html).toContain(">Contents<");
    expect(html).toContain(
      'href="https://fullmag.mzelent.pl/index.html"',
    );
    expect(startScreenStore.getSnapshot().docsRequest).toEqual({
      seq: 1,
      page: "python-api/index.html",
    });
  });
});
