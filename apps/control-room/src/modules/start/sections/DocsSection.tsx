"use client";

import { ExternalLink, Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/shared/ui/Button";

import {
  ONLINE_DOCS_URL,
  docsPageUrl,
  docsSearchUrl,
  probeDocs,
  type DocsAvailability,
} from "../model/docs";

/**
 * The documentation inside the app. The query box drives Sphinx's own search
 * page in the frame, so results, stemming and highlighting are the docs' own and
 * work offline.
 */
export function DocsSection() {
  const [availability, setAvailability] = useState<DocsAvailability>("checking");
  const [query, setQuery] = useState("");
  const [src, setSrc] = useState(docsPageUrl());
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (availability === "available") inputRef.current?.focus();
  }, [availability]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSrc(docsSearchUrl(query));
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
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Contents
        </Button>
        <a
          className="fm-start-link fm-start-docs__online"
          href={ONLINE_DOCS_URL}
          rel="noreferrer"
          target="_blank"
        >
          Open online <ExternalLink aria-hidden="true" size={12} />
        </a>
      </div>

      {availability === "available" ? (
        <iframe className="fm-start-docs__frame" referrerPolicy="no-referrer" src={src} title="Fullmag documentation" />
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
