# FullMag PBC/Floquet FEM + Airbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doprowadzic Fullmag do fizycznie poprawnego PBC/Floquet FEM dla spin-wave / frequency-domain oraz magnetostatyki w domenie `magnet + airbox`, bez cichych downgrade'ow do izolowanej geometrii.

**Architecture:** PBC jest kontraktem kilku rodzin niewiadomych, nie jedna flaga solvera. Aktualny solver ma juz statyczne `k=0` redukcje okresowe dla wybranych sciezek, ale pelny dynamiczny `delta_m + delta_phi` z airboxem i niezerowym `k` nadal wymaga nowego kontraktu IR, mesha, assemblera, walidacji i capability gatingu.

**Tech Stack:** Python DSL (`packages/fullmag-py`), `ProblemIR` / planner (`crates/fullmag-ir`, `crates/fullmag-plan`), Rust runner (`crates/fullmag-runner`), native FEM/MFEM/hypre/libCEED/CUDA (`backends/fem`, `native/include/fullmag_fem.h`), managed/container-backed `just` recipes.

---

## 0. Stan po audycie z 2026-06-27

Ten dokument koryguje poprzednie zalozenie, ze Fullmag ma tylko waski `fem_eigen.rs` Floquet/PBC. Aktualny kod ma wiecej elementow, ale sa one na roznych poziomach gotowosci. Nie wolno ich laczyc w jedna deklaracje "PBC dziala".

