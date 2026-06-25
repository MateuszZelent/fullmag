# Viewport 3D field-data architecture report

Date: 2026-06-25

Scope:

- `apps/control-room` 3D viewport
- per-object visualization state
- field data requests and resource hooks
- scalar surface color pipeline
- vector glyph pipeline
- colorbar/range model
- worker/cache/GPU update lifecycle

Related target architecture:

- `docs/specs/frontend-v2/25-viewport-3d-field-data-architecture.md`
- `docs/specs/frontend-v2/14-viewport-3d-module.md`
- `docs/specs/frontend-v2/17-performance-memory-profiler.md`
- `docs/specs/frontend-v2/23-per-object-visualization-control.md`

External audit considered:

- `/home/kkingstoun/.gemini/antigravity-ide/brain/966aa59f-1e22-4aeb-b4e8-d1a652cfba02/vector_magnetization_texture_audit.md`

## 1. Verdict

The current implementation is no longer a simple global-only renderer, but it is still not architecturally clean enough for production. It has accumulated local fixes for per-object scalar modes, per-object palettes, vector budgets, scoped requests, colorbar retention, chunked scalar colors, and stale derived buffers. Those fixes improved visible behavior, but they did not create one coherent planning layer.

After comparing this report with the Gemini audit, I do not accept the external audit's "100% optimized and production-grade" conclusion as proven. It correctly identifies useful mechanisms already present in the codebase, but it describes several of them as architecture-level guarantees when they are currently local mechanisms with missing end-to-end ownership, diagnostics, and fallback rules.

The main architectural problem is this:

> The code does not have a first-class model for target pass demands, field payload capabilities, and target buffer ownership.

Instead, the same structures and hooks still mix these responsibilities:

- user style and target visibility;
- render plan;
- fetch plan;
- scalar color build plan;
- vector glyph build plan;
- stale-compatible retention;
- colorbar legend state.

The result is fragile coupling:

- changing one object's surface mode can affect global scalar requests;
- vector-only and shader+vector cases use different implicit rules;
- the renderer often discovers buffer incompatibility late, inside layer code;
- colorbars are derived from current render buffers rather than from a stable legend plan;
- performance diagnostics can show long tasks, but cannot always explain which target demand caused which request or build.

The correct production design is a staged planner:

```text
visualization state + topology + quantities
  -> target pass demands
  -> field data demand plan
  -> resource request plan
  -> decoded payloads with capabilities
  -> target field buffers
  -> derived work plan
  -> render model
  -> R3F layer runtime
```

The existing document `25-viewport-3d-field-data-architecture.md` defines much of the desired contract. This report adds the missing audit layer: how the current code is organized today, where the boundaries leak, and what production architecture should replace it.

## 2. Current implementation: end-to-end

### 2.1 Visualization state

Per-target visualization settings are owned by `ObjectVisualizationController`.

Relevant file:

- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`

Current defaults include:

- `surfaceColorSource`
- `scalarColorPalette`
- `shaderVisible`
- `vectorsVisible`
- `vectorBudget`
- `vectorLengthScale`
- `geometryScope`
- `viewportColorbarVisible`

The controller now serializes and deserializes the important per-target fields, including:

- `surface_color_source`
- `scalar_color_palette`
- `viewport_colorbar_visible`
- `vector_budget`
- vector style fields

This is the right direction. Per-object state is no longer only local React state. However, this layer still only describes target settings. It does not produce a normalized render/data demand model.

It also does not yet model per-target scalar range and scale policy. There is a palette and a source, but no canonical per-target fields for:

- automatic vs manual scalar range;
- explicit min/max;
- symmetric range around zero;
- linear/log/diverging scale;
- range revision;
- range source: metadata, payload-derived, manual, retained stale-compatible.

That omission matters for mixed-object visualization. If different objects need different scalar ranges, the current system can render different buffers, but the state contract cannot fully describe the intended scale policy as first-class user intent.

### 2.2 Scene hook as the central coordinator

Most architecture is currently concentrated in:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`

This hook performs many roles:

- resolves selected topology and target settings;
- builds field render options;
- decides which primary field payload is needed;
- decides which per-part scoped requests are needed;
- decides which target-quantity aggregate requests are needed;
- invokes resource hooks;
- merges returned payloads into `partFieldVectors`;
- computes scalar ranges;
- starts chunked scalar color builds;
- builds the render model;
- merges chunked scalar colors back into the render model;
- passes the final model to R3F layers.

This is too much responsibility for one hook. It makes the data contract hard to reason about because fetch planning, render planning, stale retention, and worker decisions are interleaved.

### 2.3 Field render options

Current render/data options are represented by `Viewport3DFieldRenderOptions` in:

- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DFieldRenderOptions.ts`

The type currently carries:

- full-vector budget and full-vector style;
- per-part vector budgets and vector style;
- per-part scalar color modes;
- per-part scalar palettes;
- scalar ranges;
- per-part field vectors;
- scalar color visibility;
- global scalar color modes;
- field/topology/visualization revisions.

This is the core smell. `Viewport3DFieldRenderOptions` is not just render options. It is also a partial fetch plan, partial target buffer map, partial scalar build plan, and partial worker revision key.

That overload is what produced earlier bugs:

- removing a part from primary fetch options could also remove its vector budget from the render path;
- a scoped payload could be present, but the render model could still build no glyphs;
- scalar modes could be gathered globally while the object-specific palette/range relation had to be reconstructed later.

### 2.4 Current demand-to-request rules

The current code has several request paths.

Primary field request:

- computed by `resolveViewport3DPrimaryFieldQuery(...)`;
- fetches one field vector for the primary quantity;
- may request `component=full`;
- may request one scalar component if the active scalar modes collapse to one component;
- falls back to full when vector glyphs or orientation-style modes require full vector data.

Scoped part requests:

- computed by `resolveViewport3DScopedPartVectorFieldRequests(...)`;
- used for magnetic parts with non-global needs;
- calls `resolveViewport3DScopedVectorFieldQuery(...)`;
- adds `max_samples` only when vectors are visible and there is no surface shader color mode.

Target-quantity requests:

- built in `targetQuantityFieldQueries`;
- grouped by quantity id;
- merged by `mergeViewport3DFieldQuery(...)`;
- used when targets use a quantity different from the primary quantity.

Airbox requests:

- use `useViewport3DAirboxFieldVectors(...)`;
- force `scope_kind=airbox`;
- can fetch airbox or synthetic fallback data.

The logic is directionally correct but not explicit enough. It is not represented as a list of target demands and merged field demands. Instead, it is spread across helper functions and local `useMemo` blocks.

There is also a concrete scope-risk in the current airbox resource hook: per-airbox resource keys can be built with `scope_id`, but the load function resolves one common airbox query from `fieldQuery`. The production request planner must make the final request object authoritative, so the key and the actual API call cannot drift.

### 2.5 Resource hooks

Field-vector resource hooks live in:

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`

