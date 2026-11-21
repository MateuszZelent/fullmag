import { BookOpen, GraduationCap, House, Import, Info, LayoutGrid, Settings, type LucideIcon } from "lucide-react";
import { STUDY_TEMPLATES } from "../model/templates";
import type { StartSection } from "../model/startScreenState";

interface RailEntry {
  readonly commandId: string;
  readonly icon: LucideIcon;
  readonly id: StartSection;
  readonly keys?: string;
  readonly label: string;
  readonly shortcut?: string;
  /** A count shown beside the label, e.g. how many templates ship. */
  readonly count?: number;
}

export const RAIL_SECTIONS: readonly RailEntry[] = [
  { commandId: "start.section.home", icon: House, id: "home", keys: "Control+1", label: "Overview", shortcut: "Ctrl 1" },
  { commandId: "start.section.templates", icon: LayoutGrid, id: "templates", keys: "Control+2", label: "Templates", shortcut: "Ctrl 2", count: STUDY_TEMPLATES.length },
  { commandId: "start.section.import", icon: Import, id: "import", keys: "Control+3", label: "Import", shortcut: "Ctrl 3" },
  { commandId: "start.section.learn", icon: GraduationCap, id: "learn", keys: "Control+4", label: "Learn", shortcut: "Ctrl 4" },
  { commandId: "start.section.docs", icon: BookOpen, id: "docs", keys: "F1", label: "Docs", shortcut: "F1" },
  { commandId: "start.section.settings", icon: Settings, id: "settings", keys: "Control+,", label: "Settings", shortcut: "Ctrl ," },
  { commandId: "start.section.about", icon: Info, id: "about", label: "About" },
];
