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
