"use client";

import {
  Award,
  BookOpen,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  Globe,
  Grid,
  Layers,
  Network,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";
import { Button } from "@/shared/ui/Button";

import {
  FULLMAG_BIBTEX,
  FULLMAG_CAPABILITY_MATRIX_URL,
  FULLMAG_CITATION,
  FULLMAG_CITATION_NOTE,
  FULLMAG_COORDINATION,
  FULLMAG_DOCS_URL,
  FULLMAG_PIPELINE_STAGES,
  FULLMAG_EXTENDED_AUTHORS,
  FULLMAG_EXTENDED_ENGINES,
  FULLMAG_FUNDING,
  FULLMAG_GRANT_INFO,
  FULLMAG_KEY_PILLARS,
  FULLMAG_LICENSE,
  FULLMAG_OVERVIEW,
  FULLMAG_PHYSICS_MODULES,
  FULLMAG_REPOSITORY_URL,
  FULLMAG_TAGLINE,
  FULLMAG_TOOLCHAIN_BADGES,
} from "../model/aboutFullmag";
import { readBuildInfo, type BuildInfo } from "../model/buildInfo";
import { buildDiagnostics } from "../model/diagnostics";
import { startScreenStore } from "../model/startScreenState";
import type { ComputeProbeState, RecentIndexState } from "../model/types";

export interface AboutSectionProps {
  readonly compute: ComputeProbeState;
  readonly index: RecentIndexState;
}

type AboutTabId = "all" | "engines" | "pipeline" | "physics" | "authors" | "citation" | "toolchain";

const TAB_ITEMS: readonly { readonly id: AboutTabId; readonly label: string }[] = [
  { id: "all", label: "Overview" },
  { id: "engines", label: "Dual Solvers (FDM / FEM)" },
  { id: "pipeline", label: "Execution Pipeline" },
  { id: "physics", label: "Physics & Studies" },
  { id: "authors", label: "Authors & Grant" },
  { id: "citation", label: "Cite FullMag" },
  { id: "toolchain", label: "Toolchain & System" },
];

export function AboutSection({ compute, index }: AboutSectionProps) {
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [activeTab, setActiveTab] = useState<AboutTabId>("all");
  const [copiedBibtex, setCopiedBibtex] = useState(false);
  const [copiedCitation, setCopiedCitation] = useState(false);
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

  const handleCopyCitation = () => {
    void navigator.clipboard?.writeText(FULLMAG_CITATION).then(() => {
      setCopiedCitation(true);
      setTimeout(() => setCopiedCitation(false), 1800);
    });
  };

  const handleCopyDiagnostics = () => {
    const text = buildDiagnostics({
      host: tauriInvoke() ? "desktop" : "browser",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "SSR",
      locale: typeof navigator !== "undefined" ? navigator.language : "en",
      now: new Date(),
      build,
      index,
      compute,
    });
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedDiag(true);
      setTimeout(() => setCopiedDiag(false), 1800);
    });
  };

  const showAll = activeTab === "all";

  return (
    <div className="fm-about-container">
      {/* ── Brand Hero Banner ── */}
      <header className="fm-about-hero">
        <div aria-hidden="true" className="fm-about-hero__glow" />
        <div className="fm-about-hero__top">
          <div aria-hidden="true" className="fm-about-hero__logo">
            <svg
              fill="none"
              height="36"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="36"
            >
              <circle cx="12" cy="12" r="10" strokeDasharray="3 3" />
              <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(30 12 12)" />
              <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-30 12 12)" />
              <path d="M12 2v20" />
              <path d="M2 12h20" />
              <circle cx="12" cy="12" fill="currentColor" r="2" />
            </svg>
          </div>
          <div className="fm-about-hero__header-text">
            <div className="fm-about-hero__badges">
              <span className="fm-start-badge">FullMag v0.1.0</span>
              <span className="fm-start-badge fm-start-badge--fem">Hybrid Solvers</span>
              <span className="fm-start-pill fm-start-pill--ready">
                <span className="fm-start-pill__dot" />
                Active Research
              </span>
            </div>
            <h1 className="fm-about-hero__title">FullMag</h1>
            <p className="fm-about-hero__tagline">{FULLMAG_TAGLINE}</p>
            <p className="fm-about-hero__lead">
              <strong>One study model · multiple numerical engines · advanced relaxation and spectral solvers · explicit provenance.</strong>
            </p>
          </div>
        </div>

        {FULLMAG_OVERVIEW.map((paragraph) => (
          <p className="fm-start-about__text" key={paragraph}>
            {paragraph}
          </p>
        ))}

        <div className="fm-about-hero__actions">
          <Button
            onClick={() => startScreenStore.setSection("docs")}
            size="sm"
            type="button"
            variant="primary"
          >
            <BookOpen size={14} />
            Explore Documentation
          </Button>
          <Button asChild size="sm" variant="secondary">
            <a href={FULLMAG_REPOSITORY_URL} rel="noreferrer" target="_blank">
              <ExternalLink size={14} />
              GitHub Repository
            </a>
          </Button>
          <Button asChild size="sm" variant="secondary">
            <a href={FULLMAG_DOCS_URL} rel="noreferrer" target="_blank">
              <Globe size={14} />
              Online Portal
            </a>
          </Button>
          <Button onClick={handleCopyBibtex} size="sm" type="button" variant="secondary">
            {copiedBibtex ? <Check size={14} style={{ color: "var(--fm-success)" }} /> : <Copy size={14} />}
            {copiedBibtex ? "BibTeX Copied!" : "Copy BibTeX"}
          </Button>
        </div>
      </header>

      {/* ── Key Architectural Pillars ── */}
      <section aria-label="Core Architectural Pillars" className="fm-about-pillars">
        {FULLMAG_KEY_PILLARS.map((pillar) => (
          <div className="fm-about-pillar" key={pillar.id}>
            <div className="fm-about-pillar__head">
              <span className="fm-about-pillar__icon">
                {pillar.id === "solvers" && <Layers size={16} />}
                {pillar.id === "hardware" && <Cpu size={16} />}
                {pillar.id === "ir" && <Code2 size={16} />}
                {pillar.id === "strict" && <ShieldCheck size={16} />}
              </span>
              <span className="fm-about-pillar__value">{pillar.value}</span>
            </div>
            <h3 className="fm-about-pillar__title">{pillar.title}</h3>
            <p className="fm-about-pillar__desc">{pillar.desc}</p>
          </div>
        ))}
      </section>

      {/* ── Section Navigator Tabs ── */}
      <nav aria-label="About section categories" className="fm-about-nav-tabs">
        {TAB_ITEMS.map((tab) => (
          <button
            className={`fm-about-nav-tab ${activeTab === tab.id ? "fm-about-nav-tab--active" : ""}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ── Dual Numerical Solvers (FDM vs FEM) ── */}
      {(showAll || activeTab === "engines") && (
        <section aria-labelledby="fm-about-engines-title" className="fm-start-section">
          <h2 className="fm-start-section__title" id="fm-about-engines-title">
            Dual Numerical Solvers
          </h2>
          <div className="fm-about-engines">
            {FULLMAG_EXTENDED_ENGINES.map((engine) => (
              <div
                className={`fm-about-engine-card fm-about-engine-card--${engine.accent}`}
                key={engine.id}
              >
                <div className="fm-about-engine-card__head">
                  <span className={`fm-start-badge ${engine.accent === "fem" ? "fm-start-badge--fem" : ""}`}>
                    {engine.badge}
                  </span>
                  <span style={{ color: `var(--fm-solver-${engine.accent})` }}>
                    {engine.id === "fdm" ? <Grid size={20} /> : <Network size={20} />}
                  </span>
                </div>
                <div className="fm-about-engine-card__title-group">
                  <h3 className="fm-about-engine-card__title">{engine.title}</h3>
                  <p className="fm-about-engine-card__subtitle">{engine.subtitle}</p>
                </div>

                <div className="fm-about-engine-card__section">
                  <div className="fm-about-engine-card__label">Best Suited To</div>
                  <p className="fm-about-engine-card__value">{engine.bestFor}</p>
                </div>

                <div className="fm-about-engine-card__specs">
                  <dl className="fm-about-spec-row">
                    <dt>Discretization</dt>
                    <dd>{engine.discretization}</dd>
                  </dl>
                  <dl className="fm-about-spec-row">
                    <dt>Demagnetization</dt>
                    <dd>{engine.demagMethod}</dd>
                  </dl>
                  <dl className="fm-about-spec-row">
                    <dt>CPU Path</dt>
                    <dd>{engine.cpuPath}</dd>
                  </dl>
                  <dl className="fm-about-spec-row">
                    <dt>GPU Path</dt>
                    <dd>{engine.gpuPath}</dd>
                  </dl>
                </div>

                <div className="fm-about-engine-card__tags">
                  {engine.features.map((feat) => (
                    <span className="fm-start-badge" key={feat}>
                      {feat}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Execution Pipeline Workflow ── */}
      {(showAll || activeTab === "pipeline") && (
        <section aria-labelledby="fm-about-pipeline-title" className="fm-start-section">
          <div className="fm-about-pipeline">
            <div className="fm-about-pipeline__head">
              <div>
                <h2 className="fm-about-pipeline__title" id="fm-about-pipeline-title">
                  Canonical Execution Pipeline
                </h2>
                <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--fm-start-meta)" }}>
                  Strict lowering from authoring to hardware lanes with full reproducibility and zero silent fallback.
                </p>
              </div>
              <Button asChild size="sm" variant="ghost">
                <a href={FULLMAG_CAPABILITY_MATRIX_URL} rel="noreferrer" target="_blank">
                  Capability Matrix <ChevronRight size={14} />
                </a>
              </Button>
            </div>

            <div className="fm-about-pipeline__steps">
              {FULLMAG_PIPELINE_STAGES.map((stage) => (
                <div className="fm-about-step" key={stage.step}>
                  <div className="fm-about-step__top">
                    <span className="fm-about-step__num">{stage.step}</span>
                    <span className="fm-about-step__tag">{stage.tag}</span>
                  </div>
                  <h4 className="fm-about-step__title">{stage.title}</h4>
                  <div className="fm-about-step__subtitle">{stage.subtitle}</div>
                  <p className="fm-about-step__desc">{stage.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Studies & Physics Scope ── */}
      {(showAll || activeTab === "physics") && (
        <section aria-labelledby="fm-about-physics-title" className="fm-start-section">
          <h2 className="fm-start-section__title" id="fm-about-physics-title">
            Studies & Physics Scope
          </h2>
          <div className="fm-about-physics-grid">
            {FULLMAG_PHYSICS_MODULES.map((mod) => (
              <div className="fm-about-physics-card" key={mod.title}>
                <div className="fm-about-physics-card__head">
                  <h3 className="fm-about-physics-card__title">{mod.title}</h3>
                  <span className="fm-start-badge">{mod.category}</span>
                </div>
                <p className="fm-about-physics-card__desc">{mod.description}</p>
                <p className="fm-about-physics-card__scope">{mod.scope}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Scientific Authors & Leadership ── */}
      {(showAll || activeTab === "authors") && (
        <section aria-labelledby="fm-about-authors-title" className="fm-start-section">
          <h2 className="fm-start-section__title" id="fm-about-authors-title">
            Authors & Scientific Leadership
          </h2>
          <div className="fm-about-authors">
            {FULLMAG_EXTENDED_AUTHORS.map((author) => (
              <div
                className={`fm-about-author-card ${author.isLead ? "fm-about-author-card--lead" : ""}`}
                key={author.name}
              >
                <div className="fm-about-author-card__top">
                  <div className="fm-about-author-avatar">{author.initials}</div>
                  <div>
                    <h3 className="fm-about-author-name">{author.name}</h3>
                    <div className="fm-about-author-role">{author.role}</div>
                  </div>
                </div>

                <div className="fm-about-author-affil">
                  <div><strong>{author.institution}</strong></div>
                  <div style={{ color: "var(--fm-start-meta)", fontSize: "11px" }}>
                    {author.department}, {author.location}
                  </div>
                </div>

                {author.grantBadge && (
                  <div style={{ marginBottom: "10px" }}>
                    <span className="fm-start-badge fm-start-badge--fem">
                      ★ {author.grantBadge}
                    </span>
                  </div>
                )}

                <div className="fm-about-author-focus">
                  <strong>Focus:</strong> {author.focus}
                </div>
              </div>
            ))}
          </div>

          <div className="fm-about-coordination-bar" style={{ marginTop: "16px" }}>
            <Award size={18} style={{ color: "var(--fm-accent)", flexShrink: 0 }} />
            <span>Project coordination: <strong>{FULLMAG_COORDINATION}</strong></span>
          </div>

          {/* ── European Union Horizon Europe MSCA Grant Banner ── */}
          <div className="fm-about-grant" style={{ marginTop: "16px" }}>
            <div aria-hidden="true" className="fm-about-grant__eu-flag">
              <svg height="24" viewBox="0 0 48 34" width="36">
                <rect fill="var(--fm-bg-panel-raised)" height="34" width="48" />
                <circle cx="24" cy="17" fill="none" r="10" stroke="var(--fm-accent)" strokeDasharray="1.5 3.7" strokeWidth="2.5" />
              </svg>
            </div>
            <div className="fm-about-grant__body">
              <h3 className="fm-about-grant__title">
                European Union Horizon Europe Funding
              </h3>
              <div className="fm-about-grant__call">
                {FULLMAG_GRANT_INFO.scheme} · Call {FULLMAG_GRANT_INFO.call} · Grant No. <strong>{FULLMAG_GRANT_INFO.grantNumber} ({FULLMAG_GRANT_INFO.projectAcronym})</strong>
              </div>
              <p className="fm-about-grant__text">
                {FULLMAG_FUNDING}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── Cite FullMag & BibTeX ── */}
      {(showAll || activeTab === "citation") && (
        <section aria-labelledby="fm-about-cite-title" className="fm-start-section">
          <h2 className="fm-start-section__title" id="fm-about-cite-title">
            Cite FullMag
          </h2>
          <div className="fm-about-citation-box">
            <p className="fm-start-inspector__note" style={{ margin: 0 }}>
              {FULLMAG_CITATION_NOTE}.
            </p>

            <blockquote className="fm-about-citation-quote">
              {FULLMAG_CITATION}
            </blockquote>

            <div className="fm-about-bibtex-wrapper">
              <div className="fm-about-bibtex-header">
                <span style={{ fontSize: "11px", fontFamily: "var(--fm-font-mono)", color: "var(--fm-start-meta)" }}>
                  software (fullmag_2026) · BibTeX
                </span>
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button onClick={handleCopyCitation} size="sm" type="button" variant="ghost">
                    {copiedCitation ? <Check size={12} style={{ color: "var(--fm-success)" }} /> : <Copy size={12} />}
                    {copiedCitation ? "Copied" : "Copy Plain Text"}
                  </Button>
                  <Button onClick={handleCopyBibtex} size="sm" type="button" variant="secondary">
                    {copiedBibtex ? <Check size={12} style={{ color: "var(--fm-success)" }} /> : <Copy size={12} />}
                    {copiedBibtex ? "Copied" : "Copy BibTeX"}
                  </Button>
                </div>
              </div>
              <pre className="fm-about-bibtex-code">{FULLMAG_BIBTEX}</pre>
            </div>
          </div>
        </section>
      )}

      {/* ── Toolchain & Live Build Diagnostics ── */}
      {(showAll || activeTab === "toolchain") && (
        <section aria-labelledby="fm-about-toolchain-title" className="fm-start-section">
          <h2 className="fm-start-section__title" id="fm-about-toolchain-title">
            Toolchain & Verified Ecosystem
          </h2>

          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="fm-about-toolchain">
              {FULLMAG_TOOLCHAIN_BADGES.map((badge) => (
                <div
                  className={`fm-about-badge-chip ${badge.isAccent ? "fm-about-badge-chip--accent" : ""}`}
                  key={badge.name}
                >
                  <span>{badge.name}</span>
                  <span className="fm-about-badge-chip__version">{badge.version}</span>
                </div>
              ))}
            </div>

            <div className="fm-about-citation-box">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, fontSize: "13px", fontWeight: "600", color: "var(--fm-text-primary)" }}>
                  Host System Diagnostics
                </h3>
                <Button onClick={handleCopyDiagnostics} size="sm" type="button" variant="secondary">
                  {copiedDiag ? <Check size={14} style={{ color: "var(--fm-success)" }} /> : <Cpu size={14} />}
                  {copiedDiag ? "Copied Diagnostics" : "Copy Diagnostics"}
                </Button>
              </div>

              {build ? (
                <dl className="fm-start-kv__grid">
                  <div className="fm-start-kv__row">
                    <dt>Version</dt>
                    <dd>{build.version} ({build.profile})</dd>
                  </div>
                  <div className="fm-start-kv__row">
                    <dt>Platform</dt>
                    <dd>{build.os} / {build.arch}</dd>
                  </div>
                  <div className="fm-start-kv__row">
                    <dt>Project schema</dt>
                    <dd>{build.projectSchema}</dd>
                  </div>
                </dl>
              ) : (
                <p className="fm-start-inspector__note" style={{ margin: 0 }}>
                  Host build details are reported by the desktop runtime. Running in {tauriInvoke() ? "desktop mode" : "browser environment"}.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── License & Intellectual Property Notice ── */}
      <section aria-labelledby="fm-about-license-title" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-about-license-title">
          License & Terms
        </h2>
        <div className="fm-about-citation-box">
          <p className="fm-start-about__text" style={{ margin: 0 }}>
            {FULLMAG_LICENSE}
          </p>
        </div>
      </section>
    </div>
  );
}
