# FullMag PBC/Floquet FEM + Airbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Doprowadzic Fullmag do fizycznie poprawnego PBC/Floquet FEM dla spin-wave / frequency-domain oraz magnetostatyki w domenie `magnet + airbox`, bez cichych downgrade'ow do izolowanej geometrii.

**Architecture:** PBC jest kontraktem kilku rodzin niewiadomych, nie jedna flaga solvera. Aktualny solver ma juz statyczne `k=0` redukcje okresowe dla wybranych sciezek, ale pelny dynamiczny `delta_m + delta_phi` z airboxem i niezerowym `k` nadal wymaga nowego kontraktu IR, mesha, assemblera, walidacji i capability gatingu.

**Tech Stack:** Python DSL (`packages/fullmag-py`), `ProblemIR` / planner (`crates/fullmag-ir`, `crates/fullmag-plan`), Rust runner (`crates/fullmag-runner`), native FEM/MFEM/hypre/libCEED/CUDA (`backends/fem`, `native/include/fullmag_fem.h`), managed/container-backed `just` recipes.

---

## 0. Stan po audycie z 2026-06-27

Ten dokument koryguje poprzednie zalozenie, ze Fullmag ma tylko waski `fem_eigen.rs` Floquet/PBC. Aktualny kod ma wiecej elementow, ale sa one na roznych poziomach gotowosci. Nie wolno ich laczyc w jedna deklaracje "PBC dziala".

### Aktualizacja 2026-06-28 po focused frequency-domain pass

Attachment z 2026-06-28 wymaga docelowo produkcyjnego GPU-backed
frequency-domain path dla PBC/Floquet/dynamic demag. Aktualny audyt repo
potwierdza, ze ten cel nadal wykracza poza obecny wykonawczy zakres solvera:

- GPU driven response jest produkcyjnie wykonywalny dla gamma/free,
  magnetic-only, no-demag slice oraz k=0 static-periodic magnetic-only,
  no-demag slice, gdy mesh publikuje kompletne periodic pairs.
- GPU periodic airbox demag, nonzero-k Floquet response i Floquet dynamic
  demag nadal sa gated i musza pozostac jawnie `unsupported`, dopoki realne
  CUDA/libCEED/hypre operatory nie istnieja.
- Gamma-Floquet (`k=0`) jest aliasem zero-phase Periodic dla response i nie
  powinien wpadac w sciezke `floquet_bloch_nonzero_k`.
- Nonzero-k Floquet ma pozostac structured unavailable/rejected, z walidacja
  `phase_rad = -k dot translation` przed obecnym unsupported solve path.

Zamkniety mikroetap:

- Native C ABI driven-response path waliduje teraz spojnosc jawnych metadanych
  Floquet przed obecna sciezka unsupported: para z `k=[1e6,0,0]`,
  `translation=[1e-6,0,0]` i niespojnym `phase_rad=0.25` zwraca
  `validation_error` z powodem `phase_rad = -k dot translation`; para ze
  spojnym `phase_rad=-1.0` nadal dochodzi do structured
  `unsupported_reason="floquet_bloch_nonzero_k"`. Focused native contract
  przeszedl po RED/GREEN:
  `docker compose --profile fem-gpu run --rm fem-gpu ... fem_frequency_domain_contract`.
  To poprawia P4 metadata contract, ale nie implementuje phase-aware operatora.
- Native C ABI driven-response path waliduje teraz takze nonzero-k Floquet
  tangent frames i zespolony drive przed obecna sciezka unsupported. Request z
  niezgodnymi ramkami tangent zwraca structured
  `validation_error="floquet_tangent_frame_mismatch"`, a request z
  nie-Floquet-periodic drive zwraca
  `validation_error="floquet_drive_phase_mismatch"`. Focused native contract
  najpierw potwierdzil RED na statusie `UNAVAILABLE`, a po implementacji
  przeszedl; nastepnie `just verify-fem-frequency-domain-native-contract`
  odbudowal missing managed runtime bundle i zakonczyl pelna native suite
  kodem `0`. To nadal jest walidacja boundary, nie phase-aware operator.
- Nonzero-k Floquet tangent-drive validation path zachowuje teraz partial
  artifacts, gdy request podaje `output_directory` i
  `write_partial_artifacts=true`: `frequency_domain/manifest.v1.json`,
  `response/diagnostics/solver.v1.json` i `response/progress.v1.json` niosa
  `status="validation_error"` oraz
  `validation_error="floquet_drive_phase_mismatch"`, nie zapisujac
  `response/magnetic_response_sweep.v1.json` i nie maskujac bledu jako
  `unsupported_reason="floquet_bloch_nonzero_k"`. RED/GREEN dowod:
  `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp` najpierw
  padl na braku `artifact_manifest_path`, potem focused container contract
  przeszedl. Managed dowod:
  `just verify-fem-frequency-domain-native-contract` odbudowal
  `.fullmag/runtimes/fem-gpu-host` po wykryciu nowszego
  `backends/fem/src/frequency_domain/driven_response_solver.cpp`, zakonczyl
  release build po `6m 19s`, wyeksportowal runtime i uruchomil pelna native
  suite z kodem `0`.
- Rust runner tests zostaly zsynchronizowane z `Floquet(k=0) == Periodic`:
  gamma-Floquet payload test uzywa kompletnego minimalnego payloadu bez
  przypadkowego wymagania exchange elements, a nonzero-k Floquet test nadal
  wymaga planning rejection.
