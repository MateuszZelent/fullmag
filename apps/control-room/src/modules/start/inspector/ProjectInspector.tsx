import { BookOpen, Box, GraduationCap, Import, Info, LayoutGrid, Settings, type LucideIcon } from "lucide-react";

import type { ScriptOpener } from "../model/scriptOpen";
import type { StartSection } from "../model/startScreenState";
import { STUDY_TEMPLATES } from "../model/templates";
import type { ComputeProbeState, ContinueSession, RecentEntry } from "../model/types";

import type { WorkspaceItem } from "../model/workspaceItems";

import { ProjectDetails } from "./ProjectDetails";
import { ScriptDetails, type ScriptDetailsProps } from "./ScriptDetails";
import { TemplateDetails } from "./TemplateDetails";

interface InspectorHint {
  readonly body: string;
  readonly icon: LucideIcon;
  readonly title: string;
}

const INSPECTOR_HINTS: Readonly<Record<StartSection, InspectorHint>> = {
  home: {
    icon: Box,
    title: "Nothing selected",
    body: "Select a project or a script in the list to see its details, history and runs.",
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
  /** The selected script; only the Home section has one. */
  readonly script?: WorkspaceItem | null;
  readonly scriptActions?: Omit<ScriptDetailsProps, "item"> | null;
  /** Opens a template script as a project; null when this build cannot. */
  readonly scriptOpener?: ScriptOpener | null;
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
  scriptOpener = null,
  script = null,
  scriptActions = null,
  ...actions
}: ProjectInspectorProps) {
  const template = STUDY_TEMPLATES.find((t) => t.id === templateId);
  if (section === "templates" && template) {
    return (
      <TemplateDetails
        compute={compute}
        key={template.id}
        scriptOpener={scriptOpener}
        template={template}
      />
    );
  }
  if (section === "home" && entry) {
    // Keyed so the tab and the copied flag reset when another project is chosen.
    return <ProjectDetails entry={entry} key={entry.projectId} {...actions} />;
  }
  if (section === "home" && script && scriptActions) {
    // Keyed so the notice and the history reset when another script is chosen.
    return <ScriptDetails item={script} key={script.id} {...scriptActions} />;
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
