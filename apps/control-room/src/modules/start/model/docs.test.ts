import { describe, expect, it } from "vitest";

import {
  docsPageUrl,
  docsSearchUrl,
  onlineDocsUrl,
  parseDocsMessage,
  probeDocs,
  themeMessage,
} from "./docs";

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

describe("parseDocsMessage", () => {
  it("accepts the two documented messages", () => {
    expect(parseDocsMessage({ source: "fullmag-docs", type: "ready" })).toEqual({ type: "ready" });
    expect(
      parseDocsMessage({ source: "fullmag-docs", type: "navigated", path: "physics/x.html", title: "X" }),
    ).toEqual({ type: "navigated", path: "physics/x.html", title: "X" });
  });

  it("ignores anything else, including a message from another source", () => {
    expect(parseDocsMessage(null)).toBeNull();
    expect(parseDocsMessage("ready")).toBeNull();
    expect(parseDocsMessage({ source: "elsewhere", type: "ready" })).toBeNull();
    expect(parseDocsMessage({ source: "fullmag-docs", type: "eval", code: "x" })).toBeNull();
    expect(parseDocsMessage({ source: "fullmag-docs", type: "navigated", path: 5 })).toBeNull();
  });
});

describe("themeMessage", () => {
  it("is addressed from the app", () => {
    expect(themeMessage("dark")).toEqual({ source: "fullmag-app", type: "theme", theme: "dark" });
  });
});

describe("onlineDocsUrl", () => {
  it("maps a bundled page to the same page online", () => {
    expect(onlineDocsUrl("physics/exchange.html")).toBe("https://fullmag.mzelent.pl/physics/exchange.html");
    expect(onlineDocsUrl("search.html?q=demag")).toBe("https://fullmag.mzelent.pl/search.html?q=demag");
  });

  it("falls back to the home page for an empty or unsafe path", () => {
    expect(onlineDocsUrl("")).toBe("https://fullmag.mzelent.pl/");
    expect(onlineDocsUrl("../x")).toBe("https://fullmag.mzelent.pl/");
    expect(onlineDocsUrl("https://evil.example")).toBe("https://fullmag.mzelent.pl/");
  });
});