| Obszar | Aktualny stan | Dowod w repo | Konsekwencja |
|---|---|---|---|
| Python DSL | `PeriodicBC` i `FloquetBC` istnieja dla `Eigenmodes` i `FrequencyResponse`; stage builder przyjmuje `bc=...`. | `packages/fullmag-py/src/fullmag/model/study.py`, `packages/fullmag-py/src/fullmag/world.py` | Publiczna skladnia istnieje, ale nie gwarantuje jeszcze pelnej fizyki demag/Floquet. |
| Mesh metadata | `MeshIR` niesie `periodic_boundary_pairs` i `periodic_node_pairs`; boundary pair ma opcjonalne `translation` i `tolerance`. | `crates/fullmag-ir/src/mesh_hints.rs` | Planner/runtime moga walidowac pary, ale brakuje podzialu par wedlug rodziny niewiadomej. |
| Meshing helper | `PeriodicBoundaryPair` helpery (`periodic_x/y/z`) serializuja `translation`; automatyczna inferencja axis-aligned w `_gmsh_types.py` tworzy obecnie `pair_id/marker/node_pairs`, ale nie zapisuje jawnej translacji. | `packages/fullmag-py/src/fullmag/meshing/periodic.py`, `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | Production frequency-response wymaga translacji, wiec auto-wygenerowane PBC moze odrzucic runtime albo wymagac dopelnienia metadanych. |
| Native FEM static/time-domain PBC | `backends/fem/core/fem_mesh.cpp` buduje statyczny union-find reduction map i waliduje zgodnosc klas materialowych. | `backends/fem/core/fem_mesh.cpp` | `k=0` PBC istnieje jako statyczna redukcja klas, nie jako Floquet. |
| Native FEM local terms | Exchange/local anisotropy/DMI sa projektowane po klasach periodycznych tam, gdzie aktywna jest statyczna redukcja. | `backends/fem/cpu/mfem/interactions/effective_field.cpp`, `backends/fem/cpu/mfem/runtime/aos_field.cpp` | Lokalna fizyka moze byc spieta dla `k=0`, przy zachowaniu ograniczen walidacyjnych. |
| Native FEM demag PBC | Istnieje `demag_poisson_periodic.*`: buduje `P^T A P`, redukuje RHS, rozwiazuje zredukowany scalar potential i liftuje wynik. Robin mass wyklucza seam markers. | `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp`, `demag_poisson_boundary.cpp` | To jest zalazek statycznego `k=0` demag PBC, ale nie pelna dynamiczna frequency-domain magnetostatyka. |
| FEM GPU | Strict GPU Poisson demag i GPU exchange odrzucaja periodic reduced-node / periodic Poisson. | `backends/fem/gpu/cuda/demag_poisson/operators.cpp`, `backends/fem/gpu/cuda/exchange/exchange_plan.cpp` | Pelny PBC FEM GPU jest gated. Wymuszone GPU nie moze cicho spasc na CPU. |
| FEM eigen | `fem_eigen.rs` ma phase-aware reduction dla `Periodic`/`Floquet`, wymaga `periodic_node_pairs`, wymaga `k_sampling=Single` dla Floquet i odrzuca Floquet + dynamic demag. | `crates/fullmag-runner/src/fem_eigen.rs` | Exchange/aniso/Zeeman/DMI Floquet jest czesciowo dostepny w modalnej sciezce; demag Floquet nie. |
| FEM frequency response | Production CPU response obsluguje gamma/free oraz `k=0` static-periodic magnetic slice na `MergedMagneticMesh`; odrzuca demag, shared-domain airbox, nonzero-k i Floquet. | `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-runner/src/frequency_response.rs` | `examples/fem_frequency_response_smoke.py` z `include_demag=False` nie jest pelnym PBC+demag smoke. |
| C ABI frequency response | Native request ma pola `mfem_static_periodic_node_pairs`, `floquet_k_vector`, `mfem_floquet_periodic_pairs`; C++ production CPU test potwierdza static periodic diagnostics. | `native/include/fullmag_fem.h`, `backends/fem/src/api.cpp`, `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp` | ABI ma juz miejsce na Floquet, ale produkcyjna sciezka Floquet response jest gated. |
| Capability docs | `docs/physics/0710...` i `docs/physics/0600...` sa czesciowo przestarzale wobec aktualnego kodu. `native/include/fullmag_fem.h` ma stary komentarz o odrzucaniu time-domain periodic pairs. | audyt zrodlowy | P0 musi zsynchronizowac dokumenty i komentarze, zanim ktokolwiek podniesie status funkcji. |

## 1. Poprawiona definicja problemu

Referencyjny przypadek:

```text
film 200 x 200 x 10 nm
centralny otwor 50 nm
periodyczny w x/y
otwarty w z
driven FMR / spin-wave frequency response
```

Pelny model PBC dla tego przypadku nie oznacza tylko `PeriodicBC(["x_faces", "y_faces"])` na `delta_m`. Dla `include_demag=true` trzeba spiac:

1. statyczne `m0` okresowe w `Omega_m`, bez fazy Blocha;
2. dynamiczne `delta_m` okresowe albo Floquet/Bloch w `Omega_m`;
3. magnetostatyczny potencjal `phi0` / `delta_phi` w `Omega_m union Omega_air`;
4. lateralne sciany airboxa jako ten sam period cell w `x/y`;
5. otwarte przyblizenie tylko w `z`;
6. brak Robin/Dirichlet/free-Neumann na sztucznych seam faces;
7. provenance, capability matrix i artifacts, ktore rozrozniaja requested vs resolved physics.

Najwazniejsza korekta: obecny `examples/fem_frequency_response_smoke.py` jest **k=0 static-periodic magnetic response without demag**. To dobry krok posredni, ale nie dowod dla "periodic antidot lattice with demag".

## 2. Terminologia i konwencja fazy

Dla zmiennej zespolonej `u` na sparowanych scianach komorki:

```text
u_dst = s_i u_src
s_i = exp(-i k dot a_i)
```

Dla `k = 0`:

```text
u_dst = u_src
```

To jest statyczna/zero-phase periodycznosc. Obecny native FEM `build_static_periodic_reduction(...)` pokrywa tylko ten przypadek.

Dla fluxu przez przeciwlegle zewnetrzne normalne:

```text
partial_n(dst) u_dst = -s_i partial_n(src) u_src
```

Tego nie nalezy narzucac jako osobnego free-Neumann na seamie. Preferowany kontrakt solvera to constraint na przestrzen rozwiazan: test functions i trial functions musza spelniac te sama relacje Blocha/Floqueta, a relacja strumienia ma wynikac z weak form.

## 3. Macierz gotowosci solvera

| Sciezka | Status | Warunki uzycia |
|---|---|---|
| FEM static/time-domain, `k=0`, exchange + uniform Zeeman + local anisotropy + DMI | czesciowo wykonawcza | `mesh.periodic_node_pairs`, zgodne klasy materialowe, native FEM CPU/MFEM. |
| FEM static/time-domain, `k=0`, demag Poisson airbox | czesciowo zaimplementowana, wymaga kwalifikacji | `mesh.periodic_node_pairs`, `periodic_boundary_pairs`, shared-domain mesh with air, open non-periodic axis, CPU/MFEM path. |
| FEM eigen, Periodic/Floquet, no dynamic demag | czesciowo wykonawcza | `spin_wave_bc=periodic/floquet`, `periodic_node_pairs`, `k_sampling=Single` dla Floquet. |
| FEM eigen, Floquet + dynamic demag | unsupported | planner/runner musi odrzucac. |
| FEM frequency response, gamma/free, no demag | partial production CPU executable | P1 magnetic mesh, no shared-domain airbox, no demag. |
| FEM frequency response, `k=0` static-periodic, no demag | partial production CPU executable | `MergedMagneticMesh`, `PeriodicBC`, complete node pairs, translations, periodic drive/tangent frames. |
| FEM frequency response, demag + airbox | unsupported w production response | wymaga nowego dynamicznego `delta_phi` / coupled block. |
| FEM frequency response, nonzero-k Floquet | unsupported | C ABI ma pola, production lane odrzuca. |
| FEM GPU PBC / periodic demag | unsupported | strict GPU demag i exchange odrzucaja periodic reduced-node paths. |

## 4. Docelowy kontrakt IR

Obecny `MeshIR.periodic_node_pairs` jest za malo precyzyjny. Docelowo potrzebny jest kontrakt rozdzielajacy lattice, rodzine niewiadomych i zakres domeny:

```rust
pub struct PeriodicLatticeIR {
    pub vectors_m: Vec<[f64; 3]>,
    pub axes: Vec<PeriodicAxisIR>,
    pub wave_vector_rad_per_m: Option<[f64; 3]>,
    pub phase_convention: PhaseConventionIR,
    pub constraint_sets: Vec<PeriodicConstraintSetIR>,
}

