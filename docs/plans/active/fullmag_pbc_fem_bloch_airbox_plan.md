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
- Nonzero-k Floquet structured unsupported path zachowuje teraz ten sam
  artifact/provenance contract, gdy metadane Floquet sa spojne i request
  dochodzi do obecnego `unsupported_reason="floquet_bloch_nonzero_k"`.
  Partial artifacts `frequency_domain/manifest.v1.json`,
  `response/diagnostics/solver.v1.json` i `response/progress.v1.json` maja
  `status="unavailable"`, `completed_frequency_points=0`, nie deklaruja sweep
  artifactu i nie maskuja braku operatora jako validation fallback. Focused
  contract `docker compose --profile fem-gpu run --rm fem-gpu ... fem_frequency_domain_contract`
  oraz managed gate `just verify-fem-frequency-domain-native-contract`
  zakonczyly sie kodem `0`; pierwszy managed run w tym mikroetapie padl na
  rownoleglym eksporcie runtime (`fullmag-fem-gpu-bin: File exists`), a czysty
  rerun bez konkurencyjnego kontenera przeszedl.
- Rust native wrapper nie short-circuituje juz kazdego nonzero-k Floquet przed
  C ABI/native solverem. Dopuszczony waski `production_gpu` no-demag Floquet
  slice z phase-consistent drive i supplied exchange-edge dociera do
  `fullmag_fem_frequency_domain_solve_driven_response`; szersze albo niespojne
  requesty nadal dostaja natywne `validation_error` / `unavailable` i standardowe
  partial artifacts. Dowod Rust RED/GREEN:
  `native_frequency_response_production_gpu_runs_floquet_exchange_no_demag`
  najpierw padl na pre-native `unsupported_reason="floquet_bloch_nonzero_k"`,
  po usunieciu nadmiernego short-circuitu focused filter `native_frequency_response`
  zakonczyl sie `12 passed; 0 failed; 3 ignored`. Managed gate
  `just verify-fem-frequency-domain-native-contract` odbudowal runtime po zmianie
  runnera i zakonczyl sie kodem `0`.
- High-level FEM frequency-response planner i runner payload dopuszczaja teraz
  tylko waski `requested_device=gpu`, magnetic-body, no-demag/no-DMI nonzero-k
  Floquet slice z kompletnymi periodic boundary/node pair metadata. Planner
  zachowuje `BlochPhase` constraint set, a runner buduje zespolony tangent drive
  z faza wezla propagowana z `phase_rad=-k dot translation`. CPU, demag, DMI,
  brak pair metadata i non-Floquet nonzero-k pozostaja gated. RED/GREEN:
  focused `fullmag-plan` test najpierw padl na gate
  `Floquet-periodic excitation`, po zmianie przeszedl kodem `0`; focused
  `fullmag-runner` lane-selection test przeszedl kodem `0`. Managed
  `just verify-fem-frequency-domain-native-contract` odbudowal runtime
  (`release` build `6m 39s`, znane 2 warningi `fullmag-cli`) i zakonczyl
  natywna suite kontraktow kodem `0`.
- P4 GPU Floquet/no-demag payload nie jest juz ograniczony do elementowych
  exchange edges z tetrahedrow: `build_exchange_edges(...)` doklada wybrane
  `mesh.periodic_node_pairs` dla `Periodic` i `Floquet`, deduplikuje je z
  lokalnymi krawedziami i przekazuje je do natywnego exchange graph. RED/GREEN:
  focused `fullmag-runner` test najpierw padl na braku krawedzi `0 -> 4` dla
  pary `x_faces` nieobecnej w lokalnych elementach, po implementacji przeszedl
  (`1 passed`). Managed proof: `just verify-fem-frequency-domain-native-contract`
  oraz `just verify-fem-frequency-domain-gpu-floquet-runtime` zakonczyly sie
  kodem `0`; artefakty runtime raportuja `resolved_execution_lane="production_gpu"`,
  `floquet_phase_projection=true`, `floquet_periodic_pair_count=4`,
  `floquet_k_vector_rad_per_m=[1000000,0,0]` i
  `validation_fallback_used=false`. To nadal jest phase-projected no-demag
  slice, nie pelny Bloch-reduced operator i nie dynamic demag-k.
- Managed FEM runtime bundle odtwarza teraz unversioned linker symlinks
  `libfullmag_fem.so` i `libfullmag_fdm.so` po eksporcie natywnych bibliotek.
  Bez tego host-side focused Rust tests z `FULLMAG_FEM_LIB_DIR`/managed runtime
  nie mogly linkowac `-lfullmag_fem`, mimo ze bundle zawieral
  `libfullmag_fem.so.0`. Dowod: focused RED na
  `test_export_script_recreates_unversioned_fullmag_native_library_links`,
  potem `python3 -m pytest scripts/test_export_fem_gpu_runtime_copy_helpers.py -q`
  (`7 passed`) i swiezy `just ensure-managed-fem-runtime`.
- Rust runner tests zostaly zsynchronizowane z `Floquet(k=0) == Periodic`:
  gamma-Floquet payload test uzywa kompletnego minimalnego payloadu bez
  przypadkowego wymagania exchange elements, a nonzero-k Floquet test nadal
  wymaga planning rejection.
- Native wrapper tests zostaly zsynchronizowane z nowym podzialem
  odpowiedzialnosci: metadata phase validation zostaje przed FFI, ale
  phase-consistent Floquet requesty ida do C ABI. Niespojny drive jest teraz
  sprawdzany jako natywne `floquet_drive_phase_mismatch`, a dopuszczony GPU
  no-demag supplied exchange-edge smoke zwraca `status=ok`.
- Static-periodic runtime artifact contract zostal domkniety dla CPU
  frequency response: plan-level `mesh/periodic_pairs.v1.json` nie nadpisuje
  juz natywnego artefaktu `native_fem_frequency_domain_static_periodic`.
  Managed gate `just verify-fem-frequency-domain-static-periodic-runtime`
  przeszedl po rebuildzie runtime i verifierze `--require-static-periodic`.
- Forced-GPU `periodic_airbox_k0` unavailable boundary ma teraz ostrzejszy
  kontrakt artefaktow: zapisane native diagnostics, manifest
  `resolved_execution` i manifest diagnostics utrwalaja
  `resolved_execution_lane="unavailable"` obok
  `requested_execution_lane="production_gpu"`, reason
  `periodic_airbox_dynamic_demag_gpu_unsupported` oraz
  `validation_fallback_used=false`. Verifier runtime dostal flage
  `--require-periodic-airbox-gpu-unsupported`, ktora wymaga periodic-airbox
  metadata, `mesh/periodic_pairs.v1.json` oraz per-frequency unavailable
  `demag_contribution` artifacts zamiast akceptowac ogolne unavailable. RED:
  Python verifier najpierw potraktowal nowa flage jako sciezke artefaktow,
  a native contract najpierw padl na `GPU periodic-airbox manifest records
  unavailable resolved lane`. GREEN: `python3 -m pytest
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q` zwrocil
  `100 passed`; `just verify-fem-frequency-domain-native-contract` odbudowal
  managed runtime i zakonczyl pelna native suite kodem `0`.
- High-level planner odrzuca teraz nonzero-k `Floquet` + `include_demag=true`
  jako brakujacy model dynamic demag-k, zanim request trafi w mylacy blad
  shared-domain demag mesh. Komunikat wymaga przyszlego
  `magnetostatic_bc=floquet_airbox` oraz zwalidowanego demag-k operatora; obecny
  IR/runtime nadal ma tylko `open` i `periodic_airbox_k0`, wiec dopuszczony
  waski GPU Floquet slice musi pozostac no-demag. RED/GREEN dowod: focused
  `fullmag-plan` test najpierw padl na starym bledzie shared-domain demag mesh,
  po zmianie `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p
  fullmag-plan fem_frequency_response` zakonczyl sie `4 passed`. Managed proof
  po zmianie plannerowej: `just verify-fem-frequency-domain-native-contract`
  zakonczyl pelna native suite kodem `0`, a
  `just verify-fem-frequency-domain-gpu-floquet-runtime` zakonczyl sie kodem `0`
  z `--require-production-gpu --require-floquet-phase-projection`. To jest
  precyzyjniejszy capability gate, nie implementacja `FloquetAirbox` ani
  dynamicznego demag-k operatora.
