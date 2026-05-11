---
name: frontend-v2-performance-gates
description: Use when making frontend v2 performance, memory, profiler, rendering, diagnostics, cache, worker, or optimization changes.
---

# Frontend v2 Performance Gates

Use this before claiming a frontend v2 performance improvement or memory fix.

## Required Checks

1. Read `docs/specs/frontend-v2/17-performance-memory-profiler.md`.
2. Define the scenario, baseline, metric, and expected improvement before changing code.
3. Instrument render reasons, resource counts, or request timings where needed.
4. Verify idle behavior separately from active interaction behavior.
5. Use stress loops for leak claims.
6. Report measurements, not impressions.

## Banned Patterns

- performance claims without before/after evidence;
- sampling loops that create their own performance problem;
- `setInterval` for resource refresh;
- unbounded diagnostic logs;
- memoization used to hide wrong state ownership;
- profiler code left always-on in production paths.

## Verification

```bash
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room test -- --run resource-hooks
pnpm --dir apps/control-room test -- --run viewport-memory-stress
npx -y react-doctor@latest apps/control-room --verbose --diff
```

If a command is unavailable, state the missing command and add it as a gate.
