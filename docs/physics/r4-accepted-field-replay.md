# FEM equilibrium accepted/recomputed replay

- Status: `source_visible / unvalidated`
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-10-01
- Related physics: `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- Related contract: `docs/adr/0031-fem-nonzero-k-dispersion-representations.md`

This page defines the handoff check used before a FEM modal solve.  A native
relaxation publishes two independent static field snapshots: `accepted` is
copied at the accepted endpoint before the mandatory refresh, while
`recomputed` is copied after the refresh and is the payload used by the next
stage.  A certificate is valid only when its stored differences are reproduced
from both payloads by the consumer.  Source presence is not runtime or
scientific qualification; the current page has no managed numerical evidence.

(problem-statement)=
## 1. Physical domain and FEM static-state handoff

The domain is the magnetic FEM mesh with its demagnetizing scalar-potential
airbox when the selected plan enables demagnetization.  The handoff concerns
the static endpoint at every mesh node.  It is a prerequisite for the
linearized FEM pencil described in note 0831 and does not change the dynamic
Floquet operator or the dispersion relation.

The accepted endpoint and the refreshed endpoint are different observations of
the same equilibrium magnetization.  Reusing the recomputed payload as both
observations would make the replay tautological and could hide a stale native
field cache.

(governing-equations)=
## 2. Static field model and replay equations

For node $i$ the certified effective field is decomposed in the order used by
the native observable contract:

```{math}
:label: eq-accepted-field-decomposition
\mathbf H_{\mathrm{eff},i}
=\mathbf H_{\mathrm{ex},i}
+\mathbf H_{\mathrm{demag},i}
+\mathbf H_{\mathrm{ani},i}
+\mathbf H_{\mathrm{ext},i},
```

where the anisotropy term is absent for the legacy V1 material family.  V2 is
selected by the presence of a `uniaxial_anisotropy` authoring field, including
the explicit value $K_u=0$; it is not selected by testing whether $K_u$ is
nonzero.  The scalar potential $φ_i$ is compared independently.

For every field component family $X$ the consumer recomputes the maximum
componentwise difference:

```{math}
:label: eq-replay-difference
\Delta_X=\max_{i,c}\left|H^{\mathrm{accepted}}_{X,i,c}
-H^{\mathrm{recomputed}}_{X,i,c}\right|,
\qquad
\Delta_{\phi}=\max_i\left|\phi_i^{\mathrm{accepted}}
-\phi_i^{\mathrm{recomputed}}\right|.
```

The recorded certificate must equal these recomputed values exactly.  A field
family passes the numerical gate when:

```{math}
:label: eq-replay-acceptance
\Delta_X\leq\epsilon_{X,\mathrm{abs}}
+\epsilon_{X,\mathrm{rel}}\max\left(1,
\max|H_X^{\mathrm{accepted}}|,
\max|H_X^{\mathrm{recomputed}}|\right),
```

and the scalar potential uses the analogous absolute potential tolerance plus
the shared relative term.  The current constants are $10^{-6}\,\mathrm{A\,m^{-1}}$,
$10^{-8}$, and $10^{-12}\,\mathrm A$.  They are a static-state refresh gate,
not a modal residual, mesh-convergence, or frequency-error threshold.

(symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `H_ex` / $\mathbf H_{\mathrm{ex}}$ | exchange effective field | $\mathrm{A\,m^{-1}}$ |
| `H_demag` / $\mathbf H_{\mathrm{demag}}$ | static demagnetizing effective field | $\mathrm{A\,m^{-1}}$ |
| `H_ani` / $\mathbf H_{\mathrm{ani}}$ | uniaxial anisotropy effective field | $\mathrm{A\,m^{-1}}$ |
| `H_ext` / $\mathbf H_{\mathrm{ext}}$ | external field | $\mathrm{A\,m^{-1}}$ |
| `H_eff` / $\mathbf H_{\mathrm{eff}}$ | exact native sum of static field views | $\mathrm{A\,m^{-1}}$ |
| `phi` / $\phi$ | scalar demagnetizing potential | $\mathrm A$ |
| `Ku` / $K_u$ | uniaxial anisotropy energy density | $\mathrm{J\,m^{-3}}$ |
| `i` / $i$ | magnetic mesh node index | $1$ |
| `c` / $c$ | Cartesian field component | $1$ |
| `Delta_X` / $\Delta_X$ | maximum accepted/recomputed field difference | $\mathrm{A\,m^{-1}}$ |
| `Delta_phi` / $\Delta_{\phi}$ | maximum accepted/recomputed potential difference | $\mathrm A$ |
| `epsilon_abs` / $\epsilon_{X,\mathrm{abs}}$ | absolute field tolerance | $\mathrm{A\,m^{-1}}$ |
| `epsilon_rel` / $\epsilon_{X,\mathrm{rel}}$ | relative field tolerance | $1$ |

(assumptions-and-validity)=
## 4. Assumptions and validity limits

- Oba endpointy mają zgodną liczbę węzłów i rodzinę schematu. Każdy ma
  skończone pola, poprawną dekompozycję i własny odtworzony digest. Digesty
  accepted/recomputed mogą się różnić, jeśli różnice pól mieszczą się
  w zadanych tolerancjach.
- The magnetization digest is unchanged while the native fields are refreshed.
  This binds the comparison to one equilibrium endpoint.
- V1 contains exchange, demag, external, effective, and potential views.  V2
  additionally contains the anisotropy view.  A V1 payload with an anisotropy
  view, or a V2 payload without it, is rejected.
- `accepted_fem_equilibrium_fields.v1.json` and `.v2.json` are exact paths;
  the consumer does not fall back across schema families.
- This gate says that the static field refresh is coherent.  It does not prove
  equilibrium quality, dynamic-demag correctness, Floquet seam correctness,
  eigenvalue convergence, or agreement with COMSOL/TetraX.
- The independent replay uses the source plan's material and mesh identity.
  Raw/canonical material provenance remains owned by the equilibrium identity
  contract and is not replaced by this field comparison.

(discrete-realization)=
## 5. Discrete FEM realization

### 5.1 FEM CPU

The native FEM relaxation copies the accepted endpoint fields, refreshes the
device-resident component fields, copies the recomputed fields, and publishes
both payloads plus the V1/V2 certificate.  The eigen consumer decodes the
three artifacts and reruns the componentwise comparison before constructing
the stage handoff.  The source is visible; no managed CPU result is attached to
this page.

### 5.2 FEM GPU

The same artifact and replay contract applies to a GPU relaxation.  The field
copies and strict GPU receipt remain separate execution evidence.  This page
does not claim GPU residency, device identity, parity, or qualification.

### 5.3 FDM and hybrid lanes

The contract is an FEM native artifact boundary.  FDM CPU/GPU and hybrid
realizations are not applicable; they require their own equilibrium artifact
contract if they later feed the same modal pencil.

(implementation-mapping)=
## 6. Implementation mapping and failure semantics

`CertifiedFemEquilibriumFields::accepted_artifact_path_for_material` selects
the accepted path from material-family presence.  The relaxation finalizer
publishes the accepted fields before the recomputed certified fields.  The
replay validator checks both field digests, all identity digests, the exact
recorded differences, schema-specific anisotropy, and the shared tolerances.
The bias-field eigen caller decodes the accepted artifact explicitly and uses
`AcceptedFemRelaxStageHandoff::from_completed_relax_verified`.

Any missing artifact, unknown schema, explicit null view, digest mismatch,
shape mismatch, non-finite value, forged difference, tolerance mismatch, or
out-of-tolerance difference fails closed with a `RunError`.  A certificate
cannot be accepted merely because the recomputed payload is internally
consistent.

(python-api)=
## 7. Python API impact

No public Python constructor, interaction, observable, or unit conversion is
added.  The artifact is emitted by the native FEM execution path after the
existing stage-first authoring has already lowered to `FemPlanIR`.  Python
post-processing may read the versioned JSON paths, but must preserve the V1/V2
family and must not infer V1 from a missing V2 view.

The following read-only example shows the artifact boundary without creating a
simulation or claiming a runtime result:

```python
# %%
import json
from pathlib import Path