- Native wrapper test `native_frequency_response_rejects_floquet_metadata_before_native_call`
  uzywa teraz spojnej fazy `phase_rad=-0.01` dla `k=[1e7,0,0]` i
  `translation=[1e-9,0,0]`, dzieki czemu test sprawdza structured
  `floquet_bloch_nonzero_k`, a nie wczesniejszy metadata validation error.
- Static-periodic runtime artifact contract zostal domkniety dla CPU
  frequency response: plan-level `mesh/periodic_pairs.v1.json` nie nadpisuje
  juz natywnego artefaktu `native_fem_frequency_domain_static_periodic`.
  Managed gate `just verify-fem-frequency-domain-static-periodic-runtime`
  przeszedl po rebuildzie runtime i verifierze `--require-static-periodic`.
  Artefakt po runie zawiera `source=native_fem_frequency_domain_static_periodic`,
  `pair_count=4`, `paired_node_count=8`, `validation_status=ok` oraz zerowe
  `static_periodic_frame_max_mismatch` i
  `static_periodic_drive_max_mismatch`.
- Managed native contract gate `just verify-fem-frequency-domain-native-contract`
  przeszedl po ustabilizowaniu eksportu FEM GPU runtime bundle. Blokerem byl
  niedeterministyczny overwrite istniejacych SONAME/symlinkow w
  `.fullmag/runtimes/fem-gpu-host/lib`; `scripts/export_fem_gpu_runtime.sh`
  uzywa teraz `copy_runtime_entry_replace` z
  `scripts/lib/runtime_bundle_copy.sh`. Test
  `python3 -m pytest scripts/test_export_fem_gpu_runtime_copy_helpers.py -q`
  chroni dwa przypadki: zastapienie istniejacego symlinka regularnym plikiem
  oraz idempotentny overwrite regularnego pliku. Gate natywny buduje i odpala
  `fem_frequency_domain_contract`, `fem_operator_contract`,
  `fem_modal_eigen_contract`, `fem_driven_response_contract`,
  `fem_window_partition_contract`, `fem_mode_deduplication_contract` i
  `fem_contour_interval_solver_contract`.
- GPU static-periodic no-demag response zostal podniesiony z samego
  unavailable artifact contract do executable runtime slice. Managed gate
  `just verify-fem-frequency-domain-gpu-static-periodic-runtime` uruchamia
  `examples/fem_frequency_response_gpu_static_periodic_smoke.py` i verifier
  `--require-production-gpu --require-static-periodic`; artefakty zachowuja
  `requested_execution_lane=production_gpu`,
  `resolved_execution_lane=production_gpu`,
  `validation_fallback_used=false`,
  `source=native_fem_frequency_domain_static_periodic`, `pair_count=4`,
  `paired_node_count=8`, `validation_status=ok` oraz zerowe seam mismatch
  diagnostics. Ten gate nie jest jeszcze CPU/GPU parity validation i nie
  promuje dynamic demag ani nonzero-k Floquet.
- Biezacy rerun focused native contract oraz managed native contract zostal
  domkniety. Focused diagnostyczny gate:
  `docker compose --profile fem-gpu run --rm fem-gpu ... fem_frequency_domain_contract`
  przeszedl bez `FAIL`. Nastepnie
  `just verify-fem-frequency-domain-native-contract` wykryl brak kompletnego
  managed runtime bundle, odbudowal `.fullmag/runtimes/fem-gpu-host`, zakonczyl
  release build po okolo `6m 53s`, wyeksportowal runtime i uruchomil pelna
  natywna suite z targetu: `fem_frequency_domain_contract`,
  `fem_operator_contract`, `fem_modal_eigen_contract`,
  `fem_driven_response_contract`, `fem_window_partition_contract`,
  `fem_mode_deduplication_contract` i
  `fem_contour_interval_solver_contract`. Target zakonczyl sie kodem `0`.
  To odswieza managed proof kontraktow P1/P3/P4 po poprzednim przerwanym
  Cargo-lock runie, ale nie implementuje jeszcze phase-aware nonzero-k
  Floquet operatora ani dynamic demag.

Procent realizacji wzgledem pelnego celu PBC/Floquet/GPU:

| Etap | Ocena | Uzasadnienie |
|---|---:|---|
| P0 docs/metadane | 100% | Zakonczone w planie; mesh translations i capability truth sa opisane. |
| P1 k=0 magnetic-only response | 99% | CPU static-periodic/no-demag ma aktualny managed gate i artifact-backed verifier; GPU gamma/free i GPU static-periodic/no-demag maja runtime verifiers z `--require-production-gpu`, `--require-static-periodic` oraz bez fallbacku. Brakuje jeszcze CPU/GPU parity validation na wspolnym mesh assetcie, wiec status nie jest `validated`. |
| P2 static/time-domain demag PBC | 100% dla CPU slice | Static/time-domain periodic airbox CPU/MFEM ma artifacted validation; GPU pozostaje gated. |
| P3 k=0 frequency-response demag periodic airbox | 47% | Sa IR/ABI/artifact gates, explicit dense coupled-block hook, public C ABI/Rust FFI matrix-free coupled-block provider seams dla coupled block i demag tangent, delta_phi layout, magnetostatic delta_phi periodic-node-pair plumbing i validation errors; brak realnego MFEM assembly `[delta_m, delta_phi]`. |
| P4 nonzero-k Floquet response | 35% | Sa IR/planner metadata, phase diagnostics, gamma alias, structured unsupported, C ABI validation dla niespojnego `phase_rad != -k dot translation`, C ABI validation dla nie-Floquet-periodic tangent frames/drive oraz durable partial artifacts dla Floquet drive validation errors; brak phase-aware production operator. |
| P5 Floquet dynamic demag | 10% | Jest physics note i gating; brak `delta_phi` Bloch constraints, flux validation i solver. |
| GPU PBC/Floquet/dynamic demag | 20% | GPU no-demag/free i k=0 static-periodic/no-demag dzialaja jako baza artefaktowa z runtime verifierem i stabilnym managed runtime exportem; nadal brak nonzero-k Floquet operatora, periodic Poisson/dynamic demag i CPU/GPU parity validation dla docelowego antidot lattice. |

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
| FEM static/time-domain, `k=0`, demag Poisson airbox | partial production executable for the qualified CPU/MFEM slice | `mesh.periodic_node_pairs`, `periodic_boundary_pairs`, shared-domain mesh with air, at least one open axis, CPU/MFEM path. |
| FEM eigen, Periodic/Floquet, no dynamic demag | czesciowo wykonawcza | `spin_wave_bc=periodic/floquet`, `periodic_node_pairs`, `k_sampling=Single` dla Floquet. |
| FEM eigen, Floquet + dynamic demag | unsupported | planner/runner musi odrzucac. |
| FEM frequency response, gamma/free, no demag | partial production CPU executable | P1 magnetic mesh, no shared-domain airbox, no demag. |
| FEM frequency response, `k=0` static-periodic, no demag | partial production CPU and GPU executable | `MergedMagneticMesh`, `PeriodicBC`, complete node pairs, translations, periodic drive/tangent frames; GPU status is executable, not validated, and requires `validation_fallback_used=false`. |
| FEM frequency response, demag + airbox | unsupported w production response | wymaga nowego dynamicznego `delta_phi` / coupled block. |
| FEM frequency response, nonzero-k Floquet | unsupported | C ABI ma pola, production lane odrzuca. |
| FEM GPU PBC / periodic demag | partial for magnetic static-periodic response; periodic demag unsupported | GPU k=0 static-periodic no-demag response executes through the frequency-domain CUDA tangent path with periodic pair diagnostics. Strict GPU periodic demag, nonzero-k Floquet, and dynamic demag remain gated. |

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

- [x] Update `0710` so it no longer says static/time-domain FEM always rejects periodic meshes. It must say: native FEM has `k=0` static reductions for a limited CPU/MFEM slice; frequency-response demag and nonzero-k response remain unsupported.
- [x] Update `0600` so the "only working implementation is fem_eigen.rs" sentence is replaced by the matrix from section 3.
- [x] Update `0800` so native MFEM periodic Poisson reduction is current implementation, not future PR-4, while validation/promotion remains incomplete.
- [x] Update `native/include/fullmag_fem.h` comment for `periodic_node_pairs`: they are not unconditionally rejected anymore; they feed static reduction and seam marker handling in supported paths.
- [x] Add a failing Python meshing test proving axis-aligned inferred `periodic_boundary_pairs` include `translation` and `tolerance_m`:

```python
assert mesh_ir["periodic_boundary_pairs"][0]["translation"] == [Lx, 0.0, 0.0]
assert mesh_ir["periodic_boundary_pairs"][0]["tolerance_m"] > 0.0
```

- [x] Implement the minimal `_infer_axis_aligned_periodic_pairs(...)` change: for `x_faces`, emit `[span_x, 0, 0]`; for `y_faces`, emit `[0, span_y, 0]`; for `z_faces`, emit `[0, 0, span_z]`; reuse the existing inferred tolerance.
- [x] Re-run:

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

- [x] Keep `examples/fem_frequency_response_smoke.py` with `include_demag=False` until P3/P4 exists. Do not turn demag on to make the example look more physical.
- [x] Ensure the example description says "periodic spin-wave boundary, demag disabled" and not "full periodic antidot demag".
- [x] Ensure production rejection messages mention all three excluded cases: `include_demag=true`, shared-domain airbox, nonzero-k/Floquet.
- [x] Run the native/container-backed gates:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-static-periodic-runtime
just verify-fem-frequency-domain-gpu-static-periodic-runtime
```

Acceptance:

- `response/diagnostics/solver.v1.json` reports static-periodic projection for the static-periodic smoke.
- `mesh/periodic_pairs.v1.json` is present and validation status is `ok`.
- Dense validation fallback is not used for the production CPU static-periodic lane.
- Production GPU static-periodic smoke reports requested/resolved
  `production_gpu`, `validation_fallback_used=false`, static-periodic
  diagnostics and complete manifest/progress/solver artifacts.
- Runtime bundle export is idempotent when `.fullmag/runtimes/fem-gpu-host/lib`
  already contains copied SONAME files or symlinks.

Progress notes:

- `just verify-fem-frequency-domain-native-contract` currently covers the
  focused native contract suite after managed runtime export. This is a native
  contract/build gate, not by itself a CPU/GPU parity validation for the
  antidot FMR workload.
- Frequency-domain availability is now aligned with the currently implemented
  native GPU response slices: strict GPU requests for gamma/free no-demag and
  k=0 static-periodic no-demag driven response report the
  `native_fem_mfem_frequency_domain_gpu` lane when built with CUDA runtime and
  must keep `validation_fallback_used=false`. This does not promote GPU
  periodic demag, nonzero-k Floquet, or GPU dynamic demag.
- The public frequency-domain capability manifest now derives
  `response.magnetic_gpu` from strict-GPU availability probes, so CUDA builds
  can advertise the narrow gamma/free and k=0 static-periodic no-demag GPU
  response slices while non-CUDA or non-`fem-gpu` builds continue to report
  unsupported status. The manifest still must not advertise GPU periodic demag
  or nonzero-k Floquet.
- GPU static-periodic runtime artifacts now preserve the requested and resolved
  GPU lane, `validation_fallback_used=false`, static-periodic diagnostics, and
  `mesh/periodic_pairs.v1.json` with `validation_status=ok`. Verified by the
  managed target `just verify-fem-frequency-domain-gpu-static-periodic-runtime`;
  CPU/GPU parity on a shared mesh asset remains pending.

### P2: Kwalifikacja static/time-domain k=0 demag PBC z airboxem

**Cel:** podniesc istniejacy `demag_poisson_periodic.*` z "source-visible partial" do jawnie zweryfikowanego CPU/MFEM static/time-domain feature.

**Files:**
- Modify: `backends/fem/tests/demag_poisson_contract.cpp`
- Modify: `backends/fem/tests/fem_mesh_contract.cpp`
- Modify: `crates/fullmag-plan/src/tests.rs`
- Modify: `docs/physics/fem_demag_poisson.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Add or modify: `tests/fem_demag_validation/periodic_airbox_validation.py`

