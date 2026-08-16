# Produkcyjny racetrack ze skyrmionem i rozwiązanym transportem — plan wdrożenia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dostarczyć publiczny, fail-closed workload FDM/CUDA/FP64, który rozwiązuje prąd w racetracku HM/FM, wyznacza direct SHE i steady spin accumulation, sprzęga wynikowy transportowy SOT/STT z LLG oraz publikuje trajektorię skyrmionu i kąt Halla, z niezależną walidacją transportu i porównaniem wspólnego limitu dynamiki z MuMax3.

**Architecture:** Jedna kanoniczna definicja fizyczna przechodzi z Python DSL i Control Room przez `ProblemIR` i planner do natywnego FDM/CUDA. Charge snapshot jest niezmiennym źródłem dla steady-spin, a natywny callback RHS oblicza torque na urządzeniu dla każdej ewaluacji etapu Rungego–Kutty; Rust zarządza lifecycle, artefaktami i proweniencją, lecz nie przenosi pól przez host w gorącej pętli. Walidacja rozdziela solved transport (analityka, CPU oracle, bilanse, zbieżność) od wspólnego limitu magnetodynamicznego Fullmag–MuMax3 z identycznym polem torque.

**Tech Stack:** Python DSL, Rust (`fullmag-ir`, `fullmag-plan`, `fullmag-runner`, `fullmag-api`), C++20/CUDA (`backends/fdm`), C ABI v1, Next.js/React/TypeScript Control Room, pytest/CargoTest/CTest/Vitest/Playwright, zarządzane kontenery `just`, MuMax3.

## Global Constraints

- Pierwszy kwalifikowany tuple to dokładnie `backend=fdm`, `device=gpu`, `precision=double`, `mode=strict`; brak fallbacku CPU, FP32 i prescribed torque.
- Zakres fizyczny to steady one-way M1: solved charge, direct SHE, steady spin, mixing interface i transportowy torque; bez iSHE, transient M3, Oersteda, MTJ, PBC, temperatury i multi-GPU.
- `ProblemIR` opisuje oddzielnie domenę transportową HM+FM, domenę magnetyczną FM i maskę targetu torque; brak modułu transportu oznacza brak jego węzłów, natomiast `J=0` nie oznacza braku modułu.
- Charge snapshot jest akceptowany, wersjonowany i niezmienny; spin solver konsumuje uchwyt snapshotu, nie niezależne tablice `J_c`.
- Torque powstaje z bilansu objętościowej reakcji i powierzchniowej absorpcji; jest dodawany do każdej ewaluacji RHS LLG device-to-device.
- Odrzucony krok przywraca magnetyzację, stan transportu, generacje, telemetrykę i liczniki; częściowe wyniki nie są publikowane.
- Cała ciężka kompilacja i kwalifikacja używa kontenerowych receptur `just` oraz magazynu pod `/zfn2/mateuszz/git/fullmag`; bez host-first native build.
- Native FDM pozostaje w `backends/fdm`; runner Rust zawiera wyłącznie orkiestrację, artefakty i proweniencję.
- Dokumentacja naukowa poprzedza promocję kodu i wskazuje równania, znaki, jednostki SI, ograniczenia, symbole źródłowe i bibliografię.
- MuMax3 nie jest oraclem solved-current ani spin accumulation; porównanie MuMax3 kwalifikuje wyłącznie wspólny limit dynamiki z identycznym polem torque.

## Mapa odpowiedzialności plików

| Jednostka | Odpowiedzialność |
|---|---|
| `docs/physics/0970-spin-hall-drift-diffusion-transport.md` + source map | kanoniczne równania M1, znaki, bilanse, fixture i mapowanie do kodu |
| `docs/physics/0940-topological-charge-observable.md` + source map | środek skyrmionu, trajektoria, regresja i kąt Halla |
| `packages/fullmag-py/src/fullmag/model/spin_transport.py` | publiczne authoring transportu i jego domen |
| `crates/fullmag-ir/src/spin_transport.rs` | kanoniczne i resolved IR dla FDM/GPU M1 |
| `crates/fullmag-plan/src/spin_transport.rs`, `fdm.rs` | walidacja domen, capability i fail-closed resolution |
| `backends/fdm/gpu/cuda/transport/*` | charge/spin, snapshoty i device-resident torque |
| `native/include/fullmag_fdm.h`, `backends/fdm/include/context.hpp` | append-only ABI i lifecycle callbacku transportowego RHS |
| `crates/fullmag-fdm-sys/src/gpu_transport_abi_v1.rs` | zamrożone layouty ABI po stronie Rust |
| `crates/fullmag-runner/src/fdm/gpu/cuda/*` | sesja publiczna, lifecycle, artefakty i proweniencja |
| `crates/fullmag-api/src/analysis/*` | zasób trajektorii i kąta Halla |
| `apps/control-room/src/modules/inspector/panels/*` | object-scoped authoring i inspektory transportu/analizy |
| `examples/`, `tests/standard_problems/`, `scripts/` | wersjonowane scenariusze, orakle i porównanie MuMax3 |

---

### Task 1: Zamrożona fizyka, fixture, znaki i kryteria kwalifikacji

**Files:**
- Modify: `docs/physics/0970-spin-hall-drift-diffusion-transport.md`
- Modify: `docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json`
- Modify: `docs/physics/0940-topological-charge-observable.md`
- Create: `docs/physics/0940-topological-charge-observable.source-map.json`
- Create: `tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json`
- Create: `tests/standard_problems/transport/racetrack_m1_v1/README.md`
- Test: `scripts/test_validate_physics_docs.py`

