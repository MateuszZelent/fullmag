"use client";

import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";
import { Button } from "@/shared/ui/Button";

import {
  FULLMAG_AUTHORS,
  FULLMAG_BIBTEX,
  FULLMAG_CITATION,
  FULLMAG_CITATION_NOTE,
  FULLMAG_COORDINATION,
  FULLMAG_ENGINES,
  FULLMAG_FUNDING,
  FULLMAG_LICENSE,
  FULLMAG_OVERVIEW,
  FULLMAG_REPOSITORY_URL,
  FULLMAG_TAGLINE,
} from "../model/aboutFullmag";
import { readBuildInfo, type BuildInfo } from "../model/buildInfo";
import { buildDiagnostics } from "../model/diagnostics";
import { ONLINE_DOCS_URL } from "../model/docs";
import { startScreenStore } from "../model/startScreenState";
import type { ComputeProbeState, RecentIndexState } from "../model/types";

export interface AboutSectionProps {
  readonly compute: ComputeProbeState;
  readonly index: RecentIndexState;
}

/** A "Copy" button that says what happened for a moment, then goes back. */
function CopyButton({ label, text }: { readonly label: string; readonly text: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard?.writeText(text()).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      size="sm"
      type="button"
      variant="secondary"
    >
      <Copy aria-hidden="true" size={14} />
      {copied ? "Copied" : label}
    </Button>
  );
}

export function AboutSection({ compute, index }: AboutSectionProps) {
  const [build, setBuild] = useState<BuildInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readBuildInfo().then((found) => {
      if (!cancelled) setBuild(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const diagnostics = () =>
    buildDiagnostics({
      host: tauriInvoke() ? "desktop" : "browser",
      userAgent: navigator.userAgent,
      locale: navigator.language,
      now: new Date(),
      build,
      index,
      compute,
    });

  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>About FullMag</h1>
          <p>{FULLMAG_TAGLINE}</p>
        </div>
      </div>

      <section aria-labelledby="fm-start-about-overview" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-about-overview">
          Overview
        </h2>
        {FULLMAG_OVERVIEW.map((paragraph) => (
          <p className="fm-start-about__text" key={paragraph}>
            {paragraph}
          </p>
        ))}
        <dl className="fm-start-kv__grid">
          {FULLMAG_ENGINES.map((engine) => (
            <div className="fm-start-kv__row" key={engine.name}>
              <dt>{engine.name}</dt>
              <dd className="fm-start-about__plain">{engine.bestFor}</dd>
            </div>
          ))}
        </dl>
        <p className="fm-start-about__links">
          <button
            className="fm-start-link"
            onClick={() => startScreenStore.setSection("docs")}
            type="button"
          >
            Open the documentation
          </button>
          <a className="fm-start-link" href={FULLMAG_REPOSITORY_URL} rel="noreferrer" target="_blank">
            Repository <ExternalLink aria-hidden="true" size={12} />
          </a>
          <a className="fm-start-link" href={ONLINE_DOCS_URL} rel="noreferrer" target="_blank">
            Documentation online <ExternalLink aria-hidden="true" size={12} />
          </a>
        </p>
      </section>

      <section aria-labelledby="fm-start-about-authors" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-about-authors">
          Authors
        </h2>
        <ul className="fm-start-people">
          {FULLMAG_AUTHORS.map((author) => (
            <li key={author.name}>
              <span className="fm-start-people__name">{author.name}</span>
              <span className="fm-start-people__meta">{author.affiliation}</span>
            </li>
          ))}
        </ul>
        <p className="fm-start-inspector__note">Project coordination: {FULLMAG_COORDINATION}.</p>
      </section>

      <section aria-labelledby="fm-start-about-cite" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-about-cite">
          Cite FullMag
        </h2>
        <p className="fm-start-inspector__note">{FULLMAG_CITATION_NOTE}.</p>
        <p className="fm-start-about__text">{FULLMAG_CITATION}</p>
        <pre className="fm-start-bibtex">{FULLMAG_BIBTEX}</pre>
        <CopyButton label="Copy BibTeX" text={() => FULLMAG_BIBTEX} />
      </section>

      <section aria-labelledby="fm-start-about-build" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-about-build">
          Build
        </h2>
        {build ? (
          <dl className="fm-start-kv__grid">
            <div className="fm-start-kv__row">
              <dt>Version</dt>
              <dd>
                {build.version} ({build.profile})
              </dd>
            </div>
            <div className="fm-start-kv__row">
              <dt>Platform</dt>
              <dd>
                {build.os} / {build.arch}
              </dd>
            </div>
            <div className="fm-start-kv__row">
              <dt>Project schema</dt>
              <dd>{build.projectSchema}</dd>
            </div>
          </dl>
        ) : (
          <p className="fm-start-inspector__note">The build is reported by the desktop app.</p>
        )}
        <CopyButton label="Copy diagnostics" text={diagnostics} />
      </section>

      <section aria-labelledby="fm-start-about-legal" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-about-legal">
          License and funding
        </h2>
        <p className="fm-start-inspector__note">{FULLMAG_LICENSE}</p>
        <p className="fm-start-inspector__note">{FULLMAG_FUNDING}</p>
      </section>
    </>
  );
}
