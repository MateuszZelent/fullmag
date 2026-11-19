"use client";

import { ArrowRight, ExternalLink } from "lucide-react";

import { FULLMAG_REPOSITORY_URL } from "../model/aboutFullmag";
import { startScreenStore } from "../model/startScreenState";

interface KeyGroup {
  readonly title: string;
  readonly rows: readonly { readonly action: string; readonly keys: string }[];
}

interface LearnResource {
  readonly title: string;
  readonly description: string;
  readonly page?: string;
  readonly href?: string;
}

export const LEARN_RESOURCES: readonly LearnResource[] = [
  {
    title: "Documentation",
    description: "Model reference, solver options and the Python API.",
    page: "index.html",
  },
  {
    title: "Getting started & tutorials",
    description: "Guided FDM and FEM studies from a first relaxation to full dispersion maps.",
    page: "getting-started/index.html",
  },
  {
    title: "Python API reference",
    description: "Stage-oriented study authoring, geometry, materials, interactions and outputs.",
    page: "python-api/index.html",
  },
  {
    title: "µMAG benchmarks",
    description: "Standard problems and analytical validation cases.",
    page: "validation/mumag-standard-problems.html",
  },
  {
    title: "Documentation changelog",
    description: "Recent documentation updates and release notes.",
    page: "changelog/index.html",
  },
  {
    title: "Report an issue",
    description: "Bug reports and feature requests on the FullMag GitHub tracker.",
    href: `${FULLMAG_REPOSITORY_URL}/issues`,
  },
];

/** The map the interaction spec documents; every action is also in the palette. */
export const KEY_GROUPS: readonly KeyGroup[] = [
  {
    title: "Anywhere on the start screen",
    rows: [
      { action: "Command search", keys: "Ctrl ⇧ P" },
      { action: "New FDM simulation", keys: "Ctrl N" },
      { action: "New FEM simulation", keys: "Ctrl ⇧ N" },
      { action: "Open project…", keys: "Ctrl O" },
      { action: "Browse templates", keys: "Ctrl T" },
      { action: "Import model", keys: "Ctrl I" },
      { action: "Documentation", keys: "F1" },
      { action: "Settings", keys: "Ctrl ," },
      { action: "Sections Overview, Templates, Import, Learn", keys: "Ctrl 1 … Ctrl 4" },
    ],
  },
  {
    title: "Recent projects list",
    rows: [
      { action: "Focus the filter", keys: "/" },
      { action: "Move selection", keys: "↑ ↓ (grid: ← → too)" },
      { action: "Jump a group", keys: "PgUp PgDn" },
      { action: "First / last", keys: "Home End" },
      { action: "Open", keys: "Enter" },
      { action: "Pin / unpin", keys: "Ctrl P" },
      { action: "Remove from recent", keys: "Del" },
    ],
  },
  {
    title: "Inspector",
    rows: [{ action: "Move between tabs", keys: "← →" }],
  },
];

export function LearnSection() {
  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>Learn</h1>
          <p>The things you look up rather than memorise.</p>
        </div>
      </div>

      <section aria-labelledby="fm-start-resources-title" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-resources-title">
          Resources
        </h2>
        <div className="fm-start-resources">
          {LEARN_RESOURCES.map((resource) =>
            resource.page ? (
              <button
                className="fm-start-resource-card"
                key={resource.title}
                onClick={() => startScreenStore.requestDocs(resource.page)}
                type="button"
              >
                <div className="fm-start-resource-card__head">
                  <span className="fm-start-resource-card__title">{resource.title}</span>
                  <ArrowRight aria-hidden="true" size={14} />
                </div>
                <p className="fm-start-resource-card__desc">{resource.description}</p>
              </button>
            ) : (
              <a
                className="fm-start-resource-card"
                href={resource.href}
                key={resource.title}
                rel="noreferrer"
                target="_blank"
              >
                <div className="fm-start-resource-card__head">
                  <span className="fm-start-resource-card__title">{resource.title}</span>
                  <ExternalLink aria-hidden="true" size={14} />
                </div>
                <p className="fm-start-resource-card__desc">{resource.description}</p>
              </a>
            ),
          )}
        </div>
      </section>

      <section aria-labelledby="fm-start-keys-title" className="fm-start-section">
        <h2 className="fm-start-section__title" id="fm-start-keys-title">
          Keyboard map
        </h2>
        {KEY_GROUPS.map((group) => (
          <div className="fm-start-keys" key={group.title}>
            <h3 className="fm-start-kv__title">{group.title}</h3>
            <dl className="fm-start-kv__grid">
              {group.rows.map((row) => (
                <div className="fm-start-kv__row" key={row.action}>
                  <dt>{row.action}</dt>
                  <dd>{row.keys}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>

      <p className="fm-start-notice">
        Every start-screen action is also listed in the command palette (Ctrl ⇧ P).
      </p>
    </>
  );
}