- P5 ma teraz pierwszy publiczny `floquet_airbox` contract zamiast samej wzmianki
  w komunikacie bledu. Physics notes `0700-frequency-domain-linearized-llg.md`
  i `0710-periodic-and-floquet-boundary-conditions.md` definiuja
  `magnetostatic_bc="floquet_airbox"` jako Bloch/Floquet airbox dla dynamicznego
  `delta_phi`, odrebny od `periodic_airbox_k0`. `ProblemIR` serializuje
  `MagnetostaticBoundaryConditionIR::FloquetAirbox` jako `floquet_airbox`, Python
  DSL przyjmuje te wartosc w `FrequencyResponse`, a planner rozroznia dwa
  przypadki: brak `floquet_airbox` przy nonzero-k Floquet demag jest
  niekompletnym requestem, natomiast jawne `floquet_airbox` failuje jako brak
  produkcyjnego demag-k operatora. RED/GREEN dowod:
  `fullmag-ir` test najpierw nie kompilowal sie z brakiem wariantu,
  Python `test_api.py -k floquet_airbox` najpierw odrzucal value przez allow-list,
  a focused `fullmag-plan fem_frequency_response` najpierw nie kompilowal przez
  brak enum. Po implementacji: `CARGO_TARGET_DIR=/tmp/fullmag-codex-target
  cargo test -p fullmag-ir
  magnetostatic_bc_floquet_airbox_round_trips_as_snake_case_json`,
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_api.py -q -k floquet_airbox` oraz
  `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-plan
  fem_frequency_response` przeszly. To nadal nie dodaje runtime/native demag-k
  operatora ani GPU periodic Poisson/libCEED path.
- P3 solved coupled-block artifact writer zapisuje teraz deklarowany przez
  manifest `mesh/periodic_pairs.v1.json` dla `periodic_airbox_k0` explicit /
  matrix-free coupled block. Wczesniej manifest linkowal ten plik i budowal
  JSON, ale writer nie tworzyl katalogu `mesh` ani nie zapisywal artefaktu.
  RED/GREEN dowod: jednorazowy container-backed native check najpierw zakonczyl
  sie `missing mesh/periodic_pairs.v1.json for solved coupled block` z kodem
  `2`, po poprawce ten sam przypadek przeszedl z kodem `0`. Target
  `fem_frequency_domain_contract` przechodzi po odblokowaniu niezaleznych
  kontraktow waskiego Floquet no-demag phase-projection smoke.
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
- CPU/GPU parity dla kwalifikowanego `k=0` static-periodic no-demag smoke ma
  teraz osobny artifact-backed gate:
  `just verify-fem-frequency-domain-gpu-static-periodic-parity-runtime`.
  Target uruchamia swiezy CPU static-periodic runtime, swiezy GPU
  static-periodic runtime, a nastepnie porownuje GPU artifacts wzgledem CPU
  reference przez `scripts/verify_fem_frequency_domain_runtime_artifacts.py
  --require-production-gpu --require-static-periodic --compare-reference`.
  Verifier sprawdza m.in. lane CPU/GPU, brak validation fallbacku,
  `static_periodic_node_pair_count` oraz per-frequency response fields i
  observables. Gate zakonczyl sie kodem `0`; to waliduje waski `x_faces`
  static-periodic magnetic slice, nie pelny antidot lattice ani demag.
- Biezacy managed native contract zostal domkniety dla waskiego CPU/GPU
  Floquet projection slice bez demag. Sciezki production CPU i production GPU
  definiuja `floquet_phase_projection` tylko dla requestu zaakceptowanego przez
  `can_solve_floquet_projected_no_demag_response`, a solver blokowy dostaje
  `project_floquet_phase_block`; pelne nonzero-k z DMI, dynamic demag,
  periodic Poisson albo magnetostatycznymi constraintami nadal trafia w jawny
  gate.
  `just verify-fem-frequency-domain-native-contract` wykryl nowszy
  `backends/fem/src/frequency_domain/driven_response_solver.cpp`, odbudowal
  `.fullmag/runtimes/fem-gpu-host`, najpierw czekal na rownolegly Cargo build
  lock z innego eksportu runtime, potem zakonczyl release build po `13m 00s`,
  wyeksportowal runtime i uruchomil pelna natywna suite z targetu:
  `fem_frequency_domain_contract`, `fem_operator_contract`,
  `fem_modal_eigen_contract`, `fem_driven_response_contract`,
  `fem_window_partition_contract`, `fem_mode_deduplication_contract` i
  `fem_contour_interval_solver_contract`. Target zakonczyl sie kodem `0`.
- CPU/GPU Floquet projection smoke obejmuje teraz takze dostarczony
  exchange-edge tangent operator bez demag. RED kontrakt
  `production_gpu_floquet_exchange_no_demag_runs_phase_constrained_response_problem`
  najpierw padl na `GPU Floquet exchange no-demag solve succeeds`, po
  odblokowaniu helpera `can_solve_floquet_projected_no_demag_response` focused
  `fem_frequency_domain_contract` zakonczyl sie kodem `0`, a managed
  `just verify-fem-frequency-domain-native-contract` zakonczyl sie kodem `0`.
  Nastepny RED/GREEN dodal analogiczny CPU contract
  `production_cpu_floquet_exchange_no_demag_runs_phase_constrained_response_problem`:
  najpierw padl na `CPU Floquet exchange no-demag solve succeeds`, po
  generalizacji `exchange_edge_slice` z GPU-only na CPU/GPU focused
  `fem_frequency_domain_contract` i managed
  `just verify-fem-frequency-domain-native-contract` zakonczyly sie kodem `0`.
  To potwierdza tylko phase-projected no-demag local plus supplied exchange-edge
  smoke; nie implementuje pelnego periodic exchange graph, periodic Poisson ani
  dynamic demag.
- P3 periodic-airbox dynamic-demag boundary waliduje teraz zdegenerowane
  magnetostatyczne pary okresowe `delta_phi`: publiczny C ABI odrzuca
  `node_a == node_b` jako
  `periodic_airbox_degenerate_magnetostatic_periodic_node_pair` przed
  explicit/matrix-free coupled-block hookiem, zapisujac standardowe partial
  validation artifacts. RED focused contract najpierw padl na
  `C ABI periodic-airbox rejects degenerate magnetostatic periodic pair`, po
  dodaniu natywnej walidacji focused `fem_frequency_domain_contract` przeszedl
  kodem `0`, a managed `just verify-fem-frequency-domain-native-contract`
  odbudowal runtime po oczekiwaniu na rownolegly Cargo lock, zakonczyl release
  build po `11m 50s` i uruchomil pelna natywna suite z kodem `0`. To domyka
  kolejny topologiczny warunek mesh/constraint-family, ale nadal nie jest
  realnym MFEM assembly `[delta_m, delta_phi]`.
- P3 coupled-block provider boundary nie wybiera juz po cichu operatora, gdy
  request podaje jednoczesnie dense coupled block i matrix-free callbacks.
  Publiczny C ABI zwraca teraz
  `periodic_airbox_ambiguous_coupled_block_operator_provider`, nie wywoluje
  callbackow i zapisuje standardowe partial validation artifacts. RED focused
  contract najpierw padl na
  `C ABI rejects ambiguous coupled-block operator provider`, po dodaniu
  walidacji focused `fem_frequency_domain_contract` przeszedl kodem `0`, a
  managed `just verify-fem-frequency-domain-native-contract` odbudowal runtime
  i uruchomil pelna natywna suite z kodem `0`. To uszczelnia seam dla przyszlego
  MFEM assemblera, ale nadal nie montuje realnego operatora dynamic-demag.
- Floquet no-demag projection manifest provenance zostal uzupelniony: manifest
  MFEM frequency-response dla waskiego CPU/GPU Floquet projection slice zapisuje
  teraz `spin_wave_bc={"kind":"floquet"}`, `periodic_or_floquet=true` oraz
  `floquet_phase_projection=true`, zamiast wygladac jak `open` mimo
  Floquet-projector diagnostics. Clean focused native contract najpierw doszedl
  do porazki `GPU Floquet exchange no-demag manifest records phase projection
  diagnostics`, po poprawce provenance przeszedl dalej. Nastepnie high-level
  managed runtime target
  `just verify-fem-frequency-domain-gpu-floquet-runtime` uruchomil
  `examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py` przez
  `.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu` i zweryfikowal
  `--require-production-gpu --require-floquet-phase-projection` dla
  `frequency_domain/manifest.v1.json`,
  `response/diagnostics/solver.v1.json`, `response/progress.v1.json`, sweepow,
  frequency point i field payloadu. To jest high-level proof dla waskiego GPU
  Floquet no-demag projection slice, nie promocja dynamic demag ani pelnego
  periodic exchange graph.
- P3 matrix-free periodic-airbox coupled-block provider nie raportuje juz
  `phi_gauge_policy="not_required"`. Artefakty/diagnostyki solved
  matrix-free provider path uzywaja teraz
  `phi_gauge_policy="matrix_free_provider_responsibility"` i
  `phi_gauge_constraint_applied=false`, dzieki czemu testowy/provider seam nie
  udaje, ze solver sam rozpoznal brak nullspace. RED focused contract padl na
  `matrix-free coupled block diagnostics delegates phi gauge policy to the
  provider`, po minimalnej zmianie focused `fem_frequency_domain_contract`
  zakonczyl sie kodem `0`. To nadal nie jest realne MFEM assembly
  `[delta_m, delta_phi]`.
- P3 unavailable periodic-airbox dynamic-demag artifacts nie ukrywaja juz
  brakujacego assemblera MFEM. Manifest, solver diagnostics i frequency-point
  metadata zapisuja teraz `periodic_airbox_coupled_block_solver=false`,
  `mfem_coupled_block_assembly=false` oraz
  `dynamic_demag_operator_source="unassembled_mfem_periodic_airbox_coupled_block"`
  / `operator_source="unassembled_mfem_periodic_airbox_coupled_block"`.
  RED focused contract padl na
  `periodic-airbox unavailable manifest records coupled-block solver is
  inactive`; po dopisaniu provenance focused `fem_frequency_domain_contract`
  przeszedl kodem `0`.
- P4 waski Floquet no-demag projection artifact ma teraz pelniejsze metadane
  fazowe: manifest i solver diagnostics zapisuja
  `floquet_periodic_pair_count` oraz `floquet_k_vector_rad_per_m` obok
  `floquet_phase_projection=true`. Ten brak wyszedl w tym samym focused
  contract jako `GPU Floquet exchange no-demag manifest records Floquet pair
  count`; po poprawce focused contract przeszedl kodem `0`.
- High-level GPU Floquet runtime gate zostal zamkniety na tych samych
  metadanych. Poprawka objela tez `scripts/export_fem_gpu_runtime.sh`: export
  wymusza targeted `cargo clean -p fullmag-fem-sys`, bo poprzedni runtime
  bundle mogl miec manifest nowszy od zrodel, ale kopiowac przestarzaly
  `libfullmag_fem.so`. Po rebuildzie
  `just verify-fem-frequency-domain-gpu-floquet-runtime` przeszedl kodem `0`,
  a artefakty high-level smoke zapisaly
  `floquet_periodic_pair_count=4` i
  `floquet_k_vector_rad_per_m=[1000000,0,0]` w manifest diagnostics oraz solver
  diagnostics.
- High-level GPU Floquet no-demag runtime verifier zostal doprecyzowany, zeby
  `--require-floquet-phase-projection` nie moglo zostac uzyte jako dowod dla
  dynamic demag. Verifier wymaga teraz
  `manifest.capabilities.dynamic_demag_k_available=false` dla obecnego
  phase-projection no-demag gate. RED/GREEN: nowy test najpierw przeszedl
  blednie z `dynamic_demag_k_available=true`, po zmianie focused test
  przeszedl, a caly
  `python3 -m pytest scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q`
  zwrocil `101 passed`. Swiezy high-level
  `just verify-fem-frequency-domain-gpu-floquet-runtime` po zmianie verifiera
  przeszedl kodem `0` na realnych artefaktach
  `examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py`. To wzmacnia
  P4/P5 honesty boundary, ale nie dodaje `delta_phi` ani GPU periodic demag.
- P4 exchange-only reciprocal acceptance ma teraz artifact-backed managed
  runtime gate. `examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py`
  przyjmuje `FULLMAG_FMR_FLOQUET_KX_RAD_PER_M`, a nowy
  `just verify-fem-frequency-domain-gpu-floquet-reciprocal-runtime` uruchamia
  ten sam GPU no-demag Floquet smoke dla `k_x=+1e6` i `k_x=-1e6`.
  Verifier `--compare-floquet-reciprocal-reference` wymaga przeciwnego
  k-vectora, exchange-only operator terms bez demag/DMI oraz zgodnosci
  czestotliwosci i amplitud widma w tolerancji. Gate przeszedl kodem `0`;
  swieze artefakty mialy fazy par `-0.04` i `+0.04` oraz identyczne amplitudy
  `[1.5909130656926767e-10, 7.954565328463383e-11]`.
- Managed runtime export mial jeszcze jeden idempotency gap w PETSc/SLEPc
  soname handlingu: rerun
  `just verify-fem-frequency-domain-native-contract` najpierw padl na
  `ln: failed to create symbolic link ... libslepc_real.so: File exists`.
  `scripts/lib/runtime_bundle_copy.sh` ma teraz
  `ensure_runtime_soname_link`, ktory nie tworzy self-symlinka, gdy resolved
  name juz jest `${stem}.so`, i atomowo zastapi stary wpis przy wersjonowanym
  targetcie. RED/GREEN: focused helper testy najpierw padly na brak helpera,
  po zmianie `python3 -m pytest scripts/test_export_fem_gpu_runtime_copy_helpers.py -q`
  zwrocil `5 passed`, a ponowny
  `just verify-fem-frequency-domain-native-contract` wyeksportowal runtime,
  zbudowal i uruchomil natywne kontrakty frequency-domain/operator/modal/
  driven-response/window/deduplication/contour z kodem `0`.
- Managed native proof po tych zmianach przeszedl przez
  `just verify-fem-frequency-domain-native-contract`: gate wykryl nowszy
  `backends/fem/src/frequency_domain/driven_response_solver.cpp`, poczekal na
  rownolegly Cargo/export lock, odbudowal release runtime po `11m 32s`,
  wyeksportowal `.fullmag/runtimes/fem-gpu-host` i uruchomil natywne kontrakty
  frequency-domain/operator/modal/driven-response/window/deduplication/contour
  z kodem `0`.
- P3 `mesh/periodic_pairs.v1.json` dla sciezek
  `periodic_airbox_k0` nie traci juz konkretnych par
  magnetostatycznych `delta_phi`. Zarowno unavailable dynamic-demag artifact,
  jak i solved explicit/matrix-free coupled-block artifact zapisuja teraz
  `pair_family="magnetostatic_delta_phi"`, `unknown_family="delta_phi"`,
  `pair_id="magnetostatic-delta-phi-0000"`,
  `source_marker="delta_phi_node:..."`,
  `destination_marker="delta_phi_node:..."` oraz
  `phase_convention="zero_phase_periodic_airbox_k0"`, obok istniejacych
  licznikow `magnetic_periodic_constraint_set_count`,
  `magnetostatic_periodic_constraint_set_count` i
  `magnetostatic_periodic_node_pair_count`. RED focused contract padl na
  `periodic-airbox unavailable periodic-pair metadata records the delta_phi pair
  family`; po zmianie focused `fem_frequency_domain_contract` przeszedl kodem
  `0`. Managed `just verify-fem-frequency-domain-native-contract` poczekal na
  rownolegly debug build lock, odbudowal release runtime po `6m 09s`,
  wyeksportowal bundle i uruchomil natywne kontrakty
  frequency-domain/operator/modal/driven-response/window/deduplication/contour
  z kodem `0`. To uszczelnia artifact provenance dla topologii `delta_phi`,
  ale nadal nie montuje realnego MFEM `[delta_m, delta_phi]` assemblera.
- P5 `floquet_airbox` unsupported artifact boundary zapisuje teraz osobny
  `mesh/periodic_pairs.v1.json` dla par magnetostatycznych `delta_phi` zamiast
  zostawiac sama manifestowa wzmianke. Artifact ma
  `source="native_fem_frequency_domain_floquet_airbox_unavailable"`,
  `pair_family="magnetostatic_delta_phi"`, `unknown_family="delta_phi"`,
  `phase_convention="exp_minus_i_k_dot_delta_r"` oraz jawne
  `delta_phi_flux_validation_status="not_evaluated"` w periodic-pair file,
  solver diagnostics i manifest diagnostics. RED focused contract najpierw
  padl na braku statusu flux validation i par periodic-pair artifact, po zmianie
  focused `fem_frequency_domain_contract` przeszedl kodem `0`. Managed
  `just verify-fem-frequency-domain-native-contract` poczekal na rownolegly
  export lock, odbudowal release runtime, wyeksportowal bundle i uruchomil
  natywne kontrakty frequency-domain/operator/modal/driven-response/window/
  deduplication/contour z kodem `0`. To jest provenance dla `delta_phi(k)`,
  nie implementacja flux validation ani coupled demag-k solvera.
- P3/P5 forced-GPU `periodic_airbox_k0` runner boundary nie jest juz
  zatrzymywany na ogolnym `dynamic demag is not implemented for production GPU`
  przed natywnym ABI. `production_gpu_frequency_response_rejection_reason`
  ma teraz osobna galaz dla `magnetostatic_bc=periodic_airbox_k0`: wymaga
  shared-domain airbox mesh, `include_demag=true`, Demag realization,
  `delta_m` constraint set w `MagneticDomain`, `delta_phi` constraint set w
  `MagnetostaticDomainWithAir`, oraz nadal odrzuca DMI i nonzero-k dynamic
  demag. Kwalifikowany forced GPU k=0 buduje native payload z
  `requires_periodic_airbox_dynamic_demag=true`, `periodic_airbox_delta_phi`
  DOF i magnetostatic periodic constraint count, dzieki czemu native solver
  moze zapisac `periodic_airbox_dynamic_demag_gpu_unsupported` artifacts bez
  CPU/dense fallbacku. RED/GREEN: container focused Rust test najpierw przeszedl
  przez rejection gate i padl na braku payloadu, po dopelnieniu fixture i
  runner gate zakonczyl sie kodem `0`:
  `docker compose --profile fem-gpu run --rm fem-gpu bash -lc 'cd /workspace &&
  cmake --build native/build --target fullmag_fem &&
  LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-}
  cargo +nightly test -p fullmag-runner --features fem-gpu --no-default-features
  production_gpu_frequency_response_is_narrower_than_cpu_and_never_falls_back
  -- --nocapture'`. Managed proof: po czystym pojedynczym rebuildzie runtime
  `just verify-fem-frequency-domain-native-contract` zakonczyl sie kodem `0`,
  a `just verify-fem-frequency-domain-gpu-floquet-runtime` zakonczyl sie kodem
  `0` z verifierem `--require-production-gpu --require-floquet-phase-projection`.
  To nadal nie implementuje MFEM/CUDA coupled block `[delta_m, delta_phi]`.
- P3 ma teraz pierwszy realny runtime bridge do istniejacego MFEM Poisson/PBC
  demag operatora dla frequency-domain providerow: publiczne native ABI
  `fullmag_fem_backend_apply_demag_tangent_f64` stosuje
  `compute_fresh_demag_field_for_magnetization(...)` bezposrednio do
  `delta_m`, czyli zwraca liniowe `H_demag(delta_m)` bez
  baseline/perturbed finite difference i bez mutowania magnetyzacji backendu.
  Rust `NativeFemBackend` ma
  wrapper `apply_demag_tangent(...)`, a `fullmag-fem-sys` niesie deklaracje
  FFI. RED/GREEN: `fem_demag_poisson_contract` najpierw padl na braku publicznego
  ABI, po implementacji przeszedl kodem `0`; Rust source-contract
  `native_fem_backend_exposes_demag_tangent_provider_bridge` najpierw padl na
  braku wrappera, potem przeszedl kodem `0`. To nie podlacza jeszcze provideru
  do produkcyjnego `PeriodicAirboxK0` response i nie zapisuje `delta_phi`
  coupled-block artifacts. Managed
  `just verify-fem-frequency-domain-native-contract` zakonczyl sie kodem `0`
  po swiezym runtime exportcie i uruchomil natywne kontrakty
  frequency-domain/operator/modal/driven-response/window/deduplication/contour.
- P3 native frequency-domain dispatch nie odrzuca juz kwalifikowanego
  `periodic_airbox_k0` requestu jako unavailable, gdy request dostarcza
  matrix-free MFEM demag-tangent provider. Po walidacji constraint setow,
  `delta_phi` DOF i magnetostatic periodic node pairs solver przechodzi do
  istniejacego `solve_mfem_production_cpu_problem(...)`, wywoluje provider
  `apply_demag_tangent`, zapisuje
  `demag_tangent_operator_source="matrix_free_demag_tangent_provider"` i nie
  uzywa dense validation fallbacku.
  RED/GREEN: nowy contract
  `production_cpu_periodic_airbox_dynamic_demag_solves_mfem_demag_tangent_provider`
  najpierw padl na statusie unavailable, po zmianie dispatchu przeszedl kodem
  `0`. Managed proof: `just verify-fem-frequency-domain-native-contract`
  odbudowal zarzadzany runtime i zakonczyl pelna native suite kodem `0`.
  Rust runner buduje teraz `NativeBackendDemagTangentProvider`, konwertuje
  tangent DOF do `delta_m`, wywoluje
  `NativeFemBackend::apply_demag_tangent(...)`, projektuje `delta_h_demag` z
  powrotem na tangent DOF i przekazuje callback/user-data do natywnego MFEM
  operator payloadu. Ten krok zamyka automatyczne provider plumbing dla CPU
  `PeriodicAirboxK0`; nadal nie jest to pelne MFEM coupled-block assembly
  `[delta_m, delta_phi]` ani GPU periodic demag.
- Artifact verifier ma teraz osobny solved-boundary gate
  `--require-periodic-airbox-cpu-demag-solved`. Wymaga on CPU production lane,
  `periodic_airbox_k0`, braku validation fallbacku,
  `demag_tangent_operator_source="matrix_free_demag_tangent_provider"` oraz
  per-frequency `demag_contribution.status="solved"` z `h_demag_complex`.
  Dla tej provider-based sciezki `delta_phi_complex` pozostaje `null`, bo
  pelny potencjal `delta_phi` nalezy do przyszlego MFEM coupled-block assembly
  `[delta_m, delta_phi]`, a nie do callbacku `apply_demag_tangent`.
  RED/GREEN: focused pytest najpierw traktowal flage jako sciezke katalogu,
  po implementacji `python3 -m pytest
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q` przechodzi
  jako `104 passed`. To przygotowuje managed runtime gate, ale go jeszcze nie
  zastepuje.
- Native solved CPU `PeriodicAirboxK0` provider artifacts sa teraz objete
  managed native contractem. RED najpierw oblal sie na braku
  `requested_magnetostatic_bc="periodic_airbox_k0"` w provider diagnostics;
  po poprawce `just verify-fem-frequency-domain-native-contract` przechodzi.
  Generic MFEM response writer zapisuje teraz `mesh/periodic_pairs.v1.json`,
  periodic-airbox counts, `periodic_airbox_coupled_block_solver=false`,
  `mfem_coupled_block_assembly=false` oraz per-frequency
  `h_demag_complex` wyliczone przez ten sam demag-tangent callback, ktory
  zasila operator.
- High-level GPU Floquet no-demag runtime gate nie akceptuje juz samego
  `floquet_phase_projection=true` bez dowodu exchange graph. Verifier
  `--require-floquet-phase-projection` wymaga teraz
  `operator_terms_included` zawierajacego `exchange`, dodatniego
  `diagnostics.exchange_edge_count` oraz identycznego
  `manifest.diagnostics.exchange_edge_count`. Native GPU success diagnostics,
  `response/diagnostics/solver.v1.json` i `frequency_domain/manifest.v1.json`
  emituja ten licznik. Aktualny managed proof
  `just verify-fem-frequency-domain-gpu-floquet-runtime` przechodzi z
  `operator_terms_included=["exchange","zeeman"]`, `exchange_edge_count=19`,
  `floquet_periodic_pair_count=4`, `floquet_k_vector_rad_per_m=[1000000,0,0]`
  i `validation_fallback_used=false`. To wzmacnia P4 artifact honesty dla
  waskiego no-demag slice; nie implementuje dynamic demag ani pelnego
  Bloch-reduced operatora.
- Managed FEM runtime export odzyskuje teraz host ownership dla `.fullmag`,
  `.fullmag/runtimes` i runtime bundle po kontenerowym eksporcie oraz
  przygotowuje runtime root jako writeable przed wejsciem do kontenera. To
  usuwa powtarzalne blokery `Permission denied`/`install ... No such file`
  podczas odswiezania GPU runtime bundle przed managed gates.
- Managed FEM runtime export jest teraz serializowany hostowym
  `.fullmag/runtimes/fem-gpu-host/.export.lock`. To zamyka kolejny realny
  blocker managed gates: rownolegle eksporty runtime potrafily jednoczesnie
  czyscic i kopiowac `.fullmag/runtimes/fem-gpu-host`, co dawalo
  niedeterministyczne bledy `libfullmag_fem.so.0: File exists` albo
  `fullmag-fem-gpu-bin: File exists`. RED/GREEN: focused test
  `test_export_script_serializes_runtime_bundle_mutation_with_flock` najpierw
  padl na braku `RUNTIME_LOCK`, a potem
  `python3 -m pytest scripts/test_export_fem_gpu_runtime_copy_helpers.py -q`
  przeszedl jako `13 passed`.