They build resource keys with:

- quantity id;
- component;
- `scope_id`;
- `scope_kind`;
- snapshot/stage query;
- `view`;
- phase.

The key construction is useful. The problem is that returned data is still collapsed into maps such as:

```ts
Map<string, DecodedFieldVector>
```

where the string is usually a part id or quantity id. The decoded payload does not become a first-class `TargetFieldBuffer` carrying:

- target id;
- quantity id;
- scope kind;
- component kind;
- completeness;
- sampled vs complete capability;
- topology mapping;
- intended consumers.

That missing capability layer forces later code to infer safety from `nComp`, `pointCount`, identity comparison, or fallback order.

Another current loss happens before resource loading: object, region, and part target settings are collapsed into effective part settings early. After that point the request path mostly sees `partId`, quantity, visibility, scalar mode, vector visibility, and budget. The original visualization target kind is no longer consistently available to the data planner. That is acceptable for today's mesh parts, but it is not a production model for object/region/airbox scoped data.

### 2.6 Buffer merge

After resource hooks return data, `useViewport3DSceneModel.ts` creates one `partFieldVectors` map.

Priority is approximately:

1. target-quantity aggregate payloads mapped onto all compatible parts;
2. magnetic part scoped payloads;
3. airbox payloads;
4. synthetic airbox vector payloads.

This is the second core smell. `partFieldVectors` is an ambiguous bucket. It does not say whether the field vector is:

- complete or sampled;
- scalar-only or full-vector;
- scoped to object, part, airbox, or full domain;
- suitable for shader surface coloring;
- suitable for vector glyphs;
- suitable only as stale-compatible display data.

The render model has to reconstruct these facts later.

### 2.7 Render model

Render model construction happens in:

- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`

`buildViewport3DFieldRenderModel(...)` currently:

- resolves primary render field vector;
- computes global scalar colors by mode;
- computes per-part scalar colors by mode;
- computes per-part vector segments;
- creates vector glyph build references;
- creates full-vector segments;
- returns a `Viewport3DFieldRenderModel`.

This builder contains useful cache and selection logic, but it still mixes:

- scalar color derivation;
- vector segment derivation;
- buffer compatibility;
- build-key generation;
- topology selection logic.

The function is also forced to handle ambiguous payloads because the input did not distinguish capabilities earlier.

### 2.8 Chunked scalar colors

Large scalar color buffers are handled by:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.ts`

The current implementation has important production-minded pieces:

- reducer state instead of loose `useState`;
- request identity;
- cancellation via `AbortController`;
- retained chunked entries;
- progressive `publishEntries(true)` as each mode/part finishes;
- `Promise.allSettled` rather than all-or-nothing `Promise.all`.

This is a good direction. But it is still downstream of the overloaded render options. It receives:

- global color modes;
- global field vector;
- `partFieldVectors`;
- per-part scalar modes;
- per-part palettes;
- scalar ranges.

That means it repeats part of the compatibility reasoning that should already be decided by a derived work planner.

### 2.9 Mesh and vector layers

Mesh layer:

- `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`

Vector layer:

- `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`

`MeshPartLayer` selects scalar colors by:

1. trying `fieldModel.scalarColorsByPartAndMode.get(partId)?.get(mode)`;
2. falling back to `fieldModel.scalarColorsByMode.get(mode)`;
3. checking mode/palette/quantity compatibility;
4. retaining the previous compatible buffer if the current one is missing.

This is safer than the earlier global fallback bug, but it is still late validation. A production render model should already expose the buffer that this specific target/pass may consume, with a degradation reason if it cannot.

`VectorFieldLayer` works from:

- vector segments;
- vector build reference;
- derived buffer cache;
- worker/scheduler result;
- retained visible result.

This is also directionally correct, but it should consume an explicit vector pass output rather than reconstructing state from `partVectorBuilds`, `partVectorSegments`, and optional cache results.

There is still a main-thread cost before the vector worker starts. The render model builds vector line segments on the main thread, then `VectorFieldLayer` sends those segments to the glyph worker. For small fields that is fine; for large updates this is still part of the freeze risk. A production derived-work plan should own both segment construction and glyph transform construction, with explicit worker/fallback semantics.

`ScalarColorBuffer` is also a union by convention. It may carry RGB vertex colors, scalar shader values, vector shader values, complex shader values, range, palette, quantity, and build metadata. Layers infer which shape they received by checking optional arrays and lengths. This works, but it is not a strong contract. A production render model should expose pass-specific buffer types or a discriminated capability field.

The retained scalar-buffer path validates palette, quantity, and applicability to the target vertex count, but stale compatibility is still not expressed as a typed key containing color mode, range revision, field revision, and phase. Retention should be deliberate and explainable, not a best-effort fallback.

### 2.10 Colorbars

Colorbar logic lives mostly in:

- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- `apps/control-room/src/modules/viewport-3d/viewport3dStore.ts`

The current code:

- computes colorbars from `fieldModel` and current part settings;
- supports per-target `viewportColorbarVisible`;
- generates separate legends for mixed opt-in part scales;
- retains previous legends while a compatible update is pending;
- exposes active colorbar legends through `viewport3dStore`.

This fixes some visible flicker. But it is still the wrong ownership model. Colorbars are derived from available scalar buffers. In production, colorbars should be derived from a stable `ColorbarPlan` produced from visible shader pass demands, while current buffer/range state only fills in the value range.

That distinction matters. A missing fresh range should mean:

- keep previous compatible range;
- mark range source as stale/pending/unavailable;
- do not unmount the colorbar if the target still requests it.

## 3. What is architecturally wrong today

### 3.1 No first-class target pass demand model

Current code asks several local questions:

- is shader visible?
- is vector visible?
- what is the surface color mode?
- is the part primary quantity?
- should this be a scoped request?
- can this be merged into aggregate quantity request?

But there is no normalized object like:

```ts
interface Viewport3DPassDemand {
  targetId: string;
  pass: "surface" | "vector-glyph" | "colorbar";
  quantityId: string;
  scopeKind: "full" | "object" | "part" | "airbox" | "selection";
  scopeId: string | null;
  requiredComponent: "none" | "x" | "y" | "z" | "magnitude" | "full";
  completeness: "complete" | "sampled-ok";
}
```

Without this model, optimization and correctness are entangled.

### 3.2 Render plan and fetch plan are not cleanly separated

The code now has a partial split:

- `primaryFieldRenderOptions`
- `primaryFieldDataOptions`

This solved a specific vector-budget regression, but the broader architecture is still mixed. Vector budgets, scalar modes, field vectors, palette, revision keys, and worker build decisions still travel together.

Production rule:

- render plan decides what must be drawn;
- fetch plan decides the smallest correct payloads;
- fetch plan must never delete information required by the renderer.

### 3.3 Payload capability is implicit

A decoded `DecodedFieldVector` is treated as enough information. It is not.

For rendering, these payloads are materially different:

- full vector, complete full domain;
- full vector, complete object/part scope;
- full vector, sampled for glyphs;
- scalar x, complete object/part scope;
- scalar magnitude, complete full domain;
- synthetic vector field;
- complex phase projection.

Today these distinctions are inferred by downstream functions. They should be explicit data.

### 3.4 One `partFieldVectors` map hides source and eligibility

The current map answers only:

> What field vector should this part try to use?

It does not answer:

> Which pass is allowed to use it?

This is why bugs can appear as white surfaces, missing glyphs, or colorbar gaps even when the endpoint returns some data successfully.

### 3.5 Aggregate vs scoped request decisions are heuristic

The current logic can skip scoped part requests when all visible parts of a quantity share the same scalar mode. That may be optimal, but only if a complete aggregate payload is actually planned and eligible for every target.

The rule should be explicit:

- aggregate is valid when one payload covers all target selections and is cheaper or already required;
- scoped is valid when only a subset needs data or quantities/modes differ;
- sampled is valid only for vector-only passes.

### 3.6 Colorbars are downstream of buffers

Current viewport colorbars are generated from available buffers. That makes the component lifecycle dependent on field-buffer availability.

Production colorbars should be generated from demand state:

- target requests a viewport colorbar;
- target has a numeric surface color mode;
- group key identifies quantity, mode, palette, scope, and range source;
- range availability is a child state, not the existence of the colorbar.

### 3.7 Workers are good but not architecturally central

The worker/chunked scalar path already has reducer identity and progressive publishing. But it is a hook bolted onto the render model path, not the output of a central derived work plan.

Production should have:

- derived work items with stable target ids;
- lane, priority, and cancellation policy;
- explicit stale-compatible display buffers;
- explicit adoption and GPU upload budgets.

### 3.8 Diagnostics are post-fact, not explanatory

Diagnostic logs can show:

- slow long tasks;
- slow frame windows;
- slow worker lanes;
- slow requests.

But they do not reliably answer:

- why this target fetched `full`;
- why that target did not fetch scalar component;
- why vectors disappeared;
- why colorbar was pending;
- whether one full payload intentionally satisfied both shader and vectors;
- whether duplicate requests were equivalent or necessary.

### 3.9 Per-target scalar range policy is missing

The current per-target settings model can say:

- color by `x`;
- use palette `viridis`;
- show a viewport colorbar.

It cannot fully say:

- use this object's own auto range;
- lock range to `[-1, 1]`;
- use symmetric diverging scale;
- keep this manual range while data updates;
- share range with this group of targets;
- compute range from metadata rather than visible payload.

That means colorbar and shader behavior still depend too much on what buffer happens to be available. Production visualization needs scalar range policy as user intent.

### 3.10 Cache key and API request can drift

Resource keys are detailed, but request semantics are not always owned by the same object that owns the key. The airbox path is the clearest example: the system can prepare per-part scoped keys while the load function sends a common airbox query.

The production rule must be:

> The request plan object is the single source for both cache key and API call.

No helper should reconstruct query scope later from partial information.

### 3.11 Worker coverage is incomplete

The current system has workers for expensive scalar color and glyph transform stages, but not every heavy stage is off-main-thread:

- complex phase projection can allocate and loop over the full field on the main thread;
- vector segment construction happens on the main thread before glyph worker scheduling;
- worker failure can route expensive work back to synchronous main-thread fallback;
- large typed-array transfer/copy costs are not represented as planned work.

The target architecture should treat those as derived work stages with explicit lane, priority, fallback, transfer, and adoption metrics.

## 4. Correct production architecture

### 4.1 Required logical modules

The production architecture should introduce these logical modules. They may start as pure functions and small files, not large classes.

1. `Viewport3DTargetPlanBuilder`
   - Input: topology, target registry, visualization settings, active quantities, analysis overlay, FDM/FEM adapter state.
   - Output: normalized target render plan.

2. `Viewport3DPassDemandPlanner`
   - Input: target render plan.
   - Output: explicit pass demands for surface, vectors, colorbars, overlays.

