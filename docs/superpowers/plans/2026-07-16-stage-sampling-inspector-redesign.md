# Stage Sampling Inspector Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stage sampling inspectors compact, unit-aware scientific instruments while preserving the existing stage workflow and automatic-sampling semantics.

**Architecture:** Keep `studyWorkflowState` as the sole resolver of effective stage state. Add a shared presentation module for engineering/scientific format and a `SamplingPlan` card used by antenna, autosave, table autosave, response FFT, and Run inspectors. Convert the affected editable fields to the existing `FormField` primitive; CSS only styles the new semantic components through `--fm-*` tokens.

**Tech Stack:** React, TypeScript, Vitest, existing Control Room inspector primitives, Catppuccin token CSS.

## Global Constraints

- Do not change Python DSL, ProblemIR, planner, runtime, OpenAPI, or the workflow-state resolution algorithm.
- Effective values must remain derived from preceding stage instructions for the applicable next `Run`.
- Use only `fm-*` CSS classes and `--fm-*` design tokens.
- Numeric draft values remain SI; engineering format is display-only.
- No direct component `fetch()`, new global state, custom select, or custom toggle.
- Preserve unrelated unstaged files and stage only files introduced by this redesign.

---

### Task 1: Consolidate scientific value formatting

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/stages/samplingPresentation.ts`
- Create: `apps/control-room/src/modules/inspector/panels/stages/samplingPresentation.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/SincPulsePreview.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/SamplingDiagnostics.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/RunStageInspector.tsx`

**Interfaces:**
- Produces `formatEngineering(value: number, unit: string): string` for read-only values.
- Produces `formatScientific(value: number, unit: string): string` for graph axes and aria text when prefixes are not appropriate.

- [ ] **Step 1: Write a failing rendered-format test**

```ts
expect(html).toContain("<small>Nyquist limit</small><strong>500 GHz</strong>");
expect(html).toContain("<small>Highest represented FFT bin</small><strong>400 GHz</strong>");
```

- [ ] **Step 2: Run the formatter test to verify RED**

Run: `pnpm --dir apps/control-room test -- StageInspectors.test.tsx`

Expected: failure because the current local formatter renders `500.0 GHz` and
`400.0 GHz`.

- [ ] **Step 3: Implement the minimal shared formatter**

```ts
const ENGINEERING_PREFIXES = {
  [-15]: "f", [-12]: "p", [-9]: "n", [-6]: "µ", [-3]: "m",
  0: "", 3: "k", 6: "M", 9: "G", 12: "T",
} as const;

export function formatEngineering(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "invalid";
  if (value === 0) return `0 ${unit}`.trim();
  const exponent = Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
  const prefix = ENGINEERING_PREFIXES[exponent as keyof typeof ENGINEERING_PREFIXES];
  return prefix === undefined
    ? `${value.toExponential(3)} ${unit}`.trim()
    : `${Number((value / 10 ** exponent).toPrecision(4))} ${prefix}${unit}`.trim();
}
```

Then add direct unit tests for the formatter after it exists:

```ts
expect(formatEngineering(50e-12, "s")).toBe("50 ps");
expect(formatEngineering(1e-18, "s")).toBe("1.000e-18 s");
```

- [ ] **Step 4: Replace local formatters**

Import `formatEngineering` in the three affected components, remove their local `engineering` functions, and preserve the existing numerical inputs unchanged.

- [ ] **Step 5: Run formatter and pulse-preview tests to verify GREEN**

Run: `pnpm --dir apps/control-room test -- samplingPresentation.test.ts sincPulsePreview.test.ts`

Expected: all selected tests pass.

### Task 2: Create the shared sampling plan presentation

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/stages/SamplingDiagnostics.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/StageInspectors.test.tsx`
- Modify: `apps/control-room/src/design/styles/inspector.css`

**Interfaces:**
- `SamplingDiagnostics` remains the public inspector component but renders a semantic `fm-sampling-plan` card.
- It accepts the existing `durationS` and effective sampling union without changing resolver inputs.

- [ ] **Step 1: Write a failing semantic presentation test**

