"use client";

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";
import { Button } from "@/shared/ui/Button";

import { readBuildInfo, type BuildInfo } from "../model/buildInfo";
import { buildDiagnostics } from "../model/diagnostics";
import type { ComputeProbeState, RecentIndexState } from "../model/types";

export interface AboutSectionProps {
  readonly compute: ComputeProbeState;
  readonly index: RecentIndexState;
}

export function AboutSection({ compute, index }: AboutSectionProps) {
  const [copied, setCopied] = useState(false);
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

  const copyDiagnostics = () => {
    const text = buildDiagnostics({
      host: tauriInvoke() ? "desktop" : "browser",
      userAgent: navigator.userAgent,
      locale: navigator.language,
      now: new Date(),
      build,
      index,
      compute,
    });
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>About Fullmag</h1>
          <p>
            Micromagnetic simulation for magnonics: finite-difference and finite-element, on one
            model.
          </p>
        </div>
      </div>

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
      </section>

      <section aria-labelledby="fm-start-about-diag" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-about-diag">
          Diagnostics
        </h2>
        <p className="fm-start-inspector__note">
          A block describing this window, the project index and the compute probe, ready to paste
          into a bug report.
        </p>
        <Button onClick={copyDiagnostics} size="sm" type="button" variant="secondary">
          <Copy aria-hidden="true" size={14} />
          {copied ? "Copied" : "Copy diagnostics"}
        </Button>
      </section>

      <p className="fm-start-notice">
        The runtime stack and a citation for Fullmag are not exposed to this page yet.
      </p>
    </>
  );
}