3. `Viewport3DFieldDemandPlanner`
   - Input: pass demands.
   - Output: merged field data demands and a request plan.

4. `Viewport3DFieldResourceResolver`
   - Input: request plan and resource hook results.
   - Output: target field buffers with explicit capabilities.

5. `Viewport3DDerivedWorkPlanner`
   - Input: target render plan and target field buffers.
   - Output: scalar color jobs, vector glyph jobs, GPU upload jobs, stale-compatible retention decisions.

6. `Viewport3DRenderModelBuilder`
   - Input: target render plan, target field buffers, derived work results.
   - Output: immutable render model for R3F layers.

7. `Viewport3DLayerRuntime`
   - Input: render model.
   - Output: Three.js object updates, worker scheduling, GPU upload adoption, dirty-frame invalidations.

### 4.2 Target render plan

A target render plan should include only user/rendering intent:

```ts
interface Viewport3DTargetRenderPlan {
  targetId: string;
  targetKind: "object" | "part" | "region" | "airbox" | "fdm-domain";
  label: string;
  quantityId: string;
  visible: boolean;
  shader: {
    visible: boolean;
    surfaceColorSource: SurfaceColorSource;
    scalarColorMode: string | null;
    palette: string;
    scalarRangePolicy: {
      mode: "auto" | "manual" | "shared";
      min: number | null;
      max: number | null;
      symmetric: boolean;
      scale: "linear" | "log" | "diverging";
    };
    monoColor: string;
  };
  vectors: {
    visible: boolean;
    budget: number;
    scope: "surface" | "full";
    colorMode: string;
    lengthScale: number;
    anchorMode: "center" | "tail";
    surfaceOffsetEnabled: boolean;
    surfaceOffsetScale: number;
  };
  colorbar: {
    inspectorVisible: boolean;
    viewportVisible: boolean;
  };
}
```

This plan must not contain decoded field vectors or resource-hook state.

### 4.3 Pass demand model

Every active visual pass emits a demand:

```ts
type FieldPayloadCompleteness = "none" | "complete" | "sampled-ok";
type FieldComponentDemand = "none" | "x" | "y" | "z" | "magnitude" | "full";

interface Viewport3DPassDemand {
  targetId: string;
  passId: string;
  passKind: "surface" | "vector-glyph" | "colorbar" | "fdm-topography";
  quantityId: string;
  component: FieldComponentDemand;
  completeness: FieldPayloadCompleteness;
  scopeKind: "full" | "object" | "part" | "airbox" | "selection";
  scopeId: string | null;
  maxSamples: number | null;
}
```

Demand rules:

- solid shader alone demands no field data;
- component shader demands that scalar component, complete;
- magnitude shader demands scalar magnitude, complete;
- orientation/HSL shader demands full vector, complete;
- vector glyph demands full vector;
- vector-only demand can be sampled;
- shader plus vector demands the stricter complete full-vector payload;
- colorbar consumes metadata or already planned complete field data, but does not fetch a second equivalent payload by default.

### 4.4 Field data demand plan

The field data demand planner merges pass demands into field requests.

Demand key:

```text
session | quantity | snapshot/stage | scopeKind | scopeId | component | completeness | sampling
```

Merge rules:

- `full` satisfies `x`, `y`, `z`, and `magnitude`;
- complete satisfies sampled for the same target, but sampled never satisfies complete;
- different scalar components for one target merge to `full`;
- vector demand always upgrades scalar component demand to `full`;
- aggregate full-domain demand can satisfy target-scoped demand only if the topology mapping proves coverage;
- object/part/airbox scopes must not be merged unless the adapter explicitly proves equivalence.

### 4.5 Resource request plan

The request plan is the only layer allowed to create API query parameters.

```ts
interface Viewport3DFieldResourceRequest {
  requestId: string;
  quantityId: string;
  query: {
    component: "full" | "x" | "y" | "z" | "magnitude";
    scope_kind: "full" | "object" | "part" | "airbox" | "selection";
    scope_id?: string;
    max_samples?: number;
    snapshot_id?: string;
    stage_id?: string;
    view?: "real" | "complex";
    phase_rad?: number;
  };
  consumers: readonly string[];
}
```

No React component or render model should invent endpoint parameters.

The request object must also be the only source used to derive the cache key. A request with `scope_id=part-a` must not be keyed as scoped and then executed as an unscoped request.

### 4.6 Target field buffers

Decoded payloads must become capability-tagged buffers:

```ts
type Viewport3DFieldPayloadCapability =
  | "full-vector-complete"
  | "full-vector-sampled"
  | "scalar-complete"
  | "complex-full-complete"
  | "synthetic-full-vector";

interface Viewport3DTargetFieldBuffer {
  bufferId: string;
  targetIds: readonly string[];
  quantityId: string;
  component: "full" | "x" | "y" | "z" | "magnitude";
  capability: Viewport3DFieldPayloadCapability;
  scopeKind: "full" | "object" | "part" | "airbox" | "selection";
  scopeId: string | null;
  pointCount: number;
  componentCount: number;
  complete: boolean;
  sampled: boolean;
  fieldRevision: string | null;
  topologyRevision: string | null;
  values: Float32Array | Float64Array;
}
```

Eligibility is then simple:

| Pass | Allowed capability |
|---|---|
| surface component | `scalar-complete`, `full-vector-complete`, `complex-full-complete` when mode supports it |
| surface orientation | `full-vector-complete` |
| vector glyph | `full-vector-complete`, `full-vector-sampled`, `synthetic-full-vector` |
| colorbar | metadata, `scalar-complete`, `full-vector-complete` |

If a pass cannot consume a buffer, the render model records a degradation reason. It does not fall through to a global buffer unless the global buffer explicitly advertises coverage and matching quantity/mode/palette/range.

### 4.7 Render model

The render model should expose per-target pass outputs, not global maps that layers have to query manually.

Example:

```ts
interface Viewport3DTargetRenderModel {
  targetId: string;
  surface: {
    visible: boolean;
    scalarColors: ScalarColorBuffer | null;
    retained: boolean;
    degradation: string | null;
  };
  vectors: {
    visible: boolean;
    buildReference: Viewport3DVectorBuildReference | null;
    segments: Float32Array | null;
    retained: boolean;
    degradation: string | null;
  };
  colorbar: {
    requested: boolean;
    groupKey: string | null;
    rangeState: "current" | "pending" | "stale-compatible" | "unavailable";
  };
}
```

`MeshPartLayer` should receive the target model directly. It should not have to search `scalarColorsByPartAndMode`, then global `scalarColorsByMode`, then validate settings.

### 4.8 Colorbar model

Colorbars should be planned independently from current buffer availability.

Group key:

```text
quantity | colorMode | palette | scopeKind | scopeId-set | rangeRevision | visualizationRevision
```

Rules:

- Inspector colorbar belongs to selected target and should exist whenever a numeric shader mode is selected.
- Viewport colorbar is opt-in per target via `viewportColorbarVisible`.
- Targets with identical group keys share one viewport colorbar.
- Targets with different ranges, palettes, modes, quantities, or scopes need separate colorbars.
- Missing fresh range is a range state, not an unmount command.
- Solver field updates should update range values in place when group identity is unchanged.

### 4.9 Worker and GPU lifecycle

Derived work should be planned as explicit jobs:

```ts
interface Viewport3DDerivedWorkItem {
  workId: string;
  targetId: string;
  lane: "field-color" | "vector-glyph" | "gpu-upload";
  inputBufferId: string;
  outputKind: "scalar-colors" | "vector-glyphs" | "buffer-attribute";
  staleCompatibilityKey: string;
  latestWins: boolean;
}
```

Rules:

- scalar color builds above threshold run off-main-thread;
- vector glyph transforms run off-main-thread;
- vector segment construction and complex phase projection are derived work too, not free render-model bookkeeping;
- GPU upload is frame-budgeted and chunked;
- old compatible buffers remain visible until replacement is adopted;
- topology changes invalidate geometry;
- field revision changes update attributes/textures, not whole scene topology.

### 4.10 Diagnostics

The diagnostic recorder should be able to emit one compact explanation per update:

```json
{
  "targetId": "object:permalloy_layer",
  "passes": ["surface", "vector-glyph", "colorbar"],
  "demand": "full-vector-complete",
  "requests": [
    "GET /v2/sessions/current/data/fields/m/samples/vector?component=full&scope_kind=object&scope_id=object:permalloy_layer"
  ],
  "buffers": ["full-vector-complete current"],
  "derivedWork": ["field-color current", "vector-glyph pending"],
  "retained": ["surface stale-compatible"],
  "degradation": []
}
```

This is what is currently missing from the full log. The log reports freezes, but the system cannot always explain the exact target and demand that caused them.

## 5. Design decisions

### 5.1 One payload may serve multiple passes

If a target has shader and vectors enabled, fetch once when one payload can satisfy both.

Correct examples:

- `x component + vectors`: one full complete payload.
- `solid + vectors`: one full sampled payload is allowed if vectors are the only field-valued pass.
- `orientation + vectors`: one full complete payload.

Incorrect examples:

- fetch scalar `x` for surface and full vector for glyphs for the same revision when full complete already covers both;
- fetch sampled vectors and use them for surface shader;
- fetch full aggregate and scoped scalar for the same target without a measured reason.

### 5.2 Do not reduce visualization quality

Performance must come from:

- correct demand merging;
- scoped requests;
- worker offload;
- chunked uploads;
- stale-compatible retention;
- avoiding duplicate equivalent work.

It must not come from:

- disabling surface coloring;
- lowering scalar quality;
- reducing vector fidelity when the target budget requests it;
- hiding colorbars during updates;
- silently using sampled data for complete shader coloring.

### 5.3 Per-object settings must be isolated

Changing one object's:

- surface color source;
- palette;
- active quantity;
- vector budget;
- vector visibility;
- viewport colorbar visibility;

must not mutate another object's render plan. Shared requests are an optimization after isolation has been established, not the source of truth.

### 5.4 The API facade remains the only transport owner

The frontend should keep using the typed API/resource layer. The new planner should produce request objects consumed by resource hooks; it should not introduce direct `fetch()`.

## 6. Refactor plan

### Phase 0: characterization tests

Add tests before moving architecture:

- one object `x`, one object `orientation`, one object `solid`: modes stay isolated;
- `x + vectors` creates one full complete demand for that target;
- `x` without vectors creates scalar x demand;
- vector-only creates full sampled demand;
- sampled vector payload is rejected for shader;
- scalar payload is rejected for vectors;
- per-object colorbar group keys remain stable when only range values update;
- field revision update retains old compatible surface/vector/colorbar until replacement is ready.
- scoped airbox request key and actual API query are identical.
- retained scalar buffer is rejected when color mode, range, phase, or field revision is incompatible.

### Phase 1: extract target render plan

Create pure functions that convert topology and visualization settings into target render plans.

Keep the existing hook as orchestrator, but remove local repeated setting reads from deeper planning functions.

Include scalar range policy in this plan, even if the first implementation only supports `auto`. The contract must make room for per-object scale/range before colorbar behavior can become production-grade.

### Phase 2: extract pass demand planner

Create explicit pass demands from target render plans.

At this point, no resource hook behavior needs to change yet. The goal is visibility and tests.

### Phase 3: extract field demand and request planner

Convert pass demands into a fetch plan.

This phase replaces scattered logic in:

- `resolveViewport3DPrimaryFieldQuery`;
- `resolveViewport3DScopedPartVectorFieldRequests`;
- `targetQuantityFieldQueries`;
- airbox query planning.

### Phase 4: introduce target field buffers

Wrap decoded field vectors in capability-tagged target buffers.