accepted_path = Path("equilibrium/accepted_fem_equilibrium_fields.v2.json")
recomputed_path = Path("equilibrium/certified_fem_equilibrium_fields.v2.json")

# %%
accepted = json.loads(accepted_path.read_text(encoding="utf-8"))
recomputed = json.loads(recomputed_path.read_text(encoding="utf-8"))
assert accepted["schema_version"] == recomputed["schema_version"]
assert "h_anisotropy_a_per_m" in accepted
```

(problem-ir)=
## 8. ProblemIR impact

No `ProblemIR` field changes.  The existing material presence rule for
`uniaxial_anisotropy` determines the static artifact schema, so a declared
$K_u=0$ remains observable as V2.  Requested backend/device intent and the
resolved execution remain in their existing provenance records.

(round-trip-and-failure-semantics)=
## 9. Planner, capability, runtime, and provenance impact

The planner and capability matrix do not gain a new capability.  Runtime
availability remains governed by the existing FEM CPU/GPU lanes and managed
runner profiles.  The accepted sidecar is an execution artifact, not a claim
that the solver converged or that a GPU was used.  Its digest is linked from
the recomputation certificate; the modal stage consumes it only after replay.

The requested intent remains the existing FEM CPU/GPU relaxation followed by
the modal stage; the accepted sidecar records the endpoint observation and does
not alter the requested `ProblemIR`.  Validation errors are reported as a
typed execution error when the versioned artifact is missing, malformed, or
inconsistent, and the caller stops before modal assembly.  Unsupported combinations,
cross-family fallback, unknown schema versions, and an FDM payload presented as
an FEM artifact are rejected rather than normalized silently.

(validation)=
## 10. Validation strategy

### Analytical and contract checks

The independent interpreted regression covers V1, V2, explicit zero-Ku schema
selection, anisotropy differences, and a forged recorded difference.  Source
checks confirm distinct producer publication, consumer decoding, and the
verified handoff constructor.

### Cross-backend and runtime checks

Managed FEM CPU and GPU runs must later demonstrate non-empty accepted and
recomputed artifacts, matching equilibrium and mesh identities, finite fields,
zero rejected replay differences, and the requested/resolved execution class.
Those gates are pending and are not replaced by parser or source checks.

### Regression commands

```text
python scripts/test_fem_accepted_recomputed_replay_contract.py
python .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/r4-accepted-field-replay.source-map.json --repo-root .
```

Native unit compilation and managed runtime execution remain outside this
change slice and are therefore `NOT VERIFIED` here.

(limitations)=
## 11. Completeness checklist and deferred work

- [x] Physical equations, SI units, and schema assumptions
- [x] FEM CPU/GPU interpretation and FDM non-applicability
- [x] Python API and ProblemIR impact
- [x] Planner, runtime, and provenance boundary
- [x] Accepted/recomputed producer and consumer mapping
- [x] Interpreted regression contract
- [ ] Managed FEM CPU numerical replay
- [ ] Managed FEM GPU numerical replay and device evidence
- [ ] Mesh/airbox/mode convergence and COMSOL/TetraX comparison
- [x] Source path-remapper/manifest persistence for accepted V1/V2 sidecars
- [x] Source path-remapper/manifest persistence for certified fields and recomputed certificates
- [ ] Complete per-sample payload publication by the continuation binder
- [ ] Managed execution of path-remapper/manifest persistence
- [ ] Source-identity V2 binding of accepted/recomputed payloads

(scientific-bibliography)=
## 12. References

- Fullmag, `0831-fem-dynamic-pencil-modal-response-and-krylov.md`, current
  dynamic pencil and artifact qualification boundaries.
- Fullmag, `0830-fem-poisson-airbox-modal-eigen.md`, static Poisson/airbox
  field ownership.
- Fullmag, `ADR-0031`, nonzero-$\mathbf k$ dispersion representations and
  Floquet provenance.

(source-code-index)=
## 13. Source-code index

| Claim | Source | Responsibility | Lane | Evidence |
|---|---|---|---|---|
| Complete sample coverage | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` — `_computed_sample_indices_from_spectrum`, `validate_r4_signed_sidecars` | Require every computed sample independently of selected mode fields | FEM CPU/GPU | interpreted fixtures; runtime pending |
| Sample coverage regression | `scripts/test_eigen_path_signed_sidecars.py` — `test_all_seven_sidecar_arrays_must_cover_every_computed_sample` | Missing/extra samples and strict integer counts | FEM CPU/GPU | 31 interpreted tests PASS |
| V1/V2 and accepted path selection | `crates/fullmag-runner/src/types.rs` — `CertifiedFemEquilibriumFields::artifact_paths_for_material`, `accepted_artifact_path_for_material` | Exact artifact family and path | FEM CPU/GPU | source-visible |
| Shared tolerances | `crates/fullmag-runner/src/types.rs` — `FEM_LINEARIZATION_FIELD_ABSOLUTE_TOLERANCE_A_PER_M` | One producer/consumer policy | FEM CPU/GPU | source-visible |
| Accepted publication | `crates/fullmag-runner/src/fem/relax/finalize.rs` — `finalize_native_fem_relaxation` | Preserve endpoint before refresh | FEM CPU/GPU | source-visible |
| Independent replay | `crates/fullmag-runner/src/fem_eigen.rs` — `validate_recomputed_fem_linearization_certificate` | Recompute differences and fail closed | FEM CPU/GPU | source-visible |
| Required caller | `crates/fullmag-runner/src/fem/eigen_execution.rs` — `execute_bias_field_sample_with_relaxation` | Decode accepted and verified handoff | FEM CPU/GPU | source-visible |
| Verified handoff | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` — `from_completed_relax_verified` | Gate modal continuation | FEM CPU/GPU | source-visible |
| Static field schema guard | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` — `validate_certified_equilibrium_fields` | Enforce decomposition and digest | FEM CPU/GPU | source-visible |
| R4 conflict propagation | `crates/fullmag-runner/src/fem/eigen_path.rs` — `execute_fem_eigen_path` | Abort before publishing conflicting signed evidence | FEM CPU/GPU | source-visible; runtime pending |
| R4 sidecar persistence | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` — `single_k_signed_state_artifact` | Exact bytes, independent mode selection | FEM CPU/GPU | source-visible; native pending |
| R4 sidecar discovery | `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` — `build_eigen_path_frequency_domain_manifest` | Actual per-sample plural paths | FEM CPU/GPU | source-visible; runtime pending |
| Consumer plan snapshot | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` — `consumer_plan_snapshot_bytes_and_sha256` | Exact serde bytes shared by identity digest and sidecar | FEM CPU/GPU | source-visible; runtime pending |
| Consumer plan coverage | `crates/fullmag-runner/src/fem/eigen_output.rs` — `inspect_r4_sidecars` | Require one raw-SHA-bound plan per complete computed sample | FEM CPU/GPU | source-visible; runtime pending |
| Independent Python field replay | `scripts/fem_equilibrium_field_replay.py` — `replay_accepted_recomputed_fields` | Binary field digests, differences, exact certificate preimage and explicit context limitations | FEM CPU/GPU | interpreted fixture checks; runtime pending |
| Python field replay regression | `scripts/test_fem_equilibrium_field_replay.py` — `test_frozen_v1_and_v2_binary_field_digests_match_rust` | Frozen digests, mutations and strict preimage types | FEM CPU/GPU | 8 interpreted groups PASS |
| Own identity digest replay | `scripts/fem_linearization_identity_replay.py` — `replay_identity_preimage` | Exact UTF-8, typed values, raw and framed hashes; no physical-state qualification | FEM CPU/GPU | 10 interpreted groups PASS |
| Complete preimage paths | `scripts/test_eigen_path_signed_sidecars.py` — `test_exact_preimages_replayed_for_all_computed_samples` | All computed samples, historical absence, no promotion to full R4 | FEM CPU/GPU | interpreted fixtures PASS |
| Identity mutation regression | `scripts/test_fem_linearization_identity_replay.py` — `test_every_identity_field_is_bound` | Every field, JSON types, duplicate keys and nesting | FEM CPU/GPU | interpreted fixtures PASS |
| Interpreted regression | `scripts/test_fem_accepted_recomputed_replay_contract.py` — `run_accepted_recomputed_replay_contract` | Cross-layer source and numerical contract | all FEM lanes | local interpreted check |

