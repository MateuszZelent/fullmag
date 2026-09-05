# Frontend i API Fullmag

Wiążące rozwinięcie [AGENTS.md](../../AGENTS.md). Czytaj sekcje dotyczące zadania. Zachowano numerację kontraktów dla łatwego wyszukiwania; ścieżki w backtickach są względem repozytorium. Zasady procesu i uprawnień określa główny AGENTS.md.

### 9.1 Control-room API invariant

The canonical local browser contract is the v2 session-scoped resource-first API documented in:

- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/adr/0011-resource-first-api.md`

Rules:

- frontend work targets `/v2/platform/...` and `/v2/sessions/current/...`; public `/v1/live/current/...` has been removed,
- v2 route families are `platform`, `sessions`, `model`, `meshing`, `simulation`, `data`, `visualization`, `workspace`, `analysis`, `persistence`, and `diagnostics`,
- `GET /v2/sessions/current/status` stays thin and revision-driven,
- domain, field, scalar, artifact, mesh, workspace, and session data are fetched as named resources,
- heavy fields and topology belong on the binary data plane, not inside status,
- mesh/topology and field samples must support scoped access for selected objects, mesh parts, airbox, and workspace selection,
- frontend code must use the central typed client/facade and must not hand-roll endpoint strings outside the API client layer,
- JSON contract changes must be reflected in OpenAPI and shared frontend types.

### 9.2 Frontend architecture invariant

The control room must use:

- one typed API client,
- one resource-hook layer,
- one capability vocabulary,
- one domain-adapter layer,
- one unified UI tree,
- one workspace shell whose active module changes the interface context.
- one Catppuccin token system: Mocha for dark mode, Latte for light mode.
- one shadcn/ui-based primitive layer for interactive chrome such as menu, ribbon, tabs,
  command palette, dialogs, dropdowns, context menus, switches, and tooltips.

The control room must not:

- call `fetch()` directly from React components,
- fork the product tree into separate FDM and FEM applications,
- reintroduce stage-switched workspace shells such as `Build`, `Study`, and `Analyze`,
- use legacy workspace stage state as the source of truth for ribbon, inspector, viewport, or docking behavior,
- treat old `bootstrap` / `poll` / `preview/*` flows as canonical architecture.
- hardcode one-off colors in components or module CSS outside `src/design/styles/*`.
- hand-roll accessibility-sensitive primitives that shadcn/ui already covers unless the exception is documented in the module manifest or spec.

Workspace UI doctrine:

- `/workspace` is one unified workspace, not a family of build/study/analyze workspaces.
- Top-level modules such as `Home`, `Definitions`, `Geometry`, `Materials`, `Physics`, `Mesh`,
  `Study`, `Results`, and `Automation` are modular interface contexts inside the same workspace.
- Module selection may change visible ribbon groups, inspector content, viewport presets, and commands,
  but it must not switch to a separate application shell or duplicate the workspace model.
- Geometry authoring must run in the same unified 3D viewport used for FDM and FEM; Geometry mode is
  a viewport/display preset, not a separate builder viewport.
- Remove remaining `Build`/`Study`/`Analyze` stage assumptions when the requested change depends on them. Preserve explicitly transitional compatibility shims; report unrelated legacy cleanup separately.

Interactive chart doctrine:

- Charts are analysis surfaces, not decorative widgets. Use physically meaningful axes, visible SI units,
  clear legends, formatted tooltips, selectable observables, and explicit unsupported/degraded states.
- Do not mix unrelated units on one y-axis unless the chart offers a selector, split panels, or a clearly labelled dual-axis design.
- Large chart data must be bounded, decimated, paged, or virtualized before rendering. Do not spread large
  arrays into `Math.min`/`Math.max`, put large typed arrays in React state, or rebuild chart models on unrelated renders.
- ECharts and similar renderers need explicit lifecycle ownership: create once per mounted chart, update only from
  resource revisions or user interaction, resize by observer, dispose on unmount, and avoid interval polling or idle redraw loops.
- Chart styling must use `--fm-*` tokens, readable contrast, stable panel geometry, tabular numeric formatting,
  and accessible hover/focus/selection states. Raw JSON tuples and unformatted arrays must never appear in user-facing tooltips.
- Any new scientific chart must include focused model tests plus at least one UI/render test or browser smoke when
  interaction, canvas lifecycle, or tooltip/selection behavior changes.

### 9.3 Frontend v2 rewrite doctrine

The target browser frontend is documented in:

- `docs/adr/0013-frontend-v2-module-kernel.md`
- `docs/specs/frontend-v2/README.md`

During the frontend v2 migration:

- `apps/control-room` is the clean v2 target app root,
- `apps/legacy_web` is legacy reference unless the user explicitly asks to modify it,
- v2 code must not import from `apps/legacy_web`,
- legacy code may be read for behavior, math, fixtures, and visual comparison, but not copied wholesale,
- every v2 module must have a manifest and must communicate through the kernel API, event bus, command registry, resource hooks, or shared primitives,
- menu, ribbon, toolbar, shortcuts, context menus, and command palette must render one command registry,
- module enable/disable is done through manifest registration and capability gates, not hidden shell forks,
- feature flags must have owners and removal criteria,
- no v2 change may reintroduce direct component `fetch()`, bootstrap/poll normalization, preview-control quantity switching for already-published data, mutable singleton diagnostics, or always-on viewport rendering.

Agents touching frontend v2 must load the relevant `.agents/skills/frontend-v2-*` skill before editing.

### 9.4 Zero-tolerance quality gate

Every change to `apps/control-room` must leave the codebase in a shippable state. There is no "fix later" for:

- TypeScript errors (`pnpm --dir apps/control-room typecheck` must pass),
- ESLint warnings (`pnpm --dir apps/control-room lint` must pass with `--max-warnings=0`),
- test failures (`pnpm --dir apps/control-room test` must pass),
- CSS class/token naming inconsistencies with `docs/specs/frontend-v2/09-css-design-system.md`,
- dead imports, unused variables, commented-out code created by the change,
- spec drift (implementation must match the spec; if the spec is wrong, update the spec first).

If a change introduces any of the above, the change is not done. Fix it before reporting completion.

This rule applies equally to agents and human contributors.

---

## 17. Field-store doctrine

The browser must treat already-computed quantities as data, not as preview commands.

### Required end-state

- solver/runtime publishes hot fields continuously,
- API exposes a read-optimized thin status plus field catalog and field buffers,
- warm quantity switching is local and near-instant,
- geometry/topology revision is separate from field revision,
- statistics needed for legends/scales should be precomputed where possible,
- legacy bootstrap/poll/preview transports must not define the browser contract.

### Anti-regression rule

Quantity switching for already available data must not enqueue preview-control work unless truly necessary.

---

## Reguły z korekt projektu

- Always use `fm-` prefix for all CSS class names in `apps/control-room`, including shell-level layout classes. No unprefixed classes.
- The CSS design system is token-first: `--fm-*` custom properties are the source of truth. Tailwind provides the utility layer. shadcn/ui provides accessible pre-built components. All three coexist — tokens define the visual language, Tailwind provides utilities, shadcn provides components.
- Keep `apps/control-room` on Next.js 16 unless the user explicitly approves a version change.
- Keep `apps/control-room/app/globals.css` import-only; put real CSS in `src/design/styles/*`.
- Color palette is Catppuccin: Mocha for dark theme, Latte for light theme. Raw Catppuccin hex values belong only in central token/theme files; components consume `--fm-*` tokens.
- Build menus, ribbons, tabs, dropdowns, dialogs, command palette, context menus, tooltips, switches, and segmented controls from shadcn/ui-style shared primitives. Bespoke widgets need a documented exception.
- Build Control Room charts as first-class scientific instruments: every interactive chart must be readable,
  unit-aware, physically honest, keyboard/mouse inspectable, and performance-bounded; no ugly default chart
  skins, raw tuple tooltips, mixed-unit axes without selectors/dual-axis handling, unbounded datasets,
  leaking ECharts instances, or redraws while idle.
- Every semantic Explorer tree node in `apps/control-room` must map to its own Inspector detail view; do not reuse one generic inspector view for distinct child nodes such as asset, load, and transform.
- Interactive `apps/control-room` Inspectors must remain visually and structurally stable during optimistic updates, resource invalidation, and command acknowledgement: never use one target-wide `pending` flag to disable or dim unrelated controls; track pending state at field/transaction scope, preserve the last-good panel for the same target identity, subscribe through target-scoped selectors, and allow exactly one owner per server-resource subscription in a panel tree. Data refreshes must not remount the Inspector, reset scroll/focus/drafts, or replay entry animations; opacity animations are forbidden on persistent or conditionally rendered Inspector controls. Every Inspector mutation change must include a browser regression for Object and Airbox (where applicable) that checks stable root identity, zero unrelated disabled/opacity changes, no active opacity animations, bounded render/request counts, and preserved scroll/focus through pending and ACK.
- Treat frontend file-size limits as review triggers, not automatic split commands; split only when it reduces real mixed responsibility, lifecycle risk, or comprehension cost.
- Client components in `apps/control-room` that read external stores, browser state, local storage, runtime resources, or cached API data must make their first client render match SSR; use `useSyncExternalStore` server snapshots or another explicit hydration gate instead of rendering live client-only values immediately.
- Every `apps/control-room` R3F/WebGL viewport change must run a browser smoke or Playwright check that asserts the canvas is visible, the WebGL context is not lost, and the drawing buffer is non-zero after load; passing TypeScript/tests alone is not enough for viewport work.
- Treat `THREE.WebGLRenderer: Context Lost` during `apps/control-room` startup as a failing viewport lifecycle signal until proven to be teardown-only; verify with `gl.isContextLost()` and drawing-buffer dimensions before calling it harmless.
- Keep `apps/control-room` development StrictMode disabled while the installed R3F/Three stack force-loses WebGL during React development remounts; do not re-enable `reactStrictMode` without a real browser smoke showing stable 3D canvas after load.
- A Control Room launcher may stop only the frontend process it spawned; reuse of an existing dev server must never imply ownership or kill that port on drop/error.
- Airbox wireframe is not the same contract as magnetic mesh wireframe: full airbox extent must always include an interior bounds/volume overlay with hidden-edge semantics even when mesh edge geometry exists; surface extent may render only boundary surface edges; airbox surface opacity must not attenuate airbox wireframe opacity.
- FDM Airbox vector browser qualification must commit separate `wireframe on -> wireframe off -> vectors on` frames; never accept a vectors frame with wireframe enabled, zero glyphs, visually unreadable sub-pixel glyphs, or glyph heads/shafts that overlap densely enough to hide the field trajectory. Default glyph length must derive from target bounds, effective rendered glyph count, and geometry scope; camera motion must not change it.
- Quantity availability bugs must be fixed through the canonical quantity catalog, field-store/API facade, and `compute_fields` materialization path globally; do not patch one-off field IDs such as `H_demag`.
- Viewport performance fixes must preserve the currently enabled visualization quality by default; lower quality, lower glyph density, hidden layers, or simplified topology are explicit fallback modes only after quality-preserving optimization fails.
- Model scene entities with separate immutable `object_id`, user-facing `name`, presentation `type`, and explicitly authored physics modules; never infer or activate solver physics from an object name or type alone.