This phase can keep `DecodedFieldVector` internally but must expose eligibility metadata to render-model code.

### Phase 5: simplify render model builder

Change `buildViewport3DFieldRenderModel(...)` to consume:

- target render plan;
- target field buffers;
- derived work results;
- topology.

It should stop being responsible for deciding which payload is valid for which pass.

### Phase 6: move scalar/vector work to derived work planner

Unify scalar color and vector glyph work as derived work items.

The existing scheduler lanes can stay, but jobs should be keyed by explicit work ids and target ids.

This phase must include vector segment construction and complex phase projection, not only glyph mesh transforms. Otherwise the browser can still freeze before the worker stage starts.

### Phase 7: replace colorbar derivation with colorbar plan

Move colorbar grouping out of `Viewport3DModule.tsx` into a pure colorbar planner.

`Viewport3DModule.tsx` should render planned legends and range states, not derive architecture from `fieldModel`.

### Phase 8: diagnostics and validation

Add diagnostics for:

- pass demands;
- merged field demands;
- actual resource requests;
- decoded payload capabilities;
- rejected pass-buffer matches;
- stale-compatible retention;
- duplicate equivalent requests;
- worker lane queue/adopt/upload times.
- key/request mismatch checks for every scoped data-plane request.

## 7. Acceptance criteria

The refactor is complete only when all conditions below are true.

1. Per-object `surfaceColorSource`, `scalarColorPalette`, scalar range policy, `activeQuantityId`, `vectorBudget`, `vectorsVisible`, and `viewportColorbarVisible` are isolated in the target render plan.
2. `x/y/z/magnitude` shader without vectors can fetch scalar component data.
3. The same shader with vectors fetches one full complete vector payload, not scalar plus vector duplicate.
4. Vector-only targets may fetch sampled full vectors.
5. Sampled payloads are impossible to consume as shader surface colors.
6. Scalar-only payloads are impossible to consume as vector glyphs.
7. Global payload fallback is allowed only when capability, quantity, scope, topology mapping, palette, and range are compatible.
8. Field updates during solver runs retain old compatible surfaces, vectors, and colorbars until replacements are ready.
9. Colorbars do not unmount when only range values update.
10. Diagnostics can explain every request and every degraded pass by target id.
11. Main-thread long tasks from topology, scalar color, vector glyph, and GPU upload paths are bounded by worker/chunking policy.

## 8. Verification ladder

Required after implementation, not for this report-only audit:

1. Focused unit tests for planners and buffer eligibility.
2. Existing viewport render model tests.
3. Existing `Viewport3DModule` colorbar tests.
4. Resource hook tests for scoped, aggregate, airbox, quantity, and duplicate request behavior.
5. `pnpm --dir apps/control-room test`.
6. `pnpm --dir apps/control-room typecheck`.
7. `pnpm --dir apps/control-room lint`.
8. Browser smoke for 3D viewport with:
   - three objects;
   - mixed surface modes;
   - vectors enabled on one target;
   - viewport colorbar opt-in on two targets;
   - running solver updates.
9. Performance diagnostics:
   - no duplicate equivalent field requests;
   - no cache-key/request-query mismatch;
   - no white surface flicker;
   - no vector disappearance during compatible updates;
   - no colorbar remount on range-only updates;
   - idle viewport returns to zero frames.

## 9. What not to do

Do not solve this by:

- disabling 3D objects;
- disabling scalar texture coloring;
- replacing HSL/component modes with solid color;
- lowering vector budgets globally;
- hiding colorbars by default beyond the explicit viewport opt-in rule;
- adding more fallbacks from per-part buffers to global buffers without capability checks;
- adding new `useMemo` patches inside `useViewport3DSceneModel.ts` without extracting the planner boundary.

Those approaches hide symptoms and preserve the architectural flaw.

## 10. Gemini audit reconciliation and upgraded unified plan

The Gemini audit is useful because it points at the correct performance direction: keep geometry stable, update WebGL attributes and uniforms in place, use workers for heavy transforms, chunk GPU uploads, and avoid switching a material into vertex-color mode before the matching color buffer is complete.

Those are good mechanisms, but they are not yet a complete production architecture. The strongest version of the design must make them guaranteed properties of the pipeline, not optimistic outcomes of several local hooks.

### 10.1 What the Gemini audit gets right

The following recommendations are aligned with the target architecture:

- field-value updates should not recreate topology geometry;
- scalar color uploads should be chunked and adopted only when the complete target buffer is ready;
- shader parameters should be updated through stable uniforms where possible;
- vector glyphs should use instancing rather than per-vector mesh objects;
- expensive glyph transforms should not run inside React render;
- compatible stale buffers should remain visible until replacement buffers are ready;
- draw calls and GPU uploads must be explicitly budgeted.

These points should be preserved. They improve performance without lowering visual quality.

### 10.2 What is not proven today

The external audit overstates readiness in these places:

- "zero React re-renders" is not an architecture contract today; the current scene model still depends on broad snapshot and resource objects that can invalidate large parts of the tree;
- "zero shader recompilations" is not guaranteed unless material program class, shader defines, and vertex-color flags are controlled by the planner and only changed at adoption boundaries;
- vector glyph work is not fully off-main-thread if segment construction, sampling preparation, or fallback paths still run synchronously before the worker stage;
- worker failure must not silently re-route large O(N) derived builds back to the main thread;
- chunked upload is not enough if data decode, scalar extraction, vector segment construction, or colorbar range derivation already froze the browser before upload begins;
- per-target color mode, palette, range, and scale are not fully modeled as target intent today;
- colorbars are still too dependent on current buffer availability rather than a stable colorbar plan;
- request deduplication is not yet a proven invariant from the planner down to the actual API query string.

That means the current recipe is not yet the best possible production design. It is a partial implementation of the right direction.

### 10.3 Stronger production design for surface textures

The best long-term texture path is not "CPU builds RGB colors for every mode switch". The production path should separate field values from color presentation.

Target design:

1. Keep decoded field payloads as canonical value buffers with explicit capabilities.
2. For shader-capable surfaces, upload raw scalar/vector value attributes or textures once per field revision.
3. Change color mode, palette, range, and scale by updating uniforms and palette textures, not by regenerating per-vertex RGB arrays.
4. Compute HSL orientation in the shader when the target buffer has a complete full-vector payload.
5. Compute `x`, `y`, `z`, and magnitude normalization in the shader from scalar or full-vector target buffers.
6. Keep worker-built RGB `ScalarColorBuffer` as a compatibility path for non-shader materials, screenshots, fallback renderers, and cases where shader capability is unavailable.

This preserves visual quality while removing the largest avoidable recoloring cost. Palette and range changes become cheap presentation changes. Field revision changes still require value-buffer upload, but not separate RGB rebuilds for every active color mode unless the fallback path is active.

The planner must decide whether a target uses:

- `shader-value-buffer`: preferred path, raw values plus shader color mapping;
- `worker-rgb-buffer`: compatibility path, derived RGB colors;
- `solid-color`: no field payload required;
- `retained-stale-compatible`: previous compatible buffer retained while a new buffer builds.

### 10.4 Stronger production design for vector glyphs

The Gemini suggestion to move quaternion transforms to the GPU is directionally correct, but a single unconditional global instanced mesh is too blunt for Fullmag. It can break per-object style, visibility, picking, diagnostics, and future selection semantics.

Correct design:

1. Short term: move vector segment construction, sampling normalization, and glyph transform preparation into the derived work planner.
2. Medium term: represent vector glyph inputs as raw instance attributes:
   - position;
   - direction;
   - magnitude or length scale;
   - color scalar or packed color;
   - target id or style bucket id where needed.
3. Compute orientation in a custom instanced vertex shader instead of uploading a full matrix per glyph.
4. Batch by style bucket, not blindly by the whole scene.
5. Use one shaft/head instanced pair per compatible style bucket.
6. Preserve per-target visibility, budget, color mode, selection, picking, and diagnostics.

This gives most of the draw-call reduction benefit without sacrificing object-level semantics. The optimal draw-call target is not always exactly two calls. It is "bounded by style buckets and pass requirements, not by accidental object count".

### 10.5 One unified repair plan for several current issues

The next implementation should not split texture correctness, vector disappearance, colorbar flicker, duplicate requests, and browser freezes into separate local fixes. They are symptoms of the same missing planner boundary.

The unified plan is:

1. Characterize the current regressions with focused probes:
   - three objects with mixed `orientation`, `x`, `y`, `z`, and solid color;
   - one target with vectors and shader enabled;
   - one target shader-only;
   - one target vector-only;
   - viewport colorbar opt-in on selected targets;
   - solver updates while changing modes;
   - duplicate request detector enabled;
   - main-thread long-task and worker fallback counters enabled.
2. Extract target render intent:
   - surface pass demand;
   - vector pass demand;
   - colorbar demand;
   - scalar range policy;
   - palette policy;
   - per-target stale retention policy.
3. Extract field demand and request planning:
   - surface-only component target may request scalar component data;
   - shader plus vectors must request one full complete vector payload;
   - vector-only may request sampled full vector data;
   - compatible targets may share one aggregate payload;
   - incompatible targets must get scoped payloads;
   - the final request object must generate both the cache key and the API query.
4. Add capability-tagged target buffers:
   - `complete-full-vector`;
   - `sampled-full-vector`;
   - `scalar-component`;
   - `surface-indexed`;
   - `volume-indexed`;
   - `shader-value-ready`;
   - `vector-glyph-ready`;
   - `colorbar-range-ready`.
5. Move derived work into one scheduler plan:
   - scalar extraction;
   - shader value buffer preparation;
   - fallback RGB color build;
   - vector segment construction;
   - vector glyph instance data;
   - colorbar range and legend data;
   - GPU upload chunks.
6. Adopt buffers atomically:
   - target keeps old compatible surface until new surface buffer is complete;
   - target keeps old compatible vectors until new vector buffer is complete;
   - colorbar identity remains mounted while only range values update;
   - no pass falls back to an incompatible global buffer.
7. Add diagnostics as a required product surface:
   - demand id;
   - request id;
   - decoded payload capability;
   - derived work id;
   - worker lane;
   - upload duration;
   - adoption reason;
   - rejection reason;
   - React render reason;
   - duplicate equivalent request warning.

This plan fixes several issues in one architectural pass:

- mixed per-object texture modes stop affecting each other;
- `x/y/z` components can use correct ranges and shader values;
- vectors and shader can share one full vector payload when both are enabled;
- surface-only targets avoid fetching unnecessary full vector data;
- vector-only targets do not require surface-indexed shader buffers;
- colorbars stop unmounting during compatible updates;
- white flicker becomes a failed adoption invariant instead of a visual race;
- main-thread freezes become attributable to a named demand, derived job, upload, or fallback path.

### 10.6 Extra acceptance criteria from the Gemini reconciliation

The production implementation must also satisfy these criteria:

1. A solver field update does not recreate topology geometry.
2. A compatible field update does not recreate material program class.
3. Palette and scalar range changes update uniforms or palette textures on the shader path.
4. Switching `orientation` to `x/y/z/magnitude` on one object does not alter other object target plans.
5. Vector segment construction is not allowed to run as an unbounded synchronous main-thread loop.
6. Worker unavailable or worker failed states are explicit degraded states, not silent full-cost synchronous fallbacks.
7. Vector draw calls are bounded by style buckets and pass requirements.
8. Browser diagnostics can distinguish decode time, derived worker time, GPU upload time, React commit time, and R3F frame time.
9. No claim of "zero React re-renders" is accepted without render-reason instrumentation in the tested scenario.
10. No claim of "no duplicate fetches" is accepted unless the request planner and actual API calls are compared by normalized request id.

## 11. Production-readiness proof matrix

