# Task 1 report: dimensionless chart scaling

## Implementation

- Added `chartScalePolicy.ts`, the shared dimension-aware display boundary.
  `resolveChartScalePolicy("1")` selects a dimensionless transform with factor
  `1` and no display unit before any SI magnitude calculation. Physical units
  retain their magnitude-derived SI display scale.
- Routed renderer axes, ticks, ECharts tooltip values, rendered series names,
  and exported PNG axis names through that transform. A normalized value of
  `0.10317` remains `0.10317`; its axis is `magnetization`, not `m1`.
- Retained CSV/TSV serialization unchanged: it uses raw point values and
  canonical `xAxis.unit`/`series.unit` metadata.
- Added descriptor coverage rejecting physical `M` (`A/m`) on a normalized
  magnetization (`1`) axis.

## Files

- `apps/control-room/src/shared/analysis-charts/chartScalePolicy.ts`
- `apps/control-room/src/shared/analysis-charts/chartScalePolicy.test.ts`
- `apps/control-room/src/shared/analysis-charts/chartRenderer.ts`
- `apps/control-room/src/shared/analysis-charts/chartRenderer.test.ts`
- `apps/control-room/src/shared/analysis-charts/scientificChartFormatting.ts`
- `apps/control-room/src/shared/analysis-charts/scientificChartFormatting.test.ts`
- `apps/control-room/src/shared/domain/analysis/chartUnits.test.ts`
- `apps/control-room/src/shared/domain/analysis/chartContracts.test.ts`

`chartUnits.ts` itself did not need a behavior change: it already resolves
`"1"` and `""` as canonical dimensionless units, which the new policy consumes.

## RED

Command:

```sh
env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run src/shared/analysis-charts/chartScalePolicy.test.ts src/shared/analysis-charts/chartRenderer.test.ts src/shared/analysis-charts/scientificChartFormatting.test.ts src/shared/domain/analysis/chartUnits.test.ts src/shared/domain/analysis/chartContracts.test.ts
```

Output (exit 1):

```text
RUN  v4.1.5 /home/kkingstoun/git/fullmag/fullmag/.worktrees/live-charts-analysis-separation/apps/control-room

❯ src/shared/analysis-charts/chartScalePolicy.test.ts (0 test)
❯ src/shared/analysis-charts/chartRenderer.test.ts (4 tests | 1 failed) 16ms
     × keeps dimensionless axes unscaled, enables ECharts aria and removes the bottom slider 8ms

FAIL  src/shared/analysis-charts/chartScalePolicy.test.ts
Error: Cannot find module './chartScalePolicy' imported from /home/kkingstoun/git/fullmag/fullmag/.worktrees/live-charts-analysis-separation/apps/control-room/src/shared/analysis-charts/chartScalePolicy.test.ts

FAIL  src/shared/analysis-charts/chartRenderer.test.ts > chart renderer owner > keeps dimensionless axes unscaled, enables ECharts aria and removes the bottom slider
AssertionError: expected axis name "magnetization"; received "magnetization [m1]"

Test Files  2 failed | 3 passed (5)
Tests  1 failed | 41 passed (42)
Duration  493ms
```

This was expected: the required policy module had not been implemented, and
the previous magnitude-only renderer applied the milli prefix to unit `1`.

## GREEN

Command:

```sh
env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run src/shared/analysis-charts/chartScalePolicy.test.ts src/shared/analysis-charts/chartRenderer.test.ts src/shared/analysis-charts/scientificChartFormatting.test.ts src/shared/domain/analysis/chartUnits.test.ts src/shared/domain/analysis/chartContracts.test.ts
```

Output (exit 0):

```text
RUN  v4.1.5 /home/kkingstoun/git/fullmag/fullmag/.worktrees/live-charts-analysis-separation/apps/control-room

Test Files  5 passed (5)
Tests  49 passed (49)
Start at  18:55:54
Duration  591ms (transform 1.31s, setup 0ms, import 1.72s, tests 44ms, environment 1ms)
```

The first green invocation completed all assertions but the sandbox wrapper
then failed during mount cleanup. The exact same command was rerun outside that
wrapper and exited 0 with the output above.

## Typecheck

Command:

```sh
corepack pnpm --dir apps/control-room typecheck
```

Output (exit 0):

```text
> @fullmag/control-room@0.1.0 typecheck /home/kkingstoun/git/fullmag/fullmag/.worktrees/live-charts-analysis-separation/apps/control-room
> node scripts/typecheck-control-room.mjs

Generating route types...
✓ Types generated successfully
```

## Self-review

- Dimensionless policy is selected from the resolved unit dimension before
  extrema are used, preventing all SI prefixes for unit `1`.
- Physical `A/m` keeps SI magnitude scaling and a physical display unit.
- Axis labels, tick formatters, tooltip values, series names, and PNG output
  share the same axis transform.
- CSV/TSV still serializes raw values and canonical units; no export change was
  required.
- `git diff --check` passed.

## Concerns

None. The only observed issue was the sandbox cleanup failure after the first
otherwise-green test run; the rerun exited successfully.

## Review-fix follow-up

### Implementation

