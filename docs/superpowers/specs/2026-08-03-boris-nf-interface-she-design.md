# BORIS N/F(/T) reciprocal SHE comparison harness design

- Status: approved design for implementation
- Date: 2026-08-03
- Scope: executable BORIS comparison for the open `SHE-BORIS-001` gate
- Related plan: `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/PLAN_WDROZENIA_I_SPECYFIKACJA_FIZYKI.md`
- Related physics note: `docs/physics/0970-spin-hall-drift-diffusion-transport.md`

## Goal

Add a reproducible, fail-closed comparison harness for the reciprocal spin
Hall transport that is already documented in Fullmag but is not yet
quantitatively qualified against BORIS. The first executable workload is a
two-mesh normal-metal/ferromagnet (N/F) interface with non-zero `Gi` and
`Gmix`, `SHA=iSHA`, finite charge and spin observables, and independently
computed residual and interface-balance checks. A tunnel-barrier N/T/F case
is a second workload and is not allowed to hide failures in the first one.

The harness produces evidence and diagnostics only. It must not promote a
capability-matrix row to `validated`, change the public default backend, or
claim solver equivalence from a single run.

## Decisions and physical conventions

1. The N/F case is executed before N/T/F. N/F isolates the transparent
   interface laws and makes a non-zero spin accumulation observable before
   barrier conductance, SML, and tunnelling transmission are introduced.
2. BORIS is run with `SHA=iSHA` and the same sign convention in every
   reciprocal run. A run with unequal coefficients is retained only as a
   deliberately non-reciprocal diagnostic and cannot be used for an Onsager
   comparison.
3. The N region is a conductor below the F region, with equal in-plane
   extents and adjacent cells in `+z`; the F mesh owns the non-zero
   interface `Gi`/`Gmix` parameters. The geometry, cell size, material
   constants, electrode direction, and applied current density are recorded
   in the artifact in SI units.
4. BORIS quantities are kept in their native conventions. The adapter records
   the explicit mapping
   `V_s = De*S/(elC*MUB_E)` and only maps to a Fullmag spin splitting as
   `mu_s = 2*V_s` when the artifact declares that convention. No implicit
   factor of two, sign flip, or Levi-Civita reordering is permitted.
5. Charge-current continuity is checked on both sides of the interface. Spin
   flux balance includes the interface-absorbed transverse spin current and
   the torque reported by BORIS; comparing only a pointwise `S` profile is
   insufficient.
6. The first evidence lane is managed BORIS CPU/embedded execution. CUDA
   execution is a separate lane with the same input and artifact schema; a
   CUDA binary or source path alone is never treated as device proof.

## Components and boundaries

### 1. BORIS scenario producer

Create a small checked-in Python scenario generator under `scripts/` that
emits the BORIS NetSocks script for the N/F case and, behind an explicit
switch, the N/T/F case. It owns only geometry, materials, parameters,
electrodes, solver settings, stage control, and output names. It must not
parse results or decide whether the physics passed.

The generated script records the stage and mesh metadata and writes V, S,
charge-current, spin-current, and torque fields in a deterministic artifact
directory. `Gi` and `Gmix` are serialized as BORIS `DBL2` values. Missing
managed binary, missing CUDA runtime, or an unsupported NetSocks operation is
an execution error, not a skipped comparison.

### 2. Execution wrapper and runtime identity

Add a host-side runner/verifier that invokes the external BORIS build through
the managed runtime used for the existing smoke. It must record:

- BORIS source-tree manifest hash;
- exact executable SHA-256;
- container image digest and Python/runtime version;
- requested device, detected device, and precision;
- scenario source SHA-256 and normalized parameter JSON.

The runner must fail closed if the binary or identity metadata is absent or
if the output directory already contains files from a different run. It may
use the existing `/zfn2/mateuszz/git/fullmag/boris-build` build copy, but it
must never modify the ignored `external_solvers/BORIS` snapshot.

### 3. Versioned artifact and independent verifier

