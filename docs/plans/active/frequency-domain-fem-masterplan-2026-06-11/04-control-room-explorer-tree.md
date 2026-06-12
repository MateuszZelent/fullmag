# 04 - Control Room Explorer Tree

## Current State

The Explorer currently has only shallow authoring support for the two related but distinct study kinds: modal `eigenmodes` and driven `frequency_response`.

Verified current nodes:

- `study.stage.eigenmodes`
- `study.stage.frequency_response`

Verified missing result nodes:

- no `results.frequency_domain.root`
- no `results.eigen.study`
- no `results.eigen.spectrum`
- no `results.eigen.mode`
- no `results.eigen.dispersion`
- no `results.eigen.branch`
- no `results.eigen.diagnostics`
- no `results.frequency_response.sweep`
- no `results.frequency_response.frequency_point`
- no analysis mode field resource nodes

Current consequence:

- A user can add an Eigenmodes or Frequency Response stage, but cannot navigate solved modal products or driven response products like a professional scientific application.
- A user cannot choose an explicit calculation workflow such as FMR, dispersion, free modes, driven frequency sweep, or response map as a first-class tree object.
- Result discovery is not modeled as a product tree.
- Charts, tables, diagnostics, and 3D plotting have no stable selection target.

## Target State

The Explorer must represent driven frequency-response authoring/execution and modal eigen/dispersion artifacts as first-class nodes under one analysis family.

Explorer must expose explicit calculation workflow modes. These are UI/product workflows, not backend solver kinds:

| Calculation mode | Canonical study | Primary result nodes | Plot surfaces |
|---|---|---|---|
| `fmr_modal` | `Eigenmodes` at k = 0 | FMR modal spectrum, mode table, selected modes | FMR frequency table, modal spectrum, mode overlay |
| `fmr_response` | `FrequencyResponse` at k = 0 | FMR response sweep, peaks, frequency points | absorption/amplitude/phase/susceptibility versus frequency |
| `free_modes` | `Eigenmodes` without k-path | spectrum, modes, diagnostics | spectrum, mode table, mode overlay |
| `dispersion_modal` | `Eigenmodes` with k-path/Floquet | dispersion, k-path, branches, modes | f(k), branch table, mode overlay |
| `response_map` | `FrequencyResponse` over k and f | response map, k/f slices, frequency points | intensity map, response sweep slices, field overlay |

The calculation mode node configures canonical study fields. It must never hide requested intent, resolved execution, boundary conditions, or capability rejections.

Rules:

- Every node kind listed in this file must be added to `ExplorerNodeKind`.
- `ExplorerNodeKind` is currently a dot-separated string union. Adding many node kinds is acceptable only with exhaustive inspector registry tests.
- `ExplorerNode` currently uses flat optional fields, not a nested `metadata` bag. Add frequency-domain fields as flat optionals matching the existing pattern.
- Every node must have a stable ID convention.
- Every node must specify its parent.
- Every node must have a domain-specific inspector.
- No frequency-domain or modal node in this family may route to `PlaceholderPanel`.
- Result nodes must be built from runtime resources, primarily the frequency-domain manifest.
- Stage authoring nodes live under `model`.
- Result nodes live under `results`.
- Raw artifact/resource nodes live under `resources`.
- Running and queued driven solver or modal solver work lives under `jobs`.
- Capability, provenance, and solver diagnostics live under `diagnostics`.

Migration note for `ExplorerNode` fields:

Add only the flat optional fields needed by the new nodes:

```ts
analysisRunId?: string;
analysisStageId?: string;
sampleIndex?: number;
modeIndex?: number;
branchId?: string;
frequencyIndex?: number;
observableId?: string;
fieldId?: string;
calculationMode?: "fmr_modal" | "fmr_response" | "free_modes" | "dispersion_modal" | "response_map";
```

Do not introduce a generic `metadata: Record<string, unknown>` escape hatch.

## Required New Node Kinds

Authoring detail nodes:

```text
study.stage.eigenmodes.setup
study.stage.eigenmodes.calculation_mode
study.stage.eigenmodes.equilibrium
study.stage.eigenmodes.operator
study.stage.eigenmodes.boundary
study.stage.eigenmodes.periodic_pairs
study.stage.eigenmodes.k_path
study.stage.eigenmodes.solver
study.stage.eigenmodes.outputs
study.stage.eigenmodes.diagnostics
study.stage.frequency_response.setup
study.stage.frequency_response.calculation_mode
study.stage.frequency_response.equilibrium
study.stage.frequency_response.operator
study.stage.frequency_response.boundary
study.stage.frequency_response.periodic_pairs
study.stage.frequency_response.k_grid
study.stage.frequency_response.excitation
study.stage.frequency_response.sweep
study.stage.frequency_response.solver
study.stage.frequency_response.outputs
study.stage.frequency_response.diagnostics
```

Result nodes:

```text
results.frequency_domain.root
results.frequency_domain.run
results.frequency_domain.calculation_modes
results.frequency_domain.fmr
results.frequency_domain.fmr_modal_spectrum
results.frequency_domain.fmr_response_sweep
results.frequency_domain.fmr_peaks
results.frequency_domain.dispersion
results.frequency_domain.response_map
results.eigen.root
results.eigen.study
results.eigen.spectrum
results.eigen.modes
results.eigen.mode
results.eigen.dispersion
results.eigen.k_path
results.eigen.branches
results.eigen.branch
results.eigen.diagnostics
results.eigen.provenance
results.frequency_response.root
results.frequency_response.study
results.frequency_response.sweep
results.frequency_response.progress
results.frequency_response.cancel_requested
results.frequency_response.frequency_points
results.frequency_response.frequency_point
results.frequency_response.observables
results.frequency_response.observable
results.frequency_response.diagnostics
results.frequency_response.provenance
results.frequency_domain.comparison
results.frequency_domain.exports
```

Resource nodes:

```text
resources.analysis.frequency_domain
resources.analysis.frequency_domain.manifest
resources.analysis.frequency_domain.calculation_modes
resources.analysis.frequency_domain.fmr
resources.analysis.frequency_domain.dispersion
resources.analysis.frequency_domain.response_map
resources.mesh.periodic_pairs
resources.analysis.eigen.spectrum
resources.analysis.eigen.branches
resources.analysis.eigen.dispersion
resources.analysis.eigen.diagnostics
resources.analysis.eigen.mode_metadata
resources.analysis.eigen.mode_field
resources.analysis.frequency_response.sweep
resources.analysis.frequency_response.progress
resources.analysis.frequency_response.cancel_requested
resources.analysis.frequency_response.frequency_point
resources.analysis.frequency_response.field
resources.analysis.frequency_response.diagnostics
```

Job nodes:

```text
jobs.frequency_domain.root
jobs.frequency_domain.stage_run
jobs.frequency_domain.eigen_sample
jobs.frequency_domain.response_frequency
jobs.frequency_domain.response_progress
jobs.frequency_domain.artifact_export
```

Diagnostics nodes:

```text
diagnostics.frequency_domain.root
diagnostics.frequency_domain.capabilities
diagnostics.frequency_domain.equilibrium
diagnostics.frequency_domain.operator
diagnostics.frequency_domain.solver
diagnostics.frequency_domain.artifacts
diagnostics.frequency_domain.api_resources
diagnostics.frequency_domain.visualization
diagnostics.frequency_domain.periodic_floquet
```

## Target Model Tab Tree

The model tab owns authoring state and execution setup.

