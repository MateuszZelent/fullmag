# Compact Inspector System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every Control Room Inspector surface to a compact, softly rounded, Apple-influenced desktop design system without changing domain semantics.

**Architecture:** Shared Radix/shadcn-style controls own interaction and finite visual variants; Inspector composition primitives own density, alignment, and section structure; domain panels retain only scientific content and resource/edit behavior. Migration proceeds family by family, with tests and obsolete CSS removal in the same task, ending in browser screenshots and a full zero-warning gate.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Radix Primitives, class-variance-authority, Catppuccin `--fm-*` tokens, Vitest, Storybook, Playwright, React Doctor.

## Global Constraints

- Preserve Python DSL, ProblemIR, OpenAPI, runtime, selection, resource-loading, edit-session, inheritance, reset, and transaction semantics.
- Preserve unrelated dirty-worktree changes, especially the user-owned `.agents/skills/frontend-apple-style/` directory.
- Use compact controls with 26 px visible height, 28 px minimum slider interaction rows, 4–6 px internal rhythm, and 10 px Inspector horizontal padding.
- Use 7 px input/select radii, 8 px button/segment radii, and 10 px disclosure/raised-region radii.
- Segmented controls use one rounded track and inset selections; migrated panels must not show grids of separately outlined square controls.
- Render tabs only for genuinely distinct task views; simple authoring inspectors and Visualization use one continuous surface.
- Full capsules are limited to short filters and status pills; scientific fields remain softly rounded rectangles.
- Keep `--fm-*` tokens as visual truth; raw Catppuccin colors stay in central token/theme files.
- Use only `fm-*` custom classes. Tailwind utilities remain allowed.
- Keep `apps/control-room/app/globals.css` import-only.
- Do not add a new UI framework, image preview, canvas, thumbnail, polling loop, or direct component `fetch()`.
- Each family migration removes the generic/domain CSS it supersedes and preserves any genuinely domain-specific chart/table layout.
- Every task follows red-green-refactor, runs focused tests, and is committed independently.

---

## File Responsibility Map

| Area | Files | Responsibility |
|---|---|---|
| Density tokens | `src/design/styles/tokens.css`, `theme.css`, `tailwind-theme.css` | Canonical compact dimensions, radii, colors, focus and motion |
| Shared controls | `src/shared/ui/controlVariants.ts`, `Button.tsx`, `Select.tsx`, `Tabs.tsx`, `SegmentedControl.tsx`, `Slider.tsx`, `Switch.tsx`, `Badge.tsx` | Accessible compact control geometry and states |
| Inspector composition | `src/modules/inspector/primitives/*`, `InspectorShell.tsx` | Compact shell, groups, rows, metrics, fields, notices and action bar |
| Visualization | `ObjectVisualizationOverview.tsx`, `ObjectVisualizationTargetSection.tsx`, `ObjectVisualizationPanel.tsx` | First complete compact panel and expanded-control proof |
| Object authoring | `ObjectGeneralPanel.tsx`, `GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `PhysicsInteractionPanel.tsx`, `AntennaObjectPanel.tsx`, `RegionalFieldDrivePanel.tsx` | Object and physics property editors |
| Mesh and regions | `ObjectMeshPolicyPanel.tsx`, `MeshDetailsPanel.tsx`, `panels/mesh-details/*`, `panels/airbox/*`, `ObjectRegionsPanel.tsx`, `RegionsListPanel.tsx`, `panels/region/*` | Mesh lifecycle, region inheritance and overrides |
| Study | `StudyInspectorPanel.tsx`, `StudyPipelineSection.tsx`, `StudyStage*.tsx`, `panels/stages/*`, `HysteresisStageDraftFields.tsx` | Study and stage authoring |
| Results/extensions | `FrequencyDomain*.tsx`, `panels/frequency-domain/*`, `ChartInspectorPanel.tsx`, `ModeVisualizationInspectorPanel.tsx`, `panels/visualization-debug/*`, `extensions/*` | Results, diagnostics and extensions |
| CSS compatibility | `src/design/styles/inspector*.css`, `registry-inspector.css` | Shell/domain-only rules during migration; generic legacy rules removed by completion |
| Browser proof | `scripts/smoke-inspector.mjs`, `.fullmag/reports/inspector-compact/` | Responsive light/dark screenshots and runtime assertions |

### Task 1: Lock the compact geometry contract

**Files:**
- Modify: `apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorCssContract.test.ts`
- Test: `apps/control-room/src/shared/ui/SegmentedControl.test.tsx`
- Test: `apps/control-room/src/modules/inspector/primitives/InspectorComposition.test.tsx`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-17-compact-inspector-system-design.md`.
- Produces: executable density, radius, ownership, and no-square-grid constraints.

- [ ] **Step 1: Add failing token and ownership assertions**

Add these assertions:

```ts
expect(tokens).toContain("--fm-control-height-compact: 26px");
expect(tokens).toContain("--fm-slider-hit-height: 28px");
expect(tokens).toContain("--fm-radius-input: 7px");
expect(tokens).toContain("--fm-radius-segment: 8px");
expect(tokens).toContain("--fm-radius-disclosure: 10px");
expect(segmented).toContain('data-slot="segmented-control"');
expect(segmented).toContain('data-slot="segmented-control-item"');
expect(segmented).not.toContain("border-r");
```

- [ ] **Step 2: Add a source inventory test for all Inspector panels**

Read `src/modules/inspector/panels/**/*.tsx` and fail when a migrated file introduces `fm-radio-group`, `fm-visualization-range`, raw `<input type="range">`, or a generic `fm-inspector-section` nested inside another section.

- [ ] **Step 3: Run the contract tests and confirm red**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/inspectorDesignSystemContract.test.ts \
  src/modules/inspector/inspectorCssContract.test.ts \
  src/shared/ui/SegmentedControl.test.tsx \
  src/modules/inspector/primitives/InspectorComposition.test.tsx
```