pub struct PeriodicConstraintSetIR {
    pub unknown_family: PeriodicUnknownFamilyIR,
    pub pair_ids: Vec<String>,
    pub domain_scope: PeriodicDomainScopeIR,
    pub phase_policy: PeriodicPhasePolicyIR,
}

pub enum PeriodicUnknownFamilyIR {
    MagnetizationStatic,
    MagnetizationDynamic,
    MagnetostaticPotentialStatic,
    MagnetostaticPotentialDynamic,
}

pub enum PeriodicDomainScopeIR {
    MagneticDomain,
    MagnetostaticDomainWithAir,
}
```

Konsekwencja dla obecnego repo:

- `SpinWaveBoundaryConditionIR` zostaje publicznym wygodnym wyborem dla `delta_m`;
- mesh nadal nosi fizyczne pair metadata;
- planner rozbija publiczna intencje na constraint sets dla `m0`, `delta_m`, `phi0`, `delta_phi`;
- frequency-domain nie moze uzyc `PeriodicBC` jako skrotu do `delta_m` i ignorowac `delta_phi`, gdy `include_demag=true`.

## 5. Airbox dla periodycznej komorki

Dla filmu okresowego w `x/y` airbox tez musi byc okresowy w `x/y`.

Niepoprawny wariant:

```text
Omega_m: periodic x/y
Omega_air side walls: isolated/open/Robin/Dirichlet x/y
```

Poprawny wariant MVP:

```text
Omega_m:     periodic or Floquet in x/y
Omega_air:   same lateral cell, periodic or Floquet in x/y
z-top/bot:   explicit open-boundary approximation
```

Otwor w filmie jest realnym interfejsem `magnet/air`, nie seamem periodycznym. Pairing dotyczy zewnetrznych scian komorki. Jesli geometria otworu przecina granice komorki, mesher musi sparowac rozcieta geometrie jako czesc okresowej komorki.

Gauge fixing:

- dla Dirichlet/Robin open-boundary w `z` operator zwykle nie ma czystej swobody stalej;
- dla czysto Neumann albo w pelni periodycznego potencjalu scalarnego wymagany jest `mean(phi)=0` albo rownowazny constraint nullspace;
- plan nie moze bezwarunkowo wymagac `mean-zero` dla kazdego airboxa, bo byloby to niezgodne z obecnymi Robin/Dirichlet realizacjami.

## 6. Kluczowe luki do zamkniecia

1. **Stale docs i komentarze:** `docs/physics/0600...`, `docs/physics/0710...`, `docs/physics/0800...`, `native/include/fullmag_fem.h` musza opisac aktualny stan, nie stan sprzed implementacji static reductions.
2. **Brak unknown-family split:** jeden `periodic_node_pairs` nie wystarcza dla `delta_m` i `delta_phi` w roznych domenach.
3. **Auto-meshing bez translacji:** `_infer_axis_aligned_periodic_pairs(...)` nie dodaje `translation`, a production response wymaga translacji.
4. **Brak periodic-airbox policy:** `study.universe(... padding=...)` nie wyraza jeszcze "lateral periodic cell, z-only open padding".
5. **Dynamic demag frequency response:** production response jawnie odrzuca `include_demag=true`; potrzebny jest coupled `delta_m / delta_phi` block.
6. **Nonzero-k Floquet response:** C ABI ma pola, ale production response odrzuca Floquet; potrzebny phase-aware projector dla operatora i drive.
7. **GPU:** strict FEM GPU nie wspiera periodic reduced-node exchange ani periodic Poisson demag.

## 7. Etapy implementacji

### P0: Korekta prawdy w dokumentach i metadanych

**Cel:** repo ma mowic jednym glosem, co dziala teraz, co jest gated, a co jest tylko semantyka.

**Files:**
- Modify: `docs/physics/0600-periodic-boundary-conditions.md`
- Modify: `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`
- Modify: `docs/physics/0800-fem-static-pbc-demag.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `native/include/fullmag_fem.h`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Test: `packages/fullmag-py/tests/test_meshing.py`
- Test: `packages/fullmag-py/tests/test_api.py`