**Interfaces:**
- Consumes: zatwierdzoną specyfikację `docs/superpowers/specs/2026-08-11-solved-current-skyrmion-racetrack-design.md`.
- Produces: `racetrack_m1_v1` z osiami `x=track`, `y=transverse`, `z=HM→FM`, dodatnim conventional current `+x`, normalną interfejsu `+z` i algorytmem `skyrmion_hall_angle_v1`.

- [ ] **Step 1: Dodać test dokumentacyjny, który wymaga pełnej tabeli fixture i source map**

  Rozszerzyć `scripts/test_validate_physics_docs.py` o asercje dla identyfikatorów `racetrack_m1_v1`, `she_1d_film_v1`, `skyrmion_hall_angle_v1`, pól `symbol`, `si_unit`, `value`, `validity`, `problem_ir_path` oraz symboli implementacyjnych wymienionych w kolejnych zadaniach.

- [ ] **Step 2: Uruchomić test i potwierdzić czerwony stan**

  Run: `python3 -m pytest scripts/test_validate_physics_docs.py -q`

  Expected: FAIL, ponieważ fixture i source map obserwabli jeszcze nie istnieją.

- [ ] **Step 3: Zapisać pełne równania i wersjonowany fixture**

  W `fixture.v1.json` zapisać dokładnie: rozmiar `512e-9 × 128e-9 m`, HM `3e-9 m`, FM `1e-9 m`, komórkę `2e-9 × 2e-9 × 1e-9 m`; FM `Ms=580e3 A/m`, `A=15e-12 J/m`, `alpha=0.3`, `Ku=0.8e6 J/m^3`, `D=3e-3 J/m^2`; HM `sigma_charge=sigma_spin=5e6 S/m`, `theta_SH=0.2`, `lambda_sf=1.5e-9 m`; FM `sigma_charge=sigma_spin=1e6 S/m`, `P=0.4`, `lambda_sf=5e-9 m`, `lambda_J=lambda_phi=1e-9 m`; interfejs `G_up=G_down=2.5e14 S/m^2`, `G_r=5e14 S/m^2`, `G_i=5e13 S/m^2`; wymuszenia `J={-1.5,-1.0,-0.5,0.5,1.0,1.5}e12 A/m^2`. Każdą wartość oznaczyć jako numeryczny fixture walidacyjny i powiązać z literaturą lub jawną motywacją zakresu, bez przypisywania całego zestawu jednemu rzeczywistemu materiałowi.

  W notach wyprowadzić charge continuity, direct-SHE tensor, steady spin diffusion z reakcjami, mixing BC, bilans torque, Gilbert LLG oraz definicję regresji `Theta_H=atan2(v_y,v_x)`. Zapisać pełną tabelę znaków dla odwrócenia `J`, `theta_SH`, normalnej i osi poprzecznej.

- [ ] **Step 4: Uruchomić walidację dokumentacji**

  Run: `python3 -m pytest scripts/test_validate_physics_docs.py -q`

  Expected: PASS dla nowych identyfikatorów, tabel parametrów i source map.

- [ ] **Step 5: Commit**

  ```bash
  git add docs/physics/0970-spin-hall-drift-diffusion-transport.md docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json docs/physics/0940-topological-charge-observable.md docs/physics/0940-topological-charge-observable.source-map.json tests/standard_problems/transport/racetrack_m1_v1 scripts/test_validate_physics_docs.py
  git diff --cached --name-only
  git commit -m "docs(physics): freeze solved-current racetrack contract"
  ```

### Task 2: Rozdzielenie domeny transportowej, magnetycznej i targetu torque

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/spin_transport.py`
- Modify: `packages/fullmag-py/tests/test_spin_transport.py`
- Modify: `crates/fullmag-ir/src/spin_transport.rs`
- Modify: `crates/fullmag-authoring/src/spin_transport.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-plan/src/spin_transport.rs`
- Test: `crates/fullmag-plan/tests/spin_transport.rs`

**Interfaces:**
- Consumes: publiczne regiony `ChargeTransportDefinition.domain`, `MagnetIR.region` i `TorqueTargetIR.region`.
- Produces: `ResolvedFdmSpinTransportIR { transport_active_mask, magnetic_active_mask, torque_target_masks, ... }`, gdzie wszystkie maski mają dokładnie `nx*ny*nz` wpisów.

- [ ] **Step 1: Napisać testy round-trip i planner invariants**

  Dodać testy `python_and_ir_preserve_separate_transport_and_magnetic_domains`, `public_gpu_m1_rejects_transport_domain_that_does_not_cover_magnetic_target`, `zero_current_preserves_transport_module` oraz `missing_transport_module_emits_no_transport_nodes`. Oczekiwać, że HM+FM należy do maski transportowej, tylko FM do magnetycznej, a target torque jest podzbiorem FM.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_spin_transport.py -q`

  Run: `cargo test -p fullmag-plan transport_domain -- --nocapture`

  Expected: FAIL z powodu pojedynczej dotychczasowej `active_mask` albo brakujących pól resolved IR.

- [ ] **Step 3: Wprowadzić minimalne semantyczne rozdzielenie domen**

  Rozszerzyć resolved IR o trzy jawne maski. Materializować transport z `charge.domain`, magnetyzm z `MagnetIR.region`, torque z `TorqueTargetIR.region`. Walidować: zgodny grid, niepusta domena transportowa i magnetyczna, `target ⊆ magnetic ⊆ transport`, brak torque poza komórkami z dodatnim `Ms`. Nie wyprowadzać obecności modułu z amplitudy prądu.

