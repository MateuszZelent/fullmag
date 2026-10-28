"use client";

import { ExternalLink, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import {
  EMBED_FALLBACK_CSS,
  EMBED_FALLBACK_STYLE_ID,
} from "@/design/styles/docsEmbedFallback";
import { useTheme } from "@/design/theme/ThemeProvider";
import { Button } from "@/shared/ui/Button";

import {
  ONLINE_DOCS_URL,
  docsPageUrl,
  docsSearchUrl,
  onlineDocsUrl,
  parseDocsMessage,
  probeDocs,
  resolveFramedDocPath,
  themeMessage,
  type DocsAvailability,
  type DocsTheme,
} from "../model/docs";
import { startScreenStore } from "../model/startScreenState";

function docPathFromSrc(srcUrl: string): string {
  const [pathname = "/docs/index.html", rawQuery = ""] = srcUrl.split("?");
  return resolveFramedDocPath(pathname, rawQuery ? `?${rawQuery}` : "");
}

function extractSearchQueryFromDocPath(docPath: string): string | null {
  const [page = "", rawQuery = ""] = docPath.split("?");
  if (page !== "search.html" || !rawQuery) {
    return null;
  }
  const params = new URLSearchParams(rawQuery);
  return params.get("q");
}

function clearSphinxSearchHighlight(frame: HTMLIFrameElement | null): void {
  try {
    window.localStorage.removeItem("sphinx_highlight_terms");
  } catch {
    // Ignore restricted storage environments.
  }
  try {
    const win = frame?.contentWindow as
      | (Window & { SphinxHighlight?: { hideSearchWords?: () => void } })
      | null
      | undefined;
    win?.SphinxHighlight?.hideSearchWords?.();
  } catch {
    // Ignore cross-origin or uninitialized frame errors.
  }
}

function syncSameOriginDocsDocument(
  frame: HTMLIFrameElement | null,
  theme: DocsTheme,
): string | null {
  if (!frame) return null;
  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win || !doc.documentElement) return null;

    const root = doc.documentElement;
    root.dataset.fullmagEmbedded = "";
    root.dataset.theme = theme;
    root.style.colorScheme = theme;

    const pygmentsDark = doc.getElementById("pygments_dark_css") as HTMLLinkElement | null;
    if (pygmentsDark) {
      pygmentsDark.removeAttribute("media");
      pygmentsDark.disabled = theme !== "dark";
    }

    if (doc.head && !doc.getElementById(EMBED_FALLBACK_STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = EMBED_FALLBACK_STYLE_ID;
      style.textContent = EMBED_FALLBACK_CSS;
      doc.head.appendChild(style);
    }

    doc.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
      const rawHref = anchor.getAttribute("href");
      if (
        !rawHref ||
        rawHref.startsWith("#") ||
        rawHref.startsWith("mailto:") ||
        rawHref.startsWith("tel:") ||
        rawHref.startsWith("javascript:")
      ) {
        return;
      }
      try {
        const resolvedUrl = new URL(rawHref, win.location.href);
        if (
          (resolvedUrl.protocol === "http:" || resolvedUrl.protocol === "https:") &&
          resolvedUrl.origin !== win.location.origin
        ) {
          anchor.setAttribute("target", "_blank");
          anchor.setAttribute("rel", "noopener noreferrer");
        }
      } catch {
        // Ignore malformed relative hrefs.
      }
    });

    if (win.location.pathname && win.location.pathname !== "about:blank") {
      return resolveFramedDocPath(win.location.pathname, win.location.search);
    }
  } catch {
    // Ignore cross-origin or uninitialized frame errors.
  }
  return null;
}

/**
 * The documentation inside the app. The query box drives Sphinx's own search
 * page in the frame, so results, stemming and highlighting are the docs' own and
 * work offline.
 */
