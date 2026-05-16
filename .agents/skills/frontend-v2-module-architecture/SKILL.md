---
name: frontend-v2-module-architecture
description: Use when modifying apps/control-room modules, module manifests, module registry, layout slots, command/menu/ribbon contributions, or cross-module interactions.
---

# Frontend v2 Module Architecture

Use this to protect the `apps/control-room` module-kernel boundary.

## Required Checks

1. Read `docs/specs/frontend-v2/01-module-kernel-architecture.md` and `02-module-catalog.md`.
2. Identify the affected module id and slot.
3. Verify every module has `manifest.ts` and a root component accepting `ModuleProps`.
4. Reject imports from `src/modules/A` to `src/modules/B`.
5. Use kernel events, command registry, resource hooks, or `src/shared` instead of cross-module imports.
6. Keep module stores private to their module.
7. Keep manifest contributions declarative and side-effect free.
8. Render menu, ribbon, toolbar, tabs, context menus, command palette, dialogs, switches, and tooltips through shared shadcn/ui-style primitives, not module-local widget systems.
9. Keep module root files small; split before the hard review thresholds in the spec.

## Banned Patterns

- importing another module's store, component, hook, renderer, or internal type;
- passing callback props through the shell to connect modules;
- commented-out module registrations as a feature toggle;
- module-local command systems that bypass the kernel command registry;
- module code importing from `apps/web`.
- bespoke module-local menu/ribbon/tab/dropdown/dialog/tooltip primitives when a shared shadcn/ui-style primitive exists.
- raw colors in module CSS; modules must consume `--fm-*` Catppuccin tokens.

## Verification

Run or emulate the narrow checks:

```bash
rg "from ['\"]\\.\\./" apps/control-room/src/modules
rg "apps/web|ControlRoomContext|normalizeSession|mergeSession" apps/control-room/src
pnpm --dir apps/control-room typecheck
```

If the v2 app does not exist yet, document which check will be added with the module.