- High-level `examples/fem_frequency_response_smoke.py` jest teraz realnym CPU
  `periodic_airbox_k0` smoke dla 200 x 200 x 10 nm Py z centralna dziura
  50 nm, PBC x/y, airboxem 200 x 200 x 90 nm i polem in-plane 10 mT, ale
  aktualny authoritative managed target
  `just verify-fem-frequency-domain-periodic-airbox-runtime` nie jest zamkniety.
  Po naprawie eksportu runtime target dochodzi przez materializacje mesha,
  relaksacje i start stage `flat_frequency_response`, po czym pada w realnym
  solverze:
  `production CPU GMRES frequency response did not converge`. Zmiana w
  `crates/fullmag-runner/src/frequency_response.rs` zaczyna przenosic z native
  diagnostics do komunikatu bledu `total_iteration_count`,
  `max_iterations_for_frequency` i `relative_residual_l2_norm`, zeby kolejny
  managed przebieg nie ukrywal numerycznego stanu solve'a.
  Follow-up 2026-06-29: native production CPU `solve_error` path zapisuje teraz
  failure artifacts (`frequency_domain/manifest.v1.json`,
  `response/diagnostics/solver.v1.json`, `response/progress.v1.json` oraz
  `mesh/periodic_pairs.v1.json` dla periodic-airbox demag tangent provider),
  ze statusem `solve_error`, licznikami GMRES i finalnym residualem. Focused
  container contract
  `docker compose --profile fem-gpu run --rm fem-gpu ... fem_frequency_domain_contract`
  przeszedl kodem `0`, a authoritative
  `just verify-fem-frequency-domain-native-contract` odbudowal managed runtime
  i przeszedl pelna native suite kodem `0`. Authoritative
  `just verify-fem-frequency-domain-periodic-airbox-runtime` doszedl ponownie
  do production CPU GMRES i nadal zakonczyl sie `solve_error`, ale zostawil
  artefakty failure: manifest status `solve_error`,
  `delta_m_tangent_dof_count=1408`, `delta_phi_dof_count=877`,
  `magnetostatic_periodic_node_pair_count=170`, `exchange_edge_count=3510`,
  `total_iteration_count=256`, `max_iterations_for_frequency=256` i
  `relative_residual_l2_norm=4.670686133410145`; progress ma
  `state="solve_error"`, `completed_frequency_points=0` i
  `partial_artifacts_available=true`. To nadal nie jest green dla P3, ale
  kolejne diagnozy solvera moga bazowac na durable artifacts. Dodatkowy
  managed eksperyment z
  `FULLMAG_FMR_RESPONSE_MAX_ITERATIONS=1024` i
  `FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS=64` zakonczyl sie tym samym
  `solve_error`: `total_iteration_count=1024`,
  `max_iterations_for_frequency=1024` oraz
  `relative_residual_l2_norm=6.125011727963814`. To zamyka hipoteze, ze
  produkcyjny gate mozna domknac samym podniesieniem limitu iteracji; kolejny
  krok musi diagnozowac operator, skaling albo preconditioning/blokowy uklad
  dynamicznego demag. Follow-up diagnostyczny 2026-06-29: production CPU GMRES
  diagnostics i artefakty `solver.v1.json` zapisuja teraz
  `initial_relative_residual_l2_norm`,
  `minimum_tracked_relative_residual_l2_norm`,
  `minimum_tracked_relative_residual_iteration` oraz `residual_growth_factor` dla
  failure path. Focused container `fem_frequency_domain_contract` przeszedl
  kodem `0` po zmianie kontraktu JSON. Wczesniejszy
  `just verify-fem-frequency-domain-native-contract` odbudowal managed runtime
  i przeszedl kodem `0` przed przemianowaniem pola
  `minimum_relative_residual_*` na uczciwsze
  `minimum_tracked_relative_residual_*`; ponowny managed rerun po zwolnieniu
  runtime export locka przeszedl kodem `0`. Swiezy
  `just verify-fem-frequency-domain-periodic-airbox-runtime` nadal zakonczyl
  sie `solve_error`, ale artefakty realnego 200 nm periodic-airbox smoke
  pokazaly `initial_relative_residual_l2_norm=1`,
  `minimum_tracked_relative_residual_l2_norm=0.6777270926628076` przy
  `minimum_tracked_relative_residual_iteration=32`, a finalny artifact residual
  `relative_residual_l2_norm=3.13505268488051` i
  `residual_growth_factor=3.13505268488051`. To wskazuje na problem
  restart/stagnation-divergence albo operator/skaling, nie na brak poczatkowego
  spadku residualu. Dodatkowy unrestarted managed eksperyment
  `FULLMAG_FMR_RESPONSE_MAX_ITERATIONS=1024` oraz
  `FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS=1024` tez zakonczyl sie
  `solve_error`: `total_iteration_count=1024`,
  `minimum_tracked_relative_residual_l2_norm=0.0009718548814258522` przy
  `minimum_tracked_relative_residual_iteration=526`, ale finalnie przeliczony
  artifact residual wyniosl `relative_residual_l2_norm=3.179226967026663` i
  `residual_growth_factor=3.179226967026663`. To zamyka hipoteze, ze sam
  unrestarted GMRES wystarczy do green gate; kolejny krok musi rozdzielic
  tracked GMRES residual od recomputed true residual i przetestowac
  liniowosc/projekcje/skaling operatora demag tangent. Follow-up RED/GREEN:
  `ProductionCpuDrivenResponseResult`, direct diagnostics oraz artifacts
  rozdzielaja teraz `last_tracked_relative_residual_l2_norm` od
  `last_recomputed_relative_residual_l2_norm`; focused container
  `fem_frequency_domain_contract` najpierw padl na brak tych pol, a po
  implementacji przeszedl kodem `0`. Authoritative
  `just verify-fem-frequency-domain-native-contract` odbudowal managed runtime
  i przeszedl kodem `0`. Swiezy
  `just verify-fem-frequency-domain-periodic-airbox-runtime` nadal zakonczyl
  sie oczekiwanym `solve_error`, ale `solver.v1.json` pokazal
  `total_iteration_count=256`,
  `minimum_tracked_relative_residual_l2_norm=0.6838546947166029` przy
  iteracji `32`, `last_tracked_relative_residual_l2_norm=1.3952016122688395`,
  `last_recomputed_relative_residual_l2_norm=6.672326482717279` oraz
  `relative_residual_l2_norm=6.672326482717279`. To zawęża nastepny krok:
  sprawdzic liniowosc i projekcje rzeczywistego demag tangent providera oraz
  porownac operator action przed preconditioningiem/blokowym coupled assembly.
  Follow-up 2026-06-29: ABI demag tangent zostal przestawiony z
  `H_demag(m + delta_m) - H_demag(m)` na bezposrednie `H_demag(delta_m)`, zgodnie
  z istniejacym wzorcem `tangent_plane_implicit.cpp`. RED/GREEN:
  `fem_demag_poisson_contract` najpierw padl na finite-difference pattern, po
  zmianie przeszedl kodem `0`; focused
  `fem_frequency_domain_contract` takze przeszedl kodem `0`. Swiezy
  authoritative `just verify-fem-frequency-domain-periodic-airbox-runtime`
  odbudowal managed runtime, uruchomil realny 200 nm periodic-airbox smoke i
  nadal zakonczyl sie `solve_error`: `total_iteration_count=256`,
  `restart_iterations_for_frequency=32`,
  `minimum_tracked_relative_residual_l2_norm=0.7618834169078934` przy iteracji
  `32`, `last_tracked_relative_residual_l2_norm=23273.266803143175`,
  `last_recomputed_relative_residual_l2_norm=88943.89144541645` oraz
  `relative_residual_l2_norm=88943.89144541645`. To usuwa jedna z hipotez
  cancellation/state-mutation w ABI, ale zostawia otwarty glowny problem:
  matrix-free provider path nie jest jeszcze zbieznym, kwalifikowanym
  dynamicznym demag solve; nastepny krok powinien isc w true-residual-driven
  operator diagnostics, preconditioning albo realne MFEM coupled assembly
  `[delta_m, delta_phi]`. Follow-up 2026-06-29: production CPU demag tangent
  self-check zostal dodany do native result diagnostics,
  `frequency_domain/manifest.v1.json` i
  `response/diagnostics/solver.v1.json`. RED `fem_frequency_domain_contract`
  najpierw padl na brak `demag_tangent_linearity_check`, po minimalnym GREEN
  focused container contract przeszedl kodem `0`. Authoritative
  `just verify-fem-frequency-domain-native-contract` odbudowal managed runtime
  i przeszedl kodem `0`. Swiezy
  `just verify-fem-frequency-domain-periodic-airbox-runtime` nadal konczy sie
  `solve_error` dla realnego 200 nm periodic-airbox smoke. Persisted
  `solver.v1.json` pokazuje teraz
  `demag_tangent_operator_source="matrix_free_demag_tangent_provider"`,
  `demag_tangent_linearity_check=true`,
  `demag_tangent_additivity_max_abs_error=3.1052053105501933`,
  `demag_tangent_homogeneity_max_abs_error=5.300283877552857`,
  `total_iteration_count=256`,
  `minimum_tracked_relative_residual_l2_norm=0.7397342458308206` przy iteracji
  `32`, `last_tracked_relative_residual_l2_norm=18881.444654926087`,
  `last_recomputed_relative_residual_l2_norm=55545.52683515249` i
  `relative_residual_l2_norm=55545.52683515249`. Manifest diagnostics zapisuje
  te same self-check fields. Bezposredni CLI error line w tym samym gate
  raportowal `relative_residual_l2_norm=106289.97263183116`, wiec nastepny
  krok musi dodatkowo wyjasnic roznice direct result vs persisted artifact oraz
  zdiagnozowac, czy blad self-checka wynika z tolerancji iteracyjnego Poissona,
  projekcji periodic/tangent, skalingu jednostek, czy z faktu, ze provider nie
  jest prawdziwym liniowym Jacobianem dynamic demag.
  Follow-up 2026-06-29: periodic Poisson reduced solve resetuje teraz
  `*x_p = 0.0` przed kazdym swiezym `solver.Mult(*rhs_p, *x_p)`, zeby
  iteracyjny reduced solve nie przenosil starego rozwiazania miedzy kolejnymi
  wywolaniami demag tangent providera. RED/GREEN:
  `fem_demag_poisson_contract` najpierw padl na brak resetu, po zmianie
  przeszedl kodem `0`; focused `fem_frequency_domain_contract` takze przeszedl
  kodem `0`. Authoritative
  `just verify-fem-frequency-domain-periodic-airbox-runtime` odbudowal managed
  runtime i nadal zakonczyl sie `solve_error`, ale najnowszy
  `solver.v1.json` przesuwa blocker z nieliniowego/stateful providera na
  zbieznosc operatora GMRES: `demag_tangent_linearity_check=true`,
  `demag_tangent_additivity_max_abs_error=0.11808458118500198`,
  `demag_tangent_homogeneity_max_abs_error=4.547473508864641e-12`,
  `total_iteration_count=256`,
  `minimum_tracked_relative_residual_l2_norm=0.6188531122788419` przy iteracji
  `256`, `last_tracked_relative_residual_l2_norm=0.6188536265698238`,
  `last_recomputed_relative_residual_l2_norm=0.6188531122788419`,
  `relative_residual_l2_norm=0.6188531122788419` i
  `completed_frequency_point_count=0`. Gate wymaga nadal
  `solver_relative_tolerance=0.001`, wiec P3 nie jest zaakceptowane. Finalny
  follow-up 2026-06-29: podniesienie domyslnego runtime smoke do
  `FULLMAG_FMR_DEMAG_MAX_ITERATIONS=500`,
  `FULLMAG_FMR_RESPONSE_MAX_ITERATIONS=2048` i
  `FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS=2048` zamknelo ten konkretny
  blocker. `examples/fem_frequency_response_smoke.py` ma te same domyslne
  limity, a `just verify-fem-frequency-domain-periodic-airbox-runtime`
  przechodzi teraz kodem `0` bez recznych env override. Finalny
  `solver.v1.json` z default targetu zapisuje `status="ready"`,
  `complete=true`, `completed_frequency_point_count=1`,
  `operator_terms_included=["exchange","zeeman","demag"]`,
  `demag_tangent_linearity_check=true`,
  latest 2026-06-29 rerun recorded
  `demag_tangent_additivity_max_abs_error=0.19835274674439596`,
  `demag_tangent_homogeneity_max_abs_error=3.1832314562052488e-12`,
  `total_iteration_count=1213`, `restart_iterations_for_frequency=2048`,
  `last_recomputed_relative_residual_l2_norm=0.00099781855339497929`
  i `relative_residual_l2_norm=0.00099781855339497929` przy tolerancji `1e-3`.
  To domyka high-level CPU `k=0` periodic-airbox demag runtime smoke dla
  realnego 200 nm antidot case; nadal nie domyka GPU periodic demag,
  nonzero-k Floquet demag ani docelowego MFEM coupled assembly
  `[delta_m, delta_phi]`.
  Follow-up z-padding 2026-06-29: dodano artifact-backed verifier
  `--compare-airbox-reference` i managed target
  `just verify-fem-frequency-domain-periodic-airbox-z-padding-runtime`, ale
  realna kwalifikacja z-padding jest nadal czerwona dla szybkiego mesha.
  Verifier najpierw zaostrzyl tolerancje amplitudy i usunal bledne porownanie
  wektorow zalezych od liczby DOF, a nastepnie dostal jawne invariants
  magnetycznego operatora: `delta_m_tangent_dof_count` i
  `exchange_edge_count` musza byc identyczne w reference i candidate, bo
  inaczej drift odpowiedzi miesza zmiane airboxa z remeshingiem filmu. Pierwszy
  90/90.1 nm run odpadal na `manifest.physics.delta_m_tangent_dof_count`:
  target `1410`, reference `1404`. Po ograniczeniu automatycznego airbox
  grading field do objetosci powietrza przez Gmsh `Restrict` jeden probe mial
  rowne `delta_m_tangent_dof_count=1408` po obu stronach, ale nadal czerwony
  `exchange_edge_count` (`3443` vs `3464`). Swiezy 2026-06-29 rerun po
  poprawce `build_exchange_edges(...)`, ktora ignoruje elementy
  `element_markers == 0` zamiast budowac exchange graph z powietrza
  zlozonego z interfejsowych wezlow magnetycznych, nadal failuje jeszcze
  wczesniej na invariantach mesha: reference `delta_m_tangent_dof_count=1408`,
  `delta_phi_dof_count=876`, `exchange_edge_count=3506`,
  `total_iteration_count=821`; candidate 90.1 nm
  `delta_m_tangent_dof_count=1410`, `delta_phi_dof_count=877`,
  `exchange_edge_count=3458`, `total_iteration_count=602`. Oba solve'y maja
  `status="ready"` i residual ponizej `1e-3`, wiec blokerem nie jest tu
  zbieznosc solvera, tylko nondeterministyczny remesh warstwy magnetycznej
  przy zmianie z-padding airboxa. Probe z `FULLMAG_FMR_MESH_ALGORITHM_3D=10`
  nie byl alternatywnym rozwiazaniem: referencja zatrzymala sie na
  `solve_error` po `2048` iteracjach z residualem
  `0.006712795006982522`. To jest dowod, ze obecny szybki mesh/airbox smoke
  nie jest jeszcze kwalifikacja konwergencji widma FMR.

Aktualizacja 2026-06-29 z biezacej weryfikacji:

- Focused native `fem_frequency_domain_contract` w kontenerze `fem-gpu`
  przeszedl kodem `0`.
- Managed gate `just verify-fem-frequency-domain-native-contract` przeszedl
  kodem `0`.
- Managed runtime gate `just verify-fem-frequency-domain-gpu-floquet-runtime`
  przeszedl kodem `0` dla waskiego GPU Floquet/no-demag slice z
  `--require-production-gpu --require-floquet-phase-projection`.
- Managed reciprocal runtime gate
  `just verify-fem-frequency-domain-gpu-floquet-reciprocal-runtime` przeszedl
  kodem `0`, porownujac artefakty `+k` i `-k`. To wzmacnia P4 GPU Floquet
  no-demag, ale nie promuje P5: `floquet_airbox` dynamic demag-k pozostaje
  bez MFEM-assembled operatora i bez GPU demag-k realizacji.
- P5 RED/GREEN domknal waski C ABI seam dla dostarczonego explicite
  `floquet_airbox` coupled block `[delta_m, delta_phi]` na lane
  `production_cpu`: focused native contract najpierw padl na
  `C ABI Floquet-airbox explicit coupled block reports ok`, a po zmianie
  przeszedl kodem `0`. Solver dopuszcza tylko CPU + supplied coupled-block
  payload, waliduje relacje Blocha
  `delta_phi_dst = exp(i phase_rad) * delta_phi_src`, zapisuje
  `requested_magnetostatic_bc="floquet_airbox"`,
  `delta_phi_phase_validation_status="ok"` i
  `dynamic_demag_operator_source="explicit_floquet_airbox_coupled_block_payload"`
  w diagnostics/manifest/frequency-point artifacts. Managed proof:
  `just verify-fem-frequency-domain-native-contract` przeszedl kodem `0`.
  To nadal nie jest MFEM coupled assembly, GPU Poisson/libCEED/hypre demag-k
  ani produkcyjny GPU Floquet dynamic demag.
