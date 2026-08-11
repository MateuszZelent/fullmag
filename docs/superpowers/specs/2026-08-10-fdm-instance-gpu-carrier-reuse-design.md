# FDM instance GPU carrier reuse

## Problem

The FDM cuboid viewport rebuilds and uploads every instance transform and color
through `InstancedMesh.setMatrixAt` and `setColorAt` whenever the target changes
between surface and wireframe rendering. For a 153,600-cell Airbox this blocks
the main thread for several seconds even though topology and field colors did
not change.

## Design

The FDM build result publishes one atomic immutable instance payload containing
`matrices`, `ordinals`, `cellIndices`, `count`, and `contentRevision`. Matrices
are a contiguous Three.js-compatible column-major `Float32Array` with one 4x4
matrix per displayed cell. The worker prepares the complete payload at the same
time as cell centers and transfers ownership rather than retaining an aliased
mutable view. Target-local payloads are rebuilt atomically only when membership
or geometry changes; a stale build result cannot combine matrices from one
revision with ordinals or cell indices from another.

Color identity is separate. Its revision key contains only inputs that can
change the uploaded RGB values: scalar buffer identity/revision, range and
palette mapping, target membership/ordinals, and color-source selection. It
does not contain `shaderVisible`, render mode, opacity, or a serialized settings
object. Colors are copied in bulk into the surface carrier once per color
content revision.

`FdmCuboidSurfacePass` retains two independent `InstancedMesh` carriers while
the cell model is current: one surface carrier and one wireframe carrier. Each
mesh owns its own `InstancedBufferAttribute`; no attribute is shared between
meshes. Upload uses `attribute.array.set(preparedArray)` followed by one
`needsUpdate` per content revision. Both carriers are prewarmed when the cell
payload becomes current, so a mode-toggle interaction never pays first
allocation or upload cost. Both remain retained until topology changes or the
layer unmounts.

Surface and wireframe remain independently visible, so `surface+edges` keeps
its existing two-pass fidelity. Points, vectors, bounds overlays, instance IDs,
and target picking retain their existing carriers and semantics. Pointer
handlers are active only on visible cuboid carriers. Each mesh keeps the
existing `instanceId` order, `count`, and picking mapping. Its matrix attribute
uses `DynamicDrawUsage`, an update range covering exactly `count * 16` floats,
and one `needsUpdate` transition after the bulk copy; the surface color
attribute analogously covers exactly `count * 3` floats. Unused capacity is
never exposed through `mesh.count`.

WebGL context loss invalidates renderer-local uploaded-revision records without
discarding the immutable CPU payload. Context restoration performs one matrix
upload per retained carrier and one surface color upload, then records the
current revisions and invalidates one frame. This does not assume React remount.
Unmount cancels pending preparation, drops payload references, releases both
meshes through R3F, and releases tracked geometry and materials through the
viewport resource tracker.

## Memory and performance contract

For 153,600 instances one matrix array is 9,830,400 bytes. The conservative
peak accounts for immutable prepared CPU matrices (9.83 MB), two independent
CPU-side Three attribute arrays (19.66 MB), two GPU matrix buffers (19.66 MB),
centers plus cell/region indices (3.07 MB), source and carrier RGB arrays
(3.69 MB), and up to one target-local prepared matrix array (9.83 MB): about
65.75 MB before small geometry/material bookkeeping. The hard gate is 72 MiB
incremental retained-plus-peak memory for one 153,600-cell full-view target,
measured across preparation, upload, toggles, context restore, and unmount.
After unmount the target-owned increment must return to baseline. The design
does not create the approximately 44.2 MB world-space line-position buffer that
an equivalent per-cell `LineSegments` representation would require.

The interaction budget is zero matrix/color uploads when only render-pass
visibility changes, no main-thread task above 50 ms, and surface↔wireframe
visual completion within 250 ms at p95 in ten warm transitions. A geometry or
membership revision prewarms each matrix carrier exactly once before the target
is declared ready. A color revision uploads the surface color carrier exactly
once. Cold preparation plus both matrix uploads for 153,600 cells must complete
within 1 s with no individual main-thread task above 100 ms. If a browser cannot
meet that budget, preparation/upload must remain chunked outside the mode-toggle
interaction and readiness must stay explicit. Idle schedules no upload tasks or
frames. Performance marks count preparation, CPU bulk copy, attribute update,
and first rendered frame separately so a fast JavaScript copy cannot conceal a
slow GPU commit.

## Verification

Unit tests prove atomic payload consistency, Three.js matrix layout, bulk copy,
exact update ranges, revision gating, independent attribute ownership,
prewarming, cleanup, and context-loss/restoration reupload without remount.
Existing tests prove picking and display-mode semantics. Browser evidence
records cold preparation/upload, ten warm surface-to-wireframe transitions,
upload counts, long tasks, peak and post-unmount memory, WebGL context health,
drawing-buffer dimensions, fidelity, and the complete 24-target plus 4-Airbox
matrix. Typecheck, focused lint/tests, idle audit, and memory stress remain
release gates.