- [x] Add native contract coverage that `periodic_boundary_pair_markers` are excluded from Robin boundary mass while nonperiodic top/bottom markers remain active.
- [x] Add planner tests for:

```text
periodic_node_pairs + Demag + shared-domain airbox + periodic_boundary_pairs => plans
periodic_node_pairs + Demag + no periodic_boundary_pairs => rejects
periodic_node_pairs + Demag + no air elements => rejects
3D fully periodic demag => rejects until gauge/model exists
```

- [x] Add validation fixture comparing a 1x static-periodic airbox solve with an explicitly repeated supercell central-cell extraction. Keep Robin/open-boundary policy fixed across the comparison.
  - [x] CSV artifact acceptance harness for primitive/supercell energy comparison.
  - [x] Active primitive/supercell runtime producer reaches managed MFEM solves and writes CSV/Zarr-derived seam metrics.
  - [x] Producer now compares primitive periodic energy against a central-cell field-energy extraction from the explicit supercell artifact, not against whole-supercell `E_demag / repetitions^2`.
  - [x] Periodic reduced Poisson solve publishes actual MFEM CG iterations/residual telemetry instead of hard-coded zeroes.
  - [x] Periodic airbox meshing now assigns non-Robin physical boundary markers to every periodic seam surface fragment, preserves all marker pairs in `periodic_boundary_pairs`, and excludes those surfaces from `Gamma_out`; current producer records `robin_periodic_seam_face_count=0`.
  - [x] Diagnostic supercell sweep summary is reproducible via `python3 tests/fem_demag_validation/periodic_airbox_validation.py --summarize-sweep ...` and is written at `.fullmag/reports/fem-demag-periodic-airbox-validation-sweep.csv`.
  - [x] Native runtime now emits scalar-potential `demag_phi` Zarr snapshots with `component_order=["scalar"]`; the fresh managed 3x3 producer writes `phi_pair_status=emitted_by_runtime` and `phi_pair_max_abs=0.0`.
  - [x] Periodic-airbox producer now uses the same thin-film magnetic mesh policy expected for the antidot/FMR examples: `hmin=3 nm`, magnetic `hmax=8 nm`, interface `hmax=5 nm`, edge/corner `hmax=4 nm`, two through-thickness layers, and repeated hole-refinement regions instead of one unsupported region union. Unit coverage lives in `tests/fem_demag_validation/test_acceptance.py::test_periodic_airbox_mesh_policy_uses_thin_film_and_repeated_hole_refinement`.
  - [x] Runtime producer CSV now carries energy-diagnostic columns: `runtime_total_e_demag_J`, `runtime_total_to_field_scope_ratio`, `magnetic_volume_m3`, `magnetic_element_count`, `magnetic_node_count`, and `energy_scope`, so future artifacts show whether a row is all-magnet energy or a central-cell extraction.
  - [x] Supercell reference now uses lateral PBC on the outer supercell faces instead of a finite-array lateral open boundary. The managed 3x3 producer writes `.fullmag/reports/fem-demag-periodic-airbox-validation-supercell-pbc/periodic_airbox_validation.csv` and passes: primitive `e_demag_J=1.8678852700529174e-19`, supercell central-cell `e_demag_J=1.8633818564459878e-19`, relative error `2.4167958871934916e-3` against the `2.0e-2` tolerance, `h_demag_pair_max_abs_Apm=0.0`, `phi_pair_max_abs=0.0`, `robin_periodic_seam_face_count=0`, primitive CG telemetry `38` iterations / `8.035072644447357e-18` residual, and supercell CG telemetry `65` iterations / `3.735510701495055e-17` residual.
- [x] Add field continuity checks:

```text
max_pair |H_demag(dst) - H_demag(src)| < tolerance
max_pair |phi(dst) - phi(src)| < tolerance
```

- [x] Run authoritative gates through the repo recipes, not hand-written host builds:

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

- [x] Add IR/Python API/planner contract for `magnetostatic_bc = periodic_airbox_k0` and reject it unless `spin_wave_bc=periodic` and `k=0`. This is a semantic gate only; the coupled frequency-domain demag solver remains in the next unchecked P3 tasks.
- [x] Add separate plan-level periodic constraint sets for:

```text
delta_m: magnetic-domain periodic pairs
delta_phi: full magnetostatic-domain-with-air lateral pairs
```

  The contract is now represented in `FemFrequencyResponsePlanIR.periodic_constraint_sets` for `magnetostatic_bc=periodic_airbox_k0`; native coupled-solver consumption remains in the next P3 tasks.