## Aktualizacja R4 multi-k — 2026-10-01

Agregator zachowuje dokładne bajty accepted fields, certified fields oraz
recomputed certificate obu rodzin w `eigen/metadata/sample_NNNN/`. Manifest
wylicza tylko rzeczywiście obecne artefakty. Ich zachowanie nie zależy od
wyboru pól modów; spectrum-only nie traci dowodów równowagi. Przygotowana
regresja natywna obejmuje próbki 0, 2, 7 i oba źródłowe prefixy. Nie została
uruchomiona. Binder kontynuacji nadal musi zachować i opublikować wszystkie
payloady; obecność pustych tablic nie zamyka replay R4.

Kompletny nowy pakiet publikuje także exact raw bytes planu konsumenta jako
`eigen/metadata/sample_NNNN/consumer_plan_snapshot.v1.json`. To ten sam
`serde_json::to_vec(FemEigenPlanIR)` stream, którego digest zapisuje
`consumer_plan_snapshot_sha256` identity V2; manifest dodaje
`consumer_plan_snapshot_v1_paths[]`, a single-k także singular alias. Brak,
nadmiar lub zmiana raw SHA pozostają `NOT_VERIFIED` i nie są zastępowane
rekonstrukcją planu po stronie odbiornika.

Dwa źródłowe prefixy mogą wskazać jeden docelowy plik próbki. Przy różnych
bajtach podpisanego sidecara agregacja zwraca błąd przed usunięciem
duplikatów; identyczne duplikaty są redukowane. Przygotowana regresja
sprawdza ten konflikt oraz rzeczywisty producent manifestu dla obu rodzin.
Kompilacja i wykonanie tych regresji pozostają niewykonane.