- [ ] **Step 4: Uruchomić testy Python/IR/planner**

  Run: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_spin_transport.py -q`

  Run: `cargo test -p fullmag-ir spin_transport -- --nocapture`

  Run: `cargo test -p fullmag-plan transport_domain -- --nocapture`

  Expected: PASS; test niepokrywającej domeny kończy planowanie kontrolowanym błędem.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/fullmag-py/src/fullmag/model/spin_transport.py packages/fullmag-py/tests/test_spin_transport.py crates/fullmag-ir/src/spin_transport.rs crates/fullmag-authoring/src/spin_transport.rs crates/fullmag-plan/src/fdm.rs crates/fullmag-plan/src/spin_transport.rs crates/fullmag-plan/tests/spin_transport.rs
  git diff --cached --name-only
  git commit -m "feat(transport): separate transport and magnetic domains"
  ```

### Task 3: Publiczny fail-closed plan FDM/GPU M1

**Files:**
- Modify: `crates/fullmag-ir/src/spin_transport.rs`
- Modify: `crates/fullmag-plan/src/spin_transport.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `docs/specs/capability-matrix-v0.json`
- Test: `crates/fullmag-plan/tests/spin_transport.rs`

**Interfaces:**
- Consumes: `TransportExecution { backend, device, precision, mode }` i `ResolvedFdmSpinTransportIR` z Task 2.
- Produces: `ResolvedSpinTransportPlanIR.fdm_gpu_double: Option<ResolvedFdmSpinTransportIR>` wyłącznie dla M1/CUDA/FP64/strict.

- [ ] **Step 1: Napisać testy pozytywne i macierz negatywną**

  Dodać `resolves_bounded_public_fdm_gpu_m1_spin_transport` oraz tabelę przypadków odrzucających `single`, `extended`, M2/iSHE, M3, PBC, thermal, Oersted, brak mixing interface i solver inny niż `native_m1_v1`. Test musi także sprawdzić, że requested oraz resolved tuple są identyczne.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `cargo test -p fullmag-plan public_fdm_gpu_m1 -- --nocapture`

  Expected: FAIL z komunikatem, że steady M1 GPU jest niedostępne.

- [ ] **Step 3: Dodać zawężoną ścieżkę capability**

  Dodać `fdm_gpu_double`, rozwiązywać ją tylko przy pełnym zgodnym tuple i descriptorze. Nie zmieniać statusu produkcyjnego w capability matrix; dodać wyłącznie jawny status `implemented_unqualified`/równoważny istniejącemu słownikowi aż do Task 12.

- [ ] **Step 4: Uruchomić planner i walidator capability**

  Run: `cargo test -p fullmag-plan public_fdm_gpu_m1 -- --nocapture`

  Run: `python3 scripts/validate_capability_matrix.py docs/specs/capability-matrix-v0.json`

  Expected: PASS; każde rozszerzenie zakresu failuje przed runtime.

- [ ] **Step 5: Commit**

  ```bash
  git add crates/fullmag-ir/src/spin_transport.rs crates/fullmag-plan/src/spin_transport.rs crates/fullmag-plan/src/fdm.rs crates/fullmag-plan/tests/spin_transport.rs docs/specs/capability-matrix-v0.json
  git diff --cached --name-only
  git commit -m "feat(plan): resolve bounded FDM CUDA M1 spin transport"
  ```

### Task 4: Rustowa sesja GPU charge→spin z niezmiennym snapshotem

**Files:**
- Create: `crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/mod.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-fdm-sys/src/gpu_transport_abi_v1.rs`
- Test: `crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport_tests.rs`

**Interfaces:**
- Consumes: `ResolvedFdmGpuChargeTransportIR`, `ResolvedFdmSpinTransportIR`, `fullmag_fdm_gpu_transport_solve_steady_spin_v1`.
- Produces: `GpuM1TransportSession::prepare(plan)`, `solve_charge() -> AcceptedChargeSnapshot`, `solve_spin_static(snapshot, m_view, torque_view) -> AcceptedSpinSnapshot`; snapshot ma `handle`, `accepted_sequence`, `source_revision`, `operator_revision` i `device_identity`.

- [ ] **Step 1: Napisać fake-ABI test lifecycle**

  Testy: `spin_requires_accepted_charge_snapshot`, `spin_rejects_foreign_or_stale_snapshot`, `dispatch_does_not_return_after_charge_when_spin_is_planned`, `accepted_snapshot_revisions_are_published_together`. Fake ABI ma rejestrować kolejność `upload → charge → accept → spin` oraz odrzucać zmieniony sequence.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `cargo test -p fullmag-runner --features cuda gpu_m1_transport_session -- --nocapture`

  Expected: FAIL, ponieważ publiczny dispatch kończy obecnie wykonanie po samym charge.

- [ ] **Step 3: Zaimplementować sesję i usunąć charge-only early return dla planu spin**

  Wprowadzić RAII dla natywnego contextu i snapshotów, jeden descriptor upload, jawne accept/rollback oraz kontrolę wszystkich rewizji. Zachować osobną charge-only ścieżkę dla workloadów bez spin; nie tworzyć pól spin, gdy modułu nie ma.

- [ ] **Step 4: Uruchomić testy runnera i ABI**

  Run: `cargo test -p fullmag-fdm-sys gpu_transport_abi_v1::tests -- --nocapture`

  Run: `cargo test -p fullmag-runner --features cuda gpu_m1_transport_session -- --nocapture`

  Expected: PASS i brak wywołania spin dla charge-only.

- [ ] **Step 5: Commit**

  ```bash
  git add crates/fullmag-runner/src/fdm/gpu/cuda crates/fullmag-runner/src/dispatch.rs crates/fullmag-fdm-sys/src/gpu_transport_abi_v1.rs
  git diff --cached --name-only
  git commit -m "feat(runner): execute public GPU M1 charge and spin session"
  ```

### Task 5: Natywny device-resident transport torque w każdym RHS LLG

**Files:**
- Modify: `native/include/fullmag_fdm.h`
- Modify: `backends/fdm/include/context.hpp`
- Modify: `backends/fdm/src/context.cpp`
- Modify: `backends/fdm/gpu/cuda/transport/context.cu`
- Modify: `backends/fdm/gpu/cuda/transport/spin/device_solver.cu`
- Modify: `backends/fdm/gpu/cuda/integrator.cu`
- Modify: `backends/fdm/CMakeLists.txt`
- Create: `backends/fdm/tests/gpu_m1_transport_llg_stage_v1_contract.cpp`
- Modify: `crates/fullmag-fdm-sys/src/gpu_transport_abi_v1.rs`

**Interfaces:**
- Consumes: zaakceptowany charge snapshot i natywne transport context/descriptor.
- Produces: append-only `fullmag_fdm_gpu_transport_llg_binding_v1`, `fullmag_fdm_context_bind_gpu_transport_v1`, `fullmag_fdm_context_unbind_gpu_transport_v1`; `Context` posiada `DeviceVectorField transport_torque` i backendowy callback `evaluate_transport_rhs(m_stage, t_stage, stage_generation)`.

- [ ] **Step 1: Napisać kontrakt natywny etapów RK**

  Test ma użyć kontrolowanego spin operatora i policzyć liczbę wywołań dla Euler/Heun/RK4, sprawdzić, że każde wywołanie otrzymało właściwy `m_stage`, torque dodano dokładnie raz, target mask zeruje HM oraz poza-target FM, a wskaźniki `m_stage` i `transport_torque` pozostają device pointers na tym samym urządzeniu.

- [ ] **Step 2: Uruchomić test przez zarządzany kontener i potwierdzić czerwony stan**

  Najpierw dodać recepturę `verify-fdm-gpu-m1-transport-llg-native-contract` do `justfile`, używając build tree `/mnt/fullmag-zfn2-native/fdm-gpu-m1-transport-llg`.

  Run: `just verify-fdm-gpu-m1-transport-llg-native-contract`

  Expected: FAIL kompilacji/testu, ponieważ `Context` nie ma bindingu ani pola dynamicznego torque.

- [ ] **Step 3: Zaimplementować backend-owned callback i append-only ABI**

  `Context` alokuje i zeruje torque zgodnie z pełnym gridem. Integrator przed każdą oceną RHS wywołuje callback z aktualnym stage view; callback używa zaakceptowanego snapshotu, rozwiązuje steady spin i zapisuje torque bez host copy. Brak bindingu daje dokładnie dotychczasowy RHS. Nie wystawiać Rustowi własności surowych wskaźników CUDA ani streamów.

- [ ] **Step 4: Uruchomić ABI layout, natywny kontrakt i compute-sanitizer**

  Run: `just verify-fdm-gpu-m1-layout-abi-contract`

  Run: `just verify-fdm-gpu-m1-transport-llg-native-contract`

  Run: `just verify-fdm-gpu-m1-transport-llg-compute-sanitizer`

  Expected: PASS; liczby callbacków odpowiadają etapom integratorów, memcheck zwraca 0 błędów.

- [ ] **Step 5: Commit**

  ```bash
  git add native/include/fullmag_fdm.h backends/fdm/include/context.hpp backends/fdm/src/context.cpp backends/fdm/gpu/cuda/transport backends/fdm/gpu/cuda/integrator.cu backends/fdm/tests/gpu_m1_transport_llg_stage_v1_contract.cpp backends/fdm/CMakeLists.txt crates/fullmag-fdm-sys/src/gpu_transport_abi_v1.rs justfile
  git diff --cached --name-only
  git commit -m "feat(fdm): couple solved transport torque into CUDA LLG stages"
  ```

### Task 6: Wspólny lifecycle, rollback, restart i brak host round-trip

**Files:**
- Modify: `backends/fdm/include/context.hpp`
- Modify: `backends/fdm/gpu/cuda/transport/context.cu`
- Modify: `backends/fdm/gpu/cuda/integrator.cu`
- Create: `backends/fdm/tests/gpu_m1_transport_llg_lifecycle_v1_contract.cpp`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport.rs`
- Modify: `crates/fullmag-runner/src/checkpoint.rs`
- Test: `crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport_tests.rs`