- P5 negative RED/GREEN doprecyzowal ten sam seam: supplied
  `floquet_airbox` coupled block, ktory po solve daje `delta_phi` niezgodne z
  faza Blocha, zwraca teraz
  `validation_error="floquet_airbox_delta_phi_phase_mismatch"` zamiast
  generycznego statusu. Diagnostics i manifest zachowuja
  `requested_magnetostatic_bc="floquet_airbox"` oraz zapisuja
  `delta_phi_phase_validation_status="mismatch"` i
  `delta_phi_phase_max_residual`, a focused native contract najpierw padl na
  brak tego validation error/statusu/residualu, po zmianie przeszedl kodem
  `0`. Managed proof: `just verify-fem-frequency-domain-native-contract`
  odbudowal runtime i przeszedl kodem `0`.
- P5 GPU honesty RED/GREEN domknal lane-specific guard dla tego samego
  `floquet_airbox` payloadu: C ABI request z
  `requested_execution_lane=production_gpu` i dostarczonym explicit coupled
  blockiem nie moze uzyc CPU solvera ani raportowac CPU operator source.
  Focused native contract najpierw padl na brak production-GPU komunikatu, po
  zmianie zwraca `unsupported_reason="floquet_airbox_dynamic_demag_gpu_unsupported"`,
  zachowuje `requested_magnetostatic_bc="floquet_airbox"` i
  `validation_fallback_used=false` w artifact diagnostics/manifest. Managed
  proof: `just verify-fem-frequency-domain-native-contract` odbudowal runtime
  i przeszedl kodem `0`. To jest bramka uczciwosci GPU, nie implementacja
  GPU Poisson/libCEED/hypre demag-k.
- P5 managed Floquet-airbox GPU unavailable gate ma teraz kompletny artifact
  contract zamiast niepelnego manifestu. Native writer dla
  `floquet_airbox_dynamic_demag_gpu_unsupported` zapisuje w
  `response/diagnostics/solver.v1.json` i `frequency_domain/manifest.v1.json`
  `requested_execution_lane="production_gpu"`,
  `resolved_execution_lane="unavailable"`,
  `periodic_airbox_coupled_block_solver=false`,
  `mfem_coupled_block_assembly=false`, `delta_m_tangent_dof_count`,
  `delta_phi_dof_count`, `spin_wave_bc={"kind":"floquet"}`,
  `periodic_or_floquet=true` oraz manifest diagnostics z
  `floquet_k_vector_rad_per_m`. RED/GREEN: focused native contract najpierw
  padl na braku `resolved_execution_lane`, a managed
  `just verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime`
  najpierw padl na braku tych pol, potem na braku
  `delta_m_tangent_dof_count`; po poprawce focused native contract,
  focused verifier pytest i managed runtime gate przeszly. Finalne artefakty
  high-level smoke raportuja `unsupported_reason="floquet_airbox_dynamic_demag_gpu_unsupported"`,
  `pair_count=22`, `delta_m_tangent_dof_count=96`,
  `delta_phi_dof_count=100`, `spin_wave_bc.kind="floquet"` i
  `validation_fallback_used=false`. To nadal jest structured unsupported
  boundary, nie GPU Poisson/libCEED/hypre demag-k.
- P3 mesh diagnostics po z-padding root-cause pass publikuja teraz kanoniczna
  `magnetic_submesh_signatures` dla kazdego magnetycznego regionu
  shared-domain mesh: `node_count`, `tetra_count`, `edge_count`, kwantyzacje
  wspolrzednych i digest wspolrzednych/konektywnosci. Pole jest serializowane w
  Python `SharedDomainBuildReport`, skroconym `mesh_provenance` remesh CLI oraz
  Rust `FemSharedDomainBuildReportIR`, wiec nowe Python artifacts nie gubia
  diagnostyki po przejsciu przez IR. Focused RED/GREEN: Python test najpierw
  wykryl brak `mesh_provenance.magnetic_submesh_signatures`, a Rust
  `fullmag-ir` test najpierw nie kompilowal sie przez brak pola w
  `FemSharedDomainBuildReportIR`; po implementacji `PYTHONPATH=packages/fullmag-py/src
  python3 -m pytest packages/fullmag-py/tests/test_meshing.py::FieldStackAcceptanceTests::test_periodic_airbox_z_padding_reports_magnetic_submesh_signature_drift
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_shared_domain_manual_remesh_uses_component_aware_path
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_payload_carries_build_truth_and_mesh_statistics -q`
  zwrocil `3 passed`, a `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test
  -p fullmag-ir shared_domain_build_report_preserves_full_mesh_v2_fields --
  --nocapture` zwrocil `1 passed`.
- Subagent-driven mesh audit potwierdzil, ze obecny shared OCC route nie moze
  gwarantowac stalego magnetic submesh: airbox, magnet i regiony sa
  fragmentowane wspolnie, a jeden globalny `gmsh.model.mesh.generate(3)` ma
  prawo przetetrowac film przy samej zmianie `AIRBOX_SIZE[2]`. Najkrotsza
  realistyczna sciezka naprawy to nowy jawny workflow
  `generated_frozen_magnetic_submesh`: osobny `MeshData + region_markers +
  interface boundary faces + signature` dla zamrozonego filmu, generator
  air/potential mesh obok `_gmsh_airbox.py`, a potem merge do jednego
  `MeshData` z zachowaniem indeksow i elementow magnetycznych albo osobny
  kontrakt IR dla magnetic/potential mesh. To zastępuje dalsze proby strojenia
  algorytmu Gmsh, ktore w probe Delaunay/Frontal/HXT/MMG3D nadal zmienialy
  magnetic signature.
- P3 frozen-magnetic-submesh workflow ma pierwszy jawny Python gate zamiast
  cichego fallbacku do shared-domain OCC/STL. `asset_pipeline.py` waliduje teraz
  `mesh_workflow["domain_mesh_mode"]`, akceptuje tylko
  `generated_shared_domain_mesh`, `explicit_shared_domain_mesh` i
  `generated_frozen_magnetic_submesh`, odrzuca literowki z lista dozwolonych
  wartosci oraz dla `generated_frozen_magnetic_submesh` wymaga
  `frozen_magnetic_submesh_source` przed jakimkolwiek przygotowaniem STL/Gmsh.
  Jesli zrodlo jest podane, tryb konczy sie jeszcze jawnym `NotImplementedError`
  zamiast udawac poprawne wygenerowanie starego mesha. Focused RED/GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_requires_explicit_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_unknown_domain_mesh_mode_is_rejected
  packages/fullmag-py/tests/test_meshing.py::FieldStackAcceptanceTests::test_periodic_airbox_z_padding_reports_magnetic_submesh_signature_drift
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_shared_domain_manual_remesh_uses_component_aware_path
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_payload_carries_build_truth_and_mesh_statistics -q`
  zwrocil `5 passed`. Ten mikroetap nie implementuje jeszcze generatora
  air/potential mesh wokol zamrozonego filmu; zamyka kontrakt wejsciowy dla
  nastepnego test-first kroku.
- P3 frozen-magnetic-submesh source contract ma juz pierwszy loader:
  `frozen_magnetic_submesh_source` jest mapa `mesh_source + region_markers`,
  gdzie `mesh_source` uzywa istniejacego `MeshData.load(...)`, a region markers
  sa walidowane pod katem nazw, dodatnich unikalnych markerow i obecnosci w
  `element_markers` zamrozonego mesha. Loader zwraca payload z
  `interface_boundary_faces` oraz kanonicznym `magnetic_submesh_signatures`,
  wiec przyszly air/potential generator dostanie sprawdzony frozen input zamiast
  ad hoc sciezki. Sama sciezka `generated_frozen_magnetic_submesh` po poprawnym
  wczytaniu zrodla nadal konczy sie jawnym `NotImplementedError`, ale bledne
  zrodla sa wykrywane przed tym generatorem. Focused RED/GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_frozen_magnetic_submesh_source_loads_mesh_markers_and_interface_faces
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_validates_source_before_generator_gap
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_requires_explicit_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_unknown_domain_mesh_mode_is_rejected -q`
  zwrocil `4 passed`.
- Python script-builder przepuszcza teraz
  `mesh_workflow["frozen_magnetic_submesh_source"]` do globalnego mesh configu
  obok `domain_mesh_mode`, `domain_mesh_source` i markerow regionow. RED/GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_script_builder_preserves_frozen_magnetic_submesh_source_in_global_mesh_config -q`
  najpierw padl na `KeyError: 'frozen_magnetic_submesh_source'`, po poprawce
  zwrocil `1 passed`. To przygotowuje odtwarzanie przykladu/skryptu z frozen
  source, ale nie zmienia jeszcze solvera GPU ani native frequency-domain.
- P3 frozen-magnetic-submesh merge ma dzialajacy kontrolowany seam dla
  prebuilt air/potential mesh. Nowy helper scala `FrozenMagneticSubmeshPayload`
  z `air_mesh_source` przez deduplikacje wezlow interfejsu po kwantyzowanych
  wspolrzednych, zachowuje frozen magnetic `nodes` i `elements` jako prefiks
  bez renumeracji, oznacza dopiete air tetrahedra markerem `0` i usuwa magnetic
  interface faces z boundary faces, bo po merge sa wewnetrznym stykiem
  magnetic-air. `generated_frozen_magnetic_submesh` z poprawnym
  `frozen_magnetic_submesh_source.mesh_source` oraz `air_mesh_source` zwraca
  teraz merged `MeshData` i `SharedDomainBuildReport(build_mode=
  "frozen_magnetic_submesh_merge")`; bez `air_mesh_source` nadal zwraca jawny
  generator gap. Focused RED/GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_merge_frozen_magnetic_submesh_with_air_mesh_preserves_magnetic_indices
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_merges_prebuilt_air_mesh
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_frozen_magnetic_submesh_source_loads_mesh_markers_and_interface_faces
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_validates_source_before_generator_gap
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_requires_explicit_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_unknown_domain_mesh_mode_is_rejected
  packages/fullmag-py/tests/test_meshing.py::FieldStackAcceptanceTests::test_periodic_airbox_z_padding_reports_magnetic_submesh_signature_drift
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_shared_domain_manual_remesh_uses_component_aware_path
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_payload_carries_build_truth_and_mesh_statistics
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_script_builder_preserves_frozen_magnetic_submesh_source_in_global_mesh_config -q`
  zwrocil `10 passed`; `python3 -m py_compile ...` i `git diff --check ...`
  byly czyste. Nadal brakuje automatycznego generatora air/potential mesh z
  airboxa i frozen boundary surface; obecny seam przyjmuje prebuilt air mesh,
  dzieki czemu nastepny generator ma juz niezmienny kontrakt merge.
- P3 frozen-magnetic-submesh generator seam jest teraz podlaczony do pipeline:
  gdy `generated_frozen_magnetic_submesh` ma poprawny frozen source, ale nie ma
  `air_mesh_source`, `_realize_fem_domain_mesh_asset_from_components_impl`
  wywoluje `_generate_air_mesh_for_frozen_magnetic_submesh(...)` z pelnym
  kontekstem (`FrozenMagneticSubmeshPayload`, geometrie, FEM hints, airbox,
  mesh_workflow, per-object recipes i object_regions), a nastepnie uzywa tego
  samego merge contractu. Domyslna implementacja generatora nadal zwraca jawny
  `NotImplementedError`, wiec realny Gmsh generator air/potential mesh pozostaje
  nastepnym brakujacym krokiem, ale pipeline nie wymaga juz osobnego
  `air_mesh_source` seamu do integracji. Focused RED/GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_uses_air_mesh_generator_when_no_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_merge_frozen_magnetic_submesh_with_air_mesh_preserves_magnetic_indices
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_merges_prebuilt_air_mesh
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_frozen_magnetic_submesh_source_loads_mesh_markers_and_interface_faces
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_validates_source_before_generator_gap
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_requires_explicit_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_unknown_domain_mesh_mode_is_rejected
  packages/fullmag-py/tests/test_meshing.py::FieldStackAcceptanceTests::test_periodic_airbox_z_padding_reports_magnetic_submesh_signature_drift
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_shared_domain_manual_remesh_uses_component_aware_path
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_payload_carries_build_truth_and_mesh_statistics
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_script_builder_preserves_frozen_magnetic_submesh_source_in_global_mesh_config -q`
  zwrocil `11 passed`; `python3 -m py_compile ...` i `git diff --check ...`
  byly czyste.
- P3 frozen-magnetic-submesh ma pierwszy realny Gmsh air/potential generator:
  `_generate_air_mesh_for_frozen_magnetic_submesh(...)` zapisuje boundary
  zamrozonego magnetic mesh jako jawny ASCII STL, uruchamia istniejaca sciezke
  `generate_mesh_from_file(..., airbox=...)`, filtruje wygenerowane air
  tetrahedra (`element_markers == 0`) i przekazuje je do tego samego merge
  contractu, ktory zachowuje magnetic nodes/elements jako prefiks. RED/GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_generates_air_mesh_from_frozen_boundary
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_uses_air_mesh_generator_when_no_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_merge_frozen_magnetic_submesh_with_air_mesh_preserves_magnetic_indices
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_merges_prebuilt_air_mesh
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_frozen_magnetic_submesh_source_loads_mesh_markers_and_interface_faces
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_validates_source_before_generator_gap
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_requires_explicit_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_unknown_domain_mesh_mode_is_rejected
  packages/fullmag-py/tests/test_meshing.py::FieldStackAcceptanceTests::test_periodic_airbox_z_padding_reports_magnetic_submesh_signature_drift
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_shared_domain_manual_remesh_uses_component_aware_path
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_payload_carries_build_truth_and_mesh_statistics
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_script_builder_preserves_frozen_magnetic_submesh_source_in_global_mesh_config -q`
  zwrocil `12 passed`; `python3 -m py_compile ...` i `git diff --check ...`
  byly czyste. Ten krok usuwa `air_mesh_source` jako wymog dla prostych
  przypadkow i zastępuje generator gap realnym Gmsh path, ale nadal wymaga
  kwalifikacji na docelowym 200 nm antidot/PBC meshu oraz sprawdzenia
  nano-scale stabilnosci i jakosci air mesh przed uznaniem P3 mesh blocker za
  zamkniety.
- P3 frozen-magnetic-submesh source mozna juz wyciac z istniejacego
  shared-domain mesha: `_extract_frozen_magnetic_submesh(...)` wybiera region
  po `geometry_name`, remapuje magnetic nodes/elements do kompaktowego
  `MeshData`, zachowuje magnetic boundary/interface faces oraz publikuje ten
  sam `FrozenMagneticSubmeshPayload` z `magnetic_submesh_signatures`, ktory
  konsumuje generator air mesh. Dodatkowy realny Gmsh smoke buduje baseline
  shared-domain mesh, wycina frozen source, zapisuje go do `.npz`, a nastepnie
  uruchamia `generated_frozen_magnetic_submesh` dla dwoch airbox sizes; oba
  wyniki zachowuja frozen magnetic nodes/elements jako prefiks i identyczny
  magnetic digest. Focused RED/GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_extract_frozen_magnetic_submesh_from_shared_domain_preserves_interface_faces
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_keeps_magnetic_prefix_stable_across_airbox_sizes
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_generates_air_mesh_from_frozen_boundary
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_uses_air_mesh_generator_when_no_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_merge_frozen_magnetic_submesh_with_air_mesh_preserves_magnetic_indices
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_merges_prebuilt_air_mesh
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_frozen_magnetic_submesh_source_loads_mesh_markers_and_interface_faces
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_validates_source_before_generator_gap
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_generated_frozen_magnetic_submesh_mode_requires_explicit_source
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_unknown_domain_mesh_mode_is_rejected
  packages/fullmag-py/tests/test_meshing.py::FieldStackAcceptanceTests::test_periodic_airbox_z_padding_reports_magnetic_submesh_signature_drift
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_shared_domain_manual_remesh_uses_component_aware_path
  packages/fullmag-py/tests/test_meshing.py::MeshScaffoldTests::test_remesh_cli_payload_carries_build_truth_and_mesh_statistics
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_script_builder_preserves_frozen_magnetic_submesh_source_in_global_mesh_config -q`
  zwrocil `14 passed`; `python3 -m py_compile ...` i `git diff --check ...`
  byly czyste. Ten krok byl mala kwalifikacja generatora; pelny 200 nm
  antidot/PBC acceptance zostal domkniety w kolejnym kroku, a integracja
  deklaratywna z przykladem FMR zostala dodana pozniej przez
  `study.frozen_magnetic_submesh(...)`.
- P3 200 nm antidot/PBC frozen workflow ma teraz przechodzacy acceptance test:
  `_extract_frozen_magnetic_submesh(...)` filtruje frozen interface do markeru
  10, wiec periodyczne/outer boundary faces (`102/103/108/109` w aktualnym
  shared meshu) nie sa juz traktowane jako wewnetrzny magnetic-air hole dla
  Gmsha. Generator air mesh dostaje techniczny clearance na osiach, gdzie
  frozen surface dotyka explicit airbox boundary, a potem odrzuca tetra, ktorych
  centroid lezy wewnatrz frozen magnetic submesh; to usuwa poprzedni
  `PLC Error: A segment and a facet intersect at point` dla PBC airboxa o tym
  samym footprint x/y co film. Nowy test
  `FieldStackAcceptanceTests::test_periodic_antidot_frozen_magnetic_submesh_stays_stable_across_airbox_z_padding`
  buduje baseline shared-domain mesh dla warstwy 200 x 200 x 10 nm z otworem
  50 nm, wycina frozen source, uruchamia `generated_frozen_magnetic_submesh`
  dla airbox z=90.0 nm i 90.1 nm oraz potwierdza bajtowo stabilny prefiks
  magnetic nodes/elements, identyczny digest i istniejace air tetrahedra.
  Review fix po tym kroku zastapil centroid-only klasyfikacje air tetra filtrem
  `centroid outside frozen` + `brak wierzcholkow scisle wewnatrz frozen` oraz
  usuwa boundary faces nieincydentne do zachowanych air tetra, zeby nie
  zostawiac stalego boundary po filtrowaniu elementow.
  Focused GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_meshing.py -q -k
  "frozen_magnetic_submesh or periodic_airbox_z_padding or frozen_air_filter or
  filter_boundary_faces"` zwrocil `14 passed, 214 deselected`; dodatkowe
  `pytest ... -k
  "test_remesh_cli_shared_domain_manual_remesh_uses_component_aware_path or
  test_remesh_cli_payload_carries_build_truth_and_mesh_statistics or
  test_script_builder_preserves_frozen_magnetic_submesh_source_in_global_mesh_config"`
  zwrocilo `3 passed, 447 deselected`; `python3 -m py_compile ...` i
  `git diff --check ...` byly czyste. Nadal brakowalo wtedy integracji tego
  frozen workflow z `examples/fem_frequency_response_smoke.py` i runtime proofu
  FMR na tym mesh policy.
