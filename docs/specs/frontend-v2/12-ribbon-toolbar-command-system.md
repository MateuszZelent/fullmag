# Frontend v2 - Ribbon, Toolbars, and Command System

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Principle

Menu items, ribbon buttons, viewport toolbar controls, context menus, shortcuts, and command palette entries are renderers of one command registry. A command exists once.

Ribbon, toolbar, menu, context-menu, tab, tooltip, and command-palette renderers are built from shared shadcn/ui-style primitives. Module contributions describe commands and groups; they do not define bespoke button systems.

## 2. Command Contract

```typescript
export interface CommandContribution {
  id: CommandId;
  title: string;
  description?: string;
  group: CommandGroupId;
  icon?: IconToken;
  scope: "global" | "workspace" | "selection" | "viewport" | "runtime" | "debug";
  capabilityGate?: CapabilityGate;
  selectionGate?: SelectionGate;
  runtimeGate?: RuntimeGate;
  confirmation?: ConfirmationSpec;
  run: (ctx: CommandContext) => Promise<CommandResult> | CommandResult;
}
```

Command ids use domain names: `mesh.build-selected`, `study.run-active`, `viewport.set-quantity`, `results.export-artifact`.

## 3. Ribbon Contexts

| Context | Groups |
|---|---|
| `Home` | session, open/recent, export, diagnostics |
| `Definitions` | parameters, materials, named quantities, Python sync |
| `Geometry` | primitives, transforms, booleans, validation, view tools |
| `Materials` | material library, assignment, tensor/scalar edits |
| `Physics` | interactions, boundary conditions, external fields, validation |
| `Mesh` | universe mesh, object mesh, shared-domain build, quality, reports |
| `Study` | stages, execution selection, run controls, provenance |
| `Results` | datasets, charts, artifacts, export |
| `Automation` | scripts, batch, managed runtimes, schedules |

Modules contribute groups declaratively. The ribbon chooses visible groups from active context, selection, and capability state.

The ribbon visual layer consumes Catppuccin-backed `--fm-*` tokens only. Raw colors, module-local button styles, and duplicate command widgets are not allowed.

## 4. Button States

Ribbon buttons must distinguish:

- enabled;
- disabled by selection;
- disabled by missing capability;
- degraded;
- running;
- pending command acceptance;
- failed last command;
- stale resource dependency.

Disabled controls need an explanation. Hidden controls are allowed only when a module is disabled or a command is irrelevant to the active context.

## 5. Toolbars

Viewport toolbars are command renderers with compact placement. They may hold transient viewport preferences, but any canonical visualization state goes through `visualization` resources.

Common toolbar groups:

- view mode: 3D, 2D, split, chart;
- quantity: active field/scalar quantity;
- layers: mesh, vectors, scalar surface, airbox, axes, selection;
- camera: fit all, fit selected, orthographic/perspective, saved views;
- selection tools: pick, box select, isolate, clear;
- diagnostics: render stats, resource counts, capture snapshot.

## 6. Shortcuts

Shortcut ownership belongs to command registry. A shortcut cannot call a module function directly.

Shortcut conflicts are resolved by scope:

1. focused input/editor;
2. modal/dialog;
3. active viewport;
4. active workspace context;
5. global.

The command palette must show the currently effective shortcut.

## 7. Command Execution

Command execution must preserve user intent and resolved reality:

- requested discretization/device/precision remain visible;
- resolved backend/device/precision come from runtime resources;
- unsupported execution fails clearly or degrades explicitly;
- stage stop reason is shown when a command completes a stage.

Commands that mutate server state must return or lead to command completion resources. Local-only commands such as panel toggles may return immediately.

## 8. Tests

Required tests:

- command registry rejects duplicate ids;
- ribbon renders only commands matching context and gates;
- same command can run from menu, ribbon, shortcut, and palette;
- disabled command exposes a reason;
- runtime command path handles accepted, rejected, completed, failed.