Niezależny moduł Python odtwarza binarne digesty pól V1/V2 i różnice obu
endpointów. Osiem grup regresji przechodzi, w tym mutacje, boolowe liczby,
duplikaty JSON oraz powiązanie dokładnego preimage z odczytanym certyfikatem.
Brak preimage, magnetyzacji, topologii albo tożsamości źródła pozostaje jawną
limitacją. Moduł nie jest jeszcze podłączony do pełnej bramki manifestu R4;
fixtures nie dowodzą odtworzenia bieżącego solvera ani kwalifikacji naukowej.

## Pokrycie wszystkich policzonych próbek — checkpoint 2026-10-01

Walidator porównuje zbiory indeksów sidecarów z jawnymi rekordami
`eigen/spectrum.v2.json` (`samples[].sample_index`, `sample_count`).
Nie wyprowadza zakresu z największego indeksu ani z wybranych pól modów.
Brak jednej próbki we wszystkich siedmiu tablicach oraz nadmiarowa próbka
są odrzucane. Historyczny brak endpointów nadal daje NOT VERIFIED.
Indeksy i liczniki muszą być nieujemnymi liczbami całkowitymi JSON;
wartości bool i float oraz duplikaty indeksów są odrzucane.

Weryfikacja: 31 regresji sidecarów PASS oraz 213 testów pytest istniejącego
walidatora PASS. Ta kontrola nie odtwarza jeszcze podpisanych payloadów
identity i nie dowodzi wykonania solvera. Główna bramka R4 pozostaje otwarta.