export function DocsSection() {
  const [availability, setAvailability] = useState<DocsAvailability>("checking");
  const [query, setQuery] = useState("");
  // A page requested before this section mounted (Help → Reference) is the
  // starting page; one requested while it is open replaces the current page.
  const { docsRequest } = useSyncExternalStore(
    startScreenStore.subscribe,
    startScreenStore.getSnapshot,
    startScreenStore.getServerSnapshot,
  );
  const [src, setSrc] = useState(() => docsPageUrl(docsRequest?.page));
  const handledRequest = useRef(docsRequest?.seq ?? 0);
  // Reading moves the frame without touching `src`, so a request for the page the
  // state already names must still bring the frame back; a new key reloads it.
  const [frameKey, setFrameKey] = useState(0);
  const [pagePath, setPagePath] = useState(() =>
    docPathFromSrc(docsPageUrl(docsRequest?.page)),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { theme } = useTheme();

  const applyNavigatedPath = useCallback((nextPath: string) => {
    setPagePath(nextPath);
    const searchQuery = extractSearchQueryFromDocPath(nextPath);
    if (searchQuery !== null) {
      setQuery(searchQuery);
    }
  }, []);

  // The framed site is same-origin; address it explicitly rather than with "*".
  const sendTheme = useCallback(() => {
    const resolvedPath = syncSameOriginDocsDocument(frameRef.current, theme);
    if (resolvedPath) {
      applyNavigatedPath(resolvedPath);
    }
    frameRef.current?.contentWindow?.postMessage(themeMessage(theme), window.location.origin);
  }, [applyNavigatedPath, theme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the frame this component owns, on this origin, is listened to.
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = parseDocsMessage(event.data);
      if (!message) return;
      if (message.type === "ready") sendTheme();
      else applyNavigatedPath(message.path);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [applyNavigatedPath, sendTheme]);

  // A theme change after the page is up reaches it without a reload.
  useEffect(() => {
    sendTheme();
  }, [sendTheme]);

  useEffect(() => {
    let cancelled = false;
    void probeDocs().then((result) => {
      if (!cancelled) setAvailability(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!docsRequest || docsRequest.seq === handledRequest.current) return;
    handledRequest.current = docsRequest.seq;
    const nextSrc = docsPageUrl(docsRequest.page);
    clearSphinxSearchHighlight(frameRef.current);
    setQuery("");
    setSrc(nextSrc);
    setPagePath(docPathFromSrc(nextSrc));
    setFrameKey((key) => key + 1);
  }, [docsRequest]);

  useEffect(() => {
    if (availability !== "available") return;
    inputRef.current?.focus();
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [availability, docsRequest?.seq]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      clearSphinxSearchHighlight(frameRef.current);
      const nextSrc = docsPageUrl();
      setSrc(nextSrc);
      setPagePath(docPathFromSrc(nextSrc));
      setFrameKey((key) => key + 1);
      return;
    }
    const nextSrc = docsSearchUrl(trimmed);
    setSrc(nextSrc);
    setPagePath(docPathFromSrc(nextSrc));
    setFrameKey((key) => key + 1);
  };

  return (
    <div className="fm-start-docs">
      <div className="fm-start-docs__bar">
        <form className="fm-start-search" onSubmit={submit} role="search">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label="Search the documentation"
            disabled={availability !== "available"}
            onChange={(event) => {
              const nextValue = event.target.value;
              setQuery(nextValue);
              if (nextValue === "" && query !== "") {
                clearSphinxSearchHighlight(frameRef.current);
                if (pagePath.startsWith("search.html")) {
                  const nextSrc = docsPageUrl();
                  setSrc(nextSrc);
                  setPagePath(docPathFromSrc(nextSrc));
                  setFrameKey((key) => key + 1);
                }
              }
            }}
            placeholder="Search the documentation"
            ref={inputRef}
            type="search"
            value={query}
          />
        </form>
        <Button
          disabled={availability !== "available"}
          onClick={() => {
            const trimmed = query.trim();
            if (!trimmed) {
              inputRef.current?.focus();
              return;
            }
            const nextSrc = docsSearchUrl(trimmed);
            setSrc(nextSrc);
            setPagePath(docPathFromSrc(nextSrc));
            setFrameKey((key) => key + 1);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Search
        </Button>
        <Button
          disabled={availability !== "available"}
          onClick={() => {
            clearSphinxSearchHighlight(frameRef.current);
            setQuery("");
            const nextSrc = docsPageUrl();
            setSrc(nextSrc);
            setPagePath(docPathFromSrc(nextSrc));
            setFrameKey((key) => key + 1);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Contents
        </Button>
        <a
          className="fm-start-link fm-start-docs__online"
          href={pagePath ? onlineDocsUrl(pagePath) : ONLINE_DOCS_URL}
          rel="noreferrer"
          target="_blank"
        >
          Open online <ExternalLink aria-hidden="true" size={12} />
        </a>
      </div>

      {availability === "available" ? (
        <iframe
          className="fm-start-docs__frame"
          key={frameKey}
          onLoad={sendTheme}
          ref={frameRef}
          referrerPolicy="no-referrer"
          src={src}
          title="Fullmag documentation"
        />
      ) : availability === "checking" ? (
        <p className="fm-start-inspector__note" role="status">
          Opening the documentation…
        </p>
      ) : (
        <div className="fm-start-notice fm-start-notice--warning" role="status">
          The documentation is not bundled with this build. It is available online at{" "}
          <a className="fm-start-link" href={ONLINE_DOCS_URL} rel="noreferrer" target="_blank">
            {ONLINE_DOCS_URL}
          </a>
          . To bundle it for offline use, build the Sphinx site and run{" "}
          <code>pnpm --dir apps/control-room docs:bundle</code>.
        </div>
      )}
    </div>
  );
}