```text
model:session
  model:study
    model:study:stages
      model:study:stage:{stageId} [kind=eigenmodes]
        model:study:stage:{stageId}:setup
        model:study:stage:{stageId}:calculation-mode
        model:study:stage:{stageId}:equilibrium
        model:study:stage:{stageId}:operator
        model:study:stage:{stageId}:boundary
        model:study:stage:{stageId}:periodic-pairs
        model:study:stage:{stageId}:k-path
        model:study:stage:{stageId}:solver
        model:study:stage:{stageId}:outputs
        model:study:stage:{stageId}:diagnostics
      model:study:stage:{stageId} [kind=frequency_response]
        model:study:stage:{stageId}:setup
        model:study:stage:{stageId}:calculation-mode
        model:study:stage:{stageId}:equilibrium
        model:study:stage:{stageId}:operator
        model:study:stage:{stageId}:boundary
        model:study:stage:{stageId}:periodic-pairs
        model:study:stage:{stageId}:k-grid
        model:study:stage:{stageId}:excitation
        model:study:stage:{stageId}:sweep
        model:study:stage:{stageId}:solver
        model:study:stage:{stageId}:outputs
        model:study:stage:{stageId}:diagnostics
    model:study:execution
    model:study:recovery
```

Node construction rules:

- For `kind=eigenmodes`, use the eigen detail children.
- For `kind=frequency_response`, use the response detail children.
- For `calculation_mode=fmr_modal`, show k = 0 FMR validation, modal spectrum, and mode table affordances.
- For `calculation_mode=fmr_response`, show k = 0 frequency sweep, excitation, response spectrum, and peak diagnostics affordances.
- For `calculation_mode=dispersion_modal`, show boundary, periodic pair, Floquet phase, k-path, branch tracking, and dispersion affordances.
- For `calculation_mode=response_map`, show k/f grid and capability-gated response-map affordances.
- The parent stage node remains selectable and opens the stage overview inspector.
- Detail children open narrow inspectors that edit only one part of the draft.
- Stage IDs must come from the existing stage snapshot; do not synthesize unstable array-only IDs when a stable stage ID exists.

Stage node statuses:

- `ready`: all required authoring fields are valid and the capability exists.
- `validation-blocked`: authoring fields are invalid.
- `unsupported`: requested backend/device/precision cannot run this stage.
- `running`: stage execution is active.
- `completed`: stage execution completed and manifest exists.
- `failed`: stage execution failed.
- `degraded`: stage ran with a reference or experimental engine.

## Target Results Tab Tree

The results tab owns solved data.

```text
results:root
  results:frequency-domain
    results:frequency-domain:run:{runId}
      results:frequency-domain:{runId}:calculation-modes
        results:frequency-domain:{runId}:fmr
          results:frequency-domain:{runId}:fmr:modal-spectrum
          results:frequency-domain:{runId}:fmr:response-sweep
          results:frequency-domain:{runId}:fmr:peaks
        results:frequency-domain:{runId}:dispersion
          results:frequency-domain:{runId}:dispersion:k-path
          results:frequency-domain:{runId}:dispersion:branches
        results:frequency-domain:{runId}:response-map
          results:frequency-domain:{runId}:response-map:kf-grid
          results:frequency-domain:{runId}:response-map:slices
      results:eigen:{stageId}
        results:eigen:{stageId}:spectrum
        results:eigen:{stageId}:modes
          results:eigen:{stageId}:sample:{sampleIndex}:mode:{modeIndex}
          results:eigen:{stageId}:sample:{sampleIndex}:mode:{modeIndex}
        results:eigen:{stageId}:dispersion
          results:eigen:{stageId}:k-path
          results:eigen:{stageId}:branches
            results:eigen:{stageId}:branch:{branchId}
            results:eigen:{stageId}:branch:{branchId}
        results:eigen:{stageId}:diagnostics
        results:eigen:{stageId}:provenance
      results:frequency-response:{stageId}
        results:frequency-response:{stageId}:sweep
        results:frequency-response:{stageId}:progress
        results:frequency-response:{stageId}:frequency-points
          results:frequency-response:{stageId}:frequency:{frequencyIndex}
          results:frequency-response:{stageId}:frequency:{frequencyIndex}
        results:frequency-response:{stageId}:observables
          results:frequency-response:{stageId}:observable:{observableId}
          results:frequency-response:{stageId}:observable:{observableId}
        results:frequency-response:{stageId}:diagnostics
        results:frequency-response:{stageId}:provenance
    results:frequency-domain:comparison
    results:frequency-domain:exports
```

