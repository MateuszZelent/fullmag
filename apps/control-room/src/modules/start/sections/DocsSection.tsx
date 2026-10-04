"use client";

import { ExternalLink, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { useTheme } from "@/design/theme/ThemeProvider";
import { Button } from "@/shared/ui/Button";

import {
  ONLINE_DOCS_URL,
  docsPageUrl,
  docsSearchUrl,
  onlineDocsUrl,
  parseDocsMessage,
  probeDocs,
  themeMessage,
  type DocsAvailability,
} from "../model/docs";
import { startScreenStore } from "../model/startScreenState";

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
  const [pagePath, setPagePath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { theme } = useTheme();

  // The framed site is same-origin; address it explicitly rather than with "*".
  const sendTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(themeMessage(theme), window.location.origin);
  }, [theme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the frame this component owns, on this origin, is listened to.
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = parseDocsMessage(event.data);
      if (!message) return;
      if (message.type === "ready") sendTheme();
      else setPagePath(message.path);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendTheme]);

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
    setSrc(docsPageUrl(docsRequest.page));
    setFrameKey((key) => key + 1);
  }, [docsRequest]);

  useEffect(() => {
    if (availability === "available") inputRef.current?.focus();
  }, [availability]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSrc(docsSearchUrl(query));
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the documentation"
            ref={inputRef}
            type="search"
            value={query}
          />
        </form>
        <Button
          disabled={availability !== "available"}
          onClick={() => {
            setQuery("");
            setSrc(docsPageUrl());
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
