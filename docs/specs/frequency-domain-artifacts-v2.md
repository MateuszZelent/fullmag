# Frequency-domain artifacts v2

Status: reference contract
Applies to: FEM eigen, dispersion, Analyze UI, v2 API resources

## Purpose

Frequency-domain artifacts must carry enough semantic information for the
frontend, Python post-processing, and regression tests to use them without
guessing file layout or reconstructing physics from labels.

The canonical artifact family is:

```text
artifacts/frequency_domain/manifest.v1.json
artifacts/eigen/diagnostics/solver.v1.json
artifacts/eigen/spectrum.v2.json
artifacts/eigen/branches.v2.json
artifacts/eigen/dispersion.csv
artifacts/eigen/dispersion/path.json
artifacts/eigen/modes/sample_XXXX/mode_YYYY.json
artifacts/eigen/mode_fields.zarr/
artifacts/response/diagnostics/solver.v1.json
artifacts/response/magnetic_response_sweep.v1.json
artifacts/response/magnetic_response_sweep.v2.json
artifacts/response/field_payloads.zarr/
artifacts/mesh/periodic_pairs.v1.json
```

## A1S — typed server-side analysis artifacts (schema freeze)

Poniższy kontrakt jest właścicielem serwerowych danych używanych przez późniejszą
warstwę API i Control Room. Nie nadaje żadnemu backendowi statusu
`production_qualified`; stan wykonania i stan kwalifikacji są niezależne.

### Wspólna koperta i digest

Każdy z artefaktów A1S publikuje te same pola identyfikujące zakres i pochodzenie:

| Pole | Typ | Znaczenie i warunek |
|---|---|---|
| `schema_version` | `string` | Jedna z wersji kanonicznych poniżej; zmiana kształtu wymaga nowej wersji. |
| `artifact_id` | `string` | Stabilny identyfikator produktu analizy, niezależny od ścieżki pliku. |
| `source` | `{kind, artifact, revision}` | Bezpośrednie źródło danych; `revision` musi być zgodne z `source_revision`. |
| `source_revision` | `string` | Digest `sha256:<hex>` źródła, a nie timestamp ani długość pliku. |
| `run_id`, `stage_id`, `scope_id`, `runtime_id` | `string` | Tożsamość sesji/run/stage/zakresu/runtime. Brak runtime proof jest jawnie oznaczany `runtime:not_provided`. |
| `revision` | `string` | Digest treści artefaktu; zmiana dowolnego pola naukowego musi go zmienić. |
| `content_sha256` | `string` | Ten sam digest co `revision`; obliczany z pełnego JSON po wyzerowaniu `revision` i `content_sha256`. |
| `status` | enum | `complete`, `partial`, `interrupted` albo `corrupt`. |
| `complete` | `boolean` | `true` wyłącznie, gdy cały zadeklarowany zakres i wszystkie referencje są obecne. |
| `interrupted` | `boolean` | `true` tylko dla kontrolowanego przerwania; nie zastępuje `status`. |
| `requested_execution`, `resolved_execution` | typed object | Żądana intencja i faktycznie rozwiązane wykonanie; brak inferencji z nazwy solvera. |
| `units` | typed object | Jednoznaczne jednostki SI każdej osi i observable. |
| `topology` | typed object | `mesh_id`, `topology_revision`, indeksowanie i osie; konflikt topologii wymusza `partial`. |
| `cross_artifact_refs` | lista `{relation, artifact, revision}` | Referencje muszą wskazywać istniejący artefakt o zgodnym digest. |

Status `partial` zachowuje poprawnie zapisane rekordy, ale nie może być awansowany
do `complete` przez klienta. `corrupt` oznacza niespójność lub nieprawidłową
wartość i jest odrzucany przez promotion verifier. Writer nie tworzy zastępczych
wektorów jednorodnych, pól bias ani brakujących wartości covariance.

### `eigen/field_sweep.v1.json`

Jest to fizyczny skan po bias field, nie konfiguracja oracle Kittela. Writer
publikuje go tylko wtedy, gdy każdy sample ma skończone
`external_field_a_per_m[3]` w opublikowanym spectrum (z zachowaniem
`bias_field_a_per_m` jako nazwy wartości skanu). Dane
`FemEigenK0KittelValidationIR.samples[]` są wyłącznie referencją postsolve i nie
mogą zasilać tego artefaktu.
Nazwa osi writera jest zamrożona jako
`scan_axis.coordinate="bias_field_a_per_m"`; `external_field_a_per_m` pozostaje
diagnostycznym polem źródłowego spectrum, nie nazwą osi artefaktu.

`source.revision`, `source_revision` oraz każde `modes[].source_revision` muszą
być SHA-256 rzeczywistych bajtów `eigen/spectrum.v2.json`. `cross_artifact_refs`
musi zawierać dokładnie `source_spectrum` i `source_branches`, z digestami
rzeczywistych bajtów odpowiednio `eigen/spectrum.v2.json` i
`eigen/branches.v2.json`. Digest koperty `revision == content_sha256` jest
niezależny od digestu source i obejmuje po wyzerowaniu tych dwóch pól całą
deklarację skanu.

```json
{
  "schema_version": "eigen/field_sweep.v1",
  "scan_axis": {
    "kind": "bias_field",
    "coordinate": "bias_field_a_per_m",
    "unit": "A/m",
    "display_conversions": [{"name": "mu0_H", "unit": "T", "scale": 0.00000125663706212}]
  },
  "samples": [{
    "sample_id": "bias-field-sample-0000",
    "sample_index": 0,
    "bias_field_a_per_m": [40000.0, 0.0, 0.0],
    "bias_field_mu0_t": [0.0502654824848, 0.0, 0.0],
    "equilibrium_artifact_sha256": "sha256:...",
    "linearization_state_sha256": "sha256:...",
    "operator_input_signature_sha256": "sha256:...",
    "modes": [{
      "sample_id": "bias-field-sample-0000",
      "mode_id": "sample-0000/mode-0000",
      "raw_mode_index": 0,
      "branch_id": 0,
      "frequency_hz": 1.0e9,
      "angular_frequency_rad_per_s": 6.283185307179586e9,
      "mode_artifact_path": "eigen/modes/sample_0000/mode_0000.json",
      "mode_field_id": "analysis:eigen:sample-0000:mode-0000",
      "mode_field_resource_key": "/v2/sessions/current/data/fields/...",
      "residual_relative_l2": 1.0e-9,
      "source_revision": "sha256:...",
      "status": "complete"
    }],
    "status": "complete"
  }]
}
```

Mode bez zweryfikowanego pełnego payloadu Cartesian complex XYZ jest
`spectrum-only`: nie może mieć `mode_field_id`, `mode_field_resource_key` ani
`mode_artifact_path`. Dla `complete=true` każdy mode wizualizowalny musi mieć
jednoznaczną referencję do branch, metadanych i payloadu; brakujący lub częściowy
payload żądanego eksportu jest błędem writera, nie zerowym wektorem zastępczym.

`sample_id` i `mode_id` są stabilną tożsamością danych, natomiast
`sample_index`/`raw_mode_index` są indeksami prezentacyjnymi. Każdy mode field
referuje Cartesian complex payload; sam tangent-local vector bez rekonstrukcji
`global_xyz` nie jest poprawnym `mode_field_id` do wizualizacji.

Każdy zapisany mode field musi ponadto nieść niezmienną
`source_mesh_identity`: niepusty `mesh_id`, pełny lowercase
`topology_fingerprint=sha256:<64 hex>`, opcjonalne generation ID i revision,
`indexing="full_domain_node_order"` oraz `node_count` równy długości obu części
Cartesian complex payloadu. Writer waliduje całą tożsamość przed utworzeniem
metadanych, payloadu albo `mode_field_id`; brak lub niekanoniczny fingerprint
przerywa publikację zamiast tworzyć niekonsumowalny handoff. Endpoint binarnego
pola porównuje tę tożsamość z aktualnym zasobem siatki przed serializacją FMVP.
Brak tożsamości w starym artefakcie lub dowolna niezgodność daje
`409 stale_eigen_mode_mesh`; serwer nie może podpisać starego wektora aktualnym
mesh revision nawet wtedy, gdy liczba węzłów jest taka sama.

`relax_to_eigen_handoff_sha256` i `source_mesh_topology_sha256` są opcjonalne
wyłącznie dla lane'u, który nie deklaruje zaakceptowanego cross-stage
`relax -> eigen` handoffu. Jeżeli którekolwiek pole występuje, oba są
obowiązkowymi lowercase tokenami `sha256:<64 hex>`. Topology digest musi być
równy `source_mesh_identity.topology_fingerprint`, a oba digesty muszą być
identyczne w odpowiadającym mode summary `eigen/spectrum.v2.json`, wpisie
`eigen/metadata/eigen_summary.json` i per-mode metadata. Promotion verifier
odrzuca brak pary, niekanoniczny digest albo dowolny cross-artifact drift.

Zmiana `real`/`imag`/`abs`/`phase` dla zgodnego mode field podmienia wyłącznie
bufor pola. Zmiana topologii unieważnia bufor i wymaga ponownego pobrania albo
regeneracji artefaktu; klient nie rekonstruuje zera ani pola zastępczego z
metadanych.

### `fmr/peaks.v1.json`

Peaks są derived data setem. `source.kind=driven_response` wymaga istniejącego
`response/magnetic_response_sweep.v2.json` i fizycznego
`max_response_amplitude`/observable z jednostką artefaktu. `source.kind=modal_coupling`
jest dozwolone dopiero z zatwierdzonym drive/polarization i oscillator-strength
observable. Sama lista eigenfrequency nigdy nie jest automatycznie FMR intensity.
Jednostka `response_amplitude` musi być przepisana z mapy `si_units` źródłowego
response artifact; brak deklaracji pozostaje `null`, nie może być zastąpiony
wartością domyślną.

Obowiązkowe pola root to `algorithm`, `algorithm_parameters`, `requested_point_count`,
`completed_point_count`, `peaks[]`, `source_revision`, `units` i wspólna koperta.
Każdy peak ma `peak_id`, source frequency index, `frequency_hz`,
`response_amplitude`, `bracketed` oraz jawne `uncertainty`. Peak na końcu skanu
może być zapisany diagnostycznie z `bracketed=false`, lecz nie może być promowany
do refined resonance.

Jeżeli peak pochodzi z modalnego źródła, writer zachowuje jego `sample_id` i
`mode_id`; dla driven-response pozostają one `null`, a identyfikatorem punktu
źródłowego jest `frequency-point-####` w response sweep.

### `fmr/resonance_fits.v1.json`

Fit zapisuje `model`, `fit_range_hz`, `baseline`, `weights`,
`peak_frequency_hz`, `linewidth_hz`, `q_factor`, `coefficients`, `covariance`,
`conditioning`, `residual_l2`, uncertainty i referencję do `fmr/peaks.v1.json`. Writer może
opublikować lokalny fit diagnostyczny, ale bez modelu szumu covariance pozostaje
`null`, `status=partial`, a `complete=false`; brak covariance nie może być
przedstawiony jako niepewność statystyczna.

### `fmr/kittel_fit.v1.json`

Jest to wersjonowany postsolve comparison job. `model` (np.
`macrospin_larmor` albo `thin_film_in_plane`), `parameters`, `validation_status`,
`validation_tolerance_relative`, `points[]`, `excluded_samples` i niezależne
`source_revision` muszą być zapisane. Każdy point wiąże
`sample_id`, `mode_id`, `bias_field_a_per_m`, expected/solved frequency i
`relative_frequency_error`. Artefakt nie jest wejściem solvera. Jeśli fit nie ma
covariance/conditioning, pozostaje `partial` mimo kompletnego porównania punktów.

### Implementacja i dowody

Rust writer znajduje się w
`crates/fullmag-runner/src/eigen/artifacts.rs`:
`build_frequency_domain_field_sweep_artifact`, `build_fmr_peaks_artifact`,
`build_resonance_fits_artifact`, `build_kittel_fit_artifact` oraz odpowiadające
funkcje `write_*`. Typy są re-exportowane przez `crates/fullmag-runner/src/eigen/mod.rs`.
Focused tests sprawdzają brak fabrykacji pola z Kittel metadata, sample/mode
identity, status `interrupted`, źródło driven response, digest całej koperty
(w tym zmianę execution/topology o tej samej długości), bezpieczną podmianę
plików JSON oraz obecność ścieżek typed artifacts w manifeście.
Te testy są kontraktowe; nie są dowodem managed CPU/GPU runtime ani kwalifikacji
fizycznej.

## Storage format policy

JSON is the control-plane format only. Frequency-domain JSON artifacts may
carry schema versions, small summaries, provenance, diagnostics, resource
keys, and links, but must not become the default storage format for large
numerical arrays.

The default heavy-data format for new frequency-domain artifacts is a Zarr
directory store:

- modal mode fields: `eigen/mode_fields.zarr`,
- driven response field payloads: `response/field_payloads.zarr`,
- future dense response maps over `(k, f, component)`,
- future multi-mode amplitude/phase tensors.

HDF5/H5 is an allowed alternate backend or export format when the runtime
environment already provides an HDF5 stack and the API can expose the same
resource semantics. HDF5/H5 must not change the public resource identity:
Control Room consumes named v2 resources and data-plane field endpoints, not
backend-specific file paths.