Result tree construction rules:

- Build from `frequency_domain/manifest.v1.json`.
- If no manifest exists, show `results:frequency-domain` with status `stale` and a missing-results inspector.
- If eigen artifacts exist, create the eigen subtree.
- If response artifacts exist, create the response subtree.
- If manifest `calculation_mode` is `fmr_modal` or `fmr_response`, create the FMR workflow subtree and link it to the underlying eigen or response nodes.
- If manifest `calculation_mode` is `dispersion_modal`, create the dispersion workflow subtree and link it to the underlying eigen dispersion, k-path, branches, and mode nodes.
- If manifest `calculation_mode` is `response_map`, create the response-map workflow subtree only for real artifacts or as a capability-gated unavailable node.
- Create one `results.eigen.mode` node per manifest-listed mode metadata object.
- Create one `results.eigen.branch` node per branch in `branches.v2`.
- Create one `results.frequency_response.frequency_point` node per solved frequency point.
- Create one `results.frequency_response.observable` node per response observable in the response sweep.
- Do not create speculative nodes for artifacts that do not exist.
- Do not hide unsupported result families; show unavailable state only at root/overview nodes.

Result node badges:

- Spectrum: mode count or sample count.
- FMR: resonance count, peak count, or unsupported status.
- FMR modal spectrum: k = 0 mode count and validation status.
- FMR response sweep: frequency count and strongest peak if available.
- Dispersion workflow: k sample count and branch count.
- Response map: k sample count by frequency count, or gated status.
- Modes: number of mode metadata entries.
- Mode: frequency in GHz with raw mode index.
- Dispersion: number of k samples.
- Branches: number of tracked branches.
- Branch: branch ID plus mode count.
- Response sweep: number of frequencies.
- Frequency point: frequency in GHz.
- Observable: observable ID.
- Diagnostics: pass/warn/fail.
- Provenance: engine label.

## Target Resources Tab Tree

The resources tab exposes raw resource/artifact status without replacing domain result nodes.

```text
resources:root
  resources:analysis:frequency-domain
    resources:analysis:frequency-domain:manifest
    resources:analysis:eigen:spectrum
    resources:analysis:eigen:branches
    resources:analysis:eigen:dispersion
    resources:analysis:eigen:diagnostics
    resources:analysis:eigen:mode-metadata
      resources:analysis:eigen:mode-metadata:{sampleIndex}:{modeIndex}
    resources:analysis:eigen:mode-fields
      resources:analysis:eigen:mode-field:{fieldId}
    resources:analysis:frequency-response:sweep
    resources:analysis:frequency-response:progress
    resources:analysis:frequency-response:frequency-points
      resources:analysis:frequency-response:frequency-point:{frequencyIndex}
    resources:analysis:frequency-response:fields
      resources:analysis:frequency-response:field:{fieldId}
    resources:analysis:frequency-response:diagnostics
```

Resource tree construction rules:

- Build from manifest resource refs and resource runtime snapshots.
- Resource nodes show raw schema, path, revision, cache state, and invalidation state.
- Resource nodes do not contain authoring controls.
- Resource nodes do not duplicate charts from result inspectors.

## Target Jobs Tab Tree

The jobs tab exposes active and recent frequency-domain work.

```text
jobs:root
  jobs:frequency-domain
    jobs:frequency-domain:stage-run:{commandId}
      jobs:frequency-domain:eigen-sample:{sampleIndex}
      jobs:frequency-domain:response-frequency:{frequencyIndex}
      jobs:frequency-domain:response-progress
    jobs:frequency-domain:artifact-export:{commandId}
```

Job construction rules:

- Build from command queue status and solver stage progress resources.
- For eigen k-path runs, show per-sample progress when available.
- For response sweeps, show per-frequency progress when available.
- If the backend cannot report per-sample progress, show one stage-run node with aggregated progress.
- Job nodes must preserve command ID and stage ID.