**Interfaces:**
- Consumes: binding z Task 5.
- Produces: `TransportStageCheckpointV1 { accepted_step, charge_sequence, spin_generation, source_revision, operator_revision }` oraz atomowe `begin_trial`, `accept_trial`, `rollback_trial`.

- [ ] **Step 1: Napisać testy odrzucenia kroku i restartu**

  Testy wymuszają jeden odrzucony krok Heuna, porównują wszystkie liczniki i pola przed/po rollback, a następnie zapisują checkpoint i porównują ciągły przebieg z restartem bitwise dla deterministycznego małego przypadku. Transfer audit odrzuca D2H/H2D pól `m`, `mu_s`, `Q`, `torque` wewnątrz prób kroku; dozwolona jest tylko skalarna telemetria po akceptacji.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `just verify-fdm-gpu-m1-transport-llg-lifecycle-contract`

  Expected: FAIL, dopóki transport nie uczestniczy w rollback/checkpoint.

- [ ] **Step 3: Zaimplementować transakcyjny lifecycle**

  Zachować zaakceptowane generacje oddzielnie od trial. Na rollback przywracać pola i liczniki; na accept publikować jeden spójny revision tuple. Restart odtwarza descriptor identity i wymaga zgodności build/source/device, w przeciwnym razie fail-closed.