- [ ] Extend production CPU frequency response from magnetic-only block to coupled block:

```text
[A_mm(omega)  A_mphi] [delta_m]   [drive_m]
[A_phim       A_phiphi] [delta_phi] = [drive_phi]
```

  Progress: native driven-response request and C ABI now carry an explicit `periodic_airbox_k0` dynamic-demag request with magnetic/magnetostatic periodic constraint counts, and return structured `unavailable` diagnostics instead of falling through to the magnetic-only block. The actual coupled block assembly/solve remains unchecked.
  Progress: the frequency-domain C ABI and Rust native wrapper now also carry
  the intended coupled-vector layout for `periodic_airbox_k0`:
  `delta_m_tangent_dof_count`, `delta_phi_dof_count`, and the derived
  coupled complex DOF count. Native unavailable artifacts report these values,
  so the next implementation can assemble against an explicit `[delta_m,
  delta_phi]` layout rather than inferring it from status text.
  Progress: the Rust runner no longer rejects the qualified `k=0` `periodic_airbox_k0`
  slice as a generic shared-domain airbox before native dispatch. In builds
  without the native FEM frequency-domain solver, the same request now fails
  explicitly instead of using the dense validation fallback.
  Progress: native C++ now has an explicit `periodic_airbox_coupled_block_problem`
  hook for a supplied dense coupled operator over `[delta_m, delta_phi]`. The
  production CPU lane solves this block, returns `ok`, and writes solved
  manifest/diagnostics/frequency-point metadata with
  `demag_contribution.status="solved"` and `delta_phi_complex`. This is a real
  coupled-block solve for supplied operators, but it is not yet the MFEM
  assembly of `A_mphi/A_phim/A_phiphi`.
  Progress: the same explicit coupled-block payload was initially exposed
  through the C ABI in ABI v3 and remains available in the current
  `FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION=7` Rust FFI/native wrapper. A C ABI
  contract verifies a supplied `[delta_m, delta_phi]` dense operator reaches the
  native solver and writes solved periodic-airbox demag frequency-point
  metadata. The production runner still passes `None` here until the real MFEM
  assembly produces this operator.
  Progress: the native solver now rejects `periodic_airbox_k0` dynamic demag
  before entering even the explicit coupled-block hook when either the magnetic
  `delta_m` periodic constraint set or the magnetostatic `delta_phi` periodic
  constraint set is missing. A native contract requires machine-readable
  `periodic_airbox_missing_periodic_constraint_sets` diagnostics and proves the
  explicit test hook cannot bypass the real P3 constraint-family contract.
  Progress: the same missing-constraint-set validation path now writes partial
  artifacts when requested: `frequency_domain/manifest.v1.json`,
  `response/diagnostics/solver.v1.json`, and `response/progress.v1.json` carry
  `status="validation_error"`, requested/resolved magnetic and magnetostatic
  BCs, and the failing constraint-set counts. This makes missing `delta_m` or
  `delta_phi` pair metadata inspectable from artifacts instead of only from the
  transient result JSON.
  Progress: native dispatch now also rejects `periodic_airbox_k0` dynamic demag
  when the request carries periodic constraint sets but no `delta_phi` scalar
  potential DOFs. The validation error is machine-readable as
  `periodic_airbox_missing_delta_phi_dofs`, writes the same partial artifact
  set when requested, and prevents a magnetic-only explicit block from being
  mistaken for the coupled `[delta_m, delta_phi]` solve.
  Progress: the explicit coupled-block hook now also rejects a supplied dense
  block whose `delta_m`/`delta_phi` layout does not match the request-level
  periodic-airbox layout before solving. The validation error is
  `periodic_airbox_coupled_block_layout_mismatch`, writes the standard partial
  validation artifacts, and keeps the explicit hook aligned with the future
  MFEM `[delta_m, delta_phi]` assembler contract.
  Progress: the same explicit hook now rejects a request whose magnetic
  operator tangent DOF count does not match the request-level `delta_m`
  tangent DOF count. The validation error is
  `periodic_airbox_delta_m_tangent_dof_mismatch`, writes the standard partial
  validation artifacts, and prevents a future assembler from mixing a magnetic
  tangent layout with a different coupled-block `delta_m` layout.
  Progress: explicit coupled-block solved artifacts and diagnostics now carry
  `dynamic_demag_operator_source="explicit_coupled_block_payload"` /
  `operator_source="explicit_coupled_block_payload"` and keep
  `dynamic_demag_k_available=false` while `mfem_coupled_block_assembly=false`.
  This prevents the supplied dense test hook from being promoted as a real MFEM
  dynamic-demag-k assembly.
  Progress: the native coupled-block hook now also accepts a matrix-free
  provider for the entire `[delta_m, delta_phi]` vector via internal
  `apply_stiffness` / `apply_mass` callbacks. The production CPU GMRES path
  solves that coupled vector, writes `delta_phi_complex` artifacts, and records
  `dynamic_demag_operator_source="matrix_free_coupled_block_provider"`. This is
  the solver/assembler seam required by a future MFEM periodic-airbox dynamic
  demag assembler; `mfem_coupled_block_assembly` remains `false`.
  Progress: the matrix-free coupled-block provider seam is now exposed through
  the public C ABI and Rust FFI as
  `periodic_airbox_coupled_block_apply_stiffness`,
  `periodic_airbox_coupled_block_apply_mass`, and
  `periodic_airbox_coupled_block_operator_user_data` since ABI v5 and remains
  available in ABI v7. A C ABI contract verifies the callbacks are invoked,
  solve the coupled vector, and preserve
  `dynamic_demag_operator_source="matrix_free_coupled_block_provider"`. This
  only exposes the provider boundary; it still does not assemble the
  periodic-airbox MFEM `[delta_m, delta_phi]` operator.
  Progress: ABI v6 introduced, and the current ABI v7 still carries,
  `periodic_airbox_magnetostatic_periodic_node_pairs` /
  `periodic_airbox_magnetostatic_periodic_node_pair_count` through the public C
  ABI, Rust FFI/native wrapper, and runner payload. The runner builds these
  pairs from the `MagnetostaticPotentialDynamic/MagnetostaticDomainWithAir`
  constraint set, native diagnostics/artifacts report
  `magnetostatic_periodic_node_pair_count`, and the solver rejects
  `periodic_airbox_k0` before even the explicit or matrix-free coupled-block
  hooks when the magnetostatic `delta_phi` periodic node pairs are missing.
  This closes the topological plumbing for `delta_phi` PBC; it is still not the
  MFEM assembly of `A_mphi/A_phim/A_phiphi`.
  Progress: after the ABI v6 bump, `just verify-fem-frequency-domain-native-contract`
  rebuilt the managed FEM runtime bundle and passed the native contract suite
  (`fem_frequency_domain_contract`, operator/modal/driven response, window,
  deduplication, and contour interval contracts). A transient earlier rebuild
  was interrupted by SIGTERM after container-side export and left the launcher
  missing; the clean rerun regenerated the managed runtime bundle and passed.
  Progress: the managed FEM runtime bundle was refreshed after the ABI v6
  change. The `fullmag-fem-sys` frequency-domain layout tests pass against the
  rebuilt native library, so the exported runtime is no longer stale relative
  to the Rust bindings.
  Progress: the internal native modal/frequency-domain request ABI constant was
  also advanced through `6` and now `7`, matching the public C ABI. The full
  `just verify-fem-frequency-domain-native-contract` gate caught the mismatch
  through `fem_modal_eigen_contract` after the public ABI bump.