Raw `*.bin` payloads and JSON-heavy payloads are compatibility formats. New
writers may keep them for migration tests, small smoke fixtures, or
backward-compatible readers. Production-size mode fields and response fields
should be written to Zarr by default, with compression enabled for chunked
floating-point arrays.

Legacy artifacts may remain readable, but new dispersion UI and API surfaces
must prefer the v2 family.

## Mandatory manifest hardening envelope

This section defines the target provenance envelope shared by modal eigen and
driven response. It extends the semantics discovered through
`frequency_domain/manifest.v1.json`; it does not claim that all current writers,
OpenAPI resources or UI inspectors already emit or consume these fields.
Missing current links are `contract_gap` until the producer, validator, API and
UI move together.

### Contract versions and readiness

Every newly promoted manifest must include:

```json
{
  "physics_contract_version": "micromagnetics_frequency_domain_v5",
  "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
  "implementation_state": "executable",
  "validation_state": "unvalidated",
  "validated_scope": "exact bounded product/k/demag/device/precision/engine scope"
}
```

The allowed readiness values are the capability-matrix vocabulary:

```text
implementation_state = absent | contract_only | source_visible | executable
validation_state = unvalidated | algebra_validated | physics_validated | production_qualified
validated_scope = non-empty bounded workload description
```

`implementation_state=executable` does not imply a validation state.
`validation_state=production_qualified` is invalid without an exact
`validated_scope` and accepted evidence for that same scope. Modal and driven
response never inherit readiness from one another. K0 does not qualify
nonzero-k; no-demag does not qualify dynamic demag; CPU does not qualify GPU;
an operator-on-GPU/host-Krylov run does not qualify device-resident Krylov.

Current manifests use `physics`, `requested_execution`, `resolved_execution`,
`diagnostics` and capability snapshots, but do not consistently carry the
three readiness fields or the two version fields. That is a current
`contract_gap`; readers must not infer them from a solver name.

### Requested and resolved execution

Both objects are required. Fields not applicable to one product use an explicit
`not_applicable` value only where the schema permits it; they are not silently
omitted when needed to distinguish intent from execution.

```json
{
  "requested_execution": {
    "backend": "fem",
    "device": "cpu",
    "precision": "double",
    "execution_mode": "strict",
    "study_product": "modal_eigen",
    "solver_method": "auto",
    "preconditioner": "not_applicable",
    "include_demag": true,
    "magnetostatic_bc": "periodic_airbox_k0"
  },
  "resolved_execution": {
    "backend": "fem",
    "device": "cpu",
    "precision": "double",
    "engine": "cpu_sparse_direct",
    "implementation_id": "k0_poisson_airbox_cpu_full_coupled_slepc",
    "solver_library": "SLEPc/PETSc",
    "operator_residency": "host",
    "vector_residency": "host",
    "krylov_residency": "host",
    "preconditioner_residency": "host",
    "fallback_used": false,
    "fallback_reason": null
  }
}
```

The example demonstrates shape only; an artifact may use these values only when
the executing path produced them. Current ABI lanes `validation`,
`production_cpu`, and `production_gpu` remain compatibility fields and may be
included as `requested_execution_lane`/`resolved_execution_lane`. They do not
replace `resolved_execution.engine` and do not prove residency.

Fallback rules:

- strict device, precision or explicit solver method cannot fallback;
- `fallback_used=true` requires `fallback_reason`, `fallback_from_engine` and
  `fallback_to_engine`;
- validation/reference, CPU, K0, open-boundary, no-demag, synthetic assembly,
  analytic demag and postsolve phase projection cannot replace a different
  requested physical operator;
- unavailable strict execution preserves the requested object and publishes
  `resolved_execution.status = "unavailable"` plus `unsupported_reason`.

Current driven diagnostics expose `validation_fallback_used` and broad lane
fields. Current modal manifests may hardcode CPU/double request data. A writer
must not promote these compatibility values into the hardened envelope without
the original plan and actual engine evidence.

### Assembly, phase and identity hashes

Every manifest that claims a numeric FEM solve must include:

```json
{
  "assembly_kind": "mfem_weak_form_shared_domain",
  "operator_input_signature_sha256": "sha256:...",
  "phase_convention": "exp_i_omega_t",
  "phase_constraint_sha256": "sha256:...",
  "equilibrium_artifact_sha256": "sha256:...",
  "linearization_state_sha256": "sha256:...",
  "periodic_mesh_certificate_sha256": "sha256:..."
}
```

`phase_constraint_sha256` hashes the canonical phase convention, k sample,
magnetic/scalar equivalence classes, translations and tangent-frame transforms
used by the solved operator. For a nonperiodic solve it is the hash of an
explicit `not_applicable` phase-constraint descriptor. Hashes identify content,
not filesystem paths or display labels.

`operator_input_signature_sha256` is the lane-independent signature of the
physical/operator inputs for one sample. It is generated from the accepted
periodic mesh certificate and equivalence-map binding, reduced magnetic and
scalar maps and DOF counts, k/phase convention, Poisson-Robin boundary and
gauge tuple, material/physics/boundary snapshot identities, demag realization,
SI constants and operator dictionary. It deliberately excludes the raw
floating-point equilibrium, tangent-frame basis and linearization arrays.
The signature is compared exactly between CPU and GPU for the same sample and
is allowed to vary across a field/path sweep when the requested operator
inputs vary.

`phase_constraint_sha256`, `equilibrium_artifact_sha256` and
`linearization_state_sha256` remain required lane-specific provenance
identities. Independent CPU/GPU relaxations are not required to serialize
bit-identical state hashes: the parity gate compares the accepted
`m_initial.json` vectors component-wise against the explicit physical state
tolerance, while still rejecting missing, stale or unaccepted v6 handoff
artifacts and sidecars whose `content_sha256` does not match the diagnostic
identity. A state mismatch outside that tolerance is a parity failure, not a
warning or an implicit fallback.

`equilibrium_artifact_sha256` and `linearization_state_sha256` are required for
both products under the target v6 handoff. The periodic certificate hash is
required for periodic/Floquet solves and is the hash of an accepted
`periodic_mesh_certificate.v6`; nonperiodic solves publish an explicit
`not_applicable` value under the schema. Current v5 IDs, pair-map fingerprints,
and `equilibrium_provenance` paths are not substitutes. Target-v6 production
consumption is currently a `contract_gap`.

Allowed `assembly_kind` values include at least:

```text
mfem_weak_form_shared_domain
synthetic_algebraic_oracle
reference_dense_tangent
reference_dense_cartesian
```

An artifact with `assembly_kind=synthetic_algebraic_oracle` is limited to
`validation_state=algebra_validated` and must publish
`production_periodic_airbox_claim=false`. It cannot qualify real mesh,
airbox, Poisson, modal or driven physics.

### Boundary and gauge tuple

When magnetostatic scalar potential is present, the manifest and solver
diagnostics include one identical object:

```json
{
  "boundary_gauge": {
    "magnetostatic_bc": "periodic_airbox_k0",
    "outer_boundary_kind": "poisson_robin",
    "robin_beta": 1.0,
    "robin_beta_unit": "1/m",
    "gauge_policy": "none",
    "gauge_reason": "coercive_outer_boundary",
    "eta_row_present": false
  }
}
```

Only these K0 outer-boundary/gauge combinations are valid:

```text
poisson_robin(beta>0) -> gauge_policy=none,
                          gauge_reason=coercive_outer_boundary,
                          eta_row_present=false
poisson_dirichlet     -> gauge_policy=none,
                          gauge_reason=coercive_outer_boundary,
                          eta_row_present=false
pure_neumann          -> gauge_policy=mean_zero_augmented,
                          gauge_reason=pure_neumann_nullspace,
                          eta_row_present=true
```

The object is absent only when no scalar magnetostatic block exists. A current
diagnostic containing individual `gauge_policy`, `outer_boundary_kind` or
`robin_beta` fields is partial evidence; cross-artifact tuple identity remains
a `contract_gap` until validators compare the complete object.

### Spectral scalar mode and shift

Modal selected-spectrum diagnostics and the manifest include:

```json
{
  "spectral": {
    "spectral_transform": "shift_invert",
    "spectral_scalar_mode": "real_split",
    "sigma_real_per_s": 0.0,
    "sigma_imag_rad_per_s": 6283185307.179586
  }
}
```

Allowed `spectral_scalar_mode` values are `complex` and `real_split`. For the
canonical `lambda=i*omega` mapping, a target frequency uses
`sigma_real_per_s=0` and `sigma_imag_rad_per_s=omega_target`. A real PETSc
scalar build must use `real_split`; publishing a real-axis shift for the
imaginary eigenvalue spectrum is invalid.

Current diagnostics may expose `spectral_transform`, `shift_frequency_hz`,
`poisson_airbox_shift_sigma_real`, `poisson_airbox_shift_sigma_imag`, or
solver-specific shift labels. The canonical scalar-mode and sigma fields are a
`contract_gap` until writers derive and validators cross-check them.

### Full block residual certification

Poisson-airbox modal and coupled driven solves certify the original full
operator after reconstructing all eliminated/reduced fields:

```json
{
  "block_residuals": {
    "eps_q": 0.0,
    "eps_phi": 0.0,
    "eps_gauge": 0.0,
    "eps_full": 0.0,
    "backend_reported_residual": 0.0,
    "certification_tolerance": 1e-8,
    "certified": true
  }
}
```

All epsilon values are dimensionless. `eps_full` must equal
`max(eps_q,eps_phi,eps_gauge)`; when no gauge row exists, `eps_gauge=0` and the
tuple declares `eta_row_present=false`. A backend residual is diagnostic only
and cannot cap or replace reconstructed block errors.

Current Poisson modal diagnostics use
`magnetic_block_backward_error`, `poisson_block_backward_error`,
`gauge_constraint_backward_error`,
`reconstructed_full_descriptor_backward_error`, and
`slepc_reported_backward_error`. These map conceptually to the target fields,
but the writer/validator must prove identical normalization before translating
them. Until then, the canonical `block_residuals` object is `contract_gap`.

Magnetic-only solves publish a product-appropriate original-operator residual
object rather than a fabricated phi/gauge block.

### Device residency and transfer audit

`resolved_execution` includes the four residency fields above and, for GPU
claims, a transfer summary:

```json
{
  "device_transfer_audit": {
    "hot_loop_h2d_bytes": 0,
    "hot_loop_d2h_bytes": 0,
    "hot_loop_host_sync_count": 0,
    "control_scalar_d2h_bytes": 0,
    "device_resident_claim": false
  }
}
```

`gpu_operator_host_krylov` sets `operator_residency=device` and
`krylov_residency=host`; it must set `device_resident_claim=false`.
`gpu_device_krylov` or target `gpu_modal_device_krylov` may set the claim true
only after transfer-audit and preconditioner-residency gates pass. Existing
`gpu_device_resident_krylov`, `device_residency` or transfer counters remain
current evidence but must agree with the hardened object.

Native K0 modal diagnostics also expose `setup_h2d_transfer_count` and
`final_d2h_transfer_count`. These are logical block/vector transfers measured
at the successful native matrix-assembly and accepted-mode export boundaries;
they are not runner-supplied estimates. They describe setup/final movement
only. The independent hot-loop counters above must remain zero for a
device-resident modal claim.

### Artifact/API/UI consistency

The same envelope is inspectable through the result manifest resource and
dedicated solver/operator views. OpenAPI must type the hardened fields; a
generic `payload: Value` is not sufficient for durable client guarantees.
Control Room consumes them through `ControlRoomApi.analysis.frequencyDomain`
and resource hooks, then exposes:

- requested versus resolved backend/device/precision/engine,
- implementation and validation state plus exact validated scope,
- assembly and operator dictionary,
- lane-independent operator-input signature for each sample,
- phase, equilibrium, linearization and periodic-certificate identities,
- BC/gauge and spectral shift tuples,
- block residual certification,
- residency, transfer audit, fallback and unsupported reason.

Missing optional artifacts still return diagnostic `404`. A malformed or
contradictory hardened envelope is not optional: resource publication must fail
with a diagnostic error rather than provide an empty plot or partial success.

For a multi-sample native modal path, v6 equilibrium and linearization
sidecars are stored under `eigen/metadata/sample_NNNN/`. A single unscoped
sidecar must not overwrite another sample's accepted state; the manifest array
and each sample's diagnostics identify the corresponding content hash.

### Chapter-24 validation scope and non-object evidence

Production promotion uses the closed
`frequency_domain_validation_scope.v1` object and its content-addressed
`scope_catalog.v1`; a short device/k/demag tuple or an opaque scope hash is not
enough. The complete scope is hashed after reject-before-hash validation and
the manifest/promotion record carries the resulting `scope_id`,
`scope_catalog_uri`, and `scope_catalog_sha256`. Every JSON-object evidence
artifact carries one closed `verified_coverage_of` binding. CSV, Zarr, binary,
and plain-text evidence carries the same binding through the deterministic
sidecar `<artifact-name>.validation_manifest.v1.json`, whose artifact hash or
canonical Zarr-tree hash must match before rows or arrays are consumed.