```tsx
expect(html).toContain('class="fm-sampling-plan"');
expect(html).toContain("Clock");
expect(html).toContain("FFT limits");
expect(html).toContain("50 ps");
expect(html).not.toContain("fm-sinc-preview__metrics");
```

Use the existing odd-`N` FFT inspector fixture so the test proves the plan retains the highest represented bin below Nyquist.

- [ ] **Step 2: Run the focused inspector test to verify RED**

Run: `pnpm --dir apps/control-room test -- StageInspectors.test.tsx`

Expected: the new assertions fail because the semantic card is absent.

- [ ] **Step 3: Implement the card and token CSS**

Render labelled Source, Clock, and FFT limits groups. Show automatic source drives and Nyquist target only for ready automatic policy. Render unresolved policy as a warning card and retain the current remediation message. Add responsive `fm-sampling-plan*` styles to `inspector.css`; do not alter global CSS.

- [ ] **Step 4: Run focused inspector tests to verify GREEN**

Run: `pnpm --dir apps/control-room test -- StageInspectors.test.tsx`

Expected: selected tests pass and the automatic unresolved regression remains covered.

### Task 3: Refactor stage inputs and verification charts

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/stages/AddFieldDriveStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/AutosaveStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/TableAutosaveStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/FftResponseStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/RunStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/SincPulsePreview.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/StageInspectors.test.tsx`
- Modify: `apps/control-room/src/design/styles/inspector.css`

**Interfaces:**
- Existing stage draft and update callback interfaces are unchanged.
- Affected numeric fields use `FormField` with `unit` and retain SI string values.

- [ ] **Step 1: Write failing inspector assertions**

```tsx
expect(html).toContain("Cutoff fc");
expect(html).toContain("GHz");
expect(html).toContain("t_sampling");
expect(html).toContain("Sampling plan");
```

Add the assertions to the existing Add Field Drive, Table Autosave, Autosave, FFT Response, and Run fixtures. Ensure the test still checks that a `Run` resolves state only from preceding stages.

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `pnpm --dir apps/control-room test -- StageInspectors.test.tsx`

Expected: failure because unit-aware stage fields and the named plan hierarchy do not yet exist.

- [ ] **Step 3: Replace raw stage input labels with FormField**

Use `FormField` for scalar time/frequency/field inputs. Give authored values explicit unit suffixes (`s`, `Hz`, `T`) without transforming stored SI values. Keep vector controls as their existing grouped control. Place sampling-plan and chart sections after configuration.

- [ ] **Step 4: Improve the paired sinc plots**

Make each plot caption identify the observable and unit, use shared numerical formatting on tick labels and aria labels, and retain the authored-time axis plus visible `t0` marker.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run: `pnpm --dir apps/control-room test -- StageInspectors.test.tsx sincPulsePreview.test.ts samplingPresentation.test.ts`

Expected: all selected tests pass.

### Task 4: Verify, inspect, and commit

**Files:**
- Modify only files changed by Tasks 1-3.

- [ ] **Step 1: Run frontend quality gates**

Run:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
pnpm --dir apps/control-room test
```

Expected: exit code 0 for every command.

- [ ] **Step 2: Run the browser/screenshot inspector smoke**

Use the repository's existing Control Room browser smoke/Playwright script for the study inspector. Verify the new sampling plan is visible, graphs have a non-zero canvas/SVG layout, and no console errors occur.

- [ ] **Step 3: Review scope and commit**

Run `git diff --check`, then inspect `git diff --cached --name-only` in a separate command. Stage only the files from Tasks 1-3 and commit with:

```bash
git commit -m "ui: refine stage sampling inspectors"
```

## Self-review

- Spec coverage: Tasks 1-3 cover the formatter, scientific card, input hierarchy, charts, units, and workflow invariants; Task 4 covers type, lint, test, visual, and scope gates.
- Placeholder scan: no task refers to undefined files or an unspecified test command.
- Type consistency: the existing `SamplingDiagnostics` props remain unchanged; only its presentation markup changes.
