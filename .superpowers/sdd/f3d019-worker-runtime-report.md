# F3D-019 worker runtime ownership

Implemented a viewport-scoped worker-runtime lease. The first mounted 3D
viewport owns the shared runtime and the final lease release immediately
disposes topology-index, field-color, region-overlay, vector-glyph, and FDM
cuboid schedulers. Scheduler disposal aborts queued/running build work through
the existing controlled `AbortError` path, clears worker idle timers/listeners,
and terminates workers. A later mount creates a new runtime.

Diagnostics now expose worker-runtime workers, timers, and pending jobs through
the viewport resource tracker. The runtime test exercises every lane, verifies
that the first release preserves them while another viewport is mounted, and
that a fresh runtime can mount after final disposal.

Follow-up review fix: scheduler lifecycle changes now notify the runtime while
jobs are queued, completed, aborted, or disposed, so tracker values are live
rather than mount/unmount snapshots. The compact diagnostics string includes
`worker-runtime:workers/timers/jobs`. A production regression test creates all
five worker clients, disposes them while their jobs are pending, and verifies
controlled `AbortError` rejection, `terminate()`, and listener removal.

Final review fix: build scheduler notification now occurs after synchronous
runner/worker creation as well as queue/terminal transitions. The production
lease test observes `jobs=1, workers=1` for an active topology lane, then
releases the final runtime lease and observes zero jobs, timers, and workers.

Verification:

- `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewport3dWorkerRuntime.test.ts src/modules/viewport-3d/viewport3dTopologyIndexScheduler.test.ts src/modules/viewport-3d/viewport3dColorTransformScheduler.test.ts src/modules/viewport-3d/region-overlays/viewport3dRegionOverlayBuildScheduler.test.ts src/modules/viewport-3d/layers/vectorGlyphBuildScheduler.test.ts`
- `pnpm --dir apps/control-room typecheck`
- `pnpm --dir apps/control-room lint`