- P3 FMR smoke potrafi juz deklaratywnie uzyc frozen magnetic submesh source:
  dodano DSL `fm.frozen_magnetic_submesh(...)` /
  `study.frozen_magnetic_submesh(...)`, propagacje do
  `runtime_metadata.mesh_workflow` jako
  `domain_mesh_mode="generated_frozen_magnetic_submesh"` oraz renderer rewrite,
  ktory nie gubi `frozen_magnetic_submesh_source`. Sam
  `examples/fem_frequency_response_smoke.py` czyta
  `FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE` i opcjonalnie
  `FULLMAG_FMR_FROZEN_MAGNETIC_AIR_MESH_SOURCE`; gdy source jest ustawiony,
  skrypt deklaruje marker `periodic_film: 1` i uruchamia ten sam frozen workflow
  co acceptance test, a gdy source nie jest ustawiony, dotychczasowy
  `generated_shared_domain_mesh` pozostaje kompatybilna sciezka domyslna dla
  istniejacych verifierow. Dodatkowo `FULLMAG_FMR_RESPONSE_*` nadpisuje
  odpowiadajace `FULLMAG_FEM_FREQUENCY_RESPONSE_*` deterministycznie zamiast
  zalezec od poprzednich importow skryptu w tym samym procesie. Focused GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_script_builder_preserves_frozen_magnetic_submesh_source_in_global_mesh_config
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_study_frozen_magnetic_submesh_source_sets_domain_mesh_workflow
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_study_frozen_magnetic_submesh_source_rewrite_preserves_declaration
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_in_plane_10mt_hole_fmr_frequency_response_smoke_example_loads_contract
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_in_plane_10mt_hole_fmr_frequency_response_smoke_example_env_overrides
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_in_plane_10mt_hole_fmr_frequency_response_smoke_example_fast_mesh_preset
  packages/fullmag-py/tests/test_api.py::ProblemApiTests::test_in_plane_10mt_hole_fmr_frequency_response_smoke_example_can_use_frozen_submesh
  -q` zwrocilo `7 passed`; frozen meshing suite nadal zwraca
  `14 passed, 214 deselected`, a `python3 -m py_compile ...` i
  `git diff --check ...` byly czyste. Nadal brakuje runtime proofu FMR na
  realnym frozen source `.npz` oraz docelowego sposobu przygotowania/cache tego
  source w managed verifierze.
- P3 managed frozen-source gate ma teraz przygotowany cache helper i verifier
  contract: `scripts/prepare_fmr_frozen_magnetic_submesh.py` buduje baseline
  200 x 200 x 10 nm periodic antidot shared-domain mesh, wymaga czystego
  `build_mode="conformal_occ"`, wycina frozen magnetic submesh dla
  `periodic_film`, zapisuje `.npz` oraz raport `.report.json`; drugi przebieg
  waliduje cache bez regeneracji. Targety
  `verify-fem-frequency-domain-periodic-airbox-runtime` i
  `verify-fem-frequency-domain-periodic-airbox-z-padding-runtime` uruchamiaja
  helper, przekazuja `FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE` do
  `examples/fem_frequency_response_smoke.py` i wymagaja verifiera
  `--require-frozen-magnetic-submesh`. Verifier akceptuje tylko jawny
  `generated_frozen_magnetic_submesh` w manifest metadata, nie samo
  `shared_domain_mesh_with_air`. Focused GREEN:
  `python3 -m pytest
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py::test_validator_accepts_frozen_magnetic_submesh_boundary
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py::test_validator_rejects_missing_frozen_magnetic_submesh_boundary
  scripts/test_frequency_domain_runtime_targets.py -q` zwrocilo `9 passed`;
  `python3 -m py_compile scripts/prepare_fmr_frozen_magnetic_submesh.py
  scripts/verify_fem_frequency_domain_runtime_artifacts.py
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py
  scripts/test_frequency_domain_runtime_targets.py` przeszedl; lokalny smoke
  `PYTHONPATH=packages/fullmag-py/src FULLMAG_FMR_FAST_RUNTIME_MESH=1
  FULLMAG_FMR_MESH_ALGORITHM_3D=1 python3
  scripts/prepare_fmr_frozen_magnetic_submesh.py --output
  /tmp/fullmag-fmr-frozen-test.npz --force` zapisal realny `.npz`, a drugi
  przebieg zwrocil cache status. Frozen-workflow provenance jest teraz
  przenoszone z `problem_meta.runtime_metadata["mesh_workflow"]` przez
  `FemFrequencyResponsePlanIR.domain_mesh_workflow_mode`, Rust runner i
  `operator_diagnostics_json` do finalnych natywnych artefaktow jako
  `domain_mesh_mode="generated_frozen_magnetic_submesh"`. Focused planner
  proof `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p
  fullmag-plan
  fem_frequency_response_preserves_generated_frozen_domain_mesh_workflow_mode`
  przeszedl; `cargo check -p fullmag-runner --features fem-gpu` przeszedl; a
  `just verify-fem-frequency-domain-native-contract` po rebuildzie managed FEM
  runtime przeszedl kodem `0`.
- P3 frozen-source periodic metadata nie ginie juz po przejsciu przez `.npz`,
  ekstrakcje magnetic submesh i merge z generowanym airboxem:
  `_extract_frozen_magnetic_submesh(...)` remapuje magnetic
  `periodic_node_pairs`, `MeshData.save/load(.npz)` przenosi periodic metadata,
  a `_merge_frozen_magnetic_submesh_with_air_mesh(...)` zachowuje magnetic
  pairs w finalnym mesh prefixie i doklada remapowane air pairs, jesli air mesh
  je ma. RED/GREEN:
  `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_meshing.py::FieldStackAcceptanceTests::test_periodic_antidot_frozen_magnetic_submesh_stays_stable_across_airbox_z_padding
  -q` najpierw padl na `len(baseline_generated.periodic_node_pairs) == 0`,
  po poprawce zwrocil `1 passed`.
- High-level frozen periodic-airbox runtime proof przeszedl:
  `just verify-fem-frequency-domain-periodic-airbox-runtime` zakonczyl sie
  kodem `0` po realnym 200 nm antidot smoke z
  `FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE`. Artefakty raportuja
  `domain_mesh_mode="generated_frozen_magnetic_submesh"`,
  `mesh/periodic_pairs.v1.json` z `pair_count=106`,
  `magnetostatic_periodic_node_pair_count=106`,
  `completed_frequency_point_count=1`, `operator_terms_included` zawierajace
  `exchange`, `zeeman`, `demag`, `relative_residual_l2_norm=0.0009998117633817814`
  przy `solver_relative_tolerance=0.001` oraz
  `validation_fallback_used=false`. Review follow-up dopelnil szybkie testy
  legacy `.npz` i filtrowania air periodic-pairs z odrzuconych elementow.
  Jeden ponowny run z domyslnym limitem `2048` zakonczyl sie
  `solve_error` przy residualu `0.0010401073794505233`, wiec smoke targety
  periodic-airbox dostaly konserwatywniejsze
  `FULLMAG_FMR_RESPONSE_MAX_ITERATIONS=4096` i
  `FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS=4096` bez luzowania tolerancji.
  Swiezy `just verify-fem-frequency-domain-periodic-airbox-runtime` przeszedl
  kodem `0`; finalne diagnostics mialy `pair_count=106`,
  `paired_node_count=212`, `completed_frequency_point_count=1`,
  `total_iteration_count=2145`,
  `relative_residual_l2_norm=0.0009999960955354035`,
  `restart_iterations_for_frequency=4096` i `validation_fallback_used=false`.
  To domyka high-level CPU frozen-source periodic-airbox smoke; nadal zostaja
  koszt/preconditioning, wyjasnienie additivity self-check, docelowy MFEM
  coupled assembly `[delta_m, delta_phi]` i GPU periodic demag.
- P3 ma teraz osobny artifact-backed multi-frequency spectrum gate dla tego
  samego CPU frozen-source `periodic_airbox_k0` antidot workflowu. Verifier
  dostal flagi `--require-min-frequency-points`,
  `--require-response-peak` i
  `--require-field-payloads-for-frequency-points`, a target
  `just verify-fem-frequency-domain-periodic-airbox-spectrum-runtime` uruchamia
  3-punktowy sweep `2.5,2.75,3.0 GHz` i wymaga solved periodic-airbox demag,
  frozen magnetic submesh oraz response field payloadu dla kazdego punktu.
  RED/GREEN: nowe testy verifiera najpierw padly, bo CLI traktowal
  `--require-min-frequency-points` jako katalog artefaktow; po implementacji
  focused `python3 -m pytest
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py
  scripts/test_frequency_domain_runtime_targets.py -q` zwrocil `134 passed`,
  `py_compile` i `git diff --check` przeszly. Managed runtime gate przeszedl
  kodem `0`; artefakty raportuja `completed_frequency_point_count=3`,
  czestotliwosci `2.5/2.75/3.0 GHz`, dodatnie amplitudy
  `5.826681135056757e-09`, `6.9959196266807e-09`,
  `8.839604135484278e-09`, `pair_count=106`,
  `validation_fallback_used=false`,
  `demag_tangent_operator_source="matrix_free_demag_tangent_provider"`,
  `relative_residual_l2_norm=0.00099835482856427` i
  `total_iteration_count=5277`. Pierwsza proba 7-punktowa zostala przerwana
  po zbyt dlugim czasie; pozostaje koszt/preconditioning dla szerszego sweepu.
- Spectrum gate zapisuje teraz bezposredni kandydat modu z driven response:
  `scripts/derive_fem_frequency_response_modes.py` wybiera punkt o maksymalnej
  amplitudzie z `magnetic_response_sweep.v2.json`, wymaga istniejacego field
  payloadu i zapisuje
  `response/derived_modes/fmr_peak_mode.v1.json`. RED/GREEN:
  `python3 -m pytest scripts/test_derive_fem_frequency_response_modes.py -q`
  najpierw padl na braku skryptu, po implementacji przeszedl, a focused
  `python3 -m pytest scripts/test_derive_fem_frequency_response_modes.py
  scripts/test_frequency_domain_runtime_targets.py -q` zwrocil `13 passed`.
  Deriver uruchomiony na realnych artifactach
  `.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts`
  wybral `frequency_index=2`, `frequency_hz=3000000000`,
  `response_amplitude=8.839604135484278e-09` oraz field payload
  `response/field_payloads.zarr/frequency_0002/vector_xyz_complex/0.0.0`.
  To jest driven-response mode candidate do inspekcji, nie modalny eigenmode.
- P3 spectrum gate nie traktuje juz derived peak mode jako luznego pliku
  wygenerowanego po walidacji: runtime verifier ma flage
  `--require-derived-peak-mode`, ktora wymaga
  `response/derived_modes/fmr_peak_mode.v1.json`, sprawdza jego schema/source,
  `mode_label`, `frequency_index`, `frequency_hz`, amplituda odpowiedzi oraz
  linki do selected frequency-point i field payloadu wzgledem maksimum w
  `magnetic_response_sweep.v2.json`. Target
  `just verify-fem-frequency-domain-periodic-airbox-spectrum-runtime` uruchamia
  teraz verifier ponownie po `scripts/derive_fem_frequency_response_modes.py`
  z tym wymogiem. RED/GREEN: focused derived-mode verifier tests najpierw
  padly, bo `--require-derived-peak-mode` byl interpretowany jako katalog
  artifactow, a target nie zawieral flagi; po zmianie
  `python3 -m pytest scripts/test_verify_fem_frequency_domain_runtime_artifacts.py
  -q -k 'derived_peak_mode'` zwrocil `2 passed`, target test zwrocil
  `1 passed`, a szerszy focused suite
  `python3 -m pytest scripts/test_verify_fem_frequency_domain_runtime_artifacts.py
  scripts/test_derive_fem_frequency_response_modes.py
  scripts/test_frequency_domain_runtime_targets.py -q` zwrocil `138 passed`.
  Dodatkowo `py_compile`, `git diff --check` i strict verifier z
  `--require-derived-peak-mode` przeszly na realnych artifactach
  `.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts`.
- Derived FMR peak mode zapisuje teraz takze rekomendacje nastepnego lokalnego
  sweepu w `refinement_recommendation`. Dla peaku wewnatrz okna rekomendacja
  tworzy 5-punktowe zwezone okno wokol maksimum; dla peaku na dolnej/gornej
  krawedzi przesuwa okno poza obecny zakres, zeby uniknac falszywego
  zaakceptowania trendu jako rezonansu. Runtime verifier `--require-derived-peak-mode`
  wymaga tego bloku i sprawdza go wzgledem `magnetic_response_sweep.v2.json`.
  RED/GREEN: `python3 -m pytest
  scripts/test_derive_fem_frequency_response_modes.py -q` najpierw padl na
  braku `refinement_recommendation`, a focused verifier test najpierw
  akceptowal stary plik bez tego bloku. Po zmianie deriver tests zwrocily
  `3 passed`, derived-mode verifier tests zwrocily `3 passed`, a focused suite
  `python3 -m pytest scripts/test_verify_fem_frequency_domain_runtime_artifacts.py
  scripts/test_derive_fem_frequency_response_modes.py
  scripts/test_frequency_domain_runtime_targets.py -q` zwrocil `140 passed`.
  Strict verifier z `--require-derived-peak-mode` przeszedl po regeneracji
  derived mode na realnych artifactach. Aktualny
  `fmr_peak_mode.v1.json` w tym katalogu wskazuje
  `frequency_index=3`, `frequency_hz=2750000000`,
  `response_amplitude=8.170513384760462e-09` i rekomenduje nastepny sweep
  `2.625,2.6875,2.75,2.8125,2.875 GHz`. To nadal jest plan kolejnego
  driven-response sweepu, nie modalny eigenmode ani automatyczne uruchomienie
  drogiego refinamentu.
- Rekomendacja refinamentu ma teraz bezposredni runtime input zamiast recznego
  przepisywania wartosci z JSON: `scripts/fem_frequency_response_refinement_env.py`
  czyta `response/derived_modes/fmr_peak_mode.v1.json` i wypisuje CSV w GHz
  albo `export FULLMAG_FMR_FREQUENCIES_GHZ=...`. Dodany target
  `just fem-frequency-response-refinement-env` wypisuje export dla standardowego
  katalogu `.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts`.
  RED/GREEN: `python3 -m pytest
  scripts/test_fem_frequency_response_refinement_env.py -q` najpierw padl na
  braku skryptu, a statyczny target test najpierw padl na braku targetu. Po
  zmianie focused suite `python3 -m pytest
  scripts/test_fem_frequency_response_refinement_env.py
  scripts/test_frequency_domain_runtime_targets.py
  scripts/test_derive_fem_frequency_response_modes.py
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q` zwrocil
  `144 passed`; `py_compile` i `git diff --check` przeszly. Realny helper
  output dla aktualnych artifactow to
  `export FULLMAG_FMR_FREQUENCIES_GHZ=2.625,2.6875,2.75,2.8125,2.875`.
- Refined spectrum ma teraz osobny standardowy runtime target zamiast
  nadpisywania coarse spectrum artifactow:
  `just verify-fem-frequency-domain-periodic-airbox-refined-spectrum-runtime`.
  Target czyta rekomendowane czestotliwosci z
  `scripts/fem_frequency_response_refinement_env.py`, zapisuje wynik do
  `.fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime`,
  wymaga co najmniej 5 punktow, field payloadow dla punktow, solved
  periodic-airbox demag, frozen magnetic submesh oraz strict
  `--require-derived-peak-mode`. RED/GREEN: statyczny test targetu najpierw
  padl na braku recipe, po dodaniu targetu
  `python3 -m pytest scripts/test_frequency_domain_runtime_targets.py -q -k
  refined_spectrum_runtime_target` zwrocil `1 passed`, focused suite
  `python3 -m pytest scripts/test_fem_frequency_response_refinement_env.py
  scripts/test_frequency_domain_runtime_targets.py
  scripts/test_derive_fem_frequency_response_modes.py
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q` zwrocil
  `145 passed`, `py_compile`, `just --list` i `git diff --check` przeszly.
  Runtime attempt zostal nastepnie uruchomiony:
  `just verify-fem-frequency-domain-periodic-airbox-refined-spectrum-runtime`
  przeszedl `ensure-managed-fem-runtime`, zbudowal frozen magnetic submesh,
  zmaterializowal 5-punktowy frequency-response plan i wszedl w stage
  `flat_frequency_response`, ale po kilku minutach bez `response/progress.v1.json`,
  sweepow ani manifestu zostal recznie przerwany kodem `130`. Na dysku zostaly
  tylko `.npz` frozen source i jego report. To potwierdza, ze target jest
  uruchamialny do solvera, ale realny 5-punktowy refined proof nadal wymaga
  poprawy kosztu/preconditioningu albo czesciowego progress flush przed
  traktowaniem go jako praktyczna bramka codzienna.
- Pierwszy problem diagnostyczny refined runu zostal zawężony i poprawiony po
  stronie runnera: native production frequency-response zapisuje teraz
  poczatkowy `response/progress.v1.json` przed wywolaniem natywnego solvera.
  Artefakt ma `status="running"`, `state="not_started"`,
  `completed_frequency_points=0`, `written_frequency_point_artifacts=0` i
  pelny `total_frequency_points`, wiec dlugi pierwszy punkt nie wyglada juz jak
  brak uruchomienia stage. RED/GREEN: focused Rust test
  `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-runner
  initial_frequency_response_progress_artifact_is_written_before_first_point`
  najpierw nie kompilowal sie z brakiem helpera, po implementacji przeszedl;
  ten sam test z `--features fem-gpu` tez przeszedl. Dodatkowo focused Python
  suite `scripts/test_fem_frequency_response_refinement_env.py
  scripts/test_frequency_domain_runtime_targets.py
  scripts/test_derive_fem_frequency_response_modes.py
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q` zwrocil
  `145 passed`, `py_compile` i `git diff --check` przeszly. To nie rozwiazuje
  jeszcze kosztu/preconditioningu refined sweepu; poprawia observability przed
  pierwszym ukonczonym punktem.
- Refined 5-punktowy proof zostal doprowadzony do kompletnego artifact bundle,
  ale sam `just` run nie moze byc traktowany jako czysty kod `0`, bo w trakcie
  wznowienia byly aktywne dwa rownolegle kontenery tego samego targetu i zostaly
  zatrzymane po zapisaniu kompletnego wyniku, zeby nie nadpisaly artifactow.
  Zachowany bundle
  `.fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts`
  przeszedl strict offline verifier:
  `python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py
  --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh
  --require-min-frequency-points 5 --require-response-peak
  --require-field-payloads-for-frequency-points --require-derived-peak-mode ...`
  kodem `0`. Artefakty raportuja `completed_frequency_point_count=5`,
  `point_count=5`, `relative_residual_l2_norm=0.0009999903428716216`,
  `max_iterations_for_frequency=2333`, `validation_fallback_used=false` oraz
  peak `frequency_index=4`, `frequency_hz=2875000000`,
  `response_amplitude=1.4758654973596655e-08`. Poniewaz peak jest na gornej
  krawedzi okna, rekomendacja kolejnego sweepu to
  `2.875,2.90625,2.9375,2.96875,3 GHz`.
- Targety refinement potrafia teraz uzyc wybranego zrodla rekomendacji zamiast
  tylko coarse spectrum: `FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS` nadpisuje
  domyslne
  `.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts`
  w `just fem-frequency-response-refinement-env` i
  `just verify-fem-frequency-domain-periodic-airbox-refined-spectrum-runtime`.
  RED/GREEN: target tests najpierw padly na braku tej zmiennej w `justfile`,
  po zmianie
  `python3 -m pytest scripts/test_frequency_domain_runtime_targets.py::test_refinement_env_target_exports_next_periodic_airbox_sweep
  scripts/test_frequency_domain_runtime_targets.py::test_refined_spectrum_runtime_target_uses_recommended_frequencies -q`
  zwrocil `2 passed`. Szerszy focused suite
  `python3 -m pytest scripts/test_frequency_domain_runtime_targets.py
  scripts/test_fem_frequency_response_refinement_env.py
  scripts/test_derive_fem_frequency_response_modes.py
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q` zwrocil
  `145 passed`, `py_compile` przeszedl, a quick check
  `FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS=.fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts
  just fem-frequency-response-refinement-env` wypisal
  `export FULLMAG_FMR_FREQUENCIES_GHZ=2.875,2.90625,2.9375,2.96875,3`.
- Kolejny bug w iterative refinement zostal naprawiony test-first: target
  refined spectrum nie kasuje juz standardowego katalogu output przed
  odczytaniem rekomendacji, gdy
  `FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS` wskazuje na poprzedni refined
  bundle. RED:
  `python3 -m pytest scripts/test_frequency_domain_runtime_targets.py::test_refined_spectrum_runtime_reads_recommendation_before_cleaning_output -q`
  zwrocil `1 failed` z kolejnością `read_frequencies > clean_output`; po
  zmianie odczyt `REFINED_FREQUENCIES_GHZ` jest przed `rm -rf` i focused
  `python3 -m pytest scripts/test_frequency_domain_runtime_targets.py::test_refined_spectrum_runtime_reads_recommendation_before_cleaning_output
  scripts/test_frequency_domain_runtime_targets.py::test_refined_spectrum_runtime_target_uses_recommended_frequencies -q`
  zwrocil `2 passed`. Dry-run z
  `FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS=.fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts`
  potwierdza kolejność `REFINED_FREQUENCIES_GHZ=... && rm -rf ...`.
- Drugie okno refined zostalo policzone czystym targetem `just` z kodem `0`.
  Poprzedni bundle `2.625-2.875 GHz` zostal zachowany w
  `.fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime-2p625-2p875`,
  a standardowy target zostal uruchomiony z
  `FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS=.fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime-2p625-2p875/artifacts`.
  Artefakty w
  `.fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts`
  przeszly strict verifier z
  `--require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh
  --require-min-frequency-points 5 --require-response-peak
  --require-field-payloads-for-frequency-points --require-derived-peak-mode`.
  Sweep `2.875,2.90625,2.9375,2.96875,3.0 GHz` ma amplitudy
  `3.2735136262823595e-08`, `1.7445965095594158e-08`,
  `1.6742189187501165e-08`, `2.2940997976904594e-08`,
  `3.710778013022061e-08`; peak pozostaje na gornej krawedzi `3.0 GHz`.
  Diagnostics: `completed_frequency_point_count=5`,
  `relative_residual_l2_norm=0.000999993869950469`,
  `max_iterations_for_frequency=2740`, `validation_fallback_used=false`.
  Derived recommendation przesuwa kolejne okno na
  `3.0,3.015625,3.03125,3.046875,3.0625 GHz`.
  Focused suite po tym kroku:
  `python3 -m pytest scripts/test_frequency_domain_runtime_targets.py
  scripts/test_fem_frequency_response_refinement_env.py
  scripts/test_derive_fem_frequency_response_modes.py
  scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q` zwrocil
  `146 passed`. Docker cleanup check nie pokazal aktywnych
  `fullmag-fem-gpu-run` kontenerow.

Procent realizacji wzgledem pelnego celu PBC/Floquet/GPU:

| Etap | Ocena | Uzasadnienie |
|---|---:|---|
| P0 docs/metadane | 100% | Zakonczone w planie; mesh translations i capability truth sa opisane. |
| P1 k=0 magnetic-only response | 100% dla kwalifikowanego slice | CPU static-periodic/no-demag ma aktualny managed gate i artifact-backed verifier; GPU gamma/free i GPU static-periodic/no-demag maja runtime verifiers z `--require-production-gpu`, `--require-static-periodic` oraz bez fallbacku; dodatkowo `just verify-fem-frequency-domain-gpu-static-periodic-parity-runtime` porownuje GPU artifacts do CPU reference dla tego samego minimalnego `x_faces` static-periodic mesh assetu. To nadal nie obejmuje demag, nonzero-k ani duzego antidot lattice. |
| P2 static/time-domain demag PBC | 100% dla CPU slice | Static/time-domain periodic airbox CPU/MFEM ma artifacted validation; GPU pozostaje gated. |
| P3 k=0 frequency-response demag periodic airbox | 97% | Sa IR/ABI/artifact gates, explicit dense/matrix-free coupled-block seams, `delta_phi` layout, periodic-pair validation, honest unavailable provenance dla braku MFEM coupled-block assembly oraz runtime artifacts dla CPU/GPU boundaries. Native backend ma realny `apply_demag_tangent` bridge oparty o swiezy MFEM Poisson/PBC demag solve `H_demag(delta_m)`, a runner buduje `NativeBackendDemagTangentProvider` dla CPU `PeriodicAirboxK0`. Focused native demag i frequency-domain contracts przechodza, artifact diagnostics zapisuja self-check liniowosci demag tangent providera, a managed `just verify-fem-frequency-domain-periodic-airbox-runtime` przechodzi kodem `0` dla realnego 200 nm antidot smoke z frozen source: `complete=true`, `completed_frequency_point_count=1`, `relative_residual_l2_norm=0.0009999960955354035`, `total_iteration_count=2145`, `operator_terms_included=["exchange","zeeman","demag"]`, `domain_mesh_mode="generated_frozen_magnetic_submesh"` i `pair_count=106`. Osobny multi-frequency spectrum gate przechodzi dla 3 punktow 2.5/2.75/3.0 GHz z field payloadami, solved demag contribution i `validation_fallback_used=false`; verifier wymusza teraz derived peak mode artifact dla maksimum odpowiedzi oraz rekomendacje kolejnego lokalnego sweepu, a refined 5-point spectrum ma osobny runtime target bez nadpisywania coarse artifactow. Stary z-padding diagnostic nadal pokazuje drift shared OCC path, ale `generated_frozen_magnetic_submesh` acceptance dla tego samego 200 nm antidot/PBC setupu stabilizuje magnetic nodes/elements jako prefiks przy zmianie airbox z=90.0/90.1 nm, filtruje frozen/air overlap i zachowuje `periodic_node_pairs` przez extraction, `.npz` oraz merge. `examples/fem_frequency_response_smoke.py` potrafi przez `FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE` wejsc w frozen workflow i DSL/rewrite zachowuja source metadata. Nadal zostaje redukcja kosztu/solidniejszy preconditioning, wyjasnienie pozostalego additivity self-check, docelowe MFEM coupled assembly `[delta_m, delta_phi]` oraz GPU periodic demag, ktory pozostaje structured unsupported. |
| P4 nonzero-k Floquet response | 69% | Sa IR/planner metadata, phase diagnostics, gamma alias, structured unsupported, C ABI validation dla niespojnego `phase_rad != -k dot translation`, C ABI validation dla niespojnych corner/loop phase constraints, C ABI validation dla nie-Floquet-periodic tangent frames/drive, durable partial artifacts dla Floquet drive validation errors i samej sciezki `floquet_bloch_nonzero_k` unavailable w C ABI; produkcyjny C ABI CPU path kanonizuje teraz zero-fazowe gamma-Floquet pary do static-periodic node pairs i ma numeryczny test rownowaznosci odpowiedzi wzgledem static-periodic. Rust native wrapper przepuszcza dopuszczony GPU no-demag Floquet supplied exchange-edge slice do C ABI zamiast short-circuitowac go jako unavailable. Planner dopuszcza teraz tylko waski high-level `requested_device=gpu` nonzero-k Floquet/no-demag/no-DMI slice z kompletnymi pair metadata, a runner buduje Bloch-phase tangent drive dla periodic pairs. Runner payload doklada wybrane periodic-node exchange edges do natywnego exchange graph dla `Periodic`/`Floquet`, wiec waski GPU Floquet no-demag slice nie opiera sie juz wylacznie na lokalnych tetrahedralnych krawedziach. Waski CPU/GPU phase-projected no-demag Floquet smoke oraz CPU/GPU supplied exchange-edge smoke przechodza w native contract, manifest zapisuje Floquet/projection provenance razem z pair count i k-vector, a `just verify-fem-frequency-domain-gpu-floquet-runtime` daje artifact-backed high-level managed proof dla tego slice. Verifier tej bramki wymaga teraz `dynamic_demag_k_available=false`, `operator_terms_included` z `exchange`, dodatniego `exchange_edge_count`, `floquet_real_imag_mixing=true`, `periodic_pairs_v1_path`, kompletnej listy par z `translation_m`/`phase_rad` oraz zgodnosci `phase_rad=-k dot translation`, zeby nie mylic phase projection bez exchange graph/real-imag rotation/constraint metadata z produkcyjnym operatorem. `just verify-fem-frequency-domain-gpu-floquet-reciprocal-runtime` przeszedl kodem `0` w biezacej weryfikacji i porownuje exchange-only widmo dla `+k` i `-k` w waskim GPU Floquet/no-demag slice. Brak pelnego Bloch-reduced production operatora, DMI, demag-k i k-path validation. |
| P5 Floquet dynamic demag | 38% | Jest physics note i gating; forced GPU `periodic_airbox_k0` zachowuje teraz natywna unsupported-artifact granice bez CPU/dense fallbacku. Osobny managed target `just verify-fem-frequency-domain-periodic-airbox-gpu-unsupported-runtime` materializuje realny 200 nm antidot periodic-airbox request z `FULLMAG_FMR_DEVICE=gpu`, `equilibrium_source=provided` i wymaga verifiera `--require-production-gpu --require-periodic-airbox-gpu-unsupported`. Planner odrzuca teraz publiczne nonzero-k `Floquet` + `include_demag=true` bez `magnetostatic_bc=floquet_airbox` jako niekompletny request, a jawne `magnetostatic_bc=floquet_airbox` istnieje w physics docs, Python DSL, ProblemIR serde i plannerze jako canonical Bloch/Floquet airbox intent dla dynamicznego `delta_phi`, lecz failuje capability errorem `demag-k operator is not implemented`. Native C ABI v8 i Rust FFI niosa teraz jawne `requires_floquet_airbox_dynamic_demag`; C ABI driven-response boundary zapisuje partial artifacts dla `floquet_airbox` z `unsupported_reason="floquet_airbox_dynamic_demag_k_unimplemented"`, `requested_magnetostatic_bc="floquet_airbox"`, `resolved_magnetostatic_bc="floquet_airbox"`, `dynamic_demag_k_available=false` i `validation_fallback_used=false`. Ten boundary zapisuje tez `mesh/periodic_pairs.v1.json` dla magnetostatycznych par `delta_phi` z `pair_family="magnetostatic_delta_phi"`, `unknown_family="delta_phi"`, `phase_convention="exp_minus_i_k_dot_delta_r"`, `floquet_k_vector_rad_per_m`, `phase_metadata_status="available"`, `phase_rad`, `expected_phase_rad`, `phase_residual_rad`, `translation_m` i `delta_phi_flux_validation_status="not_evaluated"` w periodic-pair artifact, diagnostics i manifest. Native C ABI waliduje teraz, ze zadeklarowane magnetostatyczne pary `delta_phi` dla `floquet_airbox` maja realny bufor par; brak bufora zwraca `validation_error="floquet_airbox_missing_delta_phi_periodic_node_pairs"`, indeks poza `delta_phi_dof_count` zwraca `validation_error="floquet_airbox_delta_phi_periodic_node_pair_out_of_range"`, self-pair zwraca `validation_error="floquet_airbox_degenerate_delta_phi_periodic_node_pair"`, a brak pokrywajacej pary Floquet z `has_phase` i `has_translation` zwraca `validation_error="floquet_airbox_delta_phi_pair_missing_phase_metadata"` przed obecna sciezka unsupported. Planner helper emituje teraz osobny `MagnetostaticPotentialDynamic/MagnetostaticDomainWithAir` `BlochPhase` constraint-set dla `floquet_airbox`, a runner payload przenosi odpowiadajace `delta_phi` DOF count i magnetostatyczne periodic-node pairs do natywnego requestu. Focused planner RED/GREEN, `fullmag-plan fem_frequency_response`, focused `fullmag-runner --features fem-gpu` payload test, focused native contract i managed native-contract gate przechodza. Nowy waski C ABI seam potrafi rozwiazac dostarczony explicite CPU `floquet_airbox` coupled block `[delta_m, delta_phi]`, waliduje faze `delta_phi_dst = exp(i phase_rad) * delta_phi_src`, zapisuje `delta_phi_phase_validation_status="ok"` oraz `dynamic_demag_operator_source="explicit_floquet_airbox_coupled_block_payload"`, a zla solved phase wraca teraz jako `validation_error="floquet_airbox_delta_phi_phase_mismatch"` z zachowanym `requested_magnetostatic_bc="floquet_airbox"`, `delta_phi_phase_validation_status="mismatch"` i `delta_phi_phase_max_residual` w diagnostics i manifest. C ABI GPU request z dostarczonym explicit `floquet_airbox` coupled blockiem ma teraz osobny `unsupported_reason="floquet_airbox_dynamic_demag_gpu_unsupported"`, zachowuje requested GPU lane w artifact diagnostics i nie raportuje CPU explicit-block solver source. Managed `just verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime` przechodzi teraz z kompletnymi artifactami unavailable dla high-level GPU Floquet-airbox smoke. Brak MFEM-assembled coupled operatora, full-face/flux validation, GPU Poisson/libCEED/hypre realization i produkcyjnego GPU solvera. |
| GPU PBC/Floquet/dynamic demag | 46% | GPU no-demag/free i k=0 static-periodic/no-demag dzialaja jako baza artefaktowa z runtime verifierem i parytetem CPU/GPU dla kwalifikowanego minimalnego static-periodic smoke; waski phase-projected no-demag Floquet smoke z periodic-node exchange edges przechodzi native contract oraz Rust runner path do C ABI, a manifest/diagnostics zachowuja teraz pair count, k-vector provenance, `operator_terms_included=["exchange","zeeman"]`, dodatni `exchange_edge_count`, `floquet_real_imag_mixing=true` oraz `mesh/periodic_pairs.v1.json` z lista par, translacjami i fazami. High-level planner/runner payload dopuszcza waski `requested_device=gpu` nonzero-k Floquet/no-demag/no-DMI request, buduje Bloch-phase tangent drive z periodic pair metadata i ma osobny managed runtime verifier z `--require-floquet-phase-projection`, ktory dodatkowo wymaga `dynamic_demag_k_available=false`, exchange term, exchange-edge count, real/imag mixing oraz sprawdzonego `phase_rad=-k dot translation` dla tego no-demag slice. Ten slice ma teraz rowniez przechodzacy managed reciprocal gate dla `+k/-k`, ktory porownuje amplitudy widma i odrzuca brak przeciwnego k-vectora. Forced GPU `periodic_airbox_k0` z dynamic demag dociera do natywnego structured unsupported/artifact boundary zamiast wczesnego runner rejection, a `floquet_airbox` ma teraz osobny C ABI/FFI unsupported artifact boundary, CPU supplied-coupled-block seam z walidacja `delta_phi(k)` oraz high-level managed unsupported gate z kompletnym manifest/diagnostics provenance, zamiast byc mylony ze zwyklym `floquet_bloch_nonzero_k`. Nadal brak pelnego nonzero-k Bloch-reduced operatora, periodic Poisson/dynamic demag na GPU i parity validation dla docelowego antidot lattice. |

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
| FEM frequency response | Production CPU response obsluguje gamma/free, `k=0` static-periodic magnetic/no-demag slice oraz kwalifikowany high-level CPU `PeriodicAirboxK0` smoke przez matrix-free `NativeBackendDemagTangentProvider` oparty o MFEM Poisson/PBC demag tangent. Nonzero-k Floquet z demag i GPU periodic demag pozostaja gated. | `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-runner/src/frequency_response.rs`, `backends/fem/src/frequency_domain/driven_response_solver.cpp`, `justfile` | `examples/fem_frequency_response_smoke.py` jest juz high-level CPU PBC+periodic-airbox demag smoke i `just verify-fem-frequency-domain-periodic-airbox-runtime` przechodzi z solved demag contribution. Nadal nie jest to pelny coupled-block `[delta_m, delta_phi]` ani GPU proof. |
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
| FEM frequency response, nonzero-k Floquet | narrow GPU no-demag projection smoke; otherwise unsupported | C ABI ma pola i walidacje fazy/drive; GPU moze przejsc tylko phase-projected local plus supplied exchange-edge/no-DMI/no-demag slice z `floquet_phase_projection=true`. Pelny phase-aware operator z periodic exchange graph albo demag nadal jest gated. |
| FEM GPU PBC / periodic demag | partial for magnetic static-periodic response and narrow Floquet projection smoke; periodic demag unsupported | GPU k=0 static-periodic no-demag response executes through the frequency-domain CUDA tangent path with periodic pair diagnostics. Strict GPU periodic demag, full Floquet exchange graph/demag, and dynamic demag remain gated. |

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
just verify-fem-frequency-domain-gpu-static-periodic-parity-runtime
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
  CPU/GPU parity for the same minimal static-periodic mesh asset is now
  covered by `just verify-fem-frequency-domain-gpu-static-periodic-parity-runtime`.

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
  `FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION=8` Rust FFI/native wrapper. A C ABI
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
  Progress: the separate MFEM demag-tangent provider path now writes honest
  solved provider artifacts: `requested_magnetostatic_bc="periodic_airbox_k0"`,
  `periodic_airbox_coupled_block_solver=false`,
  `mfem_coupled_block_assembly=false`, periodic pair metadata, and
  `h_demag_complex` produced by `apply_demag_tangent`. It intentionally leaves
  `delta_phi_complex=null` because this path does not solve the full
  `[delta_m, delta_phi]` block.
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
  Progress: the public C ABI/native boundary now also rejects degenerate
  magnetostatic `delta_phi` periodic node pairs (`node_a == node_b`) as
  `periodic_airbox_degenerate_magnetostatic_periodic_node_pair` before the
  explicit or matrix-free coupled-block hooks can run. The rejection writes the
  standard partial validation artifact set and preserves
  `magnetostatic_periodic_node_pair_count`, so malformed mesh pair metadata is
  inspectable instead of being mistaken for a solved coupled-block response.
  Focused RED/GREEN `fem_frequency_domain_contract` and managed
  `just verify-fem-frequency-domain-native-contract` finished with code `0`;
  this is still mesh/constraint-family validation, not MFEM coupled assembly.
  Progress: the public C ABI/native boundary now rejects ambiguous coupled-block
  operator source metadata when both dense row-major matrices and matrix-free
  callbacks are supplied for the same `periodic_airbox_k0` hook. The validation
  error is `periodic_airbox_ambiguous_coupled_block_operator_provider`, writes
  the standard partial artifact set, and proves callbacks are not invoked on
  rejected requests. This makes the future MFEM assembler handoff explicit
  instead of silently preferring the dense test payload.
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
  public frequency-domain C ABI (`FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION=8`)
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
  Progress: native backend state I/O now exposes
  `fullmag_fem_backend_apply_demag_tangent_f64`, which applies the existing
  fresh demag dispatcher directly to `delta_m` and returns
  `H_demag(delta_m)`. The Rust `NativeFemBackend`
  wrapper exposes the same bridge as `apply_demag_tangent(...)`, with
  `fullmag-fem-sys` FFI coverage. This is a real MFEM Poisson/PBC demag-tangent
  bridge for matrix-free response providers; it is now wired into the production
  CPU `PeriodicAirboxK0` path through `NativeBackendDemagTangentProvider`, but
  it still does not replace the explicit
  `[delta_m, delta_phi]` coupled-block assembly. Focused native/Rust contracts
  and `just verify-fem-frequency-domain-native-contract` passed with code `0`.
  Follow-up: the ABI now explicitly rejects the old
  `H_demag(m + delta_m) - H_demag(m)` finite-difference pattern in
  `fem_demag_poisson_contract`; the focused native demag and frequency-domain
  contracts pass, but the high-level periodic-airbox runtime gate still fails in
  GMRES nonconvergence, so this bridge remains plumbing/diagnostic progress
  rather than P3 acceptance.
  Follow-up: periodic Poisson reduced solves now clear the reduced solution
  vector before each fresh demag tangent call. Focused native demag and
  frequency-domain contracts pass, and the high-level gate improved to
  `relative_residual_l2_norm=0.6188531122788419` with near-linear demag tangent
  diagnostics, but it is still above the `1e-3` acceptance tolerance and writes
  no completed frequency point.
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
- [x] Add response artifact fields for demag contribution:

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
  Progress: solved explicit/matrix-free `periodic_airbox_k0` coupled-block runs
  now write the `mesh/periodic_pairs.v1.json` artifact that their manifest links.
  The file records `source="native_fem_frequency_domain_coupled_block"`,
  magnetic/magnetostatic constraint-set counts, and
  `magnetostatic_periodic_node_pair_count`. This closes a solved-artifact
  provenance gap only; real demag values still require the future MFEM
  `[delta_m, delta_phi]` assembler rather than a supplied test operator.
  Progress: forced-GPU `periodic_airbox_k0` unavailable artifacts now preserve
  the resolved lane explicitly. Native unavailable diagnostics,
  `frequency_domain/manifest.v1.json` resolved execution, and manifest
  diagnostics carry `requested_execution_lane="production_gpu"`,
  `resolved_execution_lane="unavailable"`,
  `unsupported_reason="periodic_airbox_dynamic_demag_gpu_unsupported"`, and
  `validation_fallback_used=false`. The runtime verifier has a dedicated
  `--require-periodic-airbox-gpu-unsupported` flag that also requires
  periodic-airbox physics metadata, `mesh/periodic_pairs.v1.json`, and
  per-frequency unavailable `demag_contribution` metadata. This proves the
  boundary is honest; it still does not implement GPU periodic demag.
  Progress: solved CPU provider-based `periodic_airbox_k0` artifacts now carry
  per-frequency `demag_contribution.status="solved"`,
  `operator_source="matrix_free_demag_tangent_provider"`,
  `delta_phi_complex=null` and a real `h_demag_complex` phasor payload. The
  runtime verifier `--require-periodic-airbox-cpu-demag-solved` now rejects
  solved demag artifacts unless `h_demag_complex` is present and its length
  matches `delta_m_tangent_dof_count`; the fresh 200 nm runtime artifact has
  both values equal to `1408`. This closes the provider-based demag contribution
  artifact contract. It does not close the separate full coupled-block
  `[delta_m, delta_phi]` assembly task, where `delta_phi_complex` must become a
  solved payload.

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
  `k_sampling=Single`. This is IR/planner contract progress only; the current
  native execution remains limited to the narrow phase-projected no-demag smoke
  and does not consume the full phase-aware constraint graph.
  Progress: the narrow phase-projected Floquet runtime now emits the actual
  selected periodic-pair graph as `mesh/periodic_pairs.v1.json` with
  `source="native_fem_frequency_domain_floquet_phase_projection"`, `node_a`,
  `node_b`, `translation_m`, `expected_translation_m`, and `phase_rad`. The
  verifier requires `periodic_pairs_v1_path`, checks pair count/paired-node
  count, and validates `phase_rad=-k dot translation` modulo `2pi`. The managed
  `just verify-fem-frequency-domain-gpu-floquet-runtime` gate passed with the
  stricter verifier. This is durable graph provenance for the narrow no-demag
  projection slice, not full reduced-operator graph consumption.
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
  Progress: the narrow CPU/GPU no-demag Floquet phase-projection path now
  exposes real/imag phase rotation as first-class artifact provenance:
  `response/diagnostics/solver.v1.json` and
  `frequency_domain/manifest.v1.json` write
  `floquet_real_imag_mixing=true` when `floquet_phase_projection=true`.
  The runtime artifact verifier rejects a required Floquet projection bundle
  unless both diagnostics and manifest carry that flag, and the managed
  `just verify-fem-frequency-domain-gpu-floquet-runtime` gate passed after the
  verifier was tightened. This proves real/imag mixing for the current narrow
  phase-projected no-demag slice; the full Bloch-reduced production operator
  remains open under the broader phase-aware constraint graph task.
- [x] Validate phase loops at corners:

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
  Progress: native C ABI/driven-response validation now also consumes the
  supplied Floquet pair graph and rejects inconsistent accumulated phases around
  corner loops as `validation_error="floquet_phase_loop_mismatch"` before the
  current unsupported or phase-projected solve path. Diagnostics include
  `floquet_phase_loop_max_residual`, and `just
  verify-fem-frequency-domain-native-contract` rebuilt the managed FEM runtime
  and passed with code `0`. This closes phase-loop validation; full
  phase-reduced operator assembly still remains open in the separate
  phase-aware production-operator task.
  Progress: the native C ABI/driven-response solve boundary now also records
  `unsupported_reason="floquet_bloch_nonzero_k"` in both diagnostics and result
  JSON when nonzero-k Floquet metadata reaches the current unsupported solve
  path. This improves provenance for the gate; it is not phase-reduced
  nonzero-k operator support.
  Progress: the same structured unsupported path now writes partial artifacts
  when requested: `frequency_domain/manifest.v1.json`,
  `response/diagnostics/solver.v1.json`, and
  `response/progress.v1.json` report `status="unavailable"`,
  `unsupported_reason="floquet_bloch_nonzero_k"`, zero completed points, and no
  response sweep. This preserves provenance for a known missing production
  operator; it still does not implement phase-aware reduction.
  Progress: after the narrow no-demag Floquet projection slice became executable
  in C ABI, the Rust native wrapper stopped short-circuiting every nonzero-k
  Floquet request before native solve. It still validates pair phase metadata
  before FFI, but phase-consistent GPU no-demag requests with supplied
  exchange-edge now reach C ABI and return `status=ok` with
  `floquet_phase_projection=true`; nonperiodic drives return native
  `validation_error="floquet_drive_phase_mismatch"` plus partial artifacts when
  requested.

- [ ] Apply phase constraints to drive vectors and tangent frames. Reject non-Floquet-periodic excitation.
  Progress: the high-level planner no longer opens nonzero-k Floquet broadly;
  it accepts only `requested_device=gpu`, no-demag/no-DMI, magnetic-body
  requests with complete periodic pair metadata. In that slice,
  `FrequencyExcitationIR.field_au_per_m` is treated as the reference-cell drive
  amplitude and the runner payload propagates the complex tangent-drive phase
  over selected pairs using `phase_rad=-k dot translation`. CPU, demag, DMI,
  missing pair metadata and non-Floquet nonzero-k requests remain rejected.
  This implements drive phase treatment for the narrow GPU projection slice,
  not for the full periodic exchange graph or dynamic demag operator.
  Progress: the native C ABI/driven-response solve boundary now validates
  actual MFEM tangent frames and complex tangent drive for nonzero-k Floquet
  pairs before the current unsupported solve path. It checks
  `u_dst = exp(i phase_rad) u_src` for the drive components and requires
  matching equilibrium tangent frames on paired nodes. Mismatches return
  structured validation diagnostics
  `floquet_drive_phase_mismatch` or `floquet_tangent_frame_mismatch` instead of
  `unsupported_reason="floquet_bloch_nonzero_k"`. This is a boundary
  validation step; phase-aware operator assembly/reduction remains open.
  Progress: CPU/GPU no-demag Floquet response now has narrow phase projection
  smoke coverage in the native contract. `solve_mfem_production_cpu_problem`
  and `solve_mfem_production_gpu_problem` use `project_floquet_phase_block`
  only when `can_solve_floquet_projected_no_demag_response` accepts the
  request, and diagnostics report `floquet_phase_projection=true`. The GPU
  contract now includes supplied exchange-edge tangent operator smoke coverage
  in addition to the local-only smoke. This is still not full periodic exchange
  graph assembly; dynamic demag, periodic Poisson and full production Bloch
  reduction remain open.
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
- [x] Keep `include_demag=true` gated until P5 dynamic magnetostatic Floquet exists.
  Progress: planner/runtime gating now preserves the intended P4/P5 boundary:
  nonzero-k `Floquet` with `include_demag=true` and no
  `magnetostatic_bc=floquet_airbox` is rejected with a message requiring the
  Floquet-airbox demag-k model, explicit CPU/default `floquet_airbox` remains
  rejected as unimplemented, and only explicit production-GPU `floquet_airbox`
  is allowed to reach the native unavailable-artifact boundary. The runner
  payload carries `requires_floquet_airbox_dynamic_demag=true` plus concrete
  `delta_phi` periodic-node metadata for that boundary, and the managed
  `just verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime`
  gate passed with complete unavailable artifacts rather than a solved response
  or CPU fallback. Fresh focused proof:
  `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-plan
  fem_frequency_response -- --nocapture` returned `6 passed`, and
  `python3 -m pytest scripts/test_frequency_domain_runtime_targets.py -q`
  returned `8 passed` after the runtime suite was updated to include
  `just verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime`.
  This closes the gating checkbox only; it does not implement the P5 demag-k
  operator.
- [x] Run:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-runtime-suite
```
  Progress: fresh managed verification on 2026-06-29 closed this gate.
  `just verify-fem-frequency-domain-native-contract` completed with code `0`.
  `just verify-fem-frequency-domain-runtime-suite` also completed with code
  `0` after running the current runtime ladder, including the GPU Floquet
  no-demag, GPU Floquet reciprocal, GPU Floquet-airbox unsupported, and
  free-demag-airbox eigenmode checks. This proves the current artifact-backed
  P4 gates only; it still does not implement full phase-aware production
  operator assembly, DMI, nonzero-k demag-k, or GPU periodic dynamic demag.