- [ ] **Step 4: Uruchomić kontrakty wszystkich wspieranych integratorów**

  Run: `just verify-fdm-time-domain-native-contract`

  Run: `just verify-fdm-gpu-m1-transport-llg-lifecycle-contract`

  Expected: PASS dla Euler/Heun/RK4 i wspieranego adaptive trial; brak transferów pól w hot loop.

- [ ] **Step 5: Commit**

  ```bash
  git add backends/fdm/include/context.hpp backends/fdm/gpu/cuda/transport/context.cu backends/fdm/gpu/cuda/integrator.cu backends/fdm/tests/gpu_m1_transport_llg_lifecycle_v1_contract.cpp crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport.rs crates/fullmag-runner/src/checkpoint.rs justfile
  git diff --cached --name-only
  git commit -m "feat(runtime): make transport and LLG lifecycle transactional"
  ```

### Task 7: Pola, artefakty, quantity catalog i proweniencja transportu

**Files:**
- Modify: `crates/fullmag-runner/src/quantities.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-api/src/quantity_data_plane.rs`
- Modify: `apps/control-room/src/kernel/api/quantityIds.ts`
- Test: `crates/fullmag-runner/tests/fdm_gpu_m1_transport_artifacts.rs`

**Interfaces:**
- Consumes: accepted charge/spin/LLG revision tuple.
- Produces: `V_electric`, `J_charge`, `mu_spin`, `Q_spin`, `torque_stt`, `torque_sot`, `m`, balance summaries i `execution_provenance.transport_m1_v1`.

- [ ] **Step 1: Napisać test katalogu i atomowej publikacji**

  Sprawdzić obecność ilości tylko gdy plan ma moduł, jednostki SI, shape/tensor ordering, maskę i wspólne revision IDs. Symulować porażkę spin solve i potwierdzić brak częściowo opublikowanych pól.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `cargo test -p fullmag-runner fdm_gpu_m1_transport_artifacts -- --nocapture`

  Expected: FAIL, ponieważ FDM quantity activation zwraca obecnie false dla pól spin/torque.

- [ ] **Step 3: Zaimplementować katalog i zapis artefaktów**

  Publikować ciężkie pola na binarnym data plane, a w JSON tylko metadane, residuals, balance, wersje, requested/resolved tuple i identity GPU/runtime/build/source. Rozdzielić torque objętościowy i interfejsowy oraz zapisać ich sumę używaną przez RHS.

- [ ] **Step 4: Uruchomić testy runner/API/frontend contract**

  Run: `cargo test -p fullmag-runner fdm_gpu_m1_transport_artifacts -- --nocapture`

  Run: `cargo test -p fullmag-api quantity_data_plane -- --nocapture`

  Run: `pnpm --dir apps/control-room test -- quantityIds`

  Expected: PASS i brak transport quantities dla workloadu bez modułu.

- [ ] **Step 5: Commit**

  ```bash
  git add crates/fullmag-runner/src/quantities.rs crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport.rs crates/fullmag-runner/src/artifacts.rs crates/fullmag-runner/tests/fdm_gpu_m1_transport_artifacts.rs crates/fullmag-api/src/quantity_data_plane.rs apps/control-room/src/kernel/api/quantityIds.ts
  git diff --cached --name-only
  git commit -m "feat(data): publish coherent M1 transport fields and provenance"
  ```

### Task 8: Obserwabla trajektorii skyrmionu i kąta Halla

**Files:**
- Create: `crates/fullmag-api/src/analysis/skyrmion_trajectory.rs`
- Modify: `crates/fullmag-api/src/analysis/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/src/router.rs`
- Create: `scripts/validate_skyrmion_hall_angle.py`
- Create: `scripts/test_validate_skyrmion_hall_angle.py`
- Create: `apps/control-room/src/modules/analysis/SkyrmionTrajectoryPanel.tsx`
- Create: `apps/control-room/src/modules/analysis/SkyrmionTrajectoryPanel.test.tsx`

**Interfaces:**
- Consumes: serie zaakceptowanych `m(t)` i geometrię/siatkę.
- Produces: `SkyrmionTrajectoryV1` z `time_s`, `x_m`, `y_m`, `q`, `edge_distance_m`; `SkyrmionHallAngleV1` z `v_parallel_m_per_s`, `v_perp_m_per_s`, `angle_rad`, `angle_deg`, covariance, residuals, accepted interval, mean signed current i reason code.

- [ ] **Step 1: Napisać syntetyczne testy algorytmu**

  Przypadki: prostoliniowy ruch 30°, odwrócenie prądu, zamiana osi, heteroscedastyczny szum, brak ruchu, rozpad `|Q|`, zbliżenie do krawędzi i zbyt krótki steady window. Okno transientu wybiera kryterium stabilizacji prędkości, nie stały indeks.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `python3 -m pytest scripts/test_validate_skyrmion_hall_angle.py -q`

  Run: `cargo test -p fullmag-api skyrmion_trajectory -- --nocapture`

  Expected: FAIL z powodu brakującego algorytmu i zasobu API.