Expected: failures identify missing compact tokens and old square/legacy contracts.

- [ ] **Step 4: Commit the red contract**

```bash
git add apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts \
  apps/control-room/src/modules/inspector/inspectorCssContract.test.ts \
  apps/control-room/src/shared/ui/SegmentedControl.test.tsx \
  apps/control-room/src/modules/inspector/primitives/InspectorComposition.test.tsx
git commit -m "test: lock compact inspector geometry"
```

### Task 2: Implement shared compact tokens and controls

**Files:**
- Modify: `apps/control-room/src/design/styles/tokens.css`
- Modify: `apps/control-room/src/design/styles/theme.css`
- Modify: `apps/control-room/src/design/styles/tailwind-theme.css`
- Modify: `apps/control-room/src/design/styles/primitives.css`
- Modify: `apps/control-room/src/shared/ui/controlVariants.ts`
- Modify: `apps/control-room/src/shared/ui/Button.tsx`
- Modify: `apps/control-room/src/shared/ui/Select.tsx`
- Modify: `apps/control-room/src/shared/ui/Tabs.tsx`
- Modify: `apps/control-room/src/shared/ui/SegmentedControl.tsx`
- Modify: `apps/control-room/src/shared/ui/Slider.tsx`
- Modify: `apps/control-room/src/shared/ui/Switch.tsx`

**Interfaces:**
- Produces: `density="compact"`, compact CVA recipes, stable `data-slot` attributes, and accessible 26 px visual controls.

- [ ] **Step 1: Add canonical geometry tokens**

```css
--fm-control-height-compact: 26px;
--fm-control-height-regular: 30px;
--fm-slider-hit-height: 28px;
--fm-slider-track-height: 4px;
--fm-slider-thumb-size: 12px;
--fm-radius-input: 7px;
--fm-radius-segment: 8px;
--fm-radius-disclosure: 10px;
--fm-inspector-padding-inline: 10px;
--fm-inspector-row-gap: 4px;
--fm-inspector-control-gap: 6px;
--fm-inspector-group-gap: 10px;
```

- [ ] **Step 2: Implement the compact control recipe**

Make `controlVariants({ density: "compact" })` produce `h-[26px] rounded-[7px] px-2 text-[11px]` with token-backed border, surface, focus-visible ring, and disabled state.

- [ ] **Step 3: Rebuild segmented geometry**

