import { FULLMAG_REPOSITORY_URL } from "../model/aboutFullmag";

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
