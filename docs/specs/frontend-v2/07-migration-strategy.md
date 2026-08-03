# Frontend v2 - Migration Strategy

**Status:** Proposed architecture
**Date:** 2026-05-11; phase marker updated 2026-08-03

**Current phase:** Phase 6 — modules/parity. `apps/control-room` is implementing
and qualifying 2D, charts, console, and results workflows. `apps/legacy_web`
remains reference-only. This marker does not declare cutover, freeze, or removal.

## 1. Approach

Use a parallel app root, not in-place refactoring:

- `apps/control-room` is built from a clean kernel and selected ports.
- `apps/legacy_web` remains available as a reference while v2 reaches parity.
- No v2 file imports from `apps/legacy_web`.
- Legacy files are copied only through reviewed extraction commits.
- Cutover happens only after acceptance criteria in `21-cutover-acceptance.md` pass.

This is a controlled replacement, not a permanent dual-frontend architecture.

## 2. Porting Gate

Before porting any legacy file or concept, answer:

1. What v2 module owns it?
2. Which API/resource contract does it consume?
3. Does it depend on `ControlRoomContext`, `normalize`, `merge`, legacy preview state, or direct fetch?
4. What test proves the ported behavior?
5. What old file becomes obsolete because of this port?

If any answer is missing, rebuild the behavior instead of porting the file.

## 3. Phases

### Phase 0 - Architecture Lock

Deliver:

- this spec set;
- ADR 0013;
- AGENTS update;
- frontend-v2 skills;
- no runtime code changes.

Verification:

- docs contain no ambiguous placeholders;
- skill frontmatter is valid;
- AGENTS points agents to frontend-v2 doctrine.

### Phase 1 - Empty Kernel

Deliver:

- `apps/control-room` Next app shell;
- kernel provider;
- module registry;
- event bus;
- command registry;
- layout slots;
- status-bar placeholder;
- no copied legacy UI.

Verification:

- app starts;
- empty shell renders;
- modules can be disabled by removing manifest registration;
- registry and bus tests pass.

### Phase 2 - API Spine

Deliver:

- generated OpenAPI v2 files;
- `ControlRoomApi` facade;
- realtime invalidation;
- session status hook;
- resource hook base;
- diagnostics request log.

Verification:

- generated client builds;
- status is loaded from `/v2/sessions/current/status`;
- no direct fetch in modules;
- realtime invalidates but does not own full state.

### Phase 3 - Explorer, Selection, Inspector

Deliver:

- explorer model tree;
- selection store;
- inspector host;
- first panels for geometry/material/mesh/study;
- transaction-based edits.

Verification:

- selecting a node updates inspector and viewport selection;
- invalid edits produce diagnostics;
- accepted edits change resource revision;
- no module imports another module.

### Phase 4 - 3D Viewport

Deliver:

- 3D viewport module;
- render-model adapters;
- mesh/topology resource hooks;
- field vector resource hook;
- render-on-demand loop;
- resource tracker;
- viewport diagnostics.

Verification:

- mesh renders;
- field quantity switches without topology rebuild;
- idle frames stop;
- resources release on unmount;
- memory stress test has bounded growth.

### Phase 5 - Ribbon, Commands, Runtime

Deliver:

- app menu;
- ribbon command groups;
- command palette;
- run/build/stop command path;
- command completion display;
- job monitor.

Verification:

- same command works from menu, ribbon, shortcut, and palette;
- rejected command explains capability/precondition failure;
- command completion comes from resource/realtime flow.

### Phase 6 - 2D, Charts, Console, Results

Deliver:

- 2D slice/profile viewport;
- charts module;
- engine console;
- results navigator;
- scalar and analysis resource hooks.

Verification:

- 2D module can replace or split with 3D module;
- charts update from scalar resources;
- console shows log resources;
- no preview-control mutation for available quantities.

### Phase 7 - Cutover

Deliver:

- feature parity checklist;
- visual regression set;
- performance profile;
- legacy route/deployment switch;
- removal plan for `apps/legacy_web`.

Verification:

- acceptance in `21-cutover-acceptance.md`;
- CI gates in `18-testing-quality-gates.md`;
- `apps/legacy_web` no longer active in default scripts/deployment.

## 4. Legacy Reference Policy

Legacy can be read for:

- visual comparison;
- endpoint module implementation details;
- renderer math;
- chart formatting;
- known edge cases;
- test fixtures.

Legacy cannot be used as:

- import dependency;
- state model;
- direct design authority;
- place for new features;
- compatibility crutch after cutover.