Use one rounded track with `gap-0.5 p-0.5`; items have no independent default border and selected items use `rounded-[7px] bg-fm-selected text-fm-accent`. Preserve arrow-key behavior and `columns` wrapping.

- [ ] **Step 4: Keep slider interaction accessible**

Render a 28 px root/hit row, 4 px visual track, 12 px thumb, contour-following focus ring, and attach `aria-label`/`aria-labelledby` to the Radix thumb.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
pnpm --dir apps/control-room exec vitest run src/shared/ui
pnpm --dir apps/control-room typecheck
```

Expected: shared UI tests and typecheck pass.

- [ ] **Step 6: Commit shared controls**

Stage only the files listed in this task and commit with `feat: add compact inspector controls`.

### Task 3: Compact the shell and composition primitives

**Files:**
- Modify: `apps/control-room/src/modules/inspector/InspectorShell.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/InspectorGroup.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/InspectorPropertyRow.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/InspectorMetricStrip.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/FormField.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/FieldRow.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/FeedbackBanner.tsx`
- Modify: `apps/control-room/src/design/styles/inspector.css`
- Test: `apps/control-room/src/modules/inspector/primitives/InspectorComposition.test.tsx`

**Interfaces:**
- Produces: compact `InspectorGroup`, inline/stacked `InspectorPropertyRow`, metric strip, identity block, tabs and action bar.

- [ ] **Step 1: Extend composition tests**

Assert default two-column rows, explicit stacked fallback, compact disclosure buttons, semantic headings, no nested card role, and stable `data-slot` values.

- [ ] **Step 2: Implement compact composition**

Use 10 px shell padding, 4 px row gaps, 6 px group content gaps, 10 px group separation, 11 px titles, 10.5–11 px labels, and 26 px action buttons. Keep the scroll content and sticky action bar architecture unchanged.

- [ ] **Step 3: Remove generic card chrome**

Delete superseded generic section/input/tab/action rules from `inspector.css`; retain shell geometry and temporary compatibility selectors only for not-yet-migrated families.

- [ ] **Step 4: Verify**

```bash
pnpm --dir apps/control-room exec vitest run src/modules/inspector/primitives src/modules/inspector/InspectorEditSession.test.ts
pnpm --dir apps/control-room typecheck
```

- [ ] **Step 5: Commit**

Commit as `feat: compact inspector composition`.

### Task 4: Repair Inspector navigation and finish Visualization as the visual reference

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorDescriptor.ts`
- Modify: `apps/control-room/src/modules/inspector/InspectorShell.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorDescriptor.test.ts`
- Modify: `apps/control-room/src/design/styles/inspector-visualization.css`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.dom.test.tsx`
- Modify: `apps/control-room/scripts/smoke-inspector.mjs`

**Interfaces:**
- Consumes: compact controls/composition.
- Preserves: live viewport patching, staged interaction boundaries, exact reset baseline, lazy diagnostics, and no preview requests.

- [ ] **Step 1: Add failing navigation tests**

Assert that Visualization and simple authoring families declare no shell tabs, Mesh declares `Policy / Quality / History`, Results retains task tabs, and the shell omits the tab row when no tabs are declared.

- [ ] **Step 2: Repair behavior-focused tests before styling**

Replace source-string assertions for removed implementation details with mounted behavior assertions: slider changes update locally, commit occurs on interaction boundary, viewport preferences stay out of backend transactions, and ordinary Visualization does not load Debug evidence.

- [ ] **Step 3: Flatten Visualization into one continuous surface**

Remove its internal `TabsContent` split. Render target identity as a compact metric/property summary, then Display, Surface Coloring, Vectors, conditional Points/Wireframe, Geometry Scope and Opacity, followed by collapsed Diagnostics/Overrides. Keep diagnostics resource demand lazy until its disclosure is opened.

- [ ] **Step 4: Migrate the Overview and expanded groups**

Render Display toggles as softly filled cells without individual hard borders; Render Mode and Vector Coloring use shared rounded tracks; Surface and Vectors use compact property rows; monochrome color appears only in monochrome mode; slider labels and values share one line.

- [ ] **Step 5: Delete Visualization generic CSS**

Keep only vector accounting, domain-specific grids and visualization data layouts. Delete native-range, radio-group, generic field, generic disclosure and generic segmented styling.

- [ ] **Step 6: Extend browser proof**

Capture Overview, expanded Surface, expanded Vectors, slider controls, disabled, degraded, light and dark states at 360/416/560 px. Assert no horizontal overflow, no legacy classes, slider hit rows at least 28 px, zero console errors and zero preview requests.

- [ ] **Step 7: Verify and commit**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx \
  src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx \
  src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts \
  src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.dom.test.tsx
pnpm --dir apps/control-room smoke:inspector
```