- [ ] Update `0710` so it no longer says static/time-domain FEM always rejects periodic meshes. It must say: native FEM has `k=0` static reductions for a limited CPU/MFEM slice; frequency-response demag and nonzero-k response remain unsupported.
- [ ] Update `0600` so the "only working implementation is fem_eigen.rs" sentence is replaced by the matrix from section 3.
- [ ] Update `0800` so native MFEM periodic Poisson reduction is current implementation, not future PR-4, while validation/promotion remains incomplete.
- [ ] Update `native/include/fullmag_fem.h` comment for `periodic_node_pairs`: they are not unconditionally rejected anymore; they feed static reduction and seam marker handling in supported paths.
- [ ] Add a failing Python meshing test proving axis-aligned inferred `periodic_boundary_pairs` include `translation` and `tolerance_m`:

```python
assert mesh_ir["periodic_boundary_pairs"][0]["translation"] == [Lx, 0.0, 0.0]
assert mesh_ir["periodic_boundary_pairs"][0]["tolerance_m"] > 0.0
```

- [ ] Implement the minimal `_infer_axis_aligned_periodic_pairs(...)` change: for `x_faces`, emit `[span_x, 0, 0]`; for `y_faces`, emit `[0, span_y, 0]`; for `z_faces`, emit `[0, 0, span_z]`; reuse the existing inferred tolerance.
- [ ] Re-run:

```bash
python -m pytest packages/fullmag-py/tests/test_periodic_meshing.py packages/fullmag-py/tests/test_meshing.py packages/fullmag-py/tests/test_api.py -q
cargo test -p fullmag-plan fem_frequency_response_rejects_unsupported_production_slice_cases
cargo test -p fullmag-runner fem_frequency_response_periodic_floquet_rejects_dense_validation_fallback
```

### P1: Zamkniecie obecnego k=0 magnetic-only frequency-response slice

**Cel:** obecny `include_demag=False` static-periodic response ma byc jawnie kwalifikowany jako narrow production CPU slice.