Acceptance:

- Exchange-only reciprocal check: `f(+k) == f(-k)` within tolerance.
  Progress: the high-level GPU Floquet no-demag smoke now has an artifact-backed
  reciprocal gate. `just
  verify-fem-frequency-domain-gpu-floquet-reciprocal-runtime` runs
  `examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py` twice with
  `FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=1000000` and `-1000000`, then validates the
  positive-k bundle against the negative-k bundle with
  `--compare-floquet-reciprocal-reference`. The verifier requires both bundles
  to be production GPU Floquet phase-projection artifacts, verifies opposite
  k-vectors, excludes demag/DMI operator terms, and compares frequency and
  response-amplitude observables within tolerance. The managed gate passed with
  code `0` on fresh artifacts: pair phases were `-0.04` / `+0.04`, amplitudes
  matched exactly for the two smoke frequencies. This closes the acceptance for
  the current narrow exchange-only GPU Floquet/no-demag slice only.
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
  Progress: production CPU C ABI solve now canonicalizes zero-phase
  gamma-Floquet pair metadata to `mfem_static_periodic_node_pairs` before lane
  dispatch, clears the Floquet projector path for that alias, and writes
  diagnostics with `static_periodic_projection=true` and
  `floquet_phase_projection=false`. The focused RED contract failed on
  `C ABI gamma-Floquet comparison diagnostics canonicalize to static-periodic
  projection`; after the solver change the same contract passed, and
  `just verify-fem-frequency-domain-native-contract` rebuilt/validated the
  managed runtime suite with code `0`. The regression also compares the
  frequency-point complex response values against the explicit static-periodic
  request within `1e-12`. This proves the `k=0 Floquet == Periodic` acceptance
  item for the narrow production CPU response path; it still does not implement
  nonzero-k phase-aware exchange graph or demag.

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
  Progress: the frequency-response planner helper now emits a separate
  `MagnetostaticPotentialDynamic/MagnetostaticDomainWithAir` `BlochPhase`
  constraint set when `magnetostatic_bc=floquet_airbox`. It reuses the selected
  periodic pair ids, phase convention, k-vector and phase-loop diagnostics from
  the dynamic-magnetization Floquet constraint set. Focused RED/GREEN:
  `fem_frequency_response_floquet_airbox_plans_delta_phi_bloch_constraint_set`
  first failed because no dynamic magnetostatic-potential Bloch constraint was
  emitted, then passed after `frequency_response_periodic_constraint_sets(...)`
  added the `floquet_airbox` branch. This is planner/IR contract progress only:
  public planning still rejects the request with `demag-k operator is not
  implemented`, and native code still does not consume the `delta_phi(k)`
  constraint set or validate scalar-potential flux continuity.
  Progress: the Rust runner native payload now treats `floquet_airbox` like the
  dynamic magnetostatic airbox family for metadata transport: it sets
  `periodic_airbox_delta_phi_dof_count` from the full mesh node count and
  forwards the selected
  `MagnetostaticPotentialDynamic/MagnetostaticDomainWithAir` periodic node
  pairs into `periodic_airbox_magnetostatic_periodic_node_pairs`. Focused
  RED/GREEN in
  `production_gpu_frequency_response_is_narrower_than_cpu_and_never_falls_back`
  first failed with zero `delta_phi` pairs in the Floquet-airbox payload, then
  passed after the builder accepted both `periodic_airbox_k0` and
  `floquet_airbox`. This is payload/FFI metadata transport only; public
  capability gating and native `floquet_airbox_dynamic_demag_k_unimplemented`
  remain unchanged.
  Progress: the native `floquet_airbox_dynamic_demag_k_unimplemented` artifact
  boundary now writes the magnetostatic `delta_phi` pair topology to
  `mesh/periodic_pairs.v1.json`. The artifact records
  `source="native_fem_frequency_domain_floquet_airbox_unavailable"`,
  `pair_family="magnetostatic_delta_phi"`, `unknown_family="delta_phi"`,
  `phase_convention="exp_minus_i_k_dot_delta_r"`, node markers, and the
  magnetostatic pair counts transported through the native request. This proves
  the `delta_phi(k)` pair metadata reaches native artifact generation; it does
  not mean the native operator consumes the constraints.
  Progress: native C ABI now rejects a `floquet_airbox` dynamic-demag request
  that declares magnetostatic `delta_phi` periodic node pairs without providing
  the pair buffer. The new validation returns
  `validation_error="floquet_airbox_missing_delta_phi_periodic_node_pairs"`
  before the current
  `unsupported_reason="floquet_airbox_dynamic_demag_k_unimplemented"` path can
  run. RED/GREEN proof: focused native contract first failed at
  `C ABI Floquet-airbox missing delta_phi pairs is validation error`, then
  passed after `validate_driven_response_floquet_phase_constraints(...)` added
  the `requires_floquet_airbox_dynamic_demag` guard. Managed proof:
  `just verify-fem-frequency-domain-native-contract` rebuilt
  `.fullmag/runtimes/fem-gpu-host` and completed the native frequency-domain
  suite with code `0`. This is still topology validation for `delta_phi(k)`,
  not flux validation or a coupled demag-k operator.
  Progress: the same C ABI boundary now validates the concrete
  magnetostatic `delta_phi` node-pair indices before the unsupported operator
  path. A pair whose node is outside `periodic_airbox_delta_phi_dof_count`
  returns
  `validation_error="floquet_airbox_delta_phi_periodic_node_pair_out_of_range"`,
  and a self-pair returns
  `validation_error="floquet_airbox_degenerate_delta_phi_periodic_node_pair"`.
  RED/GREEN proof: focused native contract first failed at
  `C ABI Floquet-airbox out-of-range delta_phi pair is validation error`, then
  passed after the Floquet phase-constraint validator checked the
  `delta_phi` pair topology. Managed proof:
  `just verify-fem-frequency-domain-native-contract` rebuilt the managed
  runtime and completed the native suite with code `0`. This closes another
  metadata/topology hole; it still does not enforce
  `delta_phi_dst = exp(-i k dot delta_r) delta_phi_src` numerically in an
  assembled operator.
  Progress: native C ABI now also requires every concrete
  magnetostatic `delta_phi` pair to be covered by a matching oriented Floquet
  pair that carries both translation and phase metadata. A `floquet_airbox`
  request with a `delta_phi` pair but no usable `has_phase`/`has_translation`
  metadata now returns
  `validation_error="floquet_airbox_delta_phi_pair_missing_phase_metadata"`
  before the unsupported demag-k path. RED/GREEN proof: focused native contract
  first failed at
  `C ABI Floquet-airbox delta_phi missing phase metadata is validation error`,
  then passed after the Floquet phase-constraint validator checked this
  metadata coverage. Managed proof:
  `just verify-fem-frequency-domain-native-contract` rebuilt the managed
  runtime and completed the native suite with code `0`. This is the native
  precondition for applying the Bloch phase to `delta_phi`; the actual
  assembled scalar-potential constraint and flux validation remain open.
  Progress: the `floquet_airbox` unavailable `mesh/periodic_pairs.v1.json`
  artifact now exposes the phase metadata that the native validator requires
  for each concrete magnetostatic `delta_phi` pair. Each pair records
  `phase_metadata_status="available"`, `phase_rad`, and `translation_m` from
  the matching oriented Floquet pair instead of reporting missing
  magnetostatic translation metadata. RED/GREEN proof: focused native contract
  first failed at
  `C ABI Floquet-airbox periodic-pair artifact records available phase metadata`,
  then passed after the artifact writer mapped each `delta_phi` pair back to
  the matching Floquet pair. Managed proof:
  `just verify-fem-frequency-domain-native-contract` rebuilt the managed
  runtime and completed the native frequency-domain suite with code `0`. This
  improves inspectable `delta_phi(k)` provenance; it is still not the assembled
  scalar-potential constraint, flux validation, or GPU demag-k operator.
  Progress: the same unavailable artifact now records
  `expected_phase_rad=-k dot translation` and `phase_residual_rad` for each
  concrete `delta_phi` pair, using the matched oriented Floquet metadata. This
  makes the Bloch phase convention auditable in the native artifact instead of
  requiring readers to recompute it from `k` and `translation_m`. RED/GREEN
  proof: focused native contract first failed at
  `C ABI Floquet-airbox periodic-pair artifact records expected delta_phi phase`,
  then passed after the artifact writer emitted expected phase and canonical
  residual. Managed proof:
  `just verify-fem-frequency-domain-native-contract` rebuilt the managed
  runtime and completed the native frequency-domain suite with code `0`. This
  is still provenance/metadata validation only; the scalar-potential constraint
  is not assembled or solved yet.
  Progress: the native `floquet_airbox` unavailable boundary now preserves
  `floquet_k_vector_rad_per_m` in the returned C ABI diagnostics, the solver
  diagnostics artifact, the manifest physics block, and the
  `mesh/periodic_pairs.v1.json` metadata. RED/GREEN proof: focused native
  contract first failed at
  `C ABI Floquet-airbox diagnostics preserve k-vector`, then passed after the
  native result and artifact writers emitted the k-vector consistently.
  Managed proof: `just verify-fem-frequency-domain-native-contract` rebuilt
  the managed runtime and completed the native frequency-domain suite with code
  `0`. This makes the unavailable `delta_phi(k)` phase provenance inspectable;
  it is not yet a demag-k operator implementation.
  Progress: the supplied explicit CPU `floquet_airbox` coupled-block seam now
  records phase-validation diagnostics for solved `delta_phi` responses. A
  solved block that violates the Bloch relation returns
  `validation_error="floquet_airbox_delta_phi_phase_mismatch"` and writes
  `delta_phi_phase_validation_status="mismatch"` plus
  `delta_phi_phase_max_residual` to the C ABI diagnostics and manifest. Focused
  RED/GREEN proof: the native contract first failed because those mismatch
  diagnostics were missing, then passed after
  `solve_periodic_airbox_validation_error(...)` propagated the residual fields.
  Managed proof: `just verify-fem-frequency-domain-native-contract` rebuilt the
  managed runtime and completed the native frequency-domain suite with code
  `0`. This strengthens the artifact contract for a supplied CPU block; it is
  still not MFEM assembly of `delta_phi(k)`, flux validation, or GPU demag-k.
  Progress: the C ABI now also protects the strict GPU lane from using that
  supplied CPU coupled-block seam. A `floquet_airbox` request with
  `requested_execution_lane=production_gpu` and an explicit coupled block now
  returns
  `unsupported_reason="floquet_airbox_dynamic_demag_gpu_unsupported"`, keeps
  `requested_magnetostatic_bc="floquet_airbox"`, records
  `validation_fallback_used=false`, and does not report
  `explicit_floquet_airbox_coupled_block_payload` as an operator source.
  Focused RED/GREEN proof: the native contract first failed because the GPU
  rejection did not name the production-GPU lane, then passed after
  `solve_floquet_nonzero_k_unavailable(...)` emitted a GPU-specific reason and
  message. Managed proof: `just verify-fem-frequency-domain-native-contract`
  rebuilt the managed runtime and completed the native frequency-domain suite
  with code `0`. This is a GPU lane honesty guard, not GPU demag-k execution.