## Target Diagnostics Tab Tree

Diagnostics tab exposes implementation and validity state.

```text
diagnostics:root
  diagnostics:frequency-domain
    diagnostics:frequency-domain:capabilities
    diagnostics:frequency-domain:equilibrium
    diagnostics:frequency-domain:operator
    diagnostics:frequency-domain:solver
    diagnostics:frequency-domain:artifacts
    diagnostics:frequency-domain:api-resources
    diagnostics:frequency-domain:visualization
    diagnostics:frequency-domain:periodic-floquet
```

Diagnostics construction rules:

- Capabilities node reads current capability resource.
- Equilibrium node reads manifest diagnostics and solver diagnostics.
- Operator node reads operator diagnostics.
- Solver node reads convergence/residual diagnostics.
- Artifacts node reads manifest artifact index and API 404/missing status.
- API resources node reads resource runtime state.
- Visualization node reads mode-field registration and viewport readiness.
- Periodic-Floquet node reads periodic pair diagnostics, phase convention,
  k-path/k-grid metadata, and nonzero-k demag rejection status.

## Explorer Builder Implementation Plan

Files to change:

- `apps/control-room/src/modules/explorer/explorerTypes.ts`
- `apps/control-room/src/modules/explorer/builders/study/eigenmodesStageNode.ts`
- `apps/control-room/src/modules/explorer/builders/study/frequencyResponseStageNode.ts`
- new `apps/control-room/src/modules/explorer/builders/results/frequencyDomainResultNodes.ts`
- new `apps/control-room/src/modules/explorer/builders/resources/frequencyDomainResourceNodes.ts`
- new `apps/control-room/src/modules/explorer/builders/jobs/frequencyDomainJobNodes.ts`
- new `apps/control-room/src/modules/explorer/builders/diagnostics/frequencyDomainDiagnosticNodes.ts`

Step-by-step instructions:

1. Add new node kinds to `ExplorerNodeKind`.
2. Add icon tokens only if existing icons are insufficient; prefer existing `wave`, `activity`, `gauge`, `database`, `file`, and `sparkles`.
3. Extend `ExplorerNode` metadata minimally:
   - `analysisRunId?: string`
   - `analysisStageId?: string`
   - `sampleIndex?: number`
   - `modeIndex?: number`
   - `branchId?: string`
   - `frequencyIndex?: number`
   - `observableId?: string`
   - `fieldId?: string`
4. Keep metadata typed and optional; do not use generic `any` bags.
5. Extend study stage builders to add detail children.
6. Add a result-tree builder that consumes the manifest resource.
7. Add resource-tree nodes from manifest resource refs and current resource status.
8. Add jobs nodes from command queue/progress resources.
9. Add diagnostics nodes from capability and manifest diagnostics.
10. Add tests that assert all node kinds are generated for a fixture manifest.
11. Add tests that assert no frequency-domain node kind resolves to placeholder once inspector registry is updated.
12. Include explicit coverage for PBC/Floquet nodes:
    `study.stage.eigenmodes.periodic_pairs`,
    `study.stage.eigenmodes.k_path`,
    `study.stage.frequency_response.periodic_pairs`,
    `study.stage.frequency_response.k_grid`,
    `resources.mesh.periodic_pairs`, and
    `diagnostics.frequency_domain.periodic_floquet`.

## Explorer Acceptance Gate

This layer is complete only when:

- A completed eigen run produces a navigable spectrum node, modes folder, individual mode nodes, dispersion node, branch nodes, diagnostics node, and provenance node.
- A completed response run produces a sweep node, frequency-point nodes, observable nodes, diagnostics node, and provenance node.
- Resource tab exposes raw artifact and field-resource status for the same run.
- Jobs tab exposes active driven frequency-response solver work and modal solver work separately.
- Diagnostics tab exposes capability, equilibrium, operator, solver, artifact, API, and visualization state.
- Every generated node has a stable ID and a matching inspector.
