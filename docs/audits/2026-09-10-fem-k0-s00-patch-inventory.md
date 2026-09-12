# FEM K0 — S00 inventory poprawki `f0986ede`

Data: 2026-09-10. Baza porównania: lokalny `master`
`1620d2762d99b58cddcfc93f7eb505b84dfbf178` w worktree
`C:/git/fullmag/worktrees/k0-remediation-s00-20260910`.

To jest inwentaryzacja źródłowa i decyzja o odzysku hunks. Nie jest to dowód
nowego runtime'u ani kwalifikacji starego, dirty snapshotu. Równoważność
historycznego wyniku z czystym `f0986ede` pozostaje `NOT VERIFIED`.

## Decyzja ogólna

`f0986ede9853828dfd573a2bee12302385213321` ma rodzica
`4c7897f218eb0c32612db1f43a844502a316b4f6` i zmienia 34 pliki (`+1200/-201`).
Jest użytecznym kandydatem K0, ale miesza fizykę, planner/IR, runner/ABI,
toolchain/Docker, dokumentację, przykłady i launchery. Nie należy stosować go
jako jednego cherry-pick.

`93e1ca38423ddb661a21c76b05bb02bfaf5c9826` jest merge commit z rodzicami
`f0986ede` i `0bcd09558ac506e4ec334d24e98ce392f23d4473`. Drugi rodzic jest
ancestor obecnego `master` (PR #77), więc statystyka pierwszego rodzica
(`1453` pliki) opisuje scalanie starszego drzewa, a nie 1453 nowych zmian K0.
Combined diff pokazuje tylko jeden rozstrzygnięty konflikt merytoryczny:

* w `crates/fullmag-runner/src/fem/relax/finalize.rs` merge usunął test
  `recompute_certificate_keeps_cache_generation_and_topology_sha_separate`;
* drzewo merge zachowało również starszą implementację drugiego rodzica w
  `certify_native_linearization_recompute`: bez sprawdzenia
  `stage_mesh_generation_id` względem generation/topology SHA w tym
  konkretnym miejscu tworzenia certyfikatu. Bieżący master ma odrębne kontrole
  generation/topology w `eigen_equilibrium_contract.rs`, przy budowie i
  walidacji handoffu relax→eigen; nie jest to globalny brak walidacji identity.

Nie traktować `93e1` jako bounded K0 patch. Zachowany patch i diff merge są
materiałem audytowym, nie zostały zastosowane do bieżącego solvera.

## Mapa 34 plików

| # | Plik i aktualny anchor | Co wnosi `f0986ede` | Stan względem aktualnego mastera i decyzja |
|---:|---|---|---|
| 1 | `backends/fem/cmake/FindPETSc.cmake` — `find_library(PETSc_LIBRARY)` | Hints `PETSC_DIR/lib{,64}` i `find_path(petscversion.h)`. | Master ma już runtime-prefix, pkg-config fallback i wersjonowanie. **Nie portować wprost**; ewentualne env hints dodać tylko po wykazaniu braku w managed stacku. |
| 2 | `backends/fem/cmake/FindSLEPc.cmake` — `find_library(SLEPc_LIBRARY)` | Analogiczne hints `SLEPC_DIR` i wyszukiwanie nagłówka. | Jak #1: obecny pkg-config jest nowszym mechanizmem. **Targeted review**, nie cały hunk. |
| 3 | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` — walidacja `has_open_z_face` | Marker `0` oznacza pure Neumann; sprawdzana jest rola exterior, nie marker fizyczny. | Master nadal wymaga `marker == payload.boundary_marker` przy mapowaniu ról, mimo że assembly pure-Neumann istnieje. **Port po S01**, z regresją payloadu. |
| 4 | `backends/fem/src/api.cpp` — walidacja `payload->boundary_marker` | Dopuszcza `0` wyłącznie dla `pure_neumann`; nonzero pure-Neumann odrzuca tokenem `pure_neumann_boundary_marker_must_be_zero`. | Master odrzuca marker `0` bez wyjątku (`unknown_airbox_marker`). **Port konieczny** wraz z testem C ABI. |
| 5 | `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` — `modal_certificate_boundary_rejects_stale_and_mismatched_identity` | Test akceptacji sentinel `0` i odrzucenia nonzero pure-Neumann. | Master ma tylko stare odrzucenie markera `0`; późniejsze synthetic pure-Neumann tests nie pokrywają importera. **Port targeted regression**. |
| 6 | `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp` — payload importer | Testuje pure-Neumann `FullmagFemModalSharedDomainPayload` z markerem `0`. | Master testuje assembly i mean weights, lecz nie ten importer. **Port targeted regression**. |
| 7 | `compose.windows.yaml` — service `fullmag-windows-fem-cpu` | Włącza SLEPc i publikuje `PKG_CONFIG_PATH`, `PETSC_DIR`, `SLEPC_DIR`. | Master ma aktualne bindy frontend/storage, ale CPU SLEPc nadal `OFF`. **Port tylko po decyzji o managed SLEPc stacku**, zachowując nowe bindy. |
| 8 | `crates/fullmag-fem-sys/build.rs` — native CMake configure | Inwaliduje `CMakeCache.txt`/`CMakeFiles` przy zmianie konfiguracji PETSc/SLEPc. | Hunk nie istnieje w masterze. **Review/port** z bieżącym profilem storage; nie przenosić ślepo mechaniki starego builda. |
| 9 | `crates/fullmag-ir/src/plan.rs` — `FemEigenPlanIR`, `AirBoxConfigIR` | Dodaje `demag_solver_policy` do planu eigen i opisuje `pure_neumann`/marker source. | Master ma policy w response planie, nie w `FemEigenPlanIR`; komentarze AirBox są stare. **Port kontraktowy** po S01/S02. |
| 10 | `crates/fullmag-plan/src/fem.rs` — `resolve_k0_periodic_airbox_execution`, `plan_fem_eigen` | Explicit GPU fail-closed; auto GPU → CPU z jawnym pure-Neumann fallback reason; przenosi solver policy do eigen planu. | Master nadal legalizuje GPU i tylko stary fallback. **Port po zamrożeniu kontraktu S01**, nie jako niezależny workaround. |
| 11 | `crates/fullmag-plan/src/mesh.rs` — `build_air_box_config` | Dynamiczne exact-Gamma `periodic_airbox_k0` → `pure_neumann`, marker `0`; zwykłe/static ścieżki pozostają Robin/Dirichlet. | Master wybiera wyłącznie Robin/Dirichlet. **Port po decyzji fizycznej S01**; sprawdzić osobno static/dynamic i response callers. |
| 12 | `crates/fullmag-plan/src/tests.rs` — K0 planner tests | Aktualizuje oczekiwania pure-Neumann i fail-closed GPU/auto fallback. | Master testuje stare zachowanie, w tym GPU allowed. **Port razem z #10/#11**, nie samodzielnie. |
| 13 | `crates/fullmag-runner/src/dispatch.rs` — fixture `FemEigenPlanIR` | Dodaje wyłącznie `demag_solver_policy: None` do fixture'u testowego. | To mechaniczna konsekwencja pola IR z #9, bez zmian GPU residency. **Port po zmianie IR w S02**, razem z pozostałymi fixture'ami. |
| 14 | `crates/fullmag-runner/src/eigen/artifacts/tests.rs` — planner resolution fixture | Zastępuje przypadek jawnego GPU przypadkiem `auto` z hintem GPU i rozstrzygnięciem CPU, powodem `gpu_modal_pure_neumann_gauge_unavailable`; zawęża nazwę testu do plannable lanes. | Master zachowuje stary przypadek jawnego GPU. **Port razem z #10/#17** jako test zachowania provenance fallbacku; diff nie dodaje field-sweep tests. |
| 15 | `crates/fullmag-runner/src/eigen/orchestrator.rs` — `FemEigenPlanIR` fixture | Aktualizuje fixture pod kątem pola `demag_solver_policy`. | To konsekwencja #9. **Port po zmianie IR**, bez osobnej semantyki. |
| 16 | `crates/fullmag-runner/src/fem/eigen_execution.rs` — `bias_field_relax_plan` | Propaguje policy, obsługuje env max steps i rozdziela static Robin/Dirichlet od dynamicznego pure-Neumann planu. | Master ma stałe 8 kroków i kopiuje AirBox bez rozdzielenia. **Port/review po S01–S03**; wymaga certyfikowanego handoffu, nie ukrytego fallbacku. |
| 17 | `crates/fullmag-runner/src/fem/eigen_execution_resolution.rs` — fallback guard | Dopuszcza `gpu_modal_pure_neumann_gauge_unavailable` jako planner-recorded auto fallback. | Master zna tylko `gpu_modal_device_krylov_unavailable`. **Port razem z #10**. |
| 18 | `crates/fullmag-runner/src/fem/eigen_output.rs` — `write_eigen_v2_bundle` | Kopiuje legacy `source_mesh_topology_sha256` do `source_mesh_identity`, aby uniknąć sprzeczności. | Master używa plan fingerprint i historyczny bundle przez to odpada. **Nie portować jako naprawy**; S04 musi ustalić jeden canonical digest i regression test. |
| 19 | `crates/fullmag-runner/src/fem/eigen_tests.rs` — K0 execution/output fixtures | Aktualizuje fixture'y dla policy, pure-Neumann i fallbacku. | Master jest mieszanką starego kontraktu i nowszych testów. **Port selektywnie po #9–#18**, nie cały plik. |
| 20 | `crates/fullmag-runner/src/fem/relax/finalize.rs` — `certify_native_linearization_recompute` | Rozdziela cache generation od topology SHA, sprawdza stage generation oraz dopuszcza historyczną formę SHA w migracji; dodaje regression test. | Merge `93e1` utracił test i sprawdzenie w tej funkcji certyfikującej; master zachowuje odrębne kontrole handoffu w `eigen_equilibrium_contract.rs`. **Port/review w S03**, skoordynowany z S04 identity contract. |
| 21 | `crates/fullmag-runner/src/types.rs` — `FemEigenPlanIR` fixtures | Uzupełnia `demag_solver_policy: None`. | Brak pola wynika z #9. **Port mechanicznie po IR**, bez samodzielnego cherry-pick. |
| 22 | `docker/fem-cpu/Dockerfile` — dependency stage / `FULLMAG_FEM_WITH_SLEPC` | Buduje pinned PETSc/SLEPc przeciw temu samemu HYPRE i ustawia SLEPc ON. | Master nie buduje PETSc/SLEPc i ma `FULLMAG_FEM_WITH_SLEPC=OFF`. **Nie jest equivalent**; port/rebase całego dependency stage po decyzji managed route. |
| 23 | `docs/architecture/backend-golden-masterplan.md` — K0 boundary paragraph | Dokumentuje DtN/pure-Neumann dynamic, static Robin/Dirichlet i GPU fail-closed. | Master tego kontraktu nie zawiera. **Port jako S01 documentation**, po uzgodnieniu źródła/test anchor. |
| 24 | `docs/audits/2026-08-29-fem-k0-eigensolve-plan-realization-audit-and-remaining-implementation-plan.md` — historical audit | Dopisuje diagnozę Robin vs Neumann i status D1/D2. | Historyczny audit został później przebudowany/skrótowo usunięty hunkiem. **Nie portować wholesale**; nowy S00 report/plan jest źródłem bieżącego stanu. |
| 25 | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` — DtN and exact-Gamma sections | Dodaje równanie DtN, rozdziela finite-object Robin od k=0 Neumann i ogranicza nonzero-k. | Master ma uboższy/niejednoznaczny opis. **Port jako S01 scientific contract**, z walidacją dokumentacji. |
| 26 | `docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json` — equation/source IDs | Dodaje mapowanie DtN/K0 boundary i aktualizuje ścieżki source symbols. | Obecne ścieżki są inne po refaktorze. **Rebase ręczny**, nie kopiować JSON; wymagana source-map validation. |
| 27 | `docs/specs/capability-matrix-v0.md` — exact-Gamma readiness row | Dodaje status corrected CPU source-visible, GPU unvalidated/fail-closed. | Master nie ma tego akapitu. **Port dopiero z evidence/status ledgerem**, nie jako capability promotion. |
| 28 | `examples/fem_eigen_exchange_only_strong_k_path.py` — new diagnostic example | Dodaje exchange-only nonzero-k control. | Source/example only; nie jest dowodem demag ani Q1/Q2. **Zachować jako candidate/reference**, bez portu solvera. |
| 29 | `examples/fem_eigen_k0_kittel_periodic_airbox.py` — `target_frequency` w etapie eigenmodes | Zmienia shift z `2.0e9` na `1.0e9` Hz i dodaje komentarz wyjaśniający wybór; nie zmienia metadata/contract. | **Selektywnie rebase** wraz z kontrolą wyboru modu w S06; sama zmiana targetu nie jest runtime qualification. |
| 30 | `examples/fem_eigen_k0_periodic_antidot_field_sweep.py` — new 147-line sweep | Dodaje canonical antidot field sweep. | Candidate input only; brak dowodu Q1 window. **Zachować/rebase po S02**, bez kwalifikacji. |
| 31 | `scripts/plot_fem_k0_kittel_comparison.py` — new plot utility | Renderuje Kittel comparison. | Diagnostic/reporting only. **Opcjonalnie zachować**, nie jest validator/runtime proof. |
| 32 | `scripts/test_windows_fullmag_launcher_contract.py` — launcher tests | Dodaje no-service-ports headless check, SLEPc image/env assertions i bias-relax forwarding coverage. | Master ma nowsze storage assertions. **Port targeted assertions** po launcher/Docker zmianie; nie wholesale. |
| 33 | `scripts/windows/run_fullmag_docker.ps1` — run args/env forwarding | Headless nie publikuje `--service-ports`; forwarduje `FULLMAG_FEM_EIGEN_BIAS_RELAX_MAX_STEPS`. | Master ma już nowszy storage adapter, ale nadal zawsze `--service-ports` (okolice linii 726) i brak bias env w liście SP4. **Port tylko te dwa hunks**, zachowując storage implementation. |
| 34 | `scripts/windows/run_fullmag_wsl.ps1` — same launcher contract | Jak #33 dla zgodności aliasu WSL. | Storage adapter jest nowszy, lecz oba focused hunks pozostają nieobecne. **Port tylko headless gating + bias env**, bez starego pliku. |

## Granice odbioru

Tabela rozdziela source-visible reuse od zmian wymagających kontraktu i testów.
Nie dowodzi, że portowane hunki są już wdrożone. W szczególności pozostają
`NOT VERIFIED`: świeży managed CPU solve, GPU mean-zero implementation/residency,
CPU/GPU parity, antidot/window, FMS/API i browser/WebGL. Nowy run — nawet z
identycznym wynikiem liczbowym — nie może sam wstecznie przypisać starego dirty
artefaktu do `f0986ede`; do tego potrzebne są dokładne historyczne dirty inputs,
manifest i ich hashe.
