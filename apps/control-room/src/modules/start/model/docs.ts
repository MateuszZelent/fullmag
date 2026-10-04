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