The fail-closed reference implementation is
`scripts/verify_fem_frequency_domain_production_dod.py`. It validates scope
cross-field legality (including K0 versus Floquet), catalog entry hashes,
direct/coverage binding shape and directional coverage predicates, and
non-object sidecar hashes. A bundle that
does not provide a complete scope/catalog binding remains readable for its
bounded implementation state but is not eligible for
`validation_state=production_qualified`.

Each passing production-DOD item also carries a closed verifier execution
proof. The proof records the exact argv, zero exit status, RFC3339 UTC execution
time, scope and catalog identities, runtime commit/build identity, and SHA-256
digests of immutable stdout/stderr files. Those files require the same
`validation_artifact_manifest.v1` sidecars and scope binding as other text
evidence. The validator checks this proof before consuming metrics; a copied
metrics object or a declared `verifier.result=pass` without an executed,
hash-bound proof remains blocked.

## spectrum.v2.json

Required fields:

- `schema_version = "eigen_spectrum.v2"`,
- `solver_model`,
- `sample_count`,
- `mode_count`,
- `samples[]`.

Each sample must include:

- `sample_index`,
- `label` when the sample is a high-symmetry point,
- `k_vector` in `rad/m`,
- `path_s` in `rad/m`,
- `segment_index`,
- `t_in_segment`,
- `modes[]`.

Each mode summary must include:

- `raw_mode_index`,
- optional `branch_id`,
- `mode_field_id`,
- `mode_field_resource_key`,
- `frequency_real_hz`,
- `frequency_imag_hz`,
- `angular_frequency_rad_per_s`,
- `omega_rad_s`,
- eigenvalue real and imaginary components,
- `phasor_convention = "exp_i_omega_t"` unless a different convention is
  explicitly documented by the solver path,
- `eigenvalue_mapping`, for example `lambda_eq_i_omega`,
- `norm`,
- `max_amplitude`,
- `residual_norm`,
- `residual_absolute_l2`,
- `residual_relative_l2`,
- `residual_linf`,
- `mass_norm`,
- `tangent_leakage_mean_abs`,
- `tangent_leakage_max_abs`,
- `gamma_rad_s_T`,
- `gamma0_rad_s_per_A_m`,
- `mu0_T_m_per_A`,
- `dominant_polarization`,
- `k_vector`.

For damped modal artifacts using `phasor_convention = "exp_i_omega_t"`,
`frequency_imag_hz` is the positive damping rate `Gamma/(2*pi)` for a decaying
mode:

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
damping_rate_hz = frequency_imag_hz
linewidth_fwhm_hz = 2 * frequency_imag_hz
```

A damped `exp_i_omega_t` mode must not publish a negative
`frequency_imag_hz`. If a solver uses `exp(-i omega t)`, the artifact must
state that phasor convention and keep the sign mapping self-consistent.

For modal payloads with `eigenvalue_mapping = "lambda_eq_i_omega"`, every
mode summary, mode metadata payload, and eigen-summary mode entry must publish
finite `eigenvalue_real` and `eigenvalue_imag` fields, and the accepted branch
must satisfy:

```text
eigenvalue_imag > 0
omega_rad_s = eigenvalue_imag
frequency_hz = eigenvalue_imag / (2*pi)
```

The conjugate negative-frequency branch must not be published as an accepted
positive-frequency mode under this mapping.

`eigen/metadata/eigen_summary.json` is a compact index, not a second physical
source of truth. For every `(sample_index, raw_mode_index)` it summarizes, the
modal contract fields must match the corresponding `spectrum.v2.json` mode
summary exactly: phasor convention, eigenvalue mapping/components,
`frequency_real_hz`, `frequency_imag_hz`, `angular_frequency_rad_per_s`,
`omega_rad_s`, `mass_norm`, tangent-leakage diagnostics, and SI constants
`gamma_rad_s_T`, `gamma0_rad_s_per_A_m`, and `mu0_T_m_per_A`.
Compact legacy summaries that omit `sample_index` are interpreted as
`sample_index = 0`; when `sample_index` is present, consumers and validators
must use `(sample_index, index)` as the summary key rather than assuming the
gamma sample.

## branches.v2.json

Required fields:

- `schema_version = "eigen_branches.v2"`,
- `solver_model`,
- `tracking_score_source`,
- `modal_overlap_available`,
- optional `modal_overlap_unavailable_reason`,
- `branches[]`.

Each branch must include:

- `branch_id`,
- optional `label`,
- `points[]`.

Each point must include:

- `sample_index`,
- `raw_mode_index`,
- `frequency_hz`,
- `frequency_real_hz`,
- `frequency_imag_hz`,
- `angular_frequency_rad_per_s`,
- `tracking_confidence`,
- `tracking_score_source`,
- `modal_overlap_available`,
- `mode_field_id`,
- `mode_field_resource_key`,
- optional `overlap_prev`,
- optional `modal_overlap_unavailable_reason`.

Branch identity must be tracked by modal overlap or a stricter future tracking
method. It must not be inferred only from sorted frequency order.
When modal vectors are unavailable, the artifact must say so through
`tracking_score_source = "frequency_score_fallback"` or a mixed summary source
and `modal_overlap_available = false`; clients must not infer overlap-based
tracking from branch continuity alone.
When `modal_overlap_available = true`, `modal_overlap_unavailable_reason` must
be absent, `null`, or empty on summaries and branch points.

For the production nonzero-k modal k-path acceptance gate
(`--require-production-modal-k-path`), branch tracking is stricter: every
non-seed branch point must avoid `frequency_score_fallback`, the branch summary
and diagnostics plus `frequency_domain/manifest.v1.json.diagnostics` must
report `modal_overlap_available = true` and
`tracking_score_source = "modal_overlap_weighted_score"`; mixed fallback
summary sources are not production acceptance evidence. `branches.v2.json` must report
`tracking_method = "overlap_hungarian"`, and the artifact must include at least
one `tracking_score_source = "modal_overlap_weighted_score"` branch point.
`branches.overlap_floor`, `branches.diagnostics.min_overlap`, and non-seed
`overlap_prev` / `tracking_confidence` values must be finite values in
`[0, 1]`. Accepted modal-overlap branch points must not fall below the declared
`overlap_floor`, must publish `overlap_prev`, their `tracking_confidence` must
match `overlap_prev`, `branches.diagnostics.min_overlap` must match the
minimum modal-overlap `overlap_prev` value in the branch points, and
`branches.diagnostics.median_overlap` must publish the corresponding median.
The gamma-only production bridge does not satisfy this nonzero-k modal-overlap
proof.

## dispersion.csv

`eigen/dispersion.csv` is the public artifact for an explicit
`OutputIR::DispersionCurve` / Python `SaveDispersion` request. A multi-k
`KSamplingIR::Path` solve may still emit spectrum, branch, diagnostics, and
manifest metadata for bookkeeping, but it must not publish the public
dispersion CSV or legacy branch table unless the user requested a dispersion
curve. If a k-path request asks for dispersion but does not ask for explicit
mode payloads, the runtime publishes the default branch/mode range
`raw_mode_index = 0..count-1` so the curve is usable and every row can still
hand off to mode-field resources.

The CSV header must include:

```text
sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key
```

For `KSamplingIR::Path`, public sample count and `path_s_rad_per_m` must follow
the same path expansion rule used by the runner. Open paths and closed paths
both publish `sum(samples_per_segment) + 1` samples when
`samples_per_segment` is non-empty. For `closed=true`,
`samples_per_segment.len()` must equal the number of control points and the
last segment returns from the final control point to the first control point;
the final CSV sample therefore has the first control point k-vector at the
total closed-loop arclength.

The eigen artifact validator treats every header field listed above as required.
Each public mode key `(sample_index, raw_mode_index)` published in
`eigen/spectrum.v2.json` must appear exactly once in `dispersion.csv`.
`path_s_rad_per_m`, `kx_rad_per_m`, `ky_rad_per_m`, `kz_rad_per_m`, and
`label` must match the corresponding `eigen/spectrum.v2.json` sample metadata
for the same `sample_index`; an unlabeled spectrum sample is represented as an
empty CSV label.
When path sampling metadata is present in
`metadata.json.execution_plan.backend_plan.k_sampling` or
`eigen/dispersion/path.json`, the validator also checks the
`samples_per_segment` length, expanded sample count, and monotonic `path_s`.
It checks final arclength and final endpoint k-vector for
`eigen/dispersion/path.json` metadata and for any `closed=true` path, including
the return to the first control point.
Strict reference Full2x2 and production modal k-path validation require
`eigen/dispersion/path.json`; the legacy execution metadata path is not enough
to prove the published dispersion sampling contract.
The resource-first Control Room endpoint
`/v2/sessions/current/analysis/frequency-domain/eigen/dispersion` returns the
CSV as `FrequencyDomainTextArtifactResource.text` and publishes
`eigen/dispersion/path.json` as optional `path_metadata` when the sidecar is
present. `path_metadata` is typed in OpenAPI as
`FrequencyDomainKPathMetadataResource`, with `sampling.kind`,
`sampling.points[].label`, `sampling.points[].k_vector`,
`sampling.samples_per_segment`, and optional `sampling.closed`; it is not an
untyped JSON side channel. Each `sampling.points[].k_vector` is a fixed
three-component vector in `rad/m`, and OpenAPI must document it with
`minItems = maxItems = 3`. UI consumers must use that resource hook instead of
switching to the legacy-compatible `/analysis/eigenmodes/dispersion` endpoint
for k-path sampling metadata. The shared frequency-domain chart model may use
`path_metadata.sampling.points[].label` and `samples_per_segment` to restore
high-symmetry point labels on dispersion chart points when a legacy or partial
CSV row omits the `label` value; `dispersion.csv` remains the canonical numeric
series source. The resource endpoint rejects malformed `path_metadata` sidecars
before exposing them to UI consumers: `kind` must be `path`, at least two
control points are required, `samples_per_segment` entries must be positive,
and the segment count must match open or closed path semantics. When the CSV is
present, the endpoint also expands the sidecar sampling path and rejects
resource publication if any CSV `sample_index` lies outside that expanded path,
if the CSV `kx_rad_per_m`, `ky_rad_per_m`, or `kz_rad_per_m` value differs from
the sidecar-derived sample k-vector, or if both the CSV row and sidecar-derived
sample publish non-empty conflicting labels. Missing CSV samples remain legal
for frequency-window artifacts whose selected spectrum omits a path sample. The
eigen artifact validator additionally checks `eigen/dispersion/path.json`
control-point k-vectors against the expanded public `spectrum.v2` samples, and
rejects non-empty label conflicts between sidecar control points and the
corresponding published spectrum/CSV samples.
`branch_id` may be empty only when no branch tracking artifact exists.
When `eigen/branches.v2.json` is present, each non-empty CSV `branch_id` must
match the branch containing the same `(sample_index, raw_mode_index)` point.
`residual_norm` may be empty only for solver paths that explicitly report the
diagnostic as unavailable.
`overlap_score` is a required column for branch-tracking quality handoff, but
its value may be empty for seed points or rows whose tracking score source does
not have an overlap value. Rows with
`tracking_score_source = "modal_overlap_weighted_score"` must publish a finite
`overlap_score` in `[0, 1]`; any non-empty `overlap_score` value must also stay
inside `[0, 1]`. When `eigen/branches.v2.json` is present, a modal-overlap CSV
row's `overlap_score` must match the matching branch point's `overlap_prev` for
the same `(sample_index, raw_mode_index)`.
`tracking_score_source` must identify whether the row is a seed point,
modal-overlap-tracked point, or frequency-fallback point. When
`eigen/branches.v2.json` is present, the CSV `tracking_score_source` must match
the branch point with the same `(sample_index, raw_mode_index)`.
`mode_field_id` and `mode_field_resource_key` must match the selected mode
payload resource when a mode field is emitted, so a dispersion point can be
handed off to the same 3D mode overlay as the corresponding branch point.
When the modal payload has positive `frequency_imag_hz`, `line_width_hz` is
required and equals `2 * frequency_imag_hz`, matching `linewidth_fwhm_hz`.
`analytic_frequency_hz`, `relative_error`, and `validation_geometry` may be
empty for generic dispersion artifacts. For
`--require-low-k-de-bv-analytic-dispersion`, those columns are required for
every sample named by the DE/BV validation scenarios: `validation_geometry`
must be the normalized scenario geometry (`damon_eshbach` or
`backward_volume`), `analytic_frequency_hz` must equal the independently
computed analytic thin-film reference for the declared material/film/bias/demag
assumptions, and `relative_error` must equal
`abs(frequency_hz - analytic_frequency_hz) / max(abs(analytic_frequency_hz), 1)`.
The low-k DE/BV acceptance fixture should use separate Gamma/sample rows for
the DE and BV paths when both scenarios need a `k=0` anchor, so each published
CSV row has one unambiguous validation geometry.
Writers must derive those analytic columns from the declared DE/BV validation
intent and the run's material/bias/reference context, not from the solver-model
name alone. A future production CPU/GPU modal solver that carries the same
`thin_film_de_bv_low_k` validation intent must therefore publish the same
analytic reference and relative-error columns; the current
`reference_thin_film_de_bv_kalinikos_n0` adapter is only one producer of that
contract.
The shared artifact plotter
`scripts/plot_fem_frequency_domain_eigen_artifacts.py --dispersion-png` must
use the same columns when present: numerical solver points remain the primary
series, `analytic_frequency_hz` is rendered as an analytic reference overlay on
the same `path_s_rad_per_m` axis, and the plot footer reports the maximum
published `relative_error`.

The reference CPU `Full2x2` Floquet gate is stricter than the generic CSV
schema. `scripts/verify_fem_frequency_domain_eigen_artifacts.py
--require-reference-full-2x2-floquet` requires a real k-path dispersion bundle:
at least three samples, at least one nonzero wave vector, strictly increasing
`path_s`, labelled path endpoints, and a branch whose frequency span is
distinguishable from a flat gamma-only artifact. This gate is for the
reference/MVP lane only; it does not promote production selected-spectrum CPU
or GPU modal dispersion.

For the managed no-demag exchange+Zeeman reference example, the optional
`--require-exchange-only-analytic-dispersion` gate also checks the branch scale
against

```text
f(k) = gamma0 * (|H0| + 2 A |k|^2 / (mu0 Ms)) / (2*pi)
```

using material, external-field, and gyromagnetic-ratio values from
`metadata.json`. `--require-exchange-only-reciprocal-dispersion` is the
companion reciprocal gate: it requires at least one published nonzero `+k/-k`
pair and checks `f(k)=f(-k)` for the exchange-only/no-DMI/no-demag case. The
tolerances are intentionally coarse for the current small reference FEM mesh;
these gates catch unit/sign/order-of-magnitude and reciprocity drift in the
exchange dispersion, not production convergence.

Production-facing modal dispersion gates should not require an exhaustive
all-direction k-space map by default. The canonical acceptance fixtures are
narrow one-dimensional film sweeps in the two standard geometries:

- Damon-Eshbach (DE): in-plane `k` perpendicular to the equilibrium
  magnetization;
- backward-volume (BV): in-plane `k` parallel to the equilibrium magnetization.

The default target range is `|k| <= 2e6..3e6 rad/m` (`2..3 1/um`) with a
low-GHz modal/frequency window such as `0..5e9 Hz`. Accepted production bundles
must record enough material, geometry, bias-field, demag-model, and boundary
provenance for validators to compare the published branch against the applicable
analytic DE/BV dispersion. Broader k-direction scans may be added as stress or
coverage tests, but they are not the primary scientific acceptance path.
Regression tests should follow the same shape: separate DE and BV fixtures,
sample only the documented low-k range needed for the analytic comparison, and
use a modal/frequency window no wider than the low-GHz acceptance band by
default. Tests that sweep many k directions or larger Brillouin-zone paths must
be labelled as stress/exploration coverage rather than DE/BV analytic
acceptance.
`scripts/verify_fem_frequency_domain_eigen_artifacts.py
--require-low-k-de-bv-analytic-dispersion` is the first artifact-level gate for
this acceptance shape. It requires
`metadata.json.execution_plan.backend_plan.dispersion_validation` with
`kind = "thin_film_de_bv_low_k"`,
`analytic_model = "kalinikos_slab_n0"`, `film_thickness_m`,
`equilibrium_magnetization`, `film_normal`, `frequency_window_hz`,
`max_k_rad_per_m <= 3e6`, and scenario entries for both `damon_eshbach` and
`backward_volume`. Each scenario names the `branch_id` and `sample_indices` to
check; validators reject out-of-range k, out-of-plane k, wrong DE/BV
orientation, windows above 5 GHz, missing scenarios, and branch frequencies
whose relative error exceeds the declared tolerance.
Runtime-produced bundles obtain this validation block from authored
`problem_meta.runtime_metadata.dispersion_validation`; Python scripts should set
it with `study.dispersion_validation(fm.ThinFilmDEBVDispersionValidation(...))`
or the equivalent flat `fm.dispersion_validation(...)` helper rather than
hand-writing backend-plan metadata. The FEM eigen planner copies this payload
into the typed `FemEigenDispersionValidationIR`
`backend_plan.dispersion_validation` field, rejecting unsupported shape, broad
k ranges, missing DE/BV scenarios, invalid vectors, or windows above 5 GHz at
planning time. Runtime modal k-path bundles must also mirror the same payload
in `frequency_domain/manifest.v1.json.validation.dispersion_validation`, so API
and Control Room consumers can inspect the declared DE/BV analytic acceptance
intent through the existing manifest resource without inventing a second
endpoint. The artifact validator then checks that the manifest validation block
semantically matches `metadata.json.execution_plan.backend_plan.dispersion_validation`
and checks that exact validation intent against the published branch data.
The same `validation` object must also state where the published branch
frequencies came from:

- `dispersion_frequency_source = "analytic_reference_model"` for the current
  CPU/reference `reference_thin_film_de_bv_kalinikos_n0` slice;
- `dispersion_reference_model = "kalinikos_slab_n0"` for that analytic
  reference slice;
- `dynamic_demag_operator_source =
  "analytic_thin_film_de_bv_reference_not_fem_demag_k"` for that slice, so
  validators and Control Room do not mistake it for a numerical FEM
  dynamic-demag-k operator;
- future production CPU/GPU modal solvers that emit the same analytic columns
  must use `dispersion_frequency_source =
  "numeric_modal_solver_with_analytic_comparison"` and leave
  `dispersion_reference_model` empty unless they are themselves an analytic
  reference adapter.

## modes/sample_XXXX/mode_YYYY.json

Required fields:

- `schema_version`,
- `solver_model`,
- `sample_index`,
- `raw_mode_index`,
- optional `branch_id`,
- `frequency_real_hz`,
- `frequency_imag_hz`,
- `angular_frequency_rad_per_s`,
- `omega_rad_s`,
- `normalization`,
- `damping_policy`,
- `mode_field_id`,
- `mode_field_resource_key`,
- `residual_norm`,
- `residual_absolute_l2`,
- `residual_relative_l2`,
- `residual_linf`,
- `mass_norm`,
- `tangent_leakage_mean_abs`,
- `tangent_leakage_max_abs`,
- `gamma_rad_s_T`,
- `gamma0_rad_s_per_A_m`,
- `mu0_T_m_per_A`,
- `k_vector`,
- `relax_to_eigen_handoff_sha256` i `source_mesh_topology_sha256` jako atomowa
  para dla zaakceptowanego cross-stage handoffu,
- `source_mesh_identity` związane topology digestem z tą parą,
- `mode_field_sample_count`,
- `amplitude_summary`,
- `component_summary`.

Mode metadata must not inline large vector arrays such as `real`, `imag`,
`amplitude`, or `phase`. Reconstructed physical vectors live in
`eigen/mode_fields.zarr` by default and are exposed through the data-plane
field resource referenced by `mode_field_resource_key`.

The per-mode metadata payload is the detailed version of the corresponding
`eigen/spectrum.v2.json` mode summary, not a second source of truth. For the
same `(sample_index, raw_mode_index)`, the metadata payload must match the
spectrum summary for phasor convention, eigenvalue mapping, eigenvalue
components, `frequency_imag_hz`, `omega_rad_s`, mass norm, tangent leakage
diagnostics, SI constants, `relax_to_eigen_handoff_sha256`, and
`source_mesh_topology_sha256`.

For native shared-domain FEM modal samples, the per-mode metadata must also
carry the sample's physical and handoff provenance: `external_field_a_per_m`,
`assembly_kind`, `operator_input_signature_sha256`,
`phase_constraint_sha256`, `equilibrium_artifact_sha256`,
`linearization_state_sha256`, and `periodic_mesh_certificate_sha256`. These
fields bind a mode-field visualization to the exact bias sample, assembled
operator, accepted v6 equilibrium/linearization handoff, and periodic mesh
certificate; a consumer must not infer them from a global first-sample file.

The canonical Zarr group layout for modal fields is:

```text
eigen/mode_fields.zarr/
  sample_XXXX/
    mode_YYYY/
      vector_xyz_complex