Commit as `feat: finish compact visualization inspector`.

### Task 5: Migrate object authoring panels

**Files:**
- Modify: `ObjectGeneralPanel.tsx`, `GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `PhysicsInteractionPanel.tsx`, `AntennaObjectPanel.tsx`, `RegionalFieldDrivePanel.tsx`, `CouplingInspectorPanel.tsx`, `CrossSectionInspectorPanel.tsx`, `CrossSectionSettingsEditor.tsx`, `CrossSectionDraftEditor.tsx`
- Modify: `apps/control-room/src/design/styles/inspector.css`
- Test: `apps/control-room/src/modules/inspector/panels/CrossSectionInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanelModel.test.ts`

**Interfaces:**
- Preserves all existing draft models, validation, units and transaction callbacks.

- [ ] **Step 1: Add render-contract tests for general, material and physics panels**

Assert shared property rows/controls, compact disclosures, accessible labels, validation text, and absence of nested generic section/card markup.

- [ ] **Step 2: Migrate each panel without changing models**

Replace generic field/section markup with Inspector primitives; use inline rows by default and stacked layout only for vector, tensor, waveform or explanatory editors.

- [ ] **Step 3: Remove superseded generic CSS and verify**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/ObjectGeneralPanel* \
  src/modules/inspector/panels/ObjectMaterialPanel* \
  src/modules/inspector/panels/ObjectMagneticTexturePanel* \
  src/modules/inspector/panels/PhysicsInteractionPanel* \
  src/modules/inspector/panels/CrossSection*
```

- [ ] **Step 4: Commit**

Commit as `feat: compact object inspector panels`.

### Task 6: Migrate mesh, airbox, regions and inheritance

**Files:**
- Modify: `ObjectMeshPolicyPanel.tsx`, `MeshDetailsPanel.tsx`, `panels/mesh-details/*.tsx`, `panels/airbox/*.tsx`, `ObjectRegionsPanel.tsx`, `RegionsListPanel.tsx`, `panels/region/*.tsx`
- Modify: `inspector-mesh.css`, `inspector-regions.css`
- Test: `apps/control-room/src/modules/inspector/panels/ScopedMeshQualityPanels.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshBuildPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.test.ts`

**Interfaces:**
- Preserves mesh build actions, resource revisions, quality gates, region inheritance/source/effective values and explicit overrides.

- [ ] **Step 1: Add compact composition tests** for mesh overview/build, airbox parameters, inherited region value, and overridden region value in the four test files listed above.
- [ ] **Step 2: Migrate panels** using shared rows/groups while retaining domain-specific tables, histograms and quality layouts.
- [ ] **Step 3: Remove generic controls from mesh/region CSS** and keep chart/table geometry only.
- [ ] **Step 4: Verify** with `pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/mesh-details src/modules/inspector/panels/airbox src/modules/inspector/panels/region src/modules/inspector/panels/ObjectMeshPolicyPanelModel.test.ts src/modules/inspector/panels/ObjectRegionsPanel.test.ts`.
- [ ] **Step 5: Commit** as `feat: compact mesh and region inspectors`.

### Task 7: Migrate Study and stage authoring

**Files:**
- Modify: `StudyInspectorPanel.tsx`, `StudyPipelineSection.tsx`, `StudyStageCard.tsx`, `StudyStageDraftEditor.tsx`, `StudyStageInspectorRouter.tsx`, `HysteresisStageDraftFields.tsx`, `panels/stages/*.tsx`
- Modify: `inspector-study.css`, `inspector-hysteresis.css`, `inspector-sinc.css`
- Test: `StudyInspectorPanel.test.tsx`, `StudyInspectorPanel.performance.test.ts`, `panels/stages/StageInspectors.test.tsx`, and stage model tests