- [ ] Reuse the static Poisson PBC operator only where valid. Do not pretend the static operator is enough for dynamic `delta_phi` unless the linearized equation and RHS are explicitly assembled and tested.
  Progress: the lower-level MFEM linearized frequency-domain operator now
  rejects any enabled demag term with `unavailable` and the explicit message
  `MFEM linearized demag assembly is not implemented`. This prevents the
  existing exchange/Zeeman/anisotropy/DMI operator from silently ignoring demag
  if a caller bypasses the higher-level periodic-airbox gate.
  Progress: the same linearized operator now also has a tested explicit
  `demag_tangent` input. When a caller supplies a demag tangent field, it is
  summed into the effective-field tangent before precession/mass assembly and
  reported via `max_abs_demag_field`. This is only the operator hook for a
  future dynamic-demag provider; it does not claim that the MFEM periodic
  Poisson RHS/operator or the coupled `delta_phi` block has been assembled.
  Progress: the production CPU matrix-free driven-response path can now accept
  an explicit row-major demag tangent matrix in its MFEM validation/problem
  payload. The adapter applies this matrix to the current `delta_m` tangent
  vector and passes the resulting `demag_tangent` field into the linearized
  LLG operator. This is the first matrix-free dynamic-demag operator hook; the
  source of that matrix is still explicit test payload data, not yet the MFEM
  periodic-airbox Poisson assembly.
  Progress: the explicit demag tangent matrix hook is now exposed through the
  public frequency-domain C ABI (`FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION=7`)
  and the Rust FFI/native wrapper as `mfem_demag_tangent_matrix_row_major`.
  A C ABI contract verifies a supplied matrix reaches the production CPU
  matrix-free MFEM response path and solves without falling back to dense
  validation. The default production runner still passes `None` until a real
  MFEM periodic-airbox demag assembler produces this matrix.
  Progress: the Rust native wrapper now has focused ignored coverage that
  explicitly supplies `NativeDrivenFrequencyResponseMfemOperatorProblem::
  demag_tangent_matrix_row_major` and verifies the native production CPU
  matrix-free response path returns `ok` with `validation_fallback_used=false`.
  Progress: the native MFEM production CPU response path now also accepts a
  matrix-free `apply_demag_tangent` provider callback on the internal
  `DrivenFrequencyResponseMfemValidationProblem`, with a native contract
  proving the callback is invoked and the dense validation fallback stays off.
  This is the operator-provider seam needed by a future periodic-airbox Poisson
  assembler; it is not yet the real MFEM assembly of the dynamic demag
  operator.
  Progress: ABI v7 exposes that demag-tangent provider seam publicly as
  `mfem_apply_demag_tangent` plus `mfem_demag_tangent_user_data`, with Rust FFI
  and native-wrapper layout coverage. A C ABI contract now verifies the
  callback is invoked through the public request, solves through the production
  CPU matrix-free MFEM path without dense fallback, and reports
  `demag_tangent_operator_source="matrix_free_demag_tangent_provider"` in
  result diagnostics. This still only exposes the provider boundary; the
  provider is not yet produced by the real MFEM periodic-airbox demag assembly.
  Progress: after the ABI v7 bump, `just verify-fem-frequency-domain-native-contract`
  rebuilt the managed FEM runtime bundle and passed the native
  frequency-domain/operator/modal/driven-response/window/deduplication/contour
  interval contract suite. Focused `fullmag-fem-sys` ABI layout tests and
  `fullmag-runner --features fem-gpu frequency_response` tests also pass
  against the rebuilt native library.
