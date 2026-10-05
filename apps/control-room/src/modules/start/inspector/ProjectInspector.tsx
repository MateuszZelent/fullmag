import { BookOpen, Box, GraduationCap, Import, Info, LayoutGrid, Settings, type LucideIcon } from "lucide-react";

import type { ScriptSaver } from "../model/scriptOpen";
import type { StartSection } from "../model/startScreenState";
import { STUDY_TEMPLATES } from "../model/templates";
import type { ComputeProbeState, ContinueSession, RecentEntry, RecentIndexState } from "../model/types";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";
import type { ApiWorkspaceItem } from "../model/workspaceApiTypes";
import type { WorkspaceItem, WorkspaceItemId } from "../model/workspaceItems";

import { AboutInspector } from "./AboutInspector";
import { ProjectDetails } from "./ProjectDetails";
import { ResultInspector, type ResultInspectorProps } from "./ResultInspector";
import { ScriptInspector, type ScriptInspectorProps } from "./ScriptInspector";
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
    body: "Select a project, a script or a result folder in the list to see its details, history and runs.",
  },
  templates: {
    icon: LayoutGrid,
    title: "Pick a template",
    body: "Select a template to see its model, the expected runtime and the reference it reproduces, then create a Python script from it.",
  },
  import: {
    icon: Import,
    title: "Nothing staged",
    body: "Choose a file and Fullmag reports what maps cleanly and what needs a decision before anything is written. A translated .mx3 is saved as a Python script.",
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

/** What the script inspector needs beyond the item and its detail. */
export type ScriptInspectorActions = Omit<ScriptInspectorProps, "item" | "detail" | "desktopId"> & {
  /** The desktop host's own id for a script, which running it needs. */
  readonly desktopIdOf: (id: WorkspaceItemId) => number | null;
};

export type ResultInspectorActions = Omit<
  ResultInspectorProps,
  "item" | "detail" | "openDisabledReason"
>;

const IDLE: WorkspaceItemDetailState = { kind: "idle" };

export interface ProjectInspectorProps {
  readonly section: StartSection;
  /** The selected recent project; only the Home section has one. */
  readonly entry: RecentEntry | null;
  readonly templateId: string | null;
  readonly compute: ComputeProbeState;
  readonly session?: ContinueSession;
  readonly openDisabledReason: string | null;
  readonly onOpen: (entry: RecentEntry) => Promise<string | null>;
  /** Opens the project and shows its saved results; omitted, the viewer button is not offered. */
  readonly onOpenResults?: (entry: RecentEntry) => Promise<string | null>;
  /** Selects a result folder in the list (a row of the project's Runs tab). */
  readonly onSelectResult?: (id: string) => void;
  /** URL that downloads a result folder as a zip (the project's Runs tab). */
  readonly archiveUrl?: (id: string) => string;
  /** What the HTTP workspace API read from the selected item; idle without it. */
  readonly detail?: WorkspaceItemDetailState;
  readonly onTogglePin: (projectId: string, pinned: boolean) => void;
  readonly onForget: (projectId: string) => void;
  /** The selected script; only the Home section has one. */
  readonly script?: WorkspaceItem | null;
  readonly scriptActions?: ScriptInspectorActions | null;
  /** The selected result folder; only the Home section has one. */
  readonly result?: ApiWorkspaceItem | null;
  readonly resultActions?: ResultInspectorActions | null;
  /** Saves a template script as a new file; null where there is no desktop host. */
  readonly scriptSaver?: ScriptSaver | null;
  readonly index?: RecentIndexState;
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
  scriptSaver = null,
  script = null,
  scriptActions = null,
  result = null,
  resultActions = null,
  detail = IDLE,
  index,
  ...actions
}: ProjectInspectorProps) {
  if (section === "about") {
    return <AboutInspector compute={compute} index={index} />;
  }
  const template = STUDY_TEMPLATES.find((t) => t.id === templateId);
  if (section === "templates" && template) {
    return (
      <TemplateDetails
        compute={compute}
        key={template.id}
        scriptSaver={scriptSaver}
        template={template}
      />
    );
  }
  if (section === "home" && entry) {
    // Keyed so the tab and the copied flag reset when another project is chosen.
    return <ProjectDetails detail={detail} entry={entry} key={entry.projectId} {...actions} />;
  }
  if (section === "home" && script && scriptActions) {
    // Keyed so the notice and the history reset when another script is chosen.
    const { desktopIdOf, ...rest } = scriptActions;
    return (
      <ScriptInspector
        desktopId={desktopIdOf(script.id)}
        detail={detail}
        item={script}
        key={script.id}
        {...rest}
      />
    );
  }
  if (section === "home" && result && resultActions) {
    return (
      <ResultInspector
        detail={detail}
        item={result}
        key={result.id}
        openDisabledReason={actions.openDisabledReason}
        {...resultActions}
      />
    );
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