**Files:**
- Modify only if needed: `examples/fem_frequency_response_smoke.py`
- Modify only if needed: `examples/fem_frequency_response_static_periodic_smoke.py`
- Modify only if needed: `crates/fullmag-runner/src/frequency_response.rs`
- Test: `crates/fullmag-runner/src/frequency_response.rs`
- Test: `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`

- [ ] Keep `examples/fem_frequency_response_smoke.py` with `include_demag=False` until P3/P4 exists. Do not turn demag on to make the example look more physical.
- [ ] Ensure the example description says "periodic spin-wave boundary, demag disabled" and not "full periodic antidot demag".
- [ ] Ensure production rejection messages mention all three excluded cases: `include_demag=true`, shared-domain airbox, nonzero-k/Floquet.
- [ ] Run the native/container-backed gates:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-static-periodic-runtime
```

Acceptance:

- `response/diagnostics/solver.v1.json` reports static-periodic projection for the static-periodic smoke.
- `mesh/periodic_pairs.v1.json` is present and validation status is `ok`.
- Dense validation fallback is not used for the production CPU static-periodic lane.

### P2: Kwalifikacja static/time-domain k=0 demag PBC z airboxem

**Cel:** podniesc istniejacy `demag_poisson_periodic.*` z "source-visible partial" do jawnie zweryfikowanego CPU/MFEM static/time-domain feature.

**Files:**
- Modify: `backends/fem/tests/demag_poisson_contract.cpp`
- Modify: `backends/fem/tests/fem_mesh_contract.cpp`
- Modify: `crates/fullmag-plan/src/tests.rs`
- Modify: `docs/physics/fem_demag_poisson.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Add or modify: `tests/fem_demag_validation/periodic_airbox_validation.py`

- [ ] Add native contract coverage that `periodic_boundary_pair_markers` are excluded from Robin boundary mass while nonperiodic top/bottom markers remain active.
- [ ] Add planner tests for:

```text
periodic_node_pairs + Demag + shared-domain airbox + periodic_boundary_pairs => plans
periodic_node_pairs + Demag + no periodic_boundary_pairs => rejects
periodic_node_pairs + Demag + no air elements => rejects
3D fully periodic demag => rejects until gauge/model exists
```

- [ ] Add validation fixture comparing a 1x static-periodic airbox solve with an explicitly repeated supercell central-cell extraction. Keep Robin/open-boundary policy fixed across the comparison.
- [ ] Add field continuity checks:

```text
max_pair |H_demag(dst) - H_demag(src)| < tolerance
max_pair |phi(dst) - phi(src)| < tolerance
```

- [ ] Run authoritative gates through the repo recipes, not hand-written host builds:

```bash
just verify-fem-relaxation-runtime
just verify-fem-relaxation-convergence
```

Acceptance:

- CPU/MFEM static/time-domain demag PBC has an artifacted validation result, not only source-level contract tests.
- Capability matrix says `partial_production_executable` only for the exact CPU/MFEM `k=0`, open-axis, shared-domain-airbox slice.
- FEM GPU remains `unsupported` or `hybrid/debug` for periodic demag unless a separate GPU task qualifies it.

### P3: K=0 frequency-response demag with periodic airbox

**Cel:** pierwszy fizycznie spojny driven response dla periodycznej sieci antidotow z demag.