- [ ] Add gauge/nullspace handling only for nullspace cases. Do not add a mean-zero pin to Robin/Dirichlet cases where it is unnecessary.
  Progress: the native explicit `periodic_airbox_coupled_block_problem` path
  now detects the constant `delta_phi` nullspace by checking row/column sums
  over the phi DOFs in the supplied stiffness and mass operators. For that
  nullspace case only, it replaces one phi equation with a mean-zero gauge row
  before the dense driven-response solve. Solver diagnostics,
  `frequency_domain/manifest.v1.json`, and
  `response/frequency_points/frequency_*.json` report
  `phi_nullspace_detected`, `phi_gauge_policy`, and
  `phi_gauge_constraint_applied`. This is still coverage of the explicit dense
  coupled-block hook; real MFEM assembly of `A_mphi/A_phim/A_phiphi` remains
  unchecked.
- [ ] Add response artifact fields for demag contribution:

```text
frequency_domain/manifest.v1.json
response/diagnostics/solver.v1.json
mesh/periodic_pairs.v1.json
response/frequency_points/frequency_*.json
```

  Progress: the explicit `periodic_airbox_k0` unavailable path now writes
  `frequency_domain/manifest.v1.json` and
  `response/diagnostics/solver.v1.json` when partial artifacts are requested.
  These artifacts record `requested_magnetic_bc`, `resolved_magnetic_bc`,
  `requested_magnetostatic_bc`, `resolved_magnetostatic_bc`, and the
  magnetic/magnetostatic periodic constraint-set counts. Frequency-point demag
  artifacts remain unchecked until the coupled block exists.
  Progress: runner artifact writing now emits `mesh/periodic_pairs.v1.json` for
  FEM frequency-response plans with periodic mesh metadata instead of skipping
  that backend class. The artifact now carries top-level `artifact_path`,
  `validation_status`, pair count, paired-node count, and max residual metadata.
  This covers the generic periodic-pair artifact; frequency point demag
  contribution artifacts still require the coupled block.
  Progress: native `periodic_airbox_k0` unavailable runs with partial artifacts
  now also write `response/frequency_points/frequency_*.json` metadata. Each
  point records requested/resolved magnetic and magnetostatic BCs and an
  explicit unavailable `demag_contribution` with
  `periodic_airbox_dynamic_demag_coupled_block_unimplemented`, so the absence of
  `delta_phi` is provenance, not silence. The manifest also links
  `mesh/periodic_pairs.v1.json` and records requested/resolved spin-wave BC
  provenance. Real demag values still require the coupled block.

