import { BookOpen, Box, GraduationCap, Import, Info, LayoutGrid, Settings, type LucideIcon } from "lucide-react";

import type { StartSection } from "../model/startScreenState";
import { STUDY_TEMPLATES } from "../model/templates";
import type { ComputeProbeState, ContinueSession, RecentEntry } from "../model/types";

import { ProjectDetails } from "./ProjectDetails";
import { TemplateDetails } from "./TemplateDetails";

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
  docs: {
    icon: BookOpen,
    title: "Documentation",
    body: "Search the physics, numerics and API documentation bundled with the app.",
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

export interface ProjectInspectorProps {
  readonly section: StartSection;
  /** The selected recent project; only the Home section has one. */
  readonly entry: RecentEntry | null;
  readonly templateId: string | null;
  readonly compute: ComputeProbeState;
  readonly session?: ContinueSession;
  readonly openDisabledReason: string | null;
  readonly onOpen: (entry: RecentEntry) => Promise<string | null>;
  readonly onTogglePin: (projectId: string, pinned: boolean) => void;
  readonly onForget: (projectId: string) => void;
}

/**
 * Details of the selected project, or, when there is none, what will appear
 * here for the current section. It is never blank.
 */
export function ProjectInspector({
  section,
  entry,
  templateId,
  compute,
  ...actions
}: ProjectInspectorProps) {
  const template = STUDY_TEMPLATES.find((t) => t.id === templateId);
  if (section === "templates" && template) {
    return <TemplateDetails compute={compute} key={template.id} template={template} />;
  }
  if (section === "home" && entry) {
    // Keyed so the tab and the copied flag reset when another project is chosen.
    return <ProjectDetails entry={entry} key={entry.projectId} {...actions} />;
  }
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
