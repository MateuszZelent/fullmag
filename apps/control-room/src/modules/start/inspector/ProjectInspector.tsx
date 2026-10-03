import { Box, GraduationCap, Import, Info, LayoutGrid, Settings, type LucideIcon } from "lucide-react";

import type { StartSection } from "../model/startScreenState";

interface InspectorHint {
  readonly body: string;
  readonly icon: LucideIcon;
  readonly title: string;
}

const INSPECTOR_HINTS: Readonly<Record<StartSection, InspectorHint>> = {
  home: {
    icon: Box,
    title: "No project selected",
    body: "Select a project in the list to see its model, authors, history and runs.",
  },
  templates: {
    icon: LayoutGrid,
    title: "Pick a template",
    body: "Select a template to see its model, the expected runtime and the reference it reproduces.",
  },
  import: {
    icon: Import,
    title: "Nothing staged",
    body: "Choose a file and Fullmag reports what maps cleanly and what needs a decision before anything is written.",
  },
  learn: {
    icon: GraduationCap,
    title: "Learn",
    body: "Release notes, the keyboard map and links to the documentation.",
  },
  settings: {
    icon: Settings,
    title: "Settings",
    body: "Changes apply immediately. The full preferences dialog has the rest.",
  },
  about: {
    icon: Info,
    title: "About",
    body: "Build, runtime and citation information.",
  },
};

/**
 * Until the recent index exists there is nothing to select, so the inspector
 * explains what will appear here for the current section.
 */
export function ProjectInspector({ section }: { readonly section: StartSection }) {
  const hint = INSPECTOR_HINTS[section];
  const Icon = hint.icon;
  return (
    <aside aria-label="Project details" className="fm-start__inspector">
      <div className="fm-start-empty">
        <span aria-hidden="true" className="fm-start-empty__glyph">
          <Icon size={20} />
        </span>
        <h2>{hint.title}</h2>
        <p>{hint.body}</p>
      </div>
    </aside>
  );
}
