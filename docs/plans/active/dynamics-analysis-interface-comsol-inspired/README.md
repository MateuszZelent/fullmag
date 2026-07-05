# Dynamics Analysis Interface - COMSOL-Inspired Plan

Status: active design and implementation plan
Created: 2026-07-02
Owner surface: `apps/control-room`
Reference: `docs/comsol/Manual_for_Micromagnetics_Module.pdf`

## Goal

Build a professional Control Room interface for micromagnetic dynamics analysis:
modal eigenmodes, driven frequency response, spectra, peaks, dispersion,
complex dynamic magnetization fields, and mode/response inspection. The target
is inspired by COMSOL's workflow construction, but it must remain a Fullmag v2
resource-first workspace rather than a COMSOL clone.

## Source Hierarchy

This folder is a product/interface plan. It does not override physics notes,
artifact specs, or backend capability contracts.

Use this order when a conflict appears:

1. `docs/physics/0700-frequency-domain-linearized-llg.md`
2. `docs/physics/0600-fem-eigenmodes-linearized-llg.md`
3. `docs/specs/frequency-domain-artifacts-v2.md`
4. `docs/specs/resource-first-control-room-api-v2.md`
5. `docs/specs/capability-matrix-v0.md`
6. `docs/architecture/backend-golden-masterplan.md`
7. `docs/specs/frontend-v2/*`
8. `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/*`
9. this folder
10. COMSOL manual as external UX reference only

## Read Order

1. `01-comsol-figure-analysis.md`
2. `02-target-interface-contract.md`
3. `03-schematics.md`
4. `04-implementation-plan.md`
5. `05-frequency-driven-backend-refactor-plan.md`

## COMSOL Lesson In One Sentence

COMSOL's strength is not a single beautiful FMR dashboard. Its strength is a
consistent construction system: a left semantic tree, a settings inspector for
the selected node, a solver/study node with explicit dependent-variable
inheritance, and result nodes where each plot is a concrete expression,
dataset, solution parameter, component, and color/range configuration.

Fullmag should adopt that construction logic while presenting a more direct
dynamics-analysis workbench.

## Backend Correction

The Control Room plan is valid only when backed by the corrected
frequency-driven solver plan in `05-frequency-driven-backend-refactor-plan.md`.
That file is the local backend correction for this folder: it separates the
CPU and GPU `periodic_airbox_k0` driven-response work, preserves the future
nonzero-k Floquet demag-k path for dispersion, and treats read-only,
`unsupported`, `inactive`, `P2`, validation-only, and fallback states as
temporary development diagnostics with removal criteria.

Frontend checkboxes in `04-implementation-plan.md` do not prove backend
production readiness. Backend production claims must come from the physics
notes, capability matrix, native backend contracts, artifacts, and
container-backed `just` verification gates.

## Non-Negotiable UI Principles

- Dynamics analysis is one workflow family with distinct products:
  `Eigenmodes` and `FrequencyResponse`.
- Modal eigenmodes and driven response peaks must never be mislabeled as the
  same solver result.
- Every Explorer node must map to a dedicated Inspector surface.
- Spectrum charts must be scientific instruments: explicit axes, units,
  selected observable, selected component, selected complex view, provenance,
  point inspection, no raw arrays in tooltips, no hidden truncation.
- Complex dynamic magnetization must expose both component and complex view:
  `delta mx`, `delta my`, `delta mz`, `|delta m|` plus `real`, `imag`, `abs`,
  `phase`, and `phase_rotated_real`.
- The viewport is not a separate analysis app. It is the same unified 3D
  viewport receiving an analysis-field overlay selection.
- Heavy data remains resource/data-plane backed. UI state stores small
  preferences and selected IDs only.

## Affected Frontend Modules

| Module | Slot | Role |
|---|---|---|
| `explorer` | `panel-left` | COMSOL-like semantic navigation tree for studies, results, datasets, fields, modes, peaks, and diagnostics. |
| `inspector` | `panel-right` | Node-specific settings/details/actions, equivalent to COMSOL Settings but resource-first and capability-aware. |
| `analysis-plots` | `viewport-main` / `panel-bottom` | Spectrum, dispersion, response sweep, peak comparison, exact point inspection. |
| `viewport-3d` | `viewport-main` | Spatial mode/response field visualization with complex-view controls. |
| `ribbon` | `ribbon` | Commands: run eigenmodes, run response sweep, plot selected field, export, compare, animate phase. |
| `status-bar` | `status-bar` | Resolved backend/runtime/capability/revision status. |

## Verification Gates For Implementation

Any implementation from this plan must include:

- focused model tests for chart/selection adapters,
- Inspector/Explorer routing tests for every node kind,
- no direct `fetch()` in modules,
- no module-to-module imports,
- ECharts lifecycle cleanup tests where chart components change,
- browser smoke for analysis-field overlay when 3D viewport behavior changes,
- `pnpm --dir apps/control-room typecheck`,
- `pnpm --dir apps/control-room lint`,
- `pnpm --dir apps/control-room test`.