**Files:**
- Modify: `crates/fullmag-ir/src/execution.rs`
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-runner/src/frequency_response.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify: `backends/fem/include/frequency_domain/driven_response_solver.hpp`
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp`
- Modify: `backends/fem/cpu/frequency_domain/*`
- Test: `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`

- [ ] Add IR for `magnetostatic_bc = periodic_airbox_k0` and reject it unless `spin_wave_bc=periodic` or `k=0`.
- [ ] Add separate constraint sets for:

```text
delta_m: magnetic-domain periodic pairs
delta_phi: full magnetostatic-domain-with-air lateral pairs
```

- [ ] Extend production CPU frequency response from magnetic-only block to coupled block:

```text
[A_mm(omega)  A_mphi] [delta_m]   [drive_m]
[A_phim       A_phiphi] [delta_phi] = [drive_phi]
```

- [ ] Reuse the static Poisson PBC operator only where valid. Do not pretend the static operator is enough for dynamic `delta_phi` unless the linearized equation and RHS are explicitly assembled and tested.
- [ ] Add gauge/nullspace handling only for nullspace cases. Do not add a mean-zero pin to Robin/Dirichlet cases where it is unnecessary.
- [ ] Add response artifact fields for demag contribution:

```text
frequency_domain/manifest.v1.json
response/diagnostics/solver.v1.json
mesh/periodic_pairs.v1.json
response/frequency_points/frequency_*.json
```

- [ ] Run:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-runtime
```

Acceptance:

- `include_demag=true` no longer rejects only for the exact `k=0 periodic_airbox` slice.
- `include_demag=true` still rejects for nonperiodic airbox lateral walls, missing `delta_phi` pairs, missing open-z policy, and GPU.
- Runtime artifacts record requested/resolved magnetic and magnetostatic periodic BC separately.

### P4: Nonzero-k Floquet/Bloch frequency response

**Cel:** produkcyjny driven response dla zadanej fali spinowej `k != 0`.

**Files:**
- Modify: `crates/fullmag-ir/src/execution.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify: `backends/fem/include/frequency_domain/frequency_domain_contract.hpp`
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp`
- Modify: `backends/fem/cpu/frequency_domain/*`
- Test: `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`

- [ ] Implement phase-aware constraint graph for frequency-response production CPU. Existing `fem_eigen.rs` phase reduction is reference material, not a drop-in replacement.
- [ ] Support real/imag mixing for `u_dst = exp(-i k dot delta_r) u_src`.
- [ ] Validate phase loops at corners:

```text
phase(x then y) == phase(y then x)
```

- [ ] Apply phase constraints to drive vectors and tangent frames. Reject non-Floquet-periodic excitation.
- [ ] Keep `include_demag=true` gated until P5 dynamic magnetostatic Floquet exists.
- [ ] Run:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-runtime-suite
```

Acceptance:

- Exchange-only reciprocal check: `f(+k) == f(-k)` within tolerance.
- Bulk/interfacial DMI nonreciprocity check: `f(+k) != f(-k)` in the expected direction.
- `k=0 Floquet` matches `Periodic` within tolerance.

### P5: Floquet dynamic demag with airbox

**Cel:** pelny Bloch/Floquet magnetostatic response: `delta_m` and `delta_phi` maja te sama faze Blocha na lateralnych scianach.

**Files:**
- Modify: files from P3 and P4
- Modify: `docs/physics/0800-fem-static-pbc-demag.md` or create a new `docs/physics/08xx-fem-frequency-domain-floquet-demag.md`
- Test: native frequency-domain contract tests
- Test: runtime artifact validators

- [ ] Create/update a publication-style physics note before code. Static demag PBC note is not enough for dynamic `delta_phi(k, omega)`.
- [ ] Add `delta_phi_dst = exp(-i k dot delta_r) delta_phi_src` constraints on full lateral airbox side faces.
- [ ] Add flux validation:

```text
max_pair |partial_n(dst) delta_phi(dst) + phase * partial_n(src) delta_phi(src)| < tolerance
```

- [ ] Add airbox z-padding convergence test for response peaks and amplitudes.
- [ ] Add supercell validation:

```text
1x1 cell, k=0 PBC
2x2 or 3x3 supercell, Gamma-like excitation
```

- [ ] Keep GPU unsupported until strict GPU Poisson/libCEED/hypre periodic operators are implemented and verified.

Acceptance:

- `include_demag=true + spin_wave_bc=floquet + k != 0` runs only when `magnetostatic_bc=floquet_airbox` is resolved.
- Silent fallback to finite isolated airbox is impossible.
- Artifacts expose magnetic and magnetostatic phase convention and pair diagnostics.

### P6: Advanced open-boundary magnetostatics

**Cel:** zastapic finite z-airbox approximation tam, gdzie potrzebna jest wysoka jakosc dipolowa.

Do rozpatrzenia jako osobne plans/specs:

```text
infinite elements
FEM/BEM Fredkin-Koehler with periodic lateral treatment
periodic Green functions / Ewald sums
FFT/FMM-assisted periodic demag kernel
mapped exterior shell
```

Te modele nie moga byc dolaczone jako "lepszy airbox" bez osobnej capability, provenance i walidacji.

## 8. Testy akceptacyjne wspolne

Mesh/pair validation:

```text
all requested pair_ids exist
all node pairs have valid indices
duplicate source/destination nodes reject
translation residual <= tolerance
corner phase loops are consistent
pair metadata is artifacted as mesh/periodic_pairs.v1.json
```

Magnetic field continuity:

```text
max_pair ||m0_dst - m0_src|| < eps_m0
max_pair ||delta_m_dst - phase * delta_m_src|| < eps_dm
max_pair ||H_eff_dst - phase * H_eff_src|| < eps_h
```

Magnetostatic continuity:

```text
max_pair |phi_dst - phase * phi_src| < eps_phi
max_pair ||H_demag_dst - phase * H_demag_src|| < eps_hd
flux anti-periodicity check on lateral seams
```

Runtime/provenance:

```text
requested_spin_wave_bc
resolved_spin_wave_bc
requested_magnetostatic_bc
resolved_magnetostatic_bc
periodic_pair_artifact_path
unsupported_or_debug_downgrade = null
```

## 9. Przyklady i nazewnictwo

`examples/fem_frequency_response_smoke.py`:

- represents a 200 x 200 x 10 nm periodic magnetic cell with a hole;
- currently uses `include_demag=False`;
- should be described as static-periodic magnetic response, not full demag PBC.

`examples/fem_frequency_response_static_periodic_smoke.py`:

- is the clean smallest k=0 static-periodic frequency-response smoke;
- should remain the fast runtime gate for P1.

`examples/fem_fmr_periodic_k0_smoke.py`:

- currently describes and runs a free-boundary demag-airbox eigenmode path with `bc="free"`;
- it must not be treated as PBC evidence;
- either rename it to match `fem_fmr_free_demag_airbox_smoke.py` or convert it into a true periodic k=0 smoke after P2/P3.

The final 200 nm antidot example text should say:

```text
This model represents one unit cell of an infinite 2D antidot lattice.
The hole is repeated with lattice vectors ax=(200 nm,0,0), ay=(0,200 nm,0).
The lateral magnetic boundaries are artificial periodic cuts, not free sample surfaces.
If magnetostatics is enabled, the lateral airbox boundaries must use the same periodic/Floquet constraints.
Top and bottom airbox boundaries approximate open space and require convergence checks.
```

## 10. Zakazy

- Nie wlaczac `include_demag=True` w frequency-response PBC przykladzie, dopoki P3 nie istnieje.
- Nie oznaczac `PeriodicBC(["x_faces", "y_faces"])` jako pelnego PBC, jezeli dotyczy tylko `delta_m`.
- Nie traktowac lateralnych scian airboxa jako open/Robin/Dirichlet w modelu okresowym x/y.
- Nie akceptowac mesh PBC bez translacji dla sciezek, ktore waliduja `r_dst - r_src`.
- Nie uzywac silent fallback z requested periodic/Floquet demag do finite isolated airbox.
- Nie twierdzic, ze GPU FEM PBC dziala, dopoki strict GPU periodic reduced-node exchange i periodic Poisson demag nie przejda managed runtime gates.
- Nie wykonywac native FEM/MFEM/CUDA build proof przez recznie skladane host `cargo`/`cmake`/`docker` komendy. Uzyc repo `just` recipes.

## 11. Minimalna sekwencja prac

1. P0: zsynchronizowac dokumenty, komentarze ABI i mesh translations.
2. P1: zamknac oraz zweryfikowac obecny k=0 magnetic-only frequency-response slice.
3. P2: zakwalifikowac static/time-domain k=0 demag PBC z airboxem.
4. P3: dodac k=0 dynamic/frequency-response demag z periodic airboxem.
5. P4: dodac nonzero-k Floquet response bez demag.
6. P5: dodac nonzero-k Floquet dynamic demag.
7. P6: dopiero potem wybierac lepszy open-boundary model niz finite z-airbox.

Najblizszy poprawny krok nie jest "pelny Bloch airbox od razu". Najblizszy poprawny krok to P0 + P1, bo obecny kod ma juz waski dzialajacy slice i kilka dokumentow/metadata nie nadaza za implementacja.
