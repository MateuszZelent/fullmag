/**
 * The public Sphinx documentation, bundled into the app under `/docs/` so it is
 * available offline, with Sphinx's own client-side search (stemming included).
 * `apps/control-room/scripts/bundle-docs.mjs` copies the built HTML there.
 */
export const DOCS_BASE = "/docs/";

/** Where the same documentation is published; used when it is not bundled. */
export const ONLINE_DOCS_URL = "https://fullmag.mzelent.pl/";

/** A page of the bundled docs. Anything that could leave `/docs/` is refused. */
export function docsPageUrl(page = "index.html"): string {
  const clean = page.replace(/^\/+/, "");
  if (clean.split("/").some((part) => part === "..") || /^[a-z][a-z0-9+.-]*:/i.test(clean)) {
    return `${DOCS_BASE}index.html`;
  }
  return `${DOCS_BASE}${clean}`;
}

/**
 * Sphinx's search page for a query. The query is trimmed; an empty one opens the
 * documentation home instead of an empty result page.
 */
export function docsSearchUrl(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return docsPageUrl();
  return `${DOCS_BASE}search.html?q=${encodeURIComponent(trimmed)}`;
}

export type DocsAvailability = "checking" | "available" | "missing";

/** The bundled docs exist only if their home page can be fetched. */
export async function probeDocs(fetcher: typeof fetch = fetch): Promise<DocsAvailability> {
  try {
    const response = await fetcher(docsPageUrl(), { method: "HEAD", cache: "no-store" });
    return response.ok ? "available" : "missing";
  } catch {
    return "missing";
  }
}

/* ── Messages between the app and the framed documentation ─────────────── */

export type DocsTheme = "dark" | "light";

export type DocsMessage =
  | { readonly type: "ready" }
  | { readonly type: "navigated"; readonly path: string; readonly title: string };

/**
 * What the framed docs may tell the app. Only the two documented messages are
 * accepted and every field is re-validated: a page the docs link to must not be
 * able to steer the app by posting something shaped almost right.
 */
export function parseDocsMessage(data: unknown): DocsMessage | null {
  if (data === null || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.source !== "fullmag-docs") return null;
  if (record.type === "ready") return { type: "ready" };
  if (record.type === "navigated" && typeof record.path === "string") {
    return {
      type: "navigated",
      path: record.path,
      title: typeof record.title === "string" ? record.title : "",
    };
  }
  return null;
}

/** The message that makes the framed docs follow the app's light or dark theme. */
export function themeMessage(theme: DocsTheme): {
  readonly source: "fullmag-app";
  readonly type: "theme";
  readonly theme: DocsTheme;
} {
  return { source: "fullmag-app", type: "theme", theme };
}

/**
 * The online page matching a bundled page, so "Open online" lands where the
 * reader is. A path that could escape the site falls back to its home page.
 */
export function onlineDocsUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  if (
    !clean ||
    clean.split("/").some((part) => part === "..") ||
    /^[a-z][a-z0-9+.-]*:/i.test(clean)
  ) {
    return ONLINE_DOCS_URL;
  }
  return `${ONLINE_DOCS_URL}${clean}`;
}