**Interfaces:**
- Preserves stage ordering, authoring commands, draft state, workflow state, runtime locks and scientific units.

- [ ] **Step 1: Add compact tests** for stage cards, draft fields, runtime-locked controls and hysteresis fields.
- [ ] **Step 2: Migrate shared stage frame first**, then all concrete stage inspectors.
- [ ] **Step 3: Retain only waveform/progress/domain layouts** in Study/Hysteresis/Sinc CSS.
- [ ] **Step 4: Verify** with `pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/StudyInspectorPanel.test.tsx src/modules/inspector/panels/StudyInspectorPanel.performance.test.ts src/modules/inspector/panels/stages/StageInspectors.test.tsx src/modules/inspector/panels/StudyStageAuthoringModel.test.ts`.
- [ ] **Step 5: Commit** as `feat: compact study inspector panels`.

### Task 8: Migrate results, diagnostics and extensions

**Files:**
- Modify: `FrequencyDomain*.tsx`, `panels/frequency-domain/*.tsx`, `ChartInspectorPanel.tsx`, `ModeVisualizationInspectorPanel.tsx`, `panels/visualization-debug/*.tsx`, `extensions/ObjectExtensionsSection.tsx`, `extensions/topological-charge/*.tsx`
- Modify: `inspector-frequency-domain.css`, `inspector-topological-charge.css`, `registry-inspector.css`
- Test: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/FrequencyDomainCharts.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.dom.test.tsx`
- Test: `apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSection.test.tsx`

**Interfaces:**
- Preserves lazy loading, chart lifecycle, mode selection, export and diagnostics behavior.

- [ ] **Step 1: Add compact composition tests** for frequency controls, result tables, Debug sample controls and extension disclosure.
- [ ] **Step 2: Migrate control chrome** while preserving first-class chart/table geometry and lifecycle ownership.
- [ ] **Step 3: Remove generic form/section rules** from remaining family CSS.
- [ ] **Step 4: Verify** with `pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx src/modules/inspector/panels/FrequencyDomainCharts.test.tsx src/modules/inspector/panels/ModeVisualizationInspectorPanel.test.tsx src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.dom.test.tsx src/modules/inspector/extensions/ObjectExtensionsSection.test.tsx`.
- [ ] **Step 5: Commit** as `feat: compact result and extension inspectors`.

### Task 9: Remove compatibility debt and run production gates

**Files:**
- Modify: `apps/control-room/src/design/styles/inspector.css`
- Modify: `apps/control-room/src/design/styles/inspector-*.css`
- Modify: `apps/control-room/src/modules/inspector/inspectorCssContract.test.ts`
- Modify: `apps/control-room/scripts/smoke-inspector.mjs`
- Create: `docs/reports/2026-07-17-compact-inspector-system.md`

**Interfaces:**
- Produces: one compact Inspector system with no generic old/new styling split.

- [ ] **Step 1: Prove legacy selectors unreachable**

```bash
rg -n 'fm-radio-group|fm-visualization-range|fm-inspector-segmented|fm-inspector-section.*fm-inspector-section' apps/control-room/src
```

Expected: no component usage; remaining definitions are deleted.

- [ ] **Step 2: Run all gates**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room build:storybook
(cd apps/control-room && npx -y react-doctor@latest . --verbose --scope changed)
pnpm --dir apps/control-room smoke:inspector
git diff --check
```

Expected: zero TypeScript errors, zero ESLint warnings, all Vitest tests pass, Storybook builds, React Doctor has no new errors/score regression, smoke has zero console errors/preview requests, and diff check is clean.

- [ ] **Step 3: Inspect the required family screenshots**

Review light/dark 360/416/560 screenshots for Visualization, Material, Mesh, Region, Study and Frequency Domain. Confirm compact rhythm, soft corners, readable labels, no square outlined grids, no clipping, no horizontal overflow, and a stable sticky action bar.

- [ ] **Step 4: Record evidence and commit**

Write exact commands/results and screenshot paths to `docs/reports/2026-07-17-compact-inspector-system.md`; stage it with `git add -f`. Commit CSS deletion, final contracts, smoke changes and report as `refactor: complete compact inspector migration`.