- [ ] **Step 3: Zaimplementować algorytm v1 i resource-first API**

  Liczyć gęstość topologiczną kanonicznym dyskretnym operatorem, środek jako moment podpisanej gęstości w ważnym oknie, następnie ważoną regresję `x(t),y(t)` i covariance propagation do `atan2`. Fail-closed reason codes: `no_motion`, `topology_lost`, `edge_contaminated`, `no_stationary_window`, `insufficient_samples`.

- [ ] **Step 4: Zaimplementować panel analizy i uruchomić testy**

  Panel pokazuje trajektorię w metrach/nanometrach, zaznacza odrzucony transient, wektor prędkości, kąt i niepewność; dane pobiera przez centralny v2 client/resource hook.

  Run: `python3 -m pytest scripts/test_validate_skyrmion_hall_angle.py -q`

  Run: `cargo test -p fullmag-api skyrmion_trajectory -- --nocapture`

  Run: `pnpm --dir apps/control-room test -- SkyrmionTrajectoryPanel`

  Expected: PASS dla poprawnych i fail-closed przypadków.

- [ ] **Step 5: Commit**

  ```bash
  git add crates/fullmag-api/src/analysis crates/fullmag-api/src/openapi_v2.rs crates/fullmag-api/src/router.rs scripts/validate_skyrmion_hall_angle.py scripts/test_validate_skyrmion_hall_angle.py apps/control-room/src/modules/analysis/SkyrmionTrajectoryPanel.tsx apps/control-room/src/modules/analysis/SkyrmionTrajectoryPanel.test.tsx
  git diff --cached --name-only
  git commit -m "feat(analysis): add versioned skyrmion Hall angle observable"
  ```

### Task 9: Publiczny scenariusz Python — relaksacja i pobudzenie solved current

**Files:**
- Create: `examples/fdm_gpu_solved_current_skyrmion_racetrack.py`
- Create: `tests/standard_problems/transport/racetrack_m1_v1/test_scenario.py`
- Create: `scripts/verify_fdm_gpu_racetrack_output.py`
- Test: `scripts/test_verify_fdm_gpu_racetrack_output.py`

**Interfaces:**
- Consumes: fixture z Task 1 i publiczne API z Tasks 2–8.
- Produces: płaski module-level `study` z etapami `relax_zero_current` oraz `drive_solved_current`, bez raw JSON i bez prescribed torque/Oersted.

- [ ] **Step 1: Napisać kontrakt eksportu i wyników**

  Test importuje skrypt, normalizuje ProblemIR, sprawdza dokładny tuple, obecność HM/FM/interface/electrodes/gauge, brak Oersteda/prescribed torque oraz dwa etapy. Walidator wymaga stanu relaksacji, pól transportu, trajectory/Hall artifact i spójnych revisions.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest tests/standard_problems/transport/racetrack_m1_v1/test_scenario.py scripts/test_verify_fdm_gpu_racetrack_output.py -q`

  Expected: FAIL, ponieważ publiczny scenariusz nie istnieje.

- [ ] **Step 3: Zaimplementować scenariusz wyłącznie publicznym DSL**

  Relaksacja używa zerowego wymuszenia istniejącego modułu transportowego i wymaga stabilnego `Q`; etap drive wykonuje dodatni/ujemny prąd oraz trzy dodatnie amplitudy przez wersjonowaną sweep definition. Nie używać helperów ukrywających konfigurację study.

- [ ] **Step 4: Uruchomić testy authoringu**

  Run: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest tests/standard_problems/transport/racetrack_m1_v1/test_scenario.py scripts/test_verify_fdm_gpu_racetrack_output.py -q`

  Expected: PASS i kanoniczny Python→ProblemIR round-trip.

- [ ] **Step 5: Commit**

  ```bash
  git add examples/fdm_gpu_solved_current_skyrmion_racetrack.py tests/standard_problems/transport/racetrack_m1_v1 scripts/verify_fdm_gpu_racetrack_output.py scripts/test_verify_fdm_gpu_racetrack_output.py
  git diff --cached --name-only
  git commit -m "feat(examples): add solved-current skyrmion racetrack study"
  ```

### Task 10: MuMax3 — wspólny limit dynamiki, nie oracle transportu

**Files:**
- Create: `tests/standard_problems/transport/racetrack_m1_v1/mumax/common_limit.mx3`
- Create: `scripts/export_fullmag_transport_torque_for_mumax.py`
- Create: `scripts/compare_fdm_racetrack_mumax.py`
- Create: `scripts/test_compare_fdm_racetrack_mumax.py`
- Modify: `tests/standard_problems/transport/racetrack_m1_v1/README.md`
- Modify: `justfile`

**Interfaces:**
- Consumes: wersjonowane pole torque Fullmag na siatce FM i stan po relaksacji.
- Produces: `racetrack_mumax_common_limit_v1.json` z wersją/digest MuMax3, literalną konfiguracją, tolerancjami i metrykami `m_rms`, energie, `Q`, pozycja, prędkości, `Theta_H`.

- [ ] **Step 1: Napisać testy parsera i porównania na syntetycznych danych**

  Testy obejmują zgodność, zmianę znaku osi, różne czasy, brak próbki, utratę topologii oraz przekroczenie osobnych progów pól i obserwabli. Comparator musi odrzucić wynik bez digestu MuMax3 i bez potwierdzenia identycznego torque.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `python3 -m pytest scripts/test_compare_fdm_racetrack_mumax.py -q`

  Expected: FAIL, ponieważ comparator nie istnieje.

