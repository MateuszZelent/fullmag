# Frontend v2 - Target File Tree

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Root

```text
apps/control-room/
  app/
    layout.tsx
    page.tsx
    globals.css
    workspace/
      page.tsx
  src/
    design/
    kernel/
    platform/
    modules/
    shared/
    domain/
    test/
  public/
  scripts/
  package.json
  components.json
  tsconfig.json
  eslint.config.mjs
  vitest.config.ts
  next.config.mjs
```

`apps/control-room` is the active v2 app. `apps/web` remains legacy reference during migration and must not be imported by v2 code.

`app/globals.css` is an import-only stylesheet entrypoint. Token definitions, themes, base rules, layout classes, and component contracts live under `src/design/styles/*`.

## 2. Design And Platform Foundation

```text
src/design/
  styles/
    tokens.css
    theme.css
    base.css
    layout.css
    slots.css
    header.css
  theme/
    themePreference.ts
    ThemeProvider.tsx

src/platform/
  runtime/
    runtimeTarget.ts
  files/
    fileDialogs.ts
  window/
    nativeWindow.ts
```

The design layer owns `--fm-*` tokens, Catppuccin Mocha/Latte theme switching, shadcn-compatible shared component styling, and global layout contracts. The platform layer owns web/Tauri/Electron detection and any native bridge. Modules must not directly import Tauri, Electron, `window.process`, or native file APIs.

## 3. Kernel

```text
src/kernel/
  KernelProvider.tsx
  KernelContext.ts
  types.ts
  module/
    ModuleHost.tsx
    ModuleRegistry.ts
    moduleErrors.ts
  events/
    EventBus.ts
    eventTypes.ts
    useEvent.ts
    useEmit.ts
  commands/
    CommandRegistry.ts
    commandTypes.ts
    commandExecution.ts
  layout/
    WorkspaceShell.tsx
    SlotHost.tsx
    layoutStore.ts
    layoutTypes.ts
  api/
    ControlRoomApi.ts
    client/
    generated/
    codecs/
    realtime/
    resources/
  stores/
    sessionStore.ts
    selectionStore.ts
    diagnosticsStore.ts
  diagnostics/
    renderReasons.ts
    resourceCounters.ts
    performanceMarks.ts
```

Kernel files must be stable, small, and boring. If a kernel file becomes product-specific, move that logic into a module or domain adapter.

## 4. Domain Layer

```text
src/domain/
  capabilities/
    CapabilityMap.ts
    capabilityGates.ts
  adapters/
    DomainAdapter.ts
    FdmDomainAdapter.ts
    FemDomainAdapter.ts
    createDomainAdapter.ts
  render-models/
    meshRenderModel.ts
    fieldRenderModel.ts
    sliceRenderModel.ts
  units/
    coordinates.ts
    quantities.ts
```

The domain layer converts canonical API/resource payloads into domain-neutral models. It does not render UI.

## 5. Modules

```text
src/modules/
  index.ts
  app-menu/
  ribbon/
  explorer/
  inspector/
  viewport-3d/
  viewport-2d/
  charts/
  engine-console/
  status-bar/
  command-palette/
  notifications/
  diagnostics/
  results-navigator/
  definitions/
  geometry-authoring/
  materials/
  physics/
  mesh-authoring/
  study-authoring/
  python-export/
  run-control/
  job-monitor/
  capability-viewer/
  legend-scale/
  view-controls/
  project-start/
```

Every module directory follows this pattern:

```text
<module-id>/
  manifest.ts
  <ModuleName>Module.tsx
  store.ts
  components/
  hooks/
  model/
  __tests__/
```

Files that are not needed are omitted. No module imports another module.

## 6. Shared

```text
src/shared/
  ui/
    Button.tsx
    Menu.tsx
    Tooltip.tsx
    Tabs.tsx
    ResizablePanel.tsx
    TextInput.tsx
    NumberInput.tsx
    Select.tsx
    Switch.tsx
    StatusPill.tsx
  icons/
    iconRegistry.ts
    Icon.tsx
  format/
    numbers.ts
    si.ts
    time.ts
  accessibility/
    focus.ts
    shortcuts.ts
  utils/
    className.ts
```

Shared code must be generic. If a shared file knows about mesh, solver, physics, stages, or viewport internals, it is in the wrong place.

## 7. Test Layout

```text
src/test/
  setup.ts
  fixtures/
    sessionStatus.ts
    sceneDocument.ts
    meshTopology.ts
    fieldVector.ts
  helpers/
    renderWithKernel.tsx
    createTestKernel.ts
```

Module tests live beside modules. Kernel and domain tests live beside the files they verify.

## 8. Import Rules

Allowed:

```typescript
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";
import { createDomainAdapter } from "@/domain/adapters/createDomainAdapter";
import { useExplorerStore } from "./store";
```

Forbidden:

```typescript
import { useInspectorStore } from "../inspector/store";
import { Viewport3DModule } from "../viewport-3d/Viewport3DModule";
import { ControlRoomContext } from "@/legacy/ControlRoomContext";
import { normalizeSession } from "@/legacy/normalize";
```

## 9. Naming

- Module ids: kebab-case.
- Component files: PascalCase.
- Hooks: `useSomething.ts`.
- Stores: `store.ts` inside modules, descriptive store files in kernel.
- Renderer classes: PascalCase with `Renderer`.
- Generated files: under `src/kernel/api/generated` only.
