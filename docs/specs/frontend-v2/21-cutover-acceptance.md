# Frontend v2 - Cutover Acceptance

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Cutover Definition

Cutover means `apps/control-room` becomes the default and only active browser frontend. `apps/legacy_web` becomes frozen reference, then is removed or moved out of the active product path.

Cutover is not allowed just because v2 starts or looks better.

## 2. Functional Acceptance

Required workflows:

- open or create session;
- inspect session status and backend identity;
- navigate model/resource/results trees;
- select object/resource from explorer and viewport;
- inspect and edit supported geometry/material/physics/mesh/study properties;
- add a new geometry primitive object, edit dimensions/position/rotation, see immediate primitive display and fallback wireframe, then build mesh and see current object topology;
- build mesh where supported;
- run supported stage;
- show command completion and stage stop reason;
- switch field quantities from published resources;
- render 3D mesh/field/vector data;
- render 2D slice/profile data where supported;
- show scalar/energy/history charts;
- inspect logs and diagnostics;
- export canonical Python DSL;
- show unsupported/degraded capability reasons.

## 3. Architecture Acceptance

Required:

- no imports from `apps/legacy_web` into `apps/control-room`;
- no direct component/module `fetch`;
- no `/v1/live/current` references in v2;
- no bootstrap/poll/preview canonical data path;
- generated OpenAPI v2 transport is current;
- resource hooks are revision-driven;
- command registry owns menu/ribbon/shortcut/palette commands;
- modules have manifests and no cross-module imports;
- server-owned state is not duplicated in module stores;
- viewport resource tracker passes stress tests.

## 4. Performance Acceptance

Required:

- idle audit passes;
- viewport memory stress passes;
- repeated 3D/2D switching has bounded memory growth;
- quantity switching does not rebuild topology unless topology revision changes;
- large lists are virtualized;
- charts dispose instances on unmount;
- diagnostics can show render/resource reasons in development mode.

## 4.1. Visual Quality Acceptance

Required:

- Catppuccin Mocha dark theme and Catppuccin Latte light theme are functional and visually consistent;
- shadcn/ui-style shared components are used for menu, ribbon controls, dialogs, command palette, context menus, dropdowns, tabs, switches, segmented controls, and tooltips;
- micro-animations are present for hover, selection, overlay open/close, and status transitions;
- typography uses Inter for UI and JetBrains Mono for code/data;
- the interface looks premium in side-by-side comparison with reference applications (COMSOL, Blender, Figma);
- `prefers-reduced-motion` is respected.

## 4.2. Desktop Deployment Acceptance

Required before desktop release (may happen after web cutover):

- Tauri wrapper builds on Linux, macOS, and Windows;
- all functional workflows work in Tauri WebView;
- no SSR-only code paths break in desktop mode;
- API base URL is configurable for local and remote sessions;
- file dialogs use platform abstraction.

## 5. Documentation Acceptance

Required:

- `AGENTS.md` points to frontend v2 as active doctrine;
- `docs/specs/README.md` lists frontend v2 specs;
- ADR 0013 is accepted or explicitly superseded;
- migration strategy has current phase marked;
- legacy sunset status is current;
- frontend-v2 skills exist and are referenced.

## 6. Legacy Freeze Criteria

`apps/legacy_web` can be frozen when:

- v2 is default for local dev and deployment;
- all required workflows pass in v2;
- no active plan depends on changing legacy;
- remaining legacy-only capability is documented as intentionally dropped, deferred, or reimplemented in a v2 module.

After freeze:

- no new features in `apps/legacy_web`;
- no architectural cleanup in `apps/legacy_web`;
- only critical reference fixes if needed for migration comparison.

## 7. Legacy Removal Criteria

`apps/legacy_web` can be removed or archived outside the active product tree when:

- v2 has run through at least one stable release cycle;
- no tests/scripts/deployments reference `apps/legacy_web`;
- all copied assets have v2 ownership;
- docs no longer instruct users or agents to work in legacy;
- removal PR passes full frontend, API, and docs checks.
