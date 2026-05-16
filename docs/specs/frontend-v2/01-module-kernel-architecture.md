# Frontend v2 - Module Kernel Architecture

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Kernel Responsibility

The kernel is the only stable core of frontend v2. It owns:

- application routing and workspace URL state;
- immutable `KernelApi` construction;
- module registry and lifecycle;
- layout slots and persisted layout state;
- typed event bus;
- command registry;
- API facade and resource invalidation;
- realtime event ingestion;
- diagnostics and performance counters;
- error boundaries around module roots.

The kernel does not own physics semantics, viewport rendering internals, inspector forms, chart composition, or model-tree rendering. Those are module responsibilities.

## 2. Module Rule

A module is a directory under `apps/control-room/src/modules/<module-id>/` with one purpose, one manifest, one root component, optional module-local store, and optional command/menu/ribbon contributions.

A module may import:

- `@/kernel/...`;
- `@/shared/...`;
- its own relative files;
- generated types through kernel API facades when explicitly allowed.

A module must not import another module's components, hooks, store, internal types, or renderer classes. Shared code moves either to `src/shared` or to a kernel/domain adapter after review.

## 3. Slot Model

Slots are stable mount points owned by the kernel:

| Slot | Purpose | Examples |
|---|---|---|
| `app-menu` | top menu bar | main menu renderer |
| `ribbon` | context command groups | geometry, mesh, solver, view commands |
| `panel-left` | primary navigation | explorer, results navigator |
| `viewport-main` | central primary view | 3D viewport, 2D viewport |
| `viewport-aux` | split or secondary view | slice view, profile view, small chart |
| `panel-right` | selected object details | inspector, properties, provenance |
| `panel-bottom` | temporal/output docks | charts, logs, jobs, diagnostics |
| `status-bar` | connection and runtime state | backend, precision, revisions |
| `overlay` | global transient surfaces | command palette, dialogs, toasts |

Slots are not feature flags. A disabled module means its manifest is not registered or its capability gate fails; the slot remains valid.

## 4. Manifest Contract

Every module exports a manifest:

```typescript
export interface ModuleManifest {
  id: ModuleId;
  title: string;
  version: string;
  slots: SlotId[];
  capabilityGate?: CapabilityGate;
  component: () => Promise<{ default: React.ComponentType<ModuleProps> }>;
  contributes?: {
    commands?: CommandContribution[];
    menu?: MenuContribution[];
    ribbon?: RibbonContribution[];
    status?: StatusContribution[];
  };
  emits?: KernelEventType[];
  listens?: KernelEventType[];
}
```

Manifest data must be declarative. It may describe what the module contributes, but it must not perform side effects while being imported.

## 5. Module Root Contract

```typescript
export interface ModuleProps {
  kernel: KernelApi;
  moduleId: ModuleId;
  slotId: SlotId;
  config: ModuleConfig;
  setConfig: (patch: Partial<ModuleConfig>) => void;
}
```

The root component is a thin adapter. It subscribes to module-local stores and resource hooks, then renders module components. Heavy work belongs in hooks, resource adapters, renderer classes, or pure utilities.

## 6. Kernel API

`KernelApi` is constructed once and provided through context as an immutable object:

```typescript
export interface KernelApi {
  readonly api: ControlRoomApi;
  readonly bus: EventBus;
  readonly commands: CommandRegistry;
  readonly modules: ModuleRegistry;
  readonly layout: LayoutController;
  readonly diagnostics: DiagnosticsController;
}
```

`KernelApi` is allowed in React context because it is an immutable service locator. Mutable application state does not live in this context.

## 7. Event Bus

The event bus is for notifications, not request/response workflows.

Allowed event categories:

- `session:*` for status, capabilities, revisions, connection lifecycle;
- `workspace:*` for selection, layout, active module, focus;
- `command:*` for submit, accepted, completed, rejected;
- `explorer:*` for user navigation intent;
- `viewport:*` for picked objects, camera changes, quantity changes;
- `inspector:*` for focus and draft lifecycle;
- `diagnostics:*` for opt-in debug observations.

Events carry typed payloads. Modules may emit or listen only to events declared in their manifest. If a module needs a snapshot, it uses a resource hook. If it needs a mutation, it dispatches a command or API transaction.

## 8. Command Registry

Commands are first-class objects, not callback props passed through the tree.

```typescript
export interface CommandContribution {
  id: CommandId;
  title: string;
  description?: string;
  scope: "global" | "workspace" | "selection" | "viewport" | "debug";
  capabilityGate?: CapabilityGate;
  defaultShortcut?: string;
  run: (ctx: CommandContext) => Promise<CommandResult> | CommandResult;
}
```

Main menu, ribbon, toolbar buttons, context menus, and command palette render the same command registry. This prevents five different implementations of "build mesh", "run stage", or "select quantity".

## 9. Module Lifecycle

Lifecycle states are:

1. `registered` - manifest is known.
2. `eligible` - capability gate passes.
3. `mounted` - component is mounted in a slot.
4. `suspended` - module remains registered but not mounted.
5. `disabled` - manifest is not registered or gate fails.
6. `faulted` - module root threw; kernel isolates it and keeps the shell alive.

Unmounting a module must release event subscriptions, timers, workers, WebGL resources, object URLs, and observers. Kernel diagnostics must expose active subscriptions and resource counts in development mode.

## 10. Disable Mechanism

The primary disable mechanism is manifest registration:

```typescript
export const CORE_MODULES = [
  appMenuManifest,
  ribbonManifest,
  explorerManifest,
  viewport3dManifest,
  viewport2dManifest,
  inspectorManifest,
  chartsManifest,
  consoleManifest,
  statusBarManifest,
] satisfies ModuleManifest[];
```

Removing a manifest disables the module. Capability gates only hide modules when runtime support is unavailable. Long-lived feature flags are not architecture; each flag needs an owner and removal condition.

## 11. File Size Limits

- Module root: 150 lines target, 250 lines hard review threshold.
- Module store: 200 lines hard review threshold.
- React component: 250 lines hard review threshold.
- Viewport renderer class: 400 lines hard review threshold.
- Kernel service: 300 lines hard review threshold.

Crossing a threshold requires splitting before merge unless an ADR explains why the file must remain larger.
