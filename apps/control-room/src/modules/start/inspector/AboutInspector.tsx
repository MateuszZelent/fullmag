"use client";

import {
  BookOpen,
  Check,
  Compass,
  Copy,
  Cpu,
  ExternalLink,
  Globe,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";
import { Button } from "@/shared/ui/Button";

import {
  FULLMAG_BIBTEX,
  FULLMAG_CAPABILITY_MATRIX_URL,
  FULLMAG_COORDINATION,
  FULLMAG_DOCS_URL,
  FULLMAG_GRANT_INFO,
  FULLMAG_PYTHON_API_URL,
  FULLMAG_REPOSITORY_URL,
} from "../model/aboutFullmag";
import { readBuildInfo, type BuildInfo } from "../model/buildInfo";
import { buildDiagnostics } from "../model/diagnostics";
import { startScreenStore } from "../model/startScreenState";
import type { ComputeProbeState, RecentIndexState } from "../model/types";

export interface AboutInspectorProps {
  readonly compute: ComputeProbeState;
  readonly index?: RecentIndexState;
}

export function AboutInspector({ compute, index }: AboutInspectorProps) {
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [copiedBibtex, setCopiedBibtex] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readBuildInfo().then((found) => {
      if (!cancelled) setBuild(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyBibtex = () => {
    void navigator.clipboard?.writeText(FULLMAG_BIBTEX).then(() => {
      setCopiedBibtex(true);
      setTimeout(() => setCopiedBibtex(false), 1800);
    });
  };

  const handleCopyDiagnostics = () => {
    const text = buildDiagnostics({
      host: tauriInvoke() ? "desktop" : "browser",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "SSR",
      locale: typeof navigator !== "undefined" ? navigator.language : "en",
      now: new Date(),
      build,
      index: index ?? { kind: "unavailable" },
      compute,
    });
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedDiag(true);
      setTimeout(() => setCopiedDiag(false), 1800);
    });
  };

  const gpu = compute?.gpus?.[0];

  return (
    <aside aria-label="About details and runtime" className="fm-start__inspector">
      <div className="fm-about-inspector">
        {/* Header */}
        <div className="fm-about-inspector__head">
          <div className="fm-about-hero__logo" style={{ width: 40, height: 40 }}>
            <Sparkles size={20} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: "14px", fontWeight: "bold", color: "var(--fm-text-primary)" }}>
              FullMag
            </h2>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "2px" }}>
              <span className="fm-start-badge">v0.1.0</span>
              <span className="fm-start-badge fm-start-badge--fem">Hybrid</span>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="fm-about-inspector__card">
          <h3 className="fm-about-inspector__card-title">Quick Actions</h3>
          <div className="fm-about-inspector__btn-group">
            <Button onClick={handleCopyBibtex} size="sm" type="button" variant="secondary">
              {copiedBibtex ? <Check size={14} style={{ color: "var(--fm-success)" }} /> : <Copy size={14} />}
              {copiedBibtex ? "BibTeX Copied!" : "Copy BibTeX"}
            </Button>
            <Button onClick={handleCopyDiagnostics} size="sm" type="button" variant="secondary">
              {copiedDiag ? <Check size={14} style={{ color: "var(--fm-success)" }} /> : <Cpu size={14} />}
              {copiedDiag ? "Diagnostics Copied!" : "Copy Diagnostics"}
            </Button>
            <Button
              onClick={() => startScreenStore.setSection("docs")}
              size="sm"
              type="button"
              variant="secondary"
            >
              <BookOpen size={14} />
              Open Bundled Docs
            </Button>
          </div>
        </div>

        {/* Compute & Runtime Probe */}
        <div className="fm-about-inspector__card">
          <h3 className="fm-about-inspector__card-title">Runtime Environment</h3>
          <dl className="fm-about-spec-row" style={{ margin: 0 }}>
            <dt>Platform Host</dt>
            <dd>{tauriInvoke() ? "Desktop (Tauri)" : "Web Browser"}</dd>
          </dl>
          <dl className="fm-about-spec-row" style={{ margin: 0 }}>
            <dt>CPU Threads</dt>
            <dd>{compute ? `${compute.cpuThreads} threads` : "Probing..."}</dd>
          </dl>
          <dl className="fm-about-spec-row" style={{ margin: 0 }}>
            <dt>GPU Device</dt>
            <dd style={{ maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {gpu ? gpu.name : "None (CPU only)"}
            </dd>
          </dl>
          {gpu?.cudaVersion && (
            <dl className="fm-about-spec-row" style={{ margin: 0 }}>
              <dt>CUDA Version</dt>
              <dd>CUDA {gpu.cudaVersion}</dd>
            </dl>
          )}
          {build && (
            <>
              <dl className="fm-about-spec-row" style={{ margin: 0 }}>
                <dt>Build Target</dt>
                <dd>
                  {build.os} / {build.arch} ({build.profile})
                </dd>
              </dl>
              <dl className="fm-about-spec-row" style={{ margin: 0 }}>
                <dt>Schema Version</dt>
                <dd>{build.projectSchema}</dd>
              </dl>
            </>
          )}
        </div>

        {/* Project Leadership & Coordination */}
        <div className="fm-about-inspector__card">
          <h3 className="fm-about-inspector__card-title">Scientific Project</h3>
          <div style={{ fontSize: "12px", color: "var(--fm-text-secondary)", lineHeight: 1.45 }}>
            <p style={{ margin: "0 0 6px" }}>
              <strong>Coordination:</strong> {FULLMAG_COORDINATION}
            </p>
            <p style={{ margin: "0 0 6px" }}>
              <strong>EU Grant:</strong> MSCA No. {FULLMAG_GRANT_INFO.grantNumber} ({FULLMAG_GRANT_INFO.projectAcronym})
            </p>
            <p style={{ margin: 0, color: "var(--fm-start-meta)", fontSize: "11px" }}>
              One study model · FDM & FEM engines · Explicit provenance
            </p>
          </div>
        </div>

        {/* External Resources */}
        <div className="fm-about-inspector__card">
          <h3 className="fm-about-inspector__card-title">Resources & Links</h3>
          <a
            className="fm-about-inspector__link-item"
            href={FULLMAG_REPOSITORY_URL}
            rel="noreferrer"
            target="_blank"
          >
            <span>GitHub Repository</span>
            <ExternalLink size={12} />
          </a>
          <a
            className="fm-about-inspector__link-item"
            href={FULLMAG_DOCS_URL}
            rel="noreferrer"
            target="_blank"
          >
            <span>Online Documentation</span>
            <Globe size={12} />
          </a>
          <a
            className="fm-about-inspector__link-item"
            href={FULLMAG_PYTHON_API_URL}
            rel="noreferrer"
            target="_blank"
          >
            <span>Python API Reference</span>
            <ExternalLink size={12} />
          </a>
          <a
            className="fm-about-inspector__link-item"
            href={FULLMAG_CAPABILITY_MATRIX_URL}
            rel="noreferrer"
            target="_blank"
          >
            <span>Capability Matrix</span>
            <Compass size={12} />
          </a>
        </div>
      </div>
    </aside>
  );
}