- [ ] **Step 3: Zaimplementować eksport i fixture MuMax3**

  Eksportować torque w jednoznacznej konwencji SI i OVF, razem z hashami gridu i pola. `common_limit.mx3` ma identyczne FM, discretization, initial `m`, exchange, anisotropy, DMI, demag policy, fixed-step Heun i wstrzykiwane pole torque; nie może zawierać MuMaxowego prescribed Slonczewski/Zhang–Li jako substytutu transportu.

- [ ] **Step 4: Dodać i uruchomić zarządzaną recepturę comparison**

  Receptura `verify-fdm-gpu-racetrack-mumax-common-limit` zapisuje wyniki pod `/zfn2/mateuszz/git/fullmag/reports/fdm-gpu-racetrack-mumax/<source-digest>/`, uruchamia Fullmag, lokalny wersjonowany MuMax3 oraz comparator. Osobno raportuje literalną i zbieżniejszą politykę demag.

  Run: `python3 -m pytest scripts/test_compare_fdm_racetrack_mumax.py -q`

  Run: `just verify-fdm-gpu-racetrack-mumax-common-limit`

  Expected: unit tests PASS; runtime PASS tylko jeśli wszystkie progi i identity checks są spełnione, w przeciwnym razie kwalifikacja pozostaje otwarta z reason code.

- [ ] **Step 5: Commit**

  ```bash
  git add tests/standard_problems/transport/racetrack_m1_v1/mumax tests/standard_problems/transport/racetrack_m1_v1/README.md scripts/export_fullmag_transport_torque_for_mumax.py scripts/compare_fdm_racetrack_mumax.py scripts/test_compare_fdm_racetrack_mumax.py justfile
  git diff --cached --name-only
  git commit -m "test(validation): compare racetrack dynamics with MuMax3"
  ```

### Task 11: Pełny kontrakt Control Room i object-scoped Explorer/Inspector

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.test.tsx`
- Modify: `apps/control-room/src/modules/explorer/ExplorerTree.tsx`
- Modify: `apps/control-room/src/modules/explorer/ExplorerTree.test.tsx`
- Modify: `apps/control-room/src/modules/analysis/SkyrmionTrajectoryPanel.tsx`
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- Test: `apps/control-room/e2e/solved-current-racetrack.spec.ts`

**Interfaces:**
- Consumes: OpenAPI v2 resources i ten sam canonical authoring model co Python.
- Produces: obiektowe węzły `Charge transport`, `Spin transport`, `HM/FM interface`, `Transport torque`; globalny `Skyrmion trajectory` tylko gdy analiza została dodana.

- [ ] **Step 1: Napisać testy drzewa, Inspectorów i round-trip**

  Testować: brak modułu → brak węzłów; istniejący moduł z `J=0` → węzły obecne; moduł przypisany tylko do obiektu racetrack → brak duplikatów globalnych; każdy semantyczny węzeł ma własny Inspector; Python export odtwarza wszystkie parametry fixture i exact execution tuple.

- [ ] **Step 2: Potwierdzić czerwony stan**

  Run: `pnpm --dir apps/control-room test -- TransportAuthoringInspector ExplorerTree SkyrmionTrajectoryPanel`

  Expected: FAIL dla nieprawidłowej obecności lub położenia węzłów.

- [ ] **Step 3: Zaimplementować resource-first object-scoped UI**

  Używać centralnego typed clienta i resource hooks. Inspector ma skopiować responsywny wzorzec layoutu z inspektora Visualization, zachowując własne pola semantyczne. Węzły wynikają z graph presence, nigdy z wartości amplitudy. Nie dodawać równoległego modelu UI ani bezpośrednich `fetch()`.

- [ ] **Step 4: Regenerować OpenAPI i wykonać testy oraz browser smoke**

  Run: `just generate-openapi-v2`

  Run: `pnpm --dir apps/control-room typecheck`

  Run: `pnpm --dir apps/control-room test -- TransportAuthoringInspector ExplorerTree SkyrmionTrajectoryPanel`

  Run: `pnpm --dir apps/control-room exec playwright test e2e/solved-current-racetrack.spec.ts`

  Expected: PASS; screenshoty pokazują poprawne drzewo i responsywne Inspectory w wąskim i szerokim layoucie.

- [ ] **Step 5: Uruchomić React Doctor i commit**

  Run: `pnpm --dir apps/control-room exec react-doctor`

  Expected: brak regresji wyniku względem baseline zapisanego przed Task 11.

  ```bash
  git add apps/control-room crates/fullmag-api/src/openapi_v2.rs
  git diff --cached --name-only
  git commit -m "feat(ui): author solved-current racetrack per object"
  ```

### Task 12: Zarządzana kwalifikacja CUDA i kontrolowana promocja capability

**Files:**
- Modify: `justfile`
- Create: `scripts/verify_fdm_gpu_racetrack_qualification.py`
- Create: `scripts/test_verify_fdm_gpu_racetrack_qualification.py`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/physics/0970-spin-hall-drift-diffusion-transport.md`
- Modify: `docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json`
- Modify: `docs/physics/0940-topological-charge-observable.md`
- Create: `docs/raports/2026-08-11-fdm-gpu-solved-current-racetrack/KWALIFIKACJA.md`

**Interfaces:**
- Consumes: wszystkie artefakty Tasks 1–11.
- Produces: atomowy manifest `fdm_gpu_solved_current_racetrack_qualification_v1.json` i ewentualną promocję wyłącznie exact tuple/workload.

