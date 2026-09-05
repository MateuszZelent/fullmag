---
name: frontend-v2-performance-gates
description: "Use when making apps/control-room performance, memory, profiler, rendering, diagnostics, cache, worker, or optimization changes."
---

# Frontend v2 Performance Gates

Use this skill before claiming a measured performance or memory improvement in `apps/control-room`. The user instruction and root `AGENTS.md` take precedence. Reuse already loaded frontend skills and do not read them twice in one turn.

## Required evidence

1. Define the scenario, baseline, metric, workload, and expected improvement before changing code.
2. Instrument only the affected render reasons, resource counts, request timings, or memory counters.
3. Measure idle separately from active interaction.
4. Use a bounded stress loop for leak claims.
5. For charts, record artifact size, point/series counts, update cadence, and expected idle redraw count.
6. Report measurements and uncertainty, not impressions.

Choose only the relevant verification for the changed path:

- `audit:idle-performance` for idle rendering or refresh;
- `audit:compute-performance` or `audit:chart-performance` for the corresponding hot path;
- a focused Vitest test for resource hooks, viewport memory, chart models, or stores;
- a browser smoke when rendering or lifecycle behavior is user-visible.

Do not repeat a green measurement without a new change, failure, or unresolved question.

## Banned patterns

- performance claims without before/after evidence;
- sampling loops that create their own performance problem;
- `setInterval` for resource refresh;
- unbounded diagnostic logs;
- memoization used to hide wrong state ownership;
- profiler code left always-on in production paths;
- rebuilding chart models from raw artifacts on unrelated renders;
- spreading large arrays into `Math.min`, `Math.max`, or similar variadic calls;
- chart libraries that retain instances, observers, workers, or buffers after unmount;
- hidden `slice(0, n)` truncation instead of pagination, virtualization, or decimation.

## Repository commands

~~~powershell
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:compute-performance
pnpm --dir apps/control-room audit:chart-performance
pnpm --dir apps/control-room test -- --run <focused-test>
~~~

Use the smallest command set that proves the changed behavior. If a repository gate is unavailable, record the missing evidence; do not invent a pass or require unrelated suites.