## Własny exact preimage identity — przyrost weryfikatora

Kontrakt bajtów i framingu opisuje
`docs/physics/r4-linearization-identity-v2.md`. Główny walidator odczytuje
addytywną tablicę `linearization_identity_preimage_v1_paths[]`, jeśli jest
zadeklarowana. Wówczas musi ona obejmować wszystkie opublikowane identity
próbek, a pole `sample_index` musi odpowiadać kanonicznej ścieżce pliku.

`scripts/fem_linearization_identity_replay.py` sprawdza dokładne UTF-8 bytes,
raw SHA-256, framed digest oraz typowane wartości wszystkich 52 pól identity
po wyzerowaniu wyłącznie `content_sha256`. Nie serializuje ponownie słownika
Python w celu zgadywania bajtów `serde_json`. Odrzuca duplicate keys, bool/int/
float coercion, lone Unicode surrogates, niefinitywne liczby i nadmierne
zagnieżdżenie. Zmiana whitespace preimage zmienia jego hash.

Brak historycznego sidecara pozostaje `unverified_missing_preimage`.
Poprawny digest daje tylko `identity_content_digest_status` równy
`verified_exact_preimage`; pełne R4 nadal ma status `payload_replay_pending`.
Powiązane mesh, m0, podpisy fizyczne, endpointy i rzeczywiste wykonanie wymagają
osobnych kontroli. Podpis hash nie jest uwierzytelnieniem producenta.

Regresje interpretowane: 10 grup exact preimage oraz 38 testów sidecarów PASS.
Pełny managed replay tego przyrostu pozostaje NOT VERIFIED.