- [ ] Add flux validation:

```text
max_pair |partial_n(dst) delta_phi(dst) + phase * partial_n(src) delta_phi(src)| < tolerance
```
  Progress: flux validation is still explicitly absent, but it is no longer
  silent. The `floquet_airbox` unavailable result JSON, solver diagnostics,
  manifest diagnostics, and `mesh/periodic_pairs.v1.json` now record
  `delta_phi_flux_validation_status="not_evaluated"` with reason
  `floquet_airbox_dynamic_demag_k_unimplemented`. A focused C ABI contract
  checks those fields, and `just verify-fem-frequency-domain-native-contract`
  passed after a managed runtime rebuild. This is an honesty boundary, not a
  flux-continuity implementation.

- [x] Add artifact-backed airbox z-padding response comparison gate for response
  peaks and amplitudes. The verifier tolerates airbox/potential DOF changes,
  but compares stable scalar response quantities only when magnetic operator
  invariants such as tangent DOF count and exchange-edge count are invariant
  across the comparison.
- [ ] Make the airbox z-padding convergence gate pass with meaningful mesh,
  airbox and solver settings. The 90/90.1 nm fast-mesh probe remains red after
  the air-volume `exchange_edges` fix: the fresh reference/candidate pair
  changes `delta_m_tangent_dof_count` (`1408` vs `1410`), `delta_phi_dof_count`
  (`876` vs `877`) and `exchange_edge_count` (`3506` vs `3458`). This remains
  a P3 mesh/airbox qualification blocker before amplitude convergence can be
  trusted. A trial with `FULLMAG_FMR_MESH_ALGORITHM_3D=10` did not resolve the
  gate because the reference solve failed to converge before artifact
  comparison.
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
  operators still remain unimplemented.
  Progress: the same GPU unsupported boundary is now artifact-verifiable, not
  only result-JSON-verifiable. Saved native diagnostics/manifest data record
  `resolved_execution_lane="unavailable"` and the Python artifact verifier
  rejects the bundle unless the reason is exactly
  `periodic_airbox_dynamic_demag_gpu_unsupported` and validation fallback is
  absent.
  Progress: 2026-06-29 added
  `just verify-fem-frequency-domain-periodic-airbox-gpu-unsupported-runtime`.
  The target reuses `examples/fem_frequency_response_smoke.py` with
  `FULLMAG_FMR_DEVICE=gpu`, `FULLMAG_FMR_EQUILIBRIUM_SOURCE=provided`, and the
  fast 200 nm antidot mesh, allows the expected CLI unavailable exit, then
  verifies the generated artifacts with `--require-production-gpu`,
  `--require-periodic-airbox-gpu-unsupported`, and `--allow-unavailable`. It
  passed with code `0`. This proves the forced-GPU
  periodic-airbox request reaches the native GPU unavailable artifact boundary
  instead of being hidden by early runner rejection or CPU fallback. Strict GPU
  periodic Poisson/libCEED/hypre operators remain unchecked and unimplemented.
  Progress: the native frequency-domain C ABI now exposes
  `requires_floquet_airbox_dynamic_demag` in
  `FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION=8`, with matching Rust FFI/native
  wrapper plumbing and a C ABI contract. A nonzero-k Floquet request with this
  flag no longer collapses into the generic
  `unsupported_reason="floquet_bloch_nonzero_k"` path. It writes
  `frequency_domain/manifest.v1.json`,
  `response/diagnostics/solver.v1.json`, and
  `response/progress.v1.json` with
  `unsupported_reason="floquet_airbox_dynamic_demag_k_unimplemented"`,
  `requested_magnetostatic_bc="floquet_airbox"`,
  `resolved_magnetostatic_bc="floquet_airbox"`,
  `dynamic_demag_k_available=false`, and
  `validation_fallback_used=false`. Focused native contract, Rust FFI tests,
  runner `fem-gpu` payload smoke, and managed
  `just verify-fem-frequency-domain-native-contract` passed after rebuilding
  the managed FEM runtime bundle. This is an artifact/provenance boundary only;
  it does not implement `delta_phi(k)` constraints, flux continuity, GPU
  periodic Poisson/libCEED/hypre, or the coupled demag-k solve.

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

