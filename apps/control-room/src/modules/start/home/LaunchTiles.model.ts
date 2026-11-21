import { FileCode2, FlaskConical, Grid3x3, Import, Triangle, type LucideIcon } from "lucide-react";

type TileTone = "fdm" | "fem" | "import" | "template" | "script";

interface LaunchTile {
  readonly commandId: string;
  readonly description: string;
  readonly foot: string;
  readonly icon: LucideIcon;
  readonly id: string;
  /** Absent when the command has no shortcut (Ctrl+Shift+O is taken). */
  readonly keys?: string;
  readonly name: string;
  readonly shortcut?: string;
  readonly tone: TileTone;
}

export const LAUNCH_TILES: readonly LaunchTile[] = [
  {
    commandId: "start.new-fdm",
    description:
      "Structured finite-difference grid. GPU-accelerated, best for large uniform geometries.",
    foot: "empty problem",
    icon: Grid3x3,
    id: "fdm",
    keys: "Control+N",
    name: "FDM simulation",
    shortcut: "Ctrl N",
    tone: "fdm",
  },
  {
    commandId: "start.new-fem",
    description:
      "Unstructured tetrahedral mesh. Curved bodies, Bloch-periodic eigenmode studies.",
    foot: "empty problem",
    icon: Triangle,
    id: "fem",
    keys: "Control+Shift+N",
    name: "FEM simulation",
    shortcut: "Ctrl ⇧ N",
    tone: "fem",
  },
  {
    commandId: "start.templates",
    description:
      "Benchmarks and ready-made studies saved as Python scripts — µMAG problems, dispersion, FMR, skyrmions.",
    foot: "saved as a .py script",
    icon: FlaskConical,
    id: "template",
    keys: "Control+T",
    name: "From template",
    shortcut: "Ctrl T",
    tone: "template",
  },
  {
    commandId: "start.import",
    description:
      "Bring in an existing model from another micromagnetic package or a Fullmag archive.",
    foot: ".mif · .mx3 · .mph · .fms",
    icon: Import,
    id: "import",
    keys: "Control+I",
    name: "Import",
    shortcut: "Ctrl I",
    tone: "import",
  },
  {
    commandId: "start.open-script",
    description:
      "Add a Python script to your recent work. Fullmag lists it with its last use and last run.",
    foot: ".py · desktop app",
    icon: FileCode2,
    id: "script",
    name: "Open script…",
    tone: "script",
  },
];