```

`vector_xyz_complex` stores chunked floating-point values with logical shape
`[node, component, complex]`, where `component = x|y|z` and
`complex = real|imag`. The preferred dtype is `float64` for production
validation and `float32` only when the run provenance explicitly records a
qualified single-precision execution. The array must be compressed by the Zarr
codec configured for the runtime. If a compatibility `vector.bin` file exists,
it is a derived/export payload, not the authoritative production store.

`residual_norm` is the legacy alias for `residual_absolute_l2`. The dense
oracle path must also emit:

- `residual_relative_l2 = ||K u - lambda M u||_2 / (||K u||_2 + |lambda| ||M u||_2)`,
- `mass_norm = u^T M u`,
- `omega_rad_s = 2*pi*frequency_hz`,
- SI constants `gamma_rad_s_T`, `gamma0_rad_s_per_A_m`, and `mu0_T_m_per_A`,
  where `gamma0_rad_s_per_A_m = mu0_T_m_per_A * gamma_rad_s_T`.

Tangent leakage diagnostics are the mean and max absolute `m0 dot dm` over the
exported real and imaginary mode vectors, and must be emitted whenever the
solver reconstructs physical mode vectors.

For modal periodic/Floquet tangent-coordinate runs, solver diagnostics must
also emit:

- `basis_transport_policy`, one of `not_applicable`,
  `tangent_frame_identity`, `tangent_frame_transport`, or `rejected`,
- `floquet_tangent_frame_max_mismatch`,
- `floquet_tangent_transport_max_nonunitarity`.

For the CPU/reference `Full2x2` Floquet modal path,
`basis_transport_policy = "tangent_frame_transport"` means the reduced
stiffness and mass blocks used `phase*(T_node^T T_root)` transport. Scalar
Floquet modal paths may report `tangent_frame_identity` only after rejecting
nonidentity paired tangent frames.

## eigen/metadata/eigen_summary.json

The dense reference oracle summary must include:

- `solver_diagnostics.dense_reference_oracle`,
- `solver_diagnostics.constants.{gamma_rad_s_T,gamma0_rad_s_per_A_m,mu0_T_m_per_A}`,
- `solver_diagnostics.orthogonality[]` with
  `lhs_mode_index`, `rhs_mode_index`, and `mass_inner_product`.

## frequency_domain/manifest.v1.json

The manifest is the entry point for UI and post-processing discovery. Modal
eigen and driven-response manifests must first satisfy the mandatory manifest
hardening envelope above. Current writers that omit hardened fields remain
readable only at their existing implementation/validation scope and cannot be
promoted. Modal eigen manifests must additionally include:

- `schema_version = "frequency_domain_manifest.v1"`,
- `analysis_family = "magnetic_frequency_domain"`,
- `study_product = "modal_eigen"`,
- `stage_kind = "eigenmodes"`,
- `physics.analysis_family = "magnetic_frequency_domain"`,
- `physics.phase_convention` as either `exp_i_omega_t` or
  `exp_minus_i_omega_t`,
- `physics.frequency_units = "Hz"`,
- `physics.field_units = "dimensionless_delta_m"`,
- `physics.normalization`,
- `artifacts.spectrum_v2_path = "eigen/spectrum.v2.json"`,
- `artifacts.branches_v2_path = "eigen/branches.v2.json"`,
- `artifacts.dispersion_csv_path = "eigen/dispersion.csv"`,
- `artifacts.solver_diagnostics_path = "eigen/diagnostics/solver.v1.json"`,
- `artifacts.mode_metadata_paths[]`,
- optional `artifacts.field_sweep_v1_path =
  "eigen/field_sweep.v1.json"` when a physical per-sample bias-field
  handoff is present,
- optional `artifacts.fmr_kittel_fit_v1_path = "fmr/kittel_fit.v1.json"`
  when the postsolve Kittel comparison is derivable; this artifact remains
  `partial` when statistical covariance is unavailable,
- `artifacts.equilibrium_artifact_v6_paths[]` and
  `artifacts.linearization_state_v6_paths[]` for a multi-sample native
  handoff (each path is scoped to `sample_NNNN`),
- `resources.mode_field_resources[]`,
- `validation.dispersion_validation` as the optional
  `FemEigenDispersionValidationIR` payload copied from the FEM eigen plan,
- `diagnostics.tracking_score_source`,
- `diagnostics.modal_overlap_available`,
- optional `diagnostics.modal_overlap_unavailable_reason`.

For modal k-path dispersion manifests, `capabilities.dispersion` must publish
lane-specific status entries for:

- `reference_cpu`,
- `production_cpu`,
- `production_cpu_gamma_k_path`,
- `production_gpu`,
- `k_path`,
- `branch_tracking`.

The current production nonzero-k modal k-path acceptance gate requires
`production_cpu.status = "partial_production_executable"`,
`production_cpu_gamma_k_path.status = "partial_production_executable"`, and
`production_gpu.status = "unsupported"` with a reason that explicitly names
modal GPU dispersion as unavailable. The gamma-only bridge remains separate
from the nonzero-k Bloch/Floquet production lane.

Driven response manifests must additionally include:

- `schema_version = "frequency_domain_manifest.v1"`,
- `analysis_family = "magnetic_frequency_domain"`,
- `study_product = "driven_response"`,
- `stage_kind = "frequency_response"`,
- `physics.analysis_family = "magnetic_frequency_domain"`,
- `physics.phase_convention`,
- `physics.frequency_units = "Hz"`,
- `physics.field_units = "dimensionless_delta_m"`,
- `artifacts.solver_diagnostics_path = "response/diagnostics/solver.v1.json"`,
- optional `artifacts.fmr_peaks_v1_path = "fmr/peaks.v1.json"` and
  `artifacts.fmr_resonance_fits_v1_path = "fmr/resonance_fits.v1.json"`
  when the response sweep contains at least one written point.  These paths
  are artifact discovery hints only; typed resource keys are specified by the
  A2 API/resource contract and must not be inferred from this v1 manifest.

Completed driven-response manifests must also link the durable progress
checkpoint explicitly:

- `artifacts.response_progress_v1_path = "response/progress.v1.json"`,
- `resources.response_progress_resource_key =
  "/v2/sessions/current/analysis/frequency-domain/response/progress.v1"`.

These fields are required even though the file path is currently canonical.
Consumers must discover progress through the manifest/resource contract rather
than hardcoding a filesystem convention.

For a promoted `periodic_airbox_k0` driven-response bundle, the manifest must
also include `equilibrium_provenance` linking the response solve to the
accepted static PBC demag equilibrium that supplied `m0`. Diagnostic smoke
bundles may omit this object, but promotion gates using
`--require-m5-equilibrium-provenance` must reject the bundle unless it contains:

- `schema_version = "fem_frequency_domain_equilibrium_provenance.v1"`,
- `acceptance_gate = "M5_static_pbc_demag_equilibrium"`,
- `accepted = true`,
- `source_kind = "m5_static_pbc_demag_equilibrium"`,
- `source_artifact_root`,
- `equilibrium_field_path`,
- `seam_diagnostics_path`,
- `z_padding_report_path`,
- `supercell_report_path`,
- `magnetostatic_bc = "periodic_airbox_k0"`,
- non-empty `pbc_axes[]`.

`source_artifact_root` must resolve to an existing M5 artifact directory. The
field paths above must resolve to existing files under that source root unless
they are absolute paths. A promotion gate must reject metadata-only provenance
that names an accepted equilibrium but cannot locate the equilibrium field,
seam diagnostics, z-padding report, and supercell report. The referenced seam,
z-padding, and supercell JSON artifacts must report `status = "ok"`; a failed
static-PBC report cannot promote a periodic-airbox frequency-response bundle.
They must also carry their canonical schema identifiers:
`fem_static_pbc_demag_seams.v1` for seam diagnostics,
`fem_static_pbc_z_padding_validation.v1` for z-padding, and
`fem_static_pbc_supercell_validation.v1` for primitive-vs-supercell acceptance.

The canonical runtime handoff for this block is
`problem_meta.runtime_metadata["frequency_response_m5_equilibrium_provenance"]`.
Planner code may copy that object into `FemFrequencyResponsePlanIR`, and the
runner must preserve it in `frequency_domain/manifest.v1.json` after the native
response solve writes the base manifest. This metadata is provenance only: it
must not enable PBC, select demag, or override the study's requested
`magnetostatic_bc`.

Promoted `periodic_airbox_k0` driven-response bundles must also expose solved
dynamic seam diagnostics consistently in `response/diagnostics/solver.v1.json`,
`frequency_domain/manifest.v1.json`, and every solved frequency-point
`demag_contribution`:

- `delta_phi_phase_validation_status = "ok"`,
- `delta_phi_phase_max_residual`,
- `delta_phi_seam_validation_status = "ok"`,
- `delta_phi_seam_max_after_offset`,
- `h_demag_seam_validation_status = "ok"`,
- `h_demag_seam_max_tangent_mismatch`,
- `delta_phi_flux_validation_status = "ok"`,
- `delta_phi_flux_max_residual`.

`delta_phi_flux_validation_status = "not_evaluated"` is allowed only for
explicit unavailable/diagnostic artifacts. Production acceptance validators must
reject solved `periodic_airbox_k0` response bundles that lack the normal-flux
residual.

The manifest must always distinguish the two study products with
`study_product = "modal_eigen"` or `study_product = "driven_response"`.
UI labels must use `Eigenmodes` for `modal_eigen` and `Frequency Response` for
`driven_response`; clients must not collapse them into one generic
"frequency-domain solver" label.

Reference modal manifest:

```json
{
  "schema_version": "frequency_domain_manifest.v1",
  "analysis_family": "magnetic_frequency_domain",
  "study_product": "modal_eigen",
  "stage_kind": "eigenmodes",
  "phase_convention": "exp_i_omega_t",
  "frequency_units": "Hz",
  "field_units": "dimensionless_delta_m"
}
```

Reference driven manifest:

```json
{
  "schema_version": "frequency_domain_manifest.v1",
  "analysis_family": "magnetic_frequency_domain",
  "study_product": "driven_response",
  "stage_kind": "frequency_response",
  "phase_convention": "exp_i_omega_t",
  "frequency_units": "Hz",
  "field_units": "dimensionless_delta_m"
}
```

## eigen/diagnostics/solver.v1.json

Modal solver diagnostics live at `eigen/diagnostics/solver.v1.json` and must
describe the modal `modal_eigen` solve only.

All modal diagnostics must publish the algebra/eigenvalue contract used by the
artifact writer:

- `algebraic_form`, for example `reference_effective_field_generalized` for the
  dense reference lane or `gyrotropic_generalized` for a future production
  gyrotropic pencil;
- `matrix_equation`, for example `K u = lambda M u`;
- `phasor_convention`, using the modal lane's documented convention or
  `not_applicable_real_reference` for the current real effective-field
  reference lane;
- `eigenvalue_mapping`, for example
  `omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)` for the
  current reference lane or `lambda_eq_i_omega` for the production LLG lane;
- `frequency_mapping`;
- `production_gyrotropic_mapping` as a boolean.

For `production_gyrotropic_mapping = true` with
`eigenvalue_mapping = "lambda_eq_i_omega"`, diagnostics should also preserve
the operator-side sign convention. If the physics contract is the energy
gyrotropic form `K phi = -i omega G phi`, the generalized solver must use the
right-hand-side pencil matrix `B = -G`, i.e. `K phi = lambda B phi` with
`lambda = i omega`. Operator diagnostics should name this explicitly, for
example `gyrotropic_form = "pencil_B=-G=[[0,M],[-M,0]]"`.
Mode payloads using that mapping must also pass the per-mode
`Im(lambda)`/`omega_rad_s`/`frequency_hz` consistency rule above.

When the modal target is `frequency_window`, solver diagnostics must also
publish the resolved window search contract:

- `requested_window_hz = [frequency_min_hz, frequency_max_hz]`,
- `resolved_search_window_hz = [min_guarded_hz, max_guarded_hz]`,
- `requested_mode_count`, copied from the public `Eigenmodes.count` mode cap,
- `window_completeness.{policy,status,certification_method,additional_modes_may_exist}`,
- either one global `subwindows[]` list, when every sample used the same
  operator search, or `sample_solver_diagnostics[]` when field/k samples were
  solved independently. Each sampled entry must have a unique `sample_index`
  and a nonempty `diagnostics.subwindows[]` list. Native sampled subwindows
  publish a unique `subwindow_index`, `shift_frequency_hz`, solver `status`,
  nonnegative converged/candidate/accepted counts, and the frequencies actually
  accepted inside the requested global window. Guard-region eigenpairs remain
  candidates and must not be reported as accepted modes.
  Producers must not fabricate a global search by copying or merging
  subwindows executed against different sample operators.

`mode_count` is the public number of published modes. For a multi-k dispersion
bundle, it is the maximum `spectrum.samples[*].modes.length` after applying the
requested output filter; it must not count internal extra modes carried only for
branch tracking or overlap assignment. `mode_count` must not exceed
`requested_mode_count`. A solver that stops because this cap was reached must
use `window_completeness.status = "truncated_by_requested_count"` rather than
presenting the window as certified or exhausted. This status is valid only when
`mode_count == requested_mode_count` and
`window_completeness.additional_modes_may_exist = true`; otherwise the artifact
must use a more specific non-cap status such as `not_certified`,
`partial_convergence`, or `window_exhausted`.

Reference/MVP multi-k Floquet `FrequencyWindow` artifacts must also publish
`frequency_window_solver_policy =
"reference_k_path_window_filter_not_shift_invert_or_feast"` when the window is
filtered by the reference k-path orchestrator rather than solved by a production
shift-invert/FEAST/SLEPc backend. In that case `spectral_transform` remains
`none`, `production_solver_available = false`, and
`window_completeness.status = "not_certified"`. Nonzero-k Floquet variants of
that reference policy must also publish `production_cpu_rejection_reason =
"production_cpu_modal_nonzero_k_floquet_operator_missing"` and
`production_cpu_rejection_scope =
"selected_spectrum_nonzero_k_floquet_modal"` so downstream consumers can
distinguish a deliberate reference/MVP fallback from a production
selected-spectrum modal solve. They must also publish
`required_operator_contract =
"bloch_floquet_tangent_operator_with_periodic_pairs"` and
`required_operator_payload_kind = "bloch_floquet_tangent_operator"` plus
`modal_periodic_pair_contract_available = false` for the current
runner/reference artifact path, so UI/runtime consumers can name the missing
production operator payload instead of reporting a generic unsupported path or
mistaking pair metadata for an executable Bloch/Floquet operator.
The native modal C ABI can carry Floquet k-vector and periodic-pair metadata.
The Rust native modal wrapper and FEM eigen runner can now derive and forward
that payload from selected `mesh.periodic_node_pairs` and matching boundary-pair
translation metadata for single-k Floquet modal requests, with
`phase_rad = -k dot translation`. Native diagnostics for direct requests or
runner paths with supplied pairs may therefore report
`modal_periodic_pair_contract_available = true`; that only proves the pair
metadata handoff. Direct native modal requests may proceed past the nonzero-k
Floquet rejection only when the operator diagnostics also declare
`payload_kind = "bloch_floquet_tangent_operator"`. Current reference artifacts
may still report `modal_periodic_pair_contract_available = false` when they are
produced by the reference/MVP path rather than by the native modal production
ABI handoff, and runner-produced nonzero-k k-path artifacts must remain
reference-labelled until the runner/native FEM operator builder emits that
labelled Bloch/Floquet payload per sample. The runner-side algebraic
materializer for that payload embeds a complex Bloch/Floquet generalized
operator into the native gyrotropic pencil as `K_embedded = diag(K_R, K_R)` and
`B_embedded = [[0, -M_R], [M_R, 0]]`. Production k-path artifacts may claim
this path only when the managed runtime uses the selected-spectrum adapter,
de-embeds native mode vectors, writes persisted mode-field payloads, and keeps
`eigen/spectrum.v2.json`, nested mode metadata, solver diagnostics, and the
frequency-domain manifest on the same `lambda_eq_i_omega` /
`exp_i_omega_t` contract. The de-embedding contract is defined for positive
native branches as
`v = [x, i x] -> q = x_re + i x_im`, where `q` is the physical complex
tangent-vector payload expected by the existing modal field artifacts.

Production modal k-path/Floquet acceptance must not reuse the reference policy
above. Artifacts promoted as production selected-spectrum modal k-path evidence
must be multi-sample (`sample_count > 1`), report the managed production modal
adapter, set `spectral_transform = "shift_invert"`,
`execution_lane = "production_cpu"`, `production_solver_available = true`, and
`dense_reference_oracle = false`. Production selected-spectrum modal k-path
evidence is currently a no-demag/no-DMI contract. The manifest must publish
`requested_execution.include_demag = false`,
`resolved_execution.demag_realization = "none"`, and must not publish DMI,
dynamic demag, periodic Poisson, Floquet-airbox demag, or magnetoelastic terms
inside `requested_execution.operator_terms_included[]` or
`resolved_execution.operator_terms_included[]`. Production selected-spectrum
modal k-path evidence uses the native modal `lambda_eq_i_omega` mapping with
`phasor_convention = "exp_i_omega_t"` in both
`eigen/diagnostics/solver.v1.json` and
`frequency_domain/manifest.v1.json`; artifacts using the opposite phasor
convention or internally inconsistent modal phasor metadata must not pass this
production acceptance gate. The `--require-production-modal-k-path` validator
gate is reserved for production nonzero-k modal dispersion and therefore also
requires at least one sampled nonzero `k_vector`; gamma-equivalent bundles must
use the separate gamma gate below. The current GPU modal path has no production
acceptance contract until a native modal GPU eigensolver and Floquet operator
exist.

Because the production modal k-path gate is the nonzero-k Floquet acceptance
gate, its solver diagnostics must also publish
`basis_transport_policy = "tangent_frame_transport"`,
`floquet_tangent_frame_max_mismatch`, and
`floquet_tangent_transport_max_nonunitarity`. This proves that the accepted
artifact used the phase-aware tangent-frame transport contract at the artifact
boundary. The gamma-only production bridge below is not a nonzero-k Floquet
transport proof and must remain a separate validator gate.

Production modal k-path tracking summaries must be vector-overlap only:
`frequency_domain/manifest.v1.json.diagnostics.tracking_score_source`,
`eigen/branches.v2.json.tracking_score_source`, and
`eigen/branches.v2.json.diagnostics.tracking_score_source` must all be
`modal_overlap_weighted_score`. Mixed modal/frequency fallback summaries remain
valid for non-production or reference artifacts, but cannot satisfy
`--require-production-modal-k-path`.

Until the production k-path lane has certified window-completeness evidence,
accepted production modal/gamma k-path artifacts that publish
`requested_window_hz` must keep
`window_completeness.status = "not_certified"`,
`window_completeness.certification_method = "none"`, and
`window_completeness.additional_modes_may_exist = true`. A certified modal
count, exhausted window, or no-extra-modes claim belongs to a later production
gate with explicit contour/count or sparse/matrix-free validation evidence.
Accepted production modal/gamma k-path mode summaries must also satisfy the
current quality guard:

- `residual_relative_l2 <= 1e-6`,
- `tangent_leakage_max_abs <= 1e-8`.

Solver subwindow diagnostics are part of the same acceptance contract:

- each `subwindows[]` entry must report `accepted_modes > 0`,
- each `subwindows[]` entry must keep `residual_max <= 1e-6`.

These thresholds are acceptance guards for the current no-demag selected-
spectrum artifact slice. They do not certify window completeness, dynamic
demag-k, DMI, GPU modal dispersion, or broader magnonic-crystal production
coverage.

The frequency-domain manifest capability
`dispersion.production_cpu_gamma_k_path` is deliberately narrower than
`dispersion.production_cpu`. It marks only the managed production CPU
selected-spectrum bridge for gamma-equivalent k-path samples, where the
multi-k orchestrator preserves per-sample shift-invert provenance without
claiming Bloch/Floquet nonzero-k physics. Nonzero-k production modal
dispersion must satisfy the production selected-spectrum modal k-path
requirements above. The `--require-production-gamma-k-path` validator gate
requires the same production selected-spectrum provenance as the modal k-path
gate, but all sampled `k_vector` values must be gamma-equivalent zero.

The allowed completeness policies are `best_effort` and `certified_count`.
The allowed statuses are `not_certified`, `certified`,
`partial_convergence`, `truncated_by_requested_count`, and
`window_exhausted`. Subwindow stop reasons must use the modal solver vocabulary
(`converged`, `window_exhausted`, `partial_convergence`, `max_iterations`,
`linear_solve_failed`, `residual_not_met`, `cancelled`,
`capability_missing`, or `operator_invalid`), never a generic `completed`.

## response/diagnostics/solver.v1.json

Driven solver diagnostics live at `response/diagnostics/solver.v1.json` and
must describe the driven `driven_response` solve only.

## Response observable units

Frequency-domain response writers must distinguish dimensionless
magnetization perturbation from physical magnetization perturbation:

```text
delta_M = Ms * delta_m
```

If a susceptibility-like value is exported as `delta_m / h_drive`, it has units
`m/A` and must be labeled as a normalized response, not as dimensionless SI
susceptibility. Dimensionless magnetic susceptibility uses:

```text
chi = delta_M / h_drive = Ms * delta_m / h_drive
```

Absorbed power density for `h_drive` in `A/m` and dimensionless `delta_m`
requires the `Ms` factor:

```text
p_abs = sgn * 0.5 * mu0 * Ms * omega * Im(conj(h_drive) dot delta_m)
```

The `sgn` is fixed by the manifest `phase_convention`; for the canonical
`exp_i_omega_t` convention, validation must prove positive absorbed power near
resonance for positive Gilbert damping. Response artifacts must publish units
and provenance for every susceptibility and absorbed-power field.

## response/magnetic_response_sweep.v1.json

This artifact is the driven magnetic-only response sweep contract. The current
runner writer can emit it for dense field-driven validation payloads, and the v2
API can expose an already-written artifact at
`GET /v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1`. The
Control Room client entry point is the generated path literal plus
`ControlRoomApi.analysis.frequencyResponse.magneticSweepV1()` facade, with
`useMagneticResponseSweepResource()` as the optional artifact resource hook for
analysis surfaces; consumers should not duplicate the route string. Runtime execution remains gated until an
executable response backend is validated. Missing optional response artifacts
must return diagnostic 404 responses; clients must not synthesize empty response
curves as success.

Required fields:

- `schema_version = "magnetic_response_sweep.v1"`,
- `backend_engine_id`,
- `solver_model`,
- `damping_policy`,
- `lane_classification`,
- `matrix_layout`,
- `excitation_kind`,
- `si_units`,
- `point_count`,
- `points[]`.

Each point must include:

- `frequency_hz`,
- `angular_frequency_rad_per_s`,
- `m_complex` as `[re, im]` pairs,
- `response_amplitude`,
- `response_phase`,
- `component_response_amplitude`,
- `component_response_phase`,
- `susceptibility_tensor` as `[re, im]` pairs,
- `susceptibility_tensor_provenance`, including whether the value is a full
  tensor or a drive-projected scalar response, and whether it represents
  `delta_M / h_drive` or a normalized `delta_m / h_drive` response.
  A native response writer with a valid `Ms` contract must set
  `kind = "drive_projected_si_susceptibility"`,
  `basis = "local_tangent_drive"`,
  `response_quantity = "delta_M_over_h_drive"`,
  `response_units = "dimensionless"`,
  `dimensionless_si_susceptibility = true`,
  `requires_ms_for_chi_si = false`,
  `ms_factor_applied = true`,
  `ms_source = "uniform"` or `"per_node_field"`, and
  `normalization = "sum(Ms*response*conj(drive))/sum(abs(drive)^2)"`.
  Writers without a valid `Ms` contract may only emit the proxy form with
  `kind = "drive_projected_scalar"`, `basis = "local_tangent_drive"`,
  `response_quantity = "delta_m_over_h_drive"`,
  `response_units = "m/A"`, `dimensionless_si_susceptibility = false`,
  `requires_ms_for_chi_si = true`, `ms_factor_applied = false`, and
  `normalization = "sum(response*conj(drive))/sum(abs(drive)^2)"`,
- `absorbed_power_density`,
- `absorbed_power_density_provenance`, including whether the value is a
  physical `W/m^3` power density or a drive-projected proxy. A native response
  writer that has applied `Ms` but has not performed volume integration must
  still emit the proxy form with
  `kind = "drive_projected_absorption_proxy"`,
  `basis = "local_tangent_drive"`, `physical_power_density = false`,
  `units = "drive_projected_proxy_not_W_per_m3"`,
  `requires_mu0_ms_factor = false`, `mu0_ms_factor_applied = true`,
  `ms_source = "uniform"` or `"per_node_field"`,
  `normalization = "0.5*mu0*omega*imag(sum(Ms*response*conj(drive)))/tangent_dof_count"`,
  `volume_weighted = false`,
  `spatial_reduction = "drive_projected_tangent_dof_average"`,
  `absolute_value_applied = false`, and `full_power_density = false`.
  Writers without a valid `Ms` contract may only emit the dimensionless-response
  proxy form with
  `kind = "drive_projected_absorption_proxy"`,
  `basis = "local_tangent_drive"`, `physical_power_density = false`,
  `units = "proxy_not_W_per_m3"`, `requires_mu0_ms_factor = true`, and
  `ms_factor_applied = false`,
  `normalization = "0.5*omega*imag(sum(response*conj(drive)))/tangent_dof_count"`,
  `absolute_value_applied = false`, and `full_power_density = false`. A value
  may use `units = "W/m^3"` and `full_power_density = true` only after the
  writer has a volume-weighted local power-density/integral contract,
- `residual_l2_norm`,
- `relative_residual_l2_norm`,
- `tangent_leakage` diagnostic status,
- `excitation_provenance`,
- `sweep_reuse` provenance.

`excitation_provenance` must include `kind` and `phase_rad`. For the public
`FrequencyResponse` contract, `phase_rad` is the global harmonic drive phasor
phase applied to the real excitation field vector before solving
`(i omega B - L) q = f`.

`sweep_reuse` must include `operator_template_reused`. The first point may set
`warm_start = null`. Later points may report
`warm_start.kind = "previous_frequency_response"` and
`source_frequency_rad_per_s`; warm-start residual fields are optional and may be
`null` when the backend does not expose a separate warm-start residual
diagnostic.

## response/magnetic_response_sweep.v2.json

This artifact is the resource-first driven-response sweep contract used by the
Control Room for charts, frequency-point inspectors, and 3D response-field
selection. It may be produced by the dense validation runner or by the native
MFEM production writer, but both producers must expose the same navigation
shape.

Required fields:

- `schema_version = "magnetic_response_sweep.v2"`,
- `solve_kind = "direct_harmonic_response"`,
- `complete`,
- `completed_frequency_point_count`,
- `frequency_point_artifact_paths[]`,
- `response_field_payload_paths[]`,
- `points[]`.

`frequency_point_artifact_paths.length` and
`response_field_payload_paths.length` must equal
`completed_frequency_point_count`. Every listed path is relative to the run
artifact root and must resolve to an existing artifact when the sweep is marked
complete. The first entries must follow the canonical layout:

```text
response/frequency_points/frequency_0000.json
response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0
```

`point_count` is the number of published point rows and must equal
`completed_frequency_point_count`. The full requested sweep size belongs to
`response/progress.v1.json.total_frequency_points`, so interrupted runs can
publish `point_count < total_frequency_points`.

Each point should include:

- `frequency_index`,
- `frequency_hz`,
- `angular_frequency_rad_per_s`,
- `max_response_amplitude` or `response_amplitude`,
- `phase_rad`,
- `absorbed_power_density`,
- `observable_units`,
- `relative_residual_l2_norm`,
- `excitation_provenance`,
- `sweep_reuse`,
- `response_field_payload_path`,
- `frequency_point_artifact_path`,
- `response_tangent_field_payload_path` when the point artifact declares
  `tangent_field_payload_path`.

When `response_tangent_field_payload_path` is present, it must equal the
`tangent_field_payload_path` declared by the corresponding
`response/frequency_points/frequency_XXXX.json` artifact. It is a diagnostic
raw tangent-frame payload reference, not the canonical 3D visualization payload.

Native writers may omit per-point `frequency_index` when `points[]` order is
identical to the top-level path arrays. In that case consumers must derive the
frequency index from the point row index. Consumers must not infer field payload
identity from display labels.

`phase_rad` is the scalar charting phase for the selected or dominant response
component at the frequency point. `response_phase` is the scalar phase paired
with the dominant or maximum-amplitude component. Full per-component phases
must be carried by `component_response_phase[]` and the complex field payloads.

## response solver diagnostics fields

This artifact records driven-response solver diagnostics. Native FEM production
writers must include the matrix-free/GMRES diagnostics used to distinguish the
production CPU/GPU slices from dense validation artifacts.

`response/diagnostics.v1.json` is a compatibility export only. New manifests
must reference `response/diagnostics/solver.v1.json` through
`artifacts.solver_diagnostics_path`, and clients must treat the nested solver
diagnostics path as canonical.

Required fields for native FEM production response diagnostics:

- `schema_version = "frequency_domain_response_diagnostics.v1"`,
- `status`,
- `complete`,
- `requested_execution_lane`,
- `resolved_execution_lane`,
- `validation_fallback_used = false`,
- `assembled_mfem_operator_solver = false`,
- `dense_block_real_solver = false`,
- `matrix_free_solver = true`,
- `krylov_solver = "gmres"`,
- `operator_terms_included[]`,
- `completed_frequency_point_count`,
- `max_abs_response`,
- `residual_l2_norm`,
- `relative_residual_l2_norm`.
- `matrix_form`, one of `iomega_B_minus_L`, `K_plus_iomega_G`,
  `coupled_demag_block`, or a documented compatibility value,
- `dynamic_demag_matrix_form` when dynamic demag is enabled, one of
  `magnetic_only`, `schur_phi_consistency_provider`,
  `coupled_demag_block`, or a documented compatibility value. This field
  describes the demag realization; it does not replace the global harmonic
  response `matrix_form`,
- `krylov_preconditioner_variant` for native GMRES response diagnostics, one of
  `graph_demag_coarse`, `demag_coarse`, `block_jacobi`, `none`, or a
  documented compatibility value. Periodic-airbox Schur/provider artifacts with
  an applied preconditioner and exchange graph edges must report
  `graph_demag_coarse`; Schur/provider artifacts with an applied preconditioner
  but without exchange graph edges must report `demag_coarse`. `none` means no
  right preconditioner was applied. This field records the selected
  right-preconditioner realization and is distinct from the higher-level
  `krylov_preconditioner_kind`,
- `krylov_preconditioner_requested_variant`,
  `krylov_preconditioner_initial_variant`, and
  `krylov_preconditioner_variant` distinguish requested policy, setup result,
  and effective GMRES behavior. The important M6 diagnostic case is
  `requested="auto"`, `initial="graph_demag_coarse"` or `demag_coarse`, and
  effective `variant="block_jacobi"` or `variant="none"` after probe-based
  fallback disables a harmful right preconditioner,
- `krylov_preconditioner_kind` records the concrete native right-preconditioner
  implementation used for the selected variant. Magnetic-only
  `graph_demag_coarse` uses `mfem_tangent_graph_demag_coarse_right`; the
  periodic-airbox Schur/provider reduced magnetic slice uses
  `static_periodic_reduced_mfem_schur_residual_right` for the same
  `graph_demag_coarse` variant. This keeps the artifact-level policy variant
  stable while exposing the actual native implementation boundary,
- `graph_preconditioner_sweeps` for native Schur/provider diagnostics. When
  `krylov_preconditioner_variant="graph_demag_coarse"`, this records the
  bounded number of block-Jacobi graph-correction sweeps used by the right
  preconditioner. The value is controlled by
  `FULLMAG_FEM_FREQUENCY_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS` or legacy
  `FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS`; current native code clamps
  it to `[1, 8]`. Non-graph variants may report `0`,
- `graph_preconditioner_relaxation` for native Schur/provider diagnostics. When
  `krylov_preconditioner_initial_variant="graph_demag_coarse"`, this records the
  fixed damping factor applied to the graph off-diagonal exchange correction
  and to the periodic-airbox Schur/provider residual-correction sweeps before
  the follow-up block-Jacobi solve. The Schur/provider realization must not use
  an input-dependent line-search scale as a GMRES right preconditioner. The
  value is controlled by
  `FULLMAG_FEM_FREQUENCY_RESPONSE_GRAPH_PRECONDITIONER_RELAXATION` or legacy
  `FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_RELAXATION`; current native code
  clamps it to `(0, 1]` and defaults to `0.05`. Non-graph initial variants must
  report `0.0`,
- `right_preconditioner_probe_available`,
  `right_preconditioner_probe_residual_l2_norm`, and
  `right_preconditioner_probe_relative_residual_l2_norm` for native
  right-preconditioned GMRES diagnostics. When available, the probe applies the
  selected right preconditioner to the first RHS and records
  `||A M rhs - rhs||_2` and its value relative to `||rhs||_2`; it is a
  preconditioner-quality diagnostic, not the final solve residual. When
  `krylov_preconditioner_variant="none"`, `right_preconditioner_probe_available`
  must be `false` and the residual fields must remain finite non-negative
  placeholders unless `right_preconditioner_auto_disabled=true`,
- `right_preconditioner_auto_disabled`,
  `right_preconditioner_probe_disable_relative_threshold`, and
  `right_preconditioner_auto_disable_reason` record whether the native GMRES
  auto policy disabled a right preconditioner after the first-RHS probe or
  after a bounded unpreconditioned retry succeeds following a preconditioned
  `solve_error`. The default probe threshold is `1.0`, configurable through
  `FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD` or
  `FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD`; the bounded
  retry cap is controlled by
  `FULLMAG_FEM_FREQUENCY_RESPONSE_UNPRECONDITIONED_RETRY_MAX_ITERATIONS` or
  legacy `FULLMAG_FMR_RESPONSE_UNPRECONDITIONED_RETRY_MAX_ITERATIONS` and
  defaults to `512`. This is provenance, not a hidden fallback: forced concrete
  preconditioner variants must not silently resolve to `none`. Current reason
  strings are `probe_relative_residual_above_threshold`,
  `solve_error_retry_without_right_preconditioner`, and
  `solve_error_retry_without_right_preconditioner_improved_residual`. The last
  value means the retry still returned `solve_error`, but its recomputed
  relative residual was lower than the preconditioned failure, so artifacts and
  diagnostics keep the better failed solve while preserving the failure status,
- `demag_tangent_operator_source` when a magnetic-only dynamic-demag tangent is
  supplied to the response operator. Valid current values are `none`,
  `explicit_demag_tangent_matrix`, and
  `matrix_free_demag_tangent_provider`,
- `phasor_convention`,
- `ksp_type`,
- `pc_type`,
- `iterations`,
- `converged_reason`.

For native FEM production GPU response, `requested_execution_lane` and
`resolved_execution_lane` must both be `"production_gpu"` when the GPU solve
runs. The ordinary `k=0` free/open GPU response slice may report demag in
`operator_terms_included[]` only when `demag_tangent_operator_source` is present
and not `none`; this describes a supplied magnetic-only tangent operator and
does not imply device-resident periodic-airbox Poisson. DMI and unsupported
nonzero-k Floquet/Bloch demag response must not be reported as included until
those GPU operators are implemented and qualified.

Unavailable production GPU responses must still write diagnostics when an
artifact directory is available. They must preserve
`requested_execution_lane = "production_gpu"`, set
`resolved_execution_lane = "unavailable"`, include an `unsupported_reason`, and
keep `validation_fallback_used = false` and `dense_block_real_solver = false`.

When the response uses k = 0 static-periodic boundary conditions, diagnostics
must also include:

- `static_periodic_projection = true`,
- `static_periodic_node_pair_count`,
- `static_periodic_frame_max_mismatch`,
- `static_periodic_drive_max_mismatch`.

`static_periodic_node_pair_count` must be positive when
`static_periodic_projection` is true. Frame and drive mismatch diagnostics must
be finite non-negative SI-free residuals; production smoke artifacts should keep
both below the verifier tolerance used by
`scripts/verify_fem_frequency_domain_runtime_artifacts.py`.

For non-periodic response runs, writers may either omit the `static_periodic_*`
fields or set `static_periodic_projection = false` with zero pair count and
finite zero mismatches. Consumers must not interpret these fields as nonzero-k
Floquet/Bloch support.

When a native FEM response artifact reports `floquet_phase_projection = true`,
the solver diagnostics and manifest diagnostics must also include:

- `basis_transport_policy`, one of `tangent_frame_identity` or
  `tangent_frame_transport` for tangent-coordinate Floquet response,
- `floquet_tangent_frame_max_mismatch`,
- `floquet_tangent_transport_max_nonunitarity`.

The current no-demag Floquet phase-projection slice is identity-frame only:
`basis_transport_policy = "tangent_frame_identity"` is legal only when
`floquet_tangent_frame_max_mismatch` is below the verifier tolerance. A backend
that cannot satisfy this identity-frame precondition must reject the request
instead of applying scalar phase-only transport.

## response/progress.v1.json and live stage progress

`response/progress.v1.json` is the durable driven-response sweep checkpoint. It
records artifact-level progress for completed, interrupted, cancelled,
unavailable, or partially written frequency sweeps. It is not a time-step
telemetry stream.

Completed driven-response manifests must link this checkpoint through
`artifacts.response_progress_v1_path` and
`resources.response_progress_resource_key` using the canonical artifact path
and v2 resource path documented in the manifest section above.

Required fields:

- `schema_version = "frequency_domain_sweep_progress.v1"`,
- `status`,
- `state`,
- `complete`,
- `total_frequency_points`,
- `completed_frequency_points`,
- `written_frequency_point_artifacts`,
- `current_frequency_hz`,
- optional `frequency_min_hz`,
- optional `frequency_max_hz`,
- `partial_artifacts_available`,
- `latest_artifact_manifest_path`,
- `missing_reason`,
- `progress_json`.

The `progress_json` field is a small serialized checkpoint object for backward
compatibility and fallback readers. It is required for completed, interrupted,
unavailable, and bounded-failure bundles, must parse as JSON, and must mirror
the top-level `schema_version`, `state`, frequency work-unit counts,
`partial_artifacts_available`, and `latest_artifact_manifest_path`. When it
publishes `status`, `complete`, `current_frequency_hz`, `frequency_min_hz`,
`frequency_max_hz`, or `demag_mode`, those values must match the top-level
fields. Native response writers may also include
iteration-level values such as:

- `native_frequency_index`,
- `native_iteration_count`,
- `native_max_iterations_for_frequency`,
- `native_current_frequency_solve_fraction`,
- `native_residual_l2_norm`,
- `native_relative_residual_l2_norm`,
- `native_converged`.

For native demag response bundles that are used as solved or bounded-failure
periodic-airbox acceptance evidence, the iteration-level native fields above
are required rather than optional. `native_max_iterations_for_frequency` is the
current GMRES budget used for the active frequency point, and
`progress_json` must mirror `native_iteration_count`,
`native_max_iterations_for_frequency`,
`native_current_frequency_solve_fraction`,
`native_relative_residual_l2_norm`, and `native_converged` exactly. This keeps
long single-frequency demag solves auditable by validators and by Control Room
without inferring progress from generic stage `step/t/dt` telemetry.

`native_current_frequency_solve_fraction` is the bounded `[0, 1]` progress
estimate for the current Krylov solve. Live overall sweep progress may combine
it with completed points as
`(min(completed_frequency_points, native_frequency_index) +
native_current_frequency_solve_fraction) / total_frequency_points`. This is a
progress indicator only; it is not convergence evidence and does not replace
the residual, `native_converged`, or final solver diagnostics.

For native driven-response progress with demag enabled, the durable checkpoint
must also expose `demag_mode` both at the top level and inside `progress_json`.
Allowed current values are:

- `periodic_airbox_k0`,
- `floquet_airbox`,
- `enabled`.

Control Room live progress must prefer
`/v2/sessions/current/simulation/stages/execution` for the active stage and use
`response/progress.v1.json` only as the artifact checkpoint/fallback. For active
`frequency_response` / `flat_frequency_response` stages, the CLI maps native
`fem_frequency_response_progress` scalar updates into
`stage_execution.stages[active].progress_percent`,
`progress_label`, `progress_detail`, and `last_progress_unix_ms`. The footer and
other live UI surfaces should render progress by frequency point, sweep range,
current frequency, Krylov iteration/max-iteration budget, current-frequency
solve fraction, and residual. They must not present
generic `step`, `t`, or `dt` telemetry as the primary progress indicator for a
frequency-domain solve.

Durable progress checkpoints and native live scalar progress may publish
`frequency_min_hz` and `frequency_max_hz` with the active point update so
telemetry can show the sweep interval even before the durable response-sweep
resource has refreshed. The initial `running` checkpoint should set
`current_frequency_hz` to the first finite positive requested frequency and
include `demag_mode` when the requested response uses demag.

If a driven-response stage is active but no point has reported yet, the live UI
may show indeterminate progress with the requested sweep range when available.
Once solver progress arrives, `stage_execution.progress_*` is authoritative for
the current point and iteration. Once artifacts are complete or interrupted,
`response/progress.v1.json` is the durable source for completed/written point
counts.

If the v2 API must synthesize a progress resource from legacy sweep/manifest
artifacts because `response/progress.v1.json` is absent, the synthesized
`progress_json` must follow the same checkpoint mirror contract as the durable
artifact. Fallback readers must not receive only a partial `{state, ...}`
diagnostic string.

## response/cancel_requested.v1.json

This artifact records the moment a driven-response sweep observed a cancellation
request. It is distinct from the final interrupted `response/progress.v1.json`
so the UI can explain that a user/runtime stop request was seen before the
solver wrote its final partial bundle.

Interrupted response sweeps must write this artifact. Completed, unavailable,
or never-started response sweeps may omit it.

Required fields:

- `schema_version = "frequency_domain_sweep_progress.v1"`,
- `status = "cancel_requested"`,
- `state = "cancel_requested"`,
- `complete = false`,
- `total_frequency_points`,
- `completed_frequency_points`,
- `written_frequency_point_artifacts`,
- `partial_artifacts_available`,
- `progress_json`.

`completed_frequency_points`, `written_frequency_point_artifacts`, and
`partial_artifacts_available` must match the final interrupted
`response/progress.v1.json` checkpoint. `progress_json` follows the same
serialized checkpoint mirror contract as `response/progress.v1.json`, but its
`status`, `state`, and `complete` values must mirror the cancel-requested
artifact itself: `cancel_requested`, `cancel_requested`, and `false`.
The API resource is
`/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1`,
while the artifact path on disk is `response/cancel_requested.v1.json`.

`frequency_domain/manifest.v1.json` links this artifact explicitly:

- `artifacts.response_cancel_requested_v1_path =
  "response/cancel_requested.v1.json"` for interrupted response sweeps,
- `resources.response_cancel_requested_resource_key =
  "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1"`
  for interrupted response sweeps.

Both manifest fields are `null` for completed and unavailable response sweeps.

## response/frequency_points/frequency_XXXX.json

This artifact is the per-frequency response point descriptor. It is the source
of truth for binary response-field payload metadata. API and UI consumers must
not infer component semantics from payload byte length or display labels.

Required fields:

- `schema_version = "frequency_response_point.v1"`,
- `frequency_index`,
- `frequency_hz`,
- `field_payload_path`,
- `payload_encoding`,
- `binary_layout`,
- `value_kind`,
- `component_basis`,
- `component_count`,
- `components[]`,
- `complex_pair_count`,
- `payload_value_count`,
- `available_views[]`,
- `default_view`,
- `default_phase_rad`.

Native frequency-response point descriptors must also mirror the corresponding
sweep-point response series, residuals, and summary observables so that a point
inspector can render without having to refetch or denormalize the full sweep
table:

- `angular_frequency_rad_per_s`,
- `m_complex`,
- `response_amplitude`,
- `response_phase`,
- `phase_rad`,
- `component_response_amplitude`,
- `component_response_phase`,
- `susceptibility_tensor`,
- `susceptibility_tensor_provenance`,
- `absorbed_power_density`,
- `absorbed_power_density_provenance`,
- `residual_l2_norm`,
- `relative_residual_l2_norm`,
- `residual_source`,
- `tangent_leakage`,
- `excitation_provenance`,
- `sweep_reuse`.

`excitation_provenance` and `sweep_reuse` must match the corresponding
`magnetic_response_sweep.v2.json.points[]` row. Point inspectors and API
resource handlers may load a single frequency point without the full sweep, so
drive phasor provenance and operator-template/warm-start reuse provenance must
be self-contained in the point artifact.

For the native FEM magnetic driven-response slice, the canonical 3D
visualization payload metadata is:

```json
{
  "storage_format": "zarr",
  "zarr_store_path": "response/field_payloads.zarr",
  "zarr_array_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex",
  "zarr_chunk_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
  "zarr_dtype": "<f8",
  "zarr_shape": [1234, 3, 2],
  "zarr_chunk_shape": [1234, 3, 2],
  "zarr_compressor": null,
  "field_payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
  "compatibility_binary_payload_path": "response/field_payloads/frequency_0000/vector_xyz.bin",
  "payload_encoding": "f64_interleaved_real_imag_xyz",
  "binary_layout": "complex_f64_pairs_little_endian",
  "value_kind": "complex_spatial_vector",
  "component_basis": "global_xyz",
  "component_count": 3,
  "components": ["x", "y", "z"]
}
```

All frequency-domain field payload metadata, whether modal or driven, must
include enough semantic information for readers to avoid guessing from byte
lengths or labels:

```text
field_id
source_family = analysis/eigen | analysis/frequency-response
quantity = delta_m | delta_M | h_drive | phi_demag | H_demag
value_kind = complex_vector | complex_scalar | real_scalar
units
normalization
mesh_id
fe_space
basis = global_xyz | tangent_components | reconstructed_xyz
complex_layout = real_imag | amplitude_phase
component_order
storage_format
zarr_path
revision
```

`zarr_array_path` identifies the logical Zarr array directory. `zarr_chunk_path`
and `field_payload_path` identify the concrete chunk read by the binary
data-plane resource. JSON resources must expose both so UI inspectors can show
storage provenance while the field codec reads a single bounded payload.

Production native FEM writers may also include:

- `tangent_field_payload_path`,
- `tangent_payload_encoding = "f64_interleaved_real_imag_tangent"`,
- `tangent_value_kind = "complex_tangent_vector"`,
- `tangent_component_basis = "local_tangent_frame"`,
- `tangent_component_count = 2`,
- `tangent_components = ["tangent_e1", "tangent_e2"]`,
- `tangent_complex_pair_count`,
- `tangent_payload_value_count`.

These tangent fields are diagnostic/raw-solver payloads. UI 3D overlays must
use the canonical `field_payload_path` spatial XYZ payload unless they
explicitly implement tangent-frame reconstruction.

The canonical Zarr array stores chunked floating-point values with logical
shape `[node, component, complex]`, where `component = x|y|z` and
`complex = real|imag`. Compatibility binary exports store little-endian `f64`
values as interleaved complex pairs:

```text
x_re, x_im, y_re, y_im, z_re, z_im, x_re, x_im, y_re, y_im, z_re, z_im, ...
```

`complex_pair_count` is the number of complex spatial components in the file.
For three XYZ components per magnetic node, `complex_pair_count = 3 *
magnetic_node_count`. `payload_value_count` is the number of scalar `f64` values
and must equal `2 * complex_pair_count`. When `storage_format = "zarr"`, the
Zarr array metadata and chunks are authoritative, and `payload_value_count` is a
consistency check against the declared logical shape. When a compatibility
binary `field_payload_path` is not null, the binary file size must equal
`payload_value_count * 8` bytes.

`available_views[]` must include at least:

- `real`,
- `imag`,
- `abs` or `amplitude`,
- `phase`,
- `phase_rotated_real`.

`default_view` should be `phase_rotated_real` for 3D visualization because it
allows a static phase slider and animation by varying `phase_rad`.

Manifest `resources.response_field_resources[]` entries must be resource
descriptors, not bare payload paths:

```json
{
  "frequency_index": 0,
  "field_resource_id": "analysis:frequency-response:frequency-0000",
  "payload_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0",
  "zarr_array_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex",
  "zarr_chunk_path": "response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0"
}
```

`field_resource_id` is the data-plane field id used by
`/v2/sessions/current/data/fields/{field_id}/samples/vector`. `payload_path`
must match the corresponding chunk-level `response_field_payload_paths[]` entry
in `magnetic_response_sweep.v2.json`. The array directory remains available via
`zarr_array_path` for storage inspection and provenance.

## response/derived_modes/fmr_peak_mode.v1.json

A response-derived peak mode is a driven-response postprocessing product, not
an eigenmode. Its artifact must state:

```text
source = magnetic_response_sweep.v2
canonical_product = frequency_response
linked_frequency_index
not_an_eigenmode = true
```

The artifact must also include:

```text
provenance.schema_version = "frequency_response_derived_mode_provenance.v1"
provenance.source_artifact_path = "response/magnetic_response_sweep.v2.json"
provenance.source_schema_version = "magnetic_response_sweep.v2"
provenance.derivation_method = "select_max_response_amplitude"
provenance.selection_metric = "max_response_amplitude" | "response_amplitude"
provenance.selected_sweep_point_index
provenance.selected_frequency_index
provenance.selected_frequency_hz
provenance.selected_response_amplitude
provenance.selected_frequency_point_artifact_path
provenance.selected_field_payload_path
provenance.not_an_eigenmode = true
```

UI and API surfaces may present it as a response peak shape or candidate mode,
but must not merge it into `eigen/spectrum.v2.json`, branch tracking, modal
normalization, or eigenfrequency capability claims.

Refined response-spectrum acceptance must only treat this artifact as accepted
when the selected peak is interior to the sweep. A maximum at the first or last
frequency point means the response peak is not bracketed by the refinement
window; it may be reported as diagnostic evidence, but the promotion validator
must reject it for refined-spectrum acceptance.

## periodic_pairs.v1.json

Periodic pair diagnostics are mesh artifacts, not UI-only state. The artifact
must include:

- `schema_version = "periodic_pairs.v1"`,
- `pairs[]`,
- each `pair_id`,
- source and destination markers,
- expected translation,
- paired node count,
- `domain_node_pair_counts` with separate `magnetic` and `airbox` pair
  coverage,
- unpaired source and destination counts,
- `boundary_face_pairs` with paired source/destination face indices,
  translation, normal dot product, and orientation status,
- residual diagnostics,
- validation status.

The v2 API resource for the same contract is:

```text
/v2/sessions/current/meshing/mesh/periodic_pairs.v1
```

That resource must preserve the same domain-node coverage and opposed-normal
boundary-face diagnostics for both live `FemMeshPayload` data and artifact-file
fallback responses. A periodic-pairs API response that reports valid node
residuals but omits airbox coverage or face-orientation diagnostics is
insufficient for the M5 periodic-airbox demag gate.

`domain_node_pair_counts.magnetic` is geometry-dependent. For magnetic bodies
that cross a selected periodic seam, accepted pair diagnostics must report
positive `magnetic` and `airbox` coverage. For separated magnetic islands inside
a periodic air gap, the side seam may be airbox-only and `magnetic = 0` is
valid; validators must still require airbox coverage, opposed-normal
boundary-face pairs, same-step `phi`/`H_demag` continuity, balanced normal `B`
flux, and no artificial side magnetic charge.
The domain counts are strict homogeneous-pair counts. A periodic node pair that
connects a magnetic endpoint to an airbox endpoint is mixed-domain topology and
must leave `magnetic + airbox < paired_node_count` so validators reject it.

## diagnostics/fem_static_pbc_demag_seams.v1.json

Static PBC demag seam diagnostics are acceptance artifacts for the M5
periodic-airbox equilibrium gate. They are required for accepted
periodic-antidot or magnonic-crystal relaxation artifacts and must be evaluated
at the same step as `m_final.json`, `fields/H_demag/step_*.json`, and
`fields/demag_phi/step_*.json`.

Required fields:

- `schema_version = "fem_static_pbc_demag_seams.v1"`,
- `status = "ok"`,
- `step`,
- `pair_diagnostics[]`,
- each `pair_id`,
- `m_seam_max`,
- `h_demag_seam_max_Apm`,
- `demag_phi_seam_max_after_offset_A`,
- `b_normal_flux_seam_max_T`,
- `side_magnetic_charge_sum_abs_Am`.

`b_normal_flux_seam_max_T` and `side_magnetic_charge_sum_abs_Am` are the
false-PBC guard. A run that passes magnetization seam checks but has unbalanced
normal `B` flux or non-cancelled side magnetic charge is finite isolated-airbox
demag with periodic magnetization projection, not accepted magnetostatic PBC.
The runner may still emit this artifact with `status = "failed"` when required
same-step `H_demag`/`demag_phi` snapshots, full-domain field lengths, node
pairs, or boundary-face pairs are missing. Validators must treat any non-`ok`
status as failed acceptance evidence, not as a successful degraded mode.

## K0 CPU/GPU parity and performance evidence

The exact production K0 pair is not qualified by matching frequencies alone.
Each sample's `eigen/diagnostics/solver.v1.json` entry must publish the same
operator identity and boundary contract on CPU and GPU:

- `assembly_kind = mfem_weak_form_shared_domain`,
- `demag_kind = periodic_airbox_k0`,
- the real-split modal equation and `FrequencyOperatorDictionary.v1`,
- `poisson_robin`, positive `robin_beta` in `1/m`, and
  `gauge_policy = none` with reason `coercive_outer_boundary`,
- complete `block_residuals` and `certification` objects,
- an exact lane-independent `operator_input_signature_sha256` for the
  corresponding bias-field sample,
- matching mesh and equivalence-map certificate identities, plus required
  lane-specific phase/equilibrium/linearization provenance.

The parity verifier compares frequencies, modal residuals, all four block
residuals, accepted mode counts, and the canonical input signature. It compares
the accepted `m_initial.json` vectors component-wise against the explicit
physical state tolerance; it does not mistake bitwise differences from two
independent CPU/GPU relaxations for an operator mismatch. Historical bundles
that publish an unknown boundary/gauge tuple, omit native action/residual
counts, or omit the canonical input signature must fail closed and cannot be
used as production evidence.

GPU production evidence additionally requires a separate
`fem_k0_modal_performance.v1` proof. It contains at least three distinct DOF
sizes, one persistent-context reuse and one signature invalidation, zero hot
loop allocations, zero full-vector H2D/D2H bytes, a bounded memory envelope,
successful cancellation/partial-artifact preservation, and a passing Compute
Sanitizer result. The proof also contains a closed
`fem_k0_modal_performance_execution.v1` record: the exact managed argv, zero
exit status, runtime/source hashes, and hash-bound stdout/stderr. The stdout
record lists every completed run ID and reports cancellation and sanitizer
status, so copied timing rows or a declared sanitizer status cannot qualify the
lane. The managed release recipe must verify this proof before it can evaluate
the CPU/GPU promotion record.

Every entry in `runs[]` is additionally bound to two separate hash-addressed
raw files. `native_diagnostics` must be the native PETSc/SLEPc diagnostics
record for that exact solve and must prove
`execution_lane=production_gpu`, device-resident modal execution,
`fallback_used=false`, the same operator-context signature/reuse decision, and
zero per-iteration full-vector transfers. `runtime_telemetry` must be emitted
by the managed native runtime with schema
`fem_k0_modal_performance_telemetry.v1`; it mirrors the run ID, DOF count,
elapsed time, peak memory, and hot-loop counters. The verifier rejects a run
when either raw file is absent, stale, or disagrees with the summary row. A
hand-authored performance JSON containing only copied summary numbers is
therefore not sufficient evidence.

The Rust runner must not call the GPU runtime finalizer after an individual
modal request. PETSc/SLEPc and the Schur context remain process-local and are
released by the native `atexit` handler (or by the explicit shutdown ABI); this
is what makes a same-process signature reuse and signature invalidation
observable. A request-level finalizer is therefore a teardown operation, not a
normal solve lifecycle step.

## Frontend contract

Analyze UI must:

- use `path_s` as the dispersion x-axis,
- show high-symmetry labels from sample labels in dispersion point controls and
  selected-point summaries when the CSV `label` column is present,
- use `branches.v2.json` for branch grouping when present,
- match `branches.v2.json` branch identity to dispersion CSV rows by
  `(sample_index, raw_mode_index)` when CSV rows omit `branch_id`,
- fall back to raw mode grouping only when branch tracking is absent,
- preserve `overlap_score` from `dispersion.csv` as the point-level modal
  tracking quality when the column is present,
- preserve `line_width_hz` from `dispersion.csv` as point-level modal linewidth
  in Hz when the column value is present, including selected-point summaries in
  Analysis Plots,
- preserve `analytic_frequency_hz`, `relative_error`, and
  `validation_geometry` from DE/BV low-k `dispersion.csv` rows; when analytic
  frequencies are present, the shared dispersion chart model must expose them
  as a reference/overlay series using the same `path_s` x-axis and frequency
  unit scaling as the numerical branch,
- show a compact analytic-reference summary in dispersion inspectors when those
  columns are present, including the validated DE/BV geometries and maximum
  published relative error,
- show the declared
  `frequency_domain/manifest.v1.json.validation.dispersion_validation` intent
  in dispersion inspectors when present, including the analytic model, maximum
  accepted `k`, frequency window, and DE/BV scenario-to-branch mapping,
- propagate click selection as `{ branchId, sampleIndex, rawModeIndex }`,
- load mode artifacts by `sample_index` and `raw_mode_index`.

## API contract

The v2 API must expose:

- spectrum v2,
- branches v2,
- dispersion CSV,
- periodic pair diagnostics.

Missing optional artifacts should produce explicit `404` responses with
diagnostic messages, not silent empty plots.