- represents a 200 x 200 x 10 nm periodic Py cell with a centered 50 nm hole,
  in-plane 10 mT bias, x/y periodic magnetic cuts, and a manual
  200 x 200 x 90 nm airbox;
- now calls `study.build_domain_mesh()`, includes
  `study.demag(realization="poisson_robin")`, and requests
  `include_demag=True`, `bc=PeriodicBC(["x_faces", "y_faces"])`,
  `magnetostatic_bc="periodic_airbox_k0"` in the frequency-response stage;
- should be described as a CPU provider-based `periodic_airbox_k0` FMR smoke,
  not as full MFEM coupled-block `[delta_m, delta_phi]` assembly and not as GPU
  periodic demag evidence.
- current mesh contract is a shared-domain magnetic+airbox mesh with explicit
  x/y PBC metadata for both magnetic and magnetostatic constraint families. It
  uses the same thin-film/antidot sizing policy needed by the target example,
  but the fast smoke can loosen solver tolerances through `FULLMAG_FMR_*`
  environment variables.
- the same smoke now sets explicit/env-controlled Gmsh mesh controls
  (`algorithm_2d=6`, `FULLMAG_FMR_MESH_ALGORITHM_3D` defaulting to `1`,
  `FULLMAG_FMR_MESH_SMOOTHING_STEPS`, `FULLMAG_FMR_MESH_OPTIMIZE_ITERATIONS`,
  `FULLMAG_FMR_MESH_SIZE_FROM_CURVATURE`, `FULLMAG_FMR_MESH_NARROW_REGIONS`)
  so the periodic antidot mesh policy is visible in the example contract
  instead of being implicit defaults.

`examples/fem_frequency_response_static_periodic_smoke.py`:

- is the clean smallest k=0 static-periodic frequency-response smoke;
- should remain the fast runtime gate for P1.

`examples/fem_fmr_periodic_k0_smoke.py`:

- is now a compatibility entrypoint for the periodic k=0 antidot
  frequency-response smoke and delegates to `examples/fem_frequency_response_smoke.py`;
- no longer runs the free-boundary demag-airbox eigenmode path with `bc="free"`.
  Use `examples/fem_fmr_free_demag_airbox_smoke.py` for that separate modal
  smoke.
- `just fem-fmr-periodic-k0-example` now calls
  `just verify-fem-fmr-periodic-k0-runtime` and prints response artifacts under
  `.fullmag/reports/frequency-domain-periodic-airbox-runtime`, rather than
  free-boundary eigen artifacts. Fresh proof: `python3 -m pytest
  scripts/test_frequency_domain_runtime_targets.py -q` returned `10 passed`,
  `python3 -m py_compile examples/fem_fmr_periodic_k0_smoke.py
  scripts/test_frequency_domain_runtime_targets.py` passed, and `git diff
  --check` passed for the touched files. This removes the misleading public
  entrypoint, but it still does not implement a true periodic k0 modal/eigenmode
  solver with demag.

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