- Preserved the unit carried by scalar values while still selecting SI prefixes
  in canonical space. For example, raw `9.5` with source unit `GHz` now gets a
  raw-space factor of `1` and display unit `GHz`, rather than being labelled as
  `9.5 Hz`.
- Added shared one-pass y-axis transforms and reused them in the renderer,
  accessible points table, `AnalysisTableSurface` cursor and legend summaries,
  and export provenance. Dimensionless values retain factor `1`, an empty
  display unit, and unscaled canonical values.
- Export provenance now supplies deterministic display units when no non-empty
  caller override exists: `x` and one `y:<series-id>` entry per series. CSV and
  TSV row values and canonical unit columns remain unchanged.
- The plan-mandated `fixed` policy variant remains supported but intentionally
  unselected by the current resolver. It is not removed merely to make the
  union exhaustive; future explicit fixed-unit policy can select it.

### Review-fix files

- `apps/control-room/src/shared/analysis-charts/chartScalePolicy.ts`
- `apps/control-room/src/shared/analysis-charts/chartRenderer.ts`
- `apps/control-room/src/shared/analysis-charts/PointsTableDialog.tsx`
- `apps/control-room/src/shared/analysis-charts/chartExport.ts`
- `apps/control-room/src/modules/analysis-plots/components/AnalysisTableSurface.tsx`
- `apps/control-room/src/shared/analysis-charts/frequencyRenderModels.test.ts`
- `apps/control-room/src/shared/analysis-charts/PointsTableDialog.test.tsx`
- `apps/control-room/src/shared/analysis-charts/chartExport.test.ts`
- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`

### Review-fix RED

Command:

```sh
env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run src/shared/analysis-charts/chartScalePolicy.test.ts src/shared/analysis-charts/chartRenderer.test.ts src/shared/analysis-charts/frequencyRenderModels.test.ts src/shared/analysis-charts/PointsTableDialog.test.tsx src/shared/analysis-charts/chartExport.test.ts src/modules/analysis-plots/AnalysisPlotsModule.test.tsx src/shared/analysis-charts/scientificChartFormatting.test.ts src/shared/domain/analysis/chartUnits.test.ts src/shared/domain/analysis/chartContracts.test.ts
```

Output (exit 1):

```text
RUN  v4.1.5 /home/kkingstoun/git/fullmag/fullmag/.worktrees/live-charts-analysis-separation/apps/control-room

FAIL  src/modules/analysis-plots/AnalysisPlotsModule.test.tsx
  keeps normalized legend readings dimensionless
  Expected aria-label "mx, unit dimensionless, latest 4.447e-6"
  Received aria-label "mx, unit 1, latest 4.447e-6"

FAIL  src/shared/analysis-charts/PointsTableDialog.test.tsx
  keeps dimensionless table values and headers free of SI prefixes
  Expected "Normalized magnetization m"
  Received "my [1]" and "4.447 µ"

FAIL  src/shared/analysis-charts/chartExport.test.ts
  records resolved display units while retaining canonical CSV values
  Expected { x: "ns", "y:my": "" }
  Received {}

FAIL  src/shared/analysis-charts/frequencyRenderModels.test.ts
  keeps supplied GHz values physically correct at the renderer boundary
  Expected axis name "frequency [GHz]"
  Received axis name "frequency [Hz]"

Test Files  4 failed | 5 passed (9)
Tests  4 failed | 121 passed (125)
Start at  19:07:07
Duration  1.59s
```

The failures are the requested reproductions: unit conversion was lost at the
renderer boundary, and the three summary/export consumers had independent or
absent display policy.

### Review-fix GREEN

Command:

```sh
env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run src/shared/analysis-charts/chartScalePolicy.test.ts src/shared/analysis-charts/chartRenderer.test.ts src/shared/analysis-charts/frequencyRenderModels.test.ts src/shared/analysis-charts/PointsTableDialog.test.tsx src/shared/analysis-charts/chartExport.test.ts src/modules/analysis-plots/AnalysisPlotsModule.test.tsx src/shared/analysis-charts/scientificChartFormatting.test.ts src/shared/domain/analysis/chartUnits.test.ts src/shared/domain/analysis/chartContracts.test.ts
```

Output (exit 0):

```text
RUN  v4.1.5 /home/kkingstoun/git/fullmag/fullmag/.worktrees/live-charts-analysis-separation/apps/control-room

Test Files  9 passed (9)
Tests  125 passed (125)
Start at  19:16:26
Duration  1.69s (transform 2.23s, setup 0ms, import 3.11s, tests 309ms, environment 1ms)
```

### Review-fix typecheck

Command:

```sh
corepack pnpm --dir apps/control-room typecheck
```

Output (exit 0):

```text
> @fullmag/control-room@0.1.0 typecheck /home/kkingstoun/git/fullmag/fullmag/.worktrees/live-charts-analysis-separation/apps/control-room
> node scripts/typecheck-control-room.mjs

Generating route types...
✓ Types generated successfully
```

### Review-fix concern

`npx -y react-doctor@latest . --verbose --diff` could not complete: the
sandbox first returned npm DNS error `EAI_AGAIN`; the elevated retry downloaded
the package but failed to load the optional native module
`@oxc-parser/binding-linux-x64-gnu`. No project dependency files were changed.