Use an explicit artifact schema, `fullmag.boris_she_nf.v1`, with these top
level groups:

```json
{
  "schema_version": "fullmag.boris_she_nf.v1",
  "runtime": {},
  "scenario": {},
  "fields": {},
  "observables": {},
  "residuals": {},
  "interface_balances": {},
  "qualification": {}
}
```

`fields` contains native BORIS samples and grid metadata; `observables`
contains mapped `V_s` and optional `mu_s`; `residuals` contains charge and
spin PDE norms recomputed by the verifier from exported fields; and
`interface_balances` contains left/right charge flux, spin flux, absorbed
torque, and signed closure error. `qualification` states the workload,
precision, execution lane, and whether the evidence is only a reference
diagnostic or has crossed all declared gates. It defaults to
`"status": "diagnostic"`.

The verifier rejects absent fields, non-finite values, wrong units, grid
identity mismatches, non-monotone stages, inconsistent `SHA/iSHA`, missing
interface conductance, and closure errors above the declared tolerance. It
does not replace the Fullmag solver or silently alter source data.

### 4. Fullmag comparison adapter

The adapter consumes the same geometry and physical constants and reads a
Fullmag FDM CPU-double artifact only after the BORIS artifact has passed its
internal checks. It compares quantities after explicit coordinate, unit, and
spin-convention normalization. It reports profile errors, integrated charge
current, spin-current components, interface torque, and residuals separately;
one aggregate score is not used as a physics decision.

The first adapter target is the existing FDM CPU M2 reference lane. FEM,
GPU, single precision, heterogeneous SML/mixing, and production runtime
promotion remain separate gates.

## Failure handling and reproducibility

- No executable BORIS output means `not_run`, never `pass`.
- A failed residual or balance means `failed_physics`, even when the process
  exits successfully.
- A missing runtime identity means `unqualified_runtime`, even when fields
  are present.
- A comparison with mismatched mesh, parameters, or conventions means
  `incomparable`, not a large numerical error.
- All tolerances are stored in the artifact with SI units and precision.
- Temporary build and run data belongs below `/zfn2/mateuszz/git/fullmag`;
  the repository receives only small manifests, summaries, and regression
  fixtures.

## Validation gates

### N/F gate

The gate requires finite non-zero `S`, `V`, charge current, and spin-current
observables; non-zero `Gi` and `Gmix`; `SHA=iSHA`; finite independently
recomputed residuals; charge-current closure; spin-flux plus torque closure;
and a reproducible runtime identity. It is exercised at three resolutions
and at a tolerance sweep before any parity statement is made.

### N/T/F gate

The gate additionally requires an explicit tunnel-barrier thickness and
conductance, separate interface fluxes on N/T and T/F, and a barrier-limit
check against the N/F configuration. Failure here leaves the N/F result
valid as an N/F diagnostic but does not promote the broader SHE capability.

### CPU/CUDA gate

The same scenario and normalized artifact schema are run on BORIS CPU and
CUDA lanes. Device residency, detected device, and precision are checked
from runtime evidence. A source-level CUDA implementation or a successful
binary launch without those observations is insufficient.

## Testing and documentation

1. Unit tests cover scenario serialization, `DBL2` conductance encoding,
   explicit spin-voltage mapping, residual/balance calculations, artifact
   schema validation, and fail-closed mutations.
2. A managed execution test is opt-in and records the exact command and
   runtime identity; ordinary unit tests use small deterministic fixtures and
   never require a GPU.
3. The audit plan receives a dated implementation/evidence subsection only
   after an actual managed run. It records open gates and keeps
   `semantic_only`/`reference_executable` boundaries unchanged until all
   stated criteria are met.

## Non-goals

- Reimplementing BORIS transport in Fullmag or copying BORIS source into the
  repository.
- Declaring direct/inverse SHE, interface mixing, or Onsager equivalence
  from source inspection alone.
- Adding a new public Python/UI parameter in this harness iteration.
- Treating the existing homogeneous direct-SHE smoke with zero spin
  accumulation as the N/F qualification workload.
