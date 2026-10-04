import { describe, expect, it } from "vitest";

import { docsPageUrl, docsSearchUrl, probeDocs } from "./docs";

describe("docsPageUrl", () => {
  it("resolves pages under /docs/", () => {
    expect(docsPageUrl()).toBe("/docs/index.html");
    expect(docsPageUrl("physics/exchange.html")).toBe("/docs/physics/exchange.html");
    expect(docsPageUrl("/search.html")).toBe("/docs/search.html");
  });

  it("refuses anything that could leave the docs directory", () => {
    expect(docsPageUrl("../secret")).toBe("/docs/index.html");
    expect(docsPageUrl("a/../../b")).toBe("/docs/index.html");
    expect(docsPageUrl("https://evil.example/x")).toBe("/docs/index.html");
    expect(docsPageUrl("javascript:alert(1)")).toBe("/docs/index.html");
  });
});

describe("docsSearchUrl", () => {
  it("encodes the query for Sphinx's search page", () => {
    expect(docsSearchUrl("demag field")).toBe("/docs/search.html?q=demag%20field");
    expect(docsSearchUrl("A&B=c")).toBe("/docs/search.html?q=A%26B%3Dc");
  });

  it("opens the home page for an empty query", () => {
    expect(docsSearchUrl("   ")).toBe("/docs/index.html");
  });
});

describe("probeDocs", () => {
  it("is available only when the home page answers", async () => {
    const ok = (async () => ({ ok: true })) as unknown as typeof fetch;
    const notFound = (async () => ({ ok: false })) as unknown as typeof fetch;
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await probeDocs(ok)).toBe("available");
    expect(await probeDocs(notFound)).toBe("missing");
    expect(await probeDocs(broken)).toBe("missing");
  });
});