- [x] Run:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-runtime
```

  Progress: `just verify-fem-frequency-domain-native-contract` passed after a
  managed FEM runtime rebuild and ran the native frequency-domain/operator/modal
  contract suite. `just verify-fem-frequency-domain-runtime` also passed after
  the smoke example was corrected back to the supported magnetic-domain PBC
  no-demag slice. This verifies the current P2/P3 bridge artifacts; it does not
  complete the real `periodic_airbox_k0` coupled dynamic-demag assembly.

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
  Progress: `PeriodicPhasePolicyIR` now has a `BlochPhase` policy carrying
  `phase_convention`, `k_vector_rad_per_m`, and `real_imag_mixing`. The
  frequency-response planner emits a `MagnetizationDynamic/MagneticDomain`
  periodic constraint set with this policy for `spin_wave_bc=floquet` and
  `k_sampling=Single`. This is IR/planner contract progress only; production
  CPU still rejects nonzero-k Floquet before native solve.
- [ ] Support real/imag mixing for `u_dst = exp(-i k dot delta_r) u_src`.
  Progress: the new `BlochPhase` policy explicitly records
  `real_imag_mixing=true` for Floquet frequency-response constraints. The
  reduced operator/application path still does not consume it.
  Progress: the frequency-response runner now has a tested metadata builder
  that converts selected Floquet periodic node pairs into `pair_id`,
  `node_a/node_b`, boundary translation, and `phase_rad=-k dot translation`.
  The native MFEM request payload is wired to carry these pairs and the
  single-k vector. The production solver still rejects nonzero-k Floquet before
  operator assembly, so this is request metadata plumbing, not phase-reduced
  solve support.
- [ ] Validate phase loops at corners:

```text
phase(x then y) == phase(y then x)
```

  Progress: `PeriodicConstraintSetIR` now carries optional
  `phase_loop_diagnostics`; the Floquet frequency-response planner computes a
  checked loop count and maximum canonical phase residual for selected periodic
  pair translations. This is planner diagnostics only; native constraint graph
  and operator consumption remain open.
  Progress: the native frequency-domain wrapper now validates supplied Floquet
  pair metadata before the current unsupported return: every pair with
  translation and `phase_rad` must be consistent with `phase_rad=-k dot
  translation` modulo `2pi`. Inconsistent request metadata is rejected instead
  of being hidden behind the generic `floquet_bloch_nonzero_k` unavailable
  status. Full corner-loop constraint graph consumption remains open.
  Progress: the native C ABI/driven-response solve boundary now also records
  `unsupported_reason="floquet_bloch_nonzero_k"` in both diagnostics and result
  JSON when nonzero-k Floquet metadata reaches the current unsupported solve
  path. This improves provenance for the gate; it is not phase-reduced
  nonzero-k operator support.

- [ ] Apply phase constraints to drive vectors and tangent frames. Reject non-Floquet-periodic excitation.
  Progress: the planner now gives a specific rejection for nonzero-k Floquet
  driven response with the current `FrequencyExcitationIR` field drive: the
  model is uniform/global-phase only and is not yet a Floquet-periodic
  excitation. This prevents that missing drive/tangent-frame phase treatment
  from being hidden behind the generic nonzero-k unsupported message; applying
  phase constraints to the actual drive vector and tangent frames remains open.
  Progress: the native C ABI/driven-response solve boundary now validates
  actual MFEM tangent frames and complex tangent drive for nonzero-k Floquet
  pairs before the current unsupported solve path. It checks
  `u_dst = exp(i phase_rad) u_src` for the drive components and requires
  matching equilibrium tangent frames on paired nodes. Mismatches return
  structured validation diagnostics
  `floquet_drive_phase_mismatch` or `floquet_tangent_frame_mismatch` instead of
  `unsupported_reason="floquet_bloch_nonzero_k"`. This is a boundary
  validation step; phase-aware operator assembly/reduction remains open.
  Progress: the nonzero-k Floquet drive-validation error path now writes the
  standard partial artifact set when requested:
  `frequency_domain/manifest.v1.json`,
  `response/diagnostics/solver.v1.json`, and
  `response/progress.v1.json`. A C ABI contract verifies the manifest/progress
  point to a validation error, preserve
  `validation_error="floquet_drive_phase_mismatch"`, do not write a response
  sweep, and do not report
  `unsupported_reason="floquet_bloch_nonzero_k"`. This improves artifact
  provenance for rejected Floquet inputs; it still does not implement the
  phase-aware production operator.
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
  Progress: the frequency-response planner now normalizes gamma Floquet
  (`spin_wave_bc=floquet`, `k_sampling=Single([0,0,0])` or implicit gamma) to
  the existing zero-phase `Periodic` plan, preserving the selected pair ids and
  emitting zero-phase magnetic periodic constraints. This covers the planning
  alias needed for the acceptance item; numerical spectrum equivalence still
  needs the production/runtime acceptance gate.
  Progress: the runner-side production CPU gate and native payload builder now
  apply the same gamma-Floquet alias for direct `FemFrequencyResponsePlanIR`
  inputs: `k=0` Floquet uses static-periodic node pairs and does not send
  Floquet k-vector/pair metadata to the native unsupported path. Nonzero-k
  Floquet remains gated.
  Progress: the native C ABI/driven-response boundary now also treats gamma
  Floquet metadata (`has_floquet_k_vector=true`, `k=[0,0,0]`, zero phase pairs)
  as zero-phase periodic metadata instead of reporting
  `Floquet/Bloch nonzero-k`. Nonzero-k vectors or nonzero pair phases still
  hit the explicit `floquet_bloch_nonzero_k` unavailable path. The full native
  contract gate passes after this change.
  Progress: frequency-domain availability now follows the same rule in native
  C++/C ABI and the Rust native-FEM wrapper: gamma-Floquet k-vector metadata is
  allowed to report the existing static-periodic driven-response capability,
  while nonzero or nonfinite k-vectors still return the explicit
  `floquet_bloch_nonzero_k` unavailable reason. This is availability/aliasing
  only; it does not implement the nonzero-k phase-reduced operator.

### P5: Floquet dynamic demag with airbox

**Cel:** pelny Bloch/Floquet magnetostatic response: `delta_m` and `delta_phi` maja te sama faze Blocha na lateralnych scianach.

**Files:**
- Modify: files from P3 and P4
- Modify: `docs/physics/0800-fem-static-pbc-demag.md` or create a new `docs/physics/08xx-fem-frequency-domain-floquet-demag.md`
- Test: native frequency-domain contract tests
- Test: runtime artifact validators

- [x] Create/update a publication-style physics note before code. Static demag PBC note is not enough for dynamic `delta_phi(k, omega)`.
  Progress: added `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
  as the dynamic frequency-domain magnetostatic contract. It defines the
  coupled `[delta_m, delta_phi]` system, Bloch phase convention for
  `delta_phi`, lateral flux anti-periodicity, gauge policy, GPU unsupported
  policy, required artifacts, and validation gates. This is documentation and
  design contract progress only; it does not implement the coupled operator.
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
  Progress: native driven-response dispatch now rejects
  `production_gpu + periodic_airbox_k0` before entering the explicit CPU
  coupled-block hook, even when a caller supplies
  `periodic_airbox_coupled_block_problem`. A native contract covers this and
  requires `periodic_airbox_dynamic_demag_gpu_unsupported` with no CPU
  coupled-block provenance in the GPU diagnostics and frequency-point
  demag-contribution metadata. This keeps the GPU lane from falsely claiming
  periodic-airbox dynamic-demag support; strict GPU periodic Poisson/libCEED/hypre
  operators remain unchecked.

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
- current mesh contract intentionally remains a magnetic-domain PBC mesh while
  `include_demag=False`; it does not call `study.build_domain_mesh()` and does
  not add shared-domain air elements until the `periodic_airbox_k0` coupled
  demag path is production-ready. It explicitly disables demag for the relax
  stage as well, keeps `5 nm` film hmax, `2.5 nm` hole-edge hmax, and two
  hole-refinement bands, and now relies on magnetic-only CSG meshing to emit
  x/y `periodic_boundary_pairs` and `periodic_node_pairs`.
- the same smoke now sets explicit Gmsh mesh controls (`algorithm_2d=6`,
  `algorithm_3d=1`, `smoothing_steps=4`, `optimize_iterations=3`,
  `size_from_curvature=24`, `narrow_regions=3`) so the periodic antidot mesh
  quality policy is visible in the example contract instead of being implicit
  defaults.

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