- [ ] **Step 1: Napisać validator 12-bramkowego manifestu**

  Wymagać osobnych dowodów: znaki/jednostki, charge analytic+CPU+CUDA, spin analytic+CPU+CUDA, interface limits, torque oracle, RK lifecycle, trzy siatki relaksacji, dodatni/ujemny i trzy amplitudy drive, Hall uncertainty, MuMax common-limit, Python/UI round-trip, restart, determinism, memory budget, performance, compute-sanitizer, no-fallback i no-hot-loop-transfer. Każdy artefakt zawiera source commit/digest i runtime identity.

- [ ] **Step 2: Potwierdzić czerwony stan przed pełną kwalifikacją**

  Run: `python3 -m pytest scripts/test_verify_fdm_gpu_racetrack_qualification.py -q`

  Run: `python3 scripts/verify_fdm_gpu_racetrack_qualification.py --evidence-root /zfn2/mateuszz/git/fullmag/reports/fdm-gpu-racetrack`

  Expected: unit tests PASS; live validator FAIL z listą brakujących świeżych bramek, dopóki receptura ich nie wytworzy.

- [ ] **Step 3: Dodać atomową recepturę produkcyjną**

  `verify-fdm-gpu-solved-current-racetrack-production` buduje natywny FDM/CUDA i CLI w zarządzanym kontenerze, zapisuje source snapshot, input hashes, GPU UUID, driver/runtime, build digest, wolną pamięć i descriptor-derived memory budget; uruchamia wszystkie kontrakty, convergence sweeps, publiczny workload, restart/determinism, MuMax comparison i validator. Artefakty tymczasowe kończą się `.tmp`; summary jest publikowane dopiero po pełnym PASS.

- [ ] **Step 4: Uruchomić pełną kwalifikację i przejrzeć dowody**

  Run: `just verify-fdm-gpu-solved-current-racetrack-production`

  Expected: PASS wszystkich 12 bramek, zero fallbacków, zero transferów pól w hot loop, zgodność hashy wejściowych przed/po oraz wynik Hall z niepewnością. Jeżeli którykolwiek warunek nie przejdzie, capability pozostaje niekwalifikowane, a raport zapisuje dokładny reason code.

- [ ] **Step 5: Promować dokumentację wyłącznie po świeżym PASS**

  Zmienić capability matrix tylko dla `fdm/gpu/double/strict/racetrack_m1_v1`; pozostawić FP32, FEM, M2/M3, Oersted i MTJ jako niekwalifikowane. W raporcie rozdzielić `implemented`, `executable`, `validated`, `production-qualified` i podać bezpośrednie ścieżki do dowodów.

- [ ] **Step 6: Końcowa regresja i commit**

  Run: `git diff --check`

  Run: `python3 scripts/validate_capability_matrix.py docs/specs/capability-matrix-v0.json`

  Run: `python3 -m pytest scripts/test_validate_physics_docs.py scripts/test_verify_fdm_gpu_racetrack_qualification.py -q`

  Run: `pnpm --dir apps/control-room typecheck`

  Expected: PASS; raport i capability wskazują dokładnie ten sam source/runtime manifest.

  ```bash
  git add justfile scripts/verify_fdm_gpu_racetrack_qualification.py scripts/test_verify_fdm_gpu_racetrack_qualification.py docs/specs/capability-matrix-v0.json docs/specs/capability-matrix-v0.md docs/physics/0970-spin-hall-drift-diffusion-transport.md docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json docs/physics/0940-topological-charge-observable.md docs/raports/2026-08-11-fdm-gpu-solved-current-racetrack/KWALIFIKACJA.md
  git diff --cached --name-only
  git commit -m "test(qualification): qualify solved-current CUDA racetrack"
  ```

## Mapa pokrycia bramek

| Bramka specyfikacji | Zadania planu | Dowód wymagany do zamknięcia |
|---|---|---|
| 1. workload, znaki, jednostki | 1, 2, 9, 11 | fixture, tabela znaków, Python/UI normalized IR equality |
| 2. solved charge | 4, 7, 12 | analytic, CPU oracle, CUDA parity, balances |
| 3. direct SHE + steady spin | 3, 4, 5, 12 | `she_1d_film_v1`, residual, convergence, reversal |
| 4. HM/FM interface | 1, 3, 5, 12 | transparent/zero/real/imaginary/orientation limits |
| 5. transport SOT/STT | 5, 7, 12 | algebraic oracle, target mask, signs, units |
| 6. transport–LLG lifecycle | 5, 6, 12 | all RK stages, rollback, restart, no transfer |
| 7. stable skyrmion | 9, 12 | three grids, energy/Q/radius/center stability |
| 8. driven racetrack | 9, 12 | ±J, three amplitudes, no annihilation/edge contamination |
| 9. Hall angle | 8, 9, 12 | synthetic oracle, weighted fit, uncertainty/fail-closed |
| 10. MuMax comparison | 10, 12 | common-limit manifest, literal/converged demag policy |
| 11. product contract | 2, 3, 7, 8, 9, 11 | Python/UI round-trip, OpenAPI/resources/tree/Inspector |
| 12. production qualification | 12 | managed CUDA manifest with all fresh evidence |

## Warunek przejścia do Oersteda

Etap Oersteda nie rozpoczyna się po samym skompilowaniu ani po zielonych testach jednostkowych. Rozpoczyna się dopiero po świeżym `PASS` receptury `just verify-fdm-gpu-solved-current-racetrack-production`, publikacji manifestu wszystkich 12 bramek i kontrolowanej promocji exact capability tuple.
