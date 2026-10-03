"use client";

import { Copy } from "lucide-react";
import { useState } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";
import { Button } from "@/shared/ui/Button";

import { buildDiagnostics } from "../model/diagnostics";
import type { ComputeProbeState, RecentIndexState } from "../model/types";

export interface AboutSectionProps {
  readonly compute: ComputeProbeState;
  readonly index: RecentIndexState;
}

export function AboutSection({ compute, index }: AboutSectionProps) {
  const [copied, setCopied] = useState(false);

  const copyDiagnostics = () => {
    const text = buildDiagnostics({
      host: tauriInvoke() ? "desktop" : "browser",
      userAgent: navigator.userAgent,
      locale: navigator.language,
      now: new Date(),
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
        Build, runtime and citation details are not exposed to this page yet.
      </p>
    </>
  );
}
