import type { StartSection } from "../model/startScreenState";

type PlaceholderSection = Exclude<StartSection, "home">;

interface PlaceholderCopy {
  readonly lead: string;
  readonly title: string;
  readonly unavailable: string;
}

/** Page heads come from the mockup; the second paragraph says what is missing. */
const PLACEHOLDER_COPY: Readonly<Record<PlaceholderSection, PlaceholderCopy>> = {
  templates: {
    title: "Templates",
    lead: "Ready-made studies. Each one opens as a new project with geometry, materials and a configured solver.",
    unavailable: "This build does not ship the template gallery yet. Start from an empty FDM or FEM problem on Home.",
  },
  import: {
    title: "Import",
    lead: "Fullmag reads models from the common micromagnetic packages. What cannot be mapped is reported before anything is written.",
    unavailable: "No importer is available in this build yet. Fullmag archives open through Open project…",
  },
  learn: {
    title: "Learn",
    lead: "Documentation, release notes and the keyboard map — the things you look up rather than memorise.",
    unavailable: "Release notes and the keyboard map are not bundled with this build yet. Every start-screen action is listed in the command palette.",
  },
  settings: {
    title: "Settings",
    lead: "What the start screen needs. Everything else lives in the full preferences dialog.",
    unavailable: "Start-screen settings are not available in this build yet.",
  },
  about: {
    title: "About Fullmag",
    lead: "Micromagnetic simulation for magnonics — finite-difference and finite-element, on one model.",
    unavailable: "Build, runtime and citation details are not available in this build yet.",
  },
};

export function SectionPlaceholder({ section }: { readonly section: PlaceholderSection }) {
  const copy = PLACEHOLDER_COPY[section];
  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>{copy.title}</h1>
          <p>{copy.lead}</p>
        </div>
      </div>
      <p className="fm-start-notice">{copy.unavailable}</p>
    </>
  );
}