Implementing the target architecture is necessary, but it is not by itself enough to call the result production-grade. The implementation is production-grade only when every row below is satisfied by code, tests, and browser/runtime evidence.

| Area | Production requirement | Proof required |
|---|---|---|
| Target intent | Every object, mesh part, airbox, and fallback domain has an explicit target render plan. | Unit tests for mixed object modes, hidden objects, solid-only targets, vector-only targets, shader+vector targets, and viewport colorbar opt-in. |
| Request planning | Fetch requests are generated only from pass demands, never from layer-side fallbacks. | Planner tests proving scalar-only, vector-only, shader+vector, airbox, scoped object, and aggregate-sharing cases. |
| Cache identity | The cache key and the actual API query are produced from the same normalized request object. | Tests comparing request id, query params, component, scope kind, scope id, quantity id, sample budget, and revision. |
| Payload capability | Decoded buffers expose explicit capabilities before any layer can consume them. | Eligibility tests proving sampled payloads cannot feed shader surfaces and scalar payloads cannot feed vector glyphs. |
| Surface texture correctness | Per-target `orientation`, `x`, `y`, `z`, magnitude, palette, and range do not leak between objects. | Browser scenario with at least three magnetic objects using different modes and palettes while solver updates are running. |
| Surface texture performance | Palette/range/mode changes on the shader path update uniforms or palette textures, not topology geometry or material program class. | Render-reason diagnostics, WebGL resource counters, and material/geometry identity assertions around mode switching. |
| Vector correctness | Vectors render for object, airbox, vector-only, and shader+vector cases. | Browser scenario enabling vectors on one target while other targets use different surface modes or solid color. |
| Vector performance | Vector segment construction and glyph preparation are not unbounded synchronous main-thread loops. | Worker-lane diagnostics, fallback counters, and long-task audit during solver updates. |
| Colorbar lifecycle | Viewport colorbars are opt-in per target and remain mounted across compatible range updates. | React remount counter or stable legend identity test while ranges update. |
| Stale-compatible retention | Old compatible surfaces, vectors, and colorbars remain visible until replacement buffers are complete. | Tests for field revision transition, worker delay, aborted request, and rejected incompatible payload. |
| Worker failure | Worker unavailable/failure states are explicit degraded states, not silent full-cost main-thread rebuilds. | Forced-worker-failure test and diagnostics event proving degraded state is surfaced. |
| Dirty rendering | Idle viewport produces zero frames after settling. Solver, camera, resize, field update, and style update each have explicit dirty reasons. | `audit:idle-performance` plus viewport dirty-reason counters. |
| Resource lifecycle | WebGL resources, workers, observers, and large buffers are released on layer/module unmount or topology/style invalidation. | Viewport memory stress test and resource tracker counts returning to zero for module-owned resources. |
| API hygiene | React components do not construct data-plane endpoint strings or call transport directly. | API hygiene search/test proving requests go through facade/resource hooks/planners. |
| Diagnostics | Every freeze, degraded pass, duplicate request, or buffer rejection can be traced to a demand id and target id. | Diagnostic record fixtures and browser diagnostic report from the mixed-object live scenario. |

### 11.1 Hard fail conditions

The implementation is not production-grade if any of these remain true:

- a component-mode switch can make unrelated targets white, solid, or HSL-oriented;
- a solver update causes repeated long main-thread windows with no demand/job attribution;
- a vector layer disappears when the surface shader is enabled;
- a colorbar unmounts and remounts during a compatible range update;
- full vector data is fetched twice for the same compatible shader+vector target;
- scalar component data is fetched for a target that also needs full vector glyphs and could share the full vector payload;
- sampled vector data is consumed as a surface texture;
- worker fallback silently runs large derived work synchronously on the main thread;
- status or websocket events carry heavy field/topology payloads instead of invalidating named resources;
- UI code constructs ad-hoc `/v2/...` strings for this path.

### 11.2 Minimum live proof before calling it done

The final implementation must produce one saved diagnostic bundle for this scenario:

1. Start a short live simulation with at least three magnetic targets and an airbox.
2. Configure target A: shader surface `orientation`, vectors on.
3. Configure target B: shader surface `component_x`, vectors off, viewport colorbar on.
4. Configure target C: solid color, vectors on.
5. Configure airbox: sampled vectors on.
6. While the solver updates fields, switch target B between `x`, `y`, `z`, and magnitude.
7. Verify:
   - no unrelated target changes mode;
   - no white texture flash;
   - no vector disappearance;
   - no colorbar remount;
   - no duplicate equivalent field requests;
   - no unbounded main-thread derived build;
   - idle returns to zero viewport frames after the solver stops.

Passing unit tests without this live proof is not enough, because the reported regressions appear specifically at the interaction between resource invalidation, R3F adoption, worker timing, and live solver updates.

### 11.3 Final answer to the production question

If the implementation includes the architecture in this report, the Gemini reconciliation upgrades, and all proof gates in this section, then it is a credible production design for this subsystem.

If it implements only the structural refactor but skips diagnostics, live mixed-object proof, worker-failure behavior, or resource/request identity tests, then it is not production-grade. It would only be a cleaner version of the current fragile path.

## 12. Short version

Current architecture:

- per-object state exists;
- scoped and aggregate resource hooks exist;
- per-part scalar colors exist;
- vector workers and chunked scalar color workers exist;
- colorbar retention exists;
- but all of this is coordinated by one overloaded scene hook and one overloaded render-options object.

Correct architecture:

- target render intent is isolated first;
- scalar range and scale policy are target intent, not an accident of the latest buffer;
- visual passes emit explicit demands;
- demands merge into fetch requests;
- decoded payloads become capability-tagged target buffers;
- render model consumes only eligible buffers;
- workers build derived buffers from explicit work items;
- colorbars are planned from target demands and updated by range state;
- diagnostics explain the full chain.

That is the production direction. The next implementation step should not be another local patch in the layer code. It should be extraction of the target render plan and pass demand planner with characterization tests around the current regression scenarios.
