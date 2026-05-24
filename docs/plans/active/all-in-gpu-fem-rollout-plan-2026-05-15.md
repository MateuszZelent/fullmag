# Plan: ALL IN GPU FEM

- Status: **active**
- Data: 2026-05-15
- Cel: przeniesc time-domain FEM hot loop na GPU tak, aby CPU nie bylo elementem obliczeniowym w kazdym RHS/stage.
- Punkt startowy: `docs/reports/15.05.2026/fem-gpu-solver-audit.md`
- Zastepuje status wykonawczy S09-S13 z `docs/plans/active/fem-full-mfem-gpu-solver-plan-2026-03-27.md`; tamte elementy traktujemy jako scaffold, dopoki profiling nie potwierdzi device-resident hot loop.
- Powiazana fizyka:
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
  - `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`

---

## 0. Definicja "ALL IN GPU"

"ALL IN GPU FEM" nie znaczy, ze CPU ma byc bezczynne. Znaczy:

1. GPU jest wlascicielem stanu obliczeniowego w hot loopie.
2. `m`, `H_ex`, `H_demag`, `H_eff`, stage buffers, RHS buffers, normy, energie i redukcje pozostaja na device.
3. CPU wykonuje orchestration, decyzje runtime, event loop, live session, I/O, meshing i schedulowanie snapshotow.
4. Host/device transfery sa dozwolone tylko:
   - przy inicjalizacji,
   - przy zmianie parametrow kontrolnych,
   - przy zaplanowanym snapshocie/artefakcie,
   - przy odczycie malych skalarnych telemetrycznych.
5. Kazdy nieplanowany `HostRead`, `HostWrite`, D2H albo H2D w RHS/stage jest regresja.

Minimalna bramka sukcesu:

```text
exchange_only, exchange_demag, exchange_dmi, stt_oersted:
  - nsys pokazuje brak per-stage H2D/D2H po warmup
  - TransferAudit.hot_loop_h2d_bytes == 0
  - TransferAudit.hot_loop_d2h_bytes == 0
  - TransferAudit.hot_loop_host_read_count == 0
  - TransferAudit.hot_loop_host_write_count == 0
  - CPU native vs GPU parity w tolerancjach planu
  - GPU step_time_ms wygrywa z CPU powyzej ustalonego progu mesh size
```

---

## 1. Wybor architektury

### Opcja A: MFEM/hypre + wlasny GPU state + wlasne kernele lokalne

To jest rekomendowana sciezka.

MFEM/hypre zostaja odpowiedzialne za mesh, FE spaces, operator assembly/apply i Poisson solve. Fullmag wprowadza jeden wlasny `FemGpuState` jako zrodlo prawdy dla stepera i oddzialywan lokalnych. Interop z MFEM odbywa sie przez device vectors bez hostowego kopiowania.

Zalety:

- wykorzystuje juz zintegrowany MFEM/hypre stack,
- daje realna kontrole nad RK, LLG, lokalnymi polami, redukcjami i snapshotami,
- pozwala wymieniac `legacy_sparse` vs `partial_assembly` na podstawie benchmarku,
- minimalizuje ryzyko przepisywania calego FEM.

Ryzyko:

- trzeba bardzo rygorystycznie pilnowac MFEM memory model,
- trzeba zbudowac TransferAudit, bo inaczej host sync wroci po cichu.

### Opcja B: pelny custom CUDA FEM bez MFEM/hypre hot path

Wlasne connectivity, element kernels, sparse/AMG stack i demag solver.

Zalety:

- pelna kontrola nad pamiecia, streamami i layoutem,
- potencjalnie najlepsza wydajnosc dla waskiego zakresu P1 tet.

Ryzyko:

- bardzo duzy zakres,
- odtwarzamy solver framework,
- trudniejsza walidacja, AMR, wyzsze rzedy i open-boundary demag.

### Opcja C: poczekac na PA/libCEED jako jedyny hot path

Najmniej kodu w Fullmag, ale zbyt ryzykowne jako jedyna strategia. Obecny kod ma jawny komentarz, ze MFEM 4.7 tetra H1 PA potrafi abortowac w runtime. PA/libCEED powinno byc benchmarkowanym backendiem operatora, nie dogmatem.

Decyzja: **Opcja A**.

---

## 2. Docelowy model warstw

```text
Rust runner / session runtime
  - wybiera runtime
  - serializuje provenance
  - odbiera skalary i snapshoty
  - nie wykonuje obliczen FEM hot loop

C ABI fullmag_fem
  - tworzy/destroyuje backend
  - przyjmuje plan
  - zwraca stats/snapshot handles
  - ujawnia transfer audit i device residency flags

Native FEM GPU context
  - MFEM mesh + FE spaces
  - operator registry: exchange, mass, Poisson, local terms
  - FemGpuState jako source of truth
  - stream/event scheduler

GPU hot loop
  - RK stage assembly
  - H_eff evaluation
  - Poisson demag
  - local terms
  - LLG RHS
  - normalize/project constraints
  - reductions

Async output lane
  - scalar stats D2H
  - scheduled field snapshots
  - pinned staging
  - artifact writer
```

---

## 3. Docelowy layout danych

### 3.1 Source of truth

`Context::m_xyz` i pozostale hostowe `std::vector<double>` nie moga byc zrodlem prawdy w kroku. Zostaja tylko:

- inicjalizacyjnym stagingiem,
- fallbackiem CPU,
- buforem snapshotu po zaplanowanym D2H.

Nowy `FemGpuState`:

```text
device:
  m_x, m_y, m_z
  h_ex_x, h_ex_y, h_ex_z
  h_demag_x, h_demag_y, h_demag_z
  h_ext_x, h_ext_y, h_ext_z
  h_ani_x, h_ani_y, h_ani_z
  h_dmi_x, h_dmi_y, h_dmi_z
  h_eff_x, h_eff_y, h_eff_z
  k[stage][component]
  m_stage_x, m_stage_y, m_stage_z
  error_x, error_y, error_z
  scalar_reduce_workspace
  node/material coefficient arrays
  magnetic masks
  periodic projection maps
  poisson_rhs
  poisson_solution
  poisson_gradient/recovery buffers
```

### 3.2 Layout

Uzywamy SoA na GPU, nie AOS:

- lepsze coalescing,
- latwiejsze fused kernels,
- latwiejszy interop z komponentowymi MFEM GridFunction/Vector.

AOS host jest formatem import/export, nie formatem hot loopu.

### 3.3 Zasada synchronizacji

Wprowadzic jawne stany:

```text
HostClean / HostDirty / DeviceClean / DeviceDirty
```

W hot loopie wymagane jest `DeviceClean`. Host moze byc `HostStale` przez wiele krokow. Snapshot wykonuje `DeviceDirty -> async D2H snapshot`, ale nie zmienia source of truth.

---

## 4. Etapy wdrozenia

### Faza 0: prawda, benchmarki, bramki

Cel: zanim ruszymy obliczenia, usunac mozliwosc samooszukiwania.

Pliki:

- `docs/physics/0xxx-all-in-gpu-fem-runtime.md`
- `docs/plans/active/all-in-gpu-fem-rollout-plan-2026-05-15.md`
- `examples/bench_fem_gpu_long.py`
- `scripts/analysis/fem_gpu_benchmark.py`
- `crates/fullmag-runner/src/dispatch.rs`
- `crates/fullmag-runner/src/native_fem.rs`
- `native/include/fullmag_fem.h`
- `native/backends/fem/src/api.cpp`

Kroki:

1. Dodac publication-style physics/numerics note dla ALL IN GPU FEM.
2. Naprawic benchmark harness: `build()` ma byc bezargumentowy dla CLI, a konfiguracja ma isc z env.
3. Dodac smoke benchmark `coarse/exchange_only/heun/2 steps` dla CPU i GPU.
4. Rozdzielic capability:
   - native FEM CPU available,
   - native FEM GPU available,
   - MFEM CUDA available,
   - hypre GPU available,
   - libCEED built,
   - libCEED used in hot path.
5. Dodac `TransferAudit` do C ABI i telemetry.
6. W provenance zapisywac:
   - `fem_execution_mode`,
   - `fem_data_residency`,
   - `fem_assembly_mode`,
   - `uses_cuda_kernels`,
   - `uses_gpu_poisson`,
   - `hot_loop_host_sync_count`.

Bramka:

```bash
python3 scripts/analysis/fem_gpu_benchmark.py \
  --meshes coarse \
  --scenarios exchange_only \
  --integrators heun \
  --steps 2 \
  --output /tmp/fullmag_fem_gpu_smoke.csv
```

Oczekiwane: CPU i GPU maja `status=ok`; dla GPU provenance nie moze nazywac backendu pelnym GPU, dopoki `hot_loop_host_sync_count > 0`.

### Faza 1: FemGpuState i audyt transferow

Cel: stworzyc jeden obiekt pamieci GPU, jeszcze bez przepinania calego stepera.

Pliki:

- Create: `native/backends/fem/include/gpu_state.hpp`
- Create: `native/backends/fem/src/gpu_state.cu`
- Create: `native/backends/fem/include/transfer_audit.hpp`
- Modify: `native/backends/fem/include/context.hpp`
- Modify: `native/backends/fem/CMakeLists.txt`
- Modify: `native/include/fullmag_fem.h`

Kroki:

1. Dodac `FemGpuState` z alokacja SoA dla `m`, `H_*`, stage buffers i reductions.
2. Dodac `TransferAuditScope::HotLoop`.
3. Owinac wszystkie planowane H2D/D2H i MFEM host access helpers licznikami.
4. Dodac tryb `FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC=1`, ktory failuje, jesli w hot loopie pojawi sie host sync.
5. Dodac tryb `FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1`, ktory w Fazie 2 dopuszcza tylko jawny `ExchangeInterop`, ale failuje RK/LLG/normalize/reductions host sync.
6. Jeszcze nie przelaczac stepera; najpierw tylko instrumentacja i init/upload initial state.

Bramka:

- test create/destroy GPU state bez leakow,
- smoke run nadal dziala,
- audit pokazuje obecny problem zamiast go ukrywac.

### Faza 2: device-resident RK dla exchange-only

Cel: pierwszy prawdziwy GPU hot loop bez demag.

Pliki:

- Create: `native/backends/fem/include/gpu_rk.hpp`
- Create: `native/backends/fem/src/gpu_rk.cu`
- Create: `native/backends/fem/src/gpu_reductions.cu`
- Modify: `native/backends/fem/src/kernels.cu`
- Modify: `native/backends/fem/src/api.cpp`
- Modify: `native/backends/fem/src/mfem_bridge.cpp`

Kroki:

1. Podlaczyc istniejace kernele LLG/normalize zamiast trzymac je jako dead code.
2. Dodac GPU RK stage builder:
   - Heun,
   - RK4,
   - RK23,
   - RK45/DP54 z FSAL.
3. Dodac device-side max norm, max torque, average magnetization i energy reductions.
4. Zrobic exchange-only path z tymczasowym exchange operator interop, ale bez hostowego stepera.
5. Dla tej fazy dopuszczalny jest host sync w exchange, ale nie w RK/LLG/normalize/reductions.

Status implementacji 2026-05-15:

- Heun, RK4, RK23 i RK45 maja pierwsza waska sciezke CUDA RK z call site dla LLG,
  normalize, accumulate H_eff, device reductions oraz device-resident legacy
  sparse exchange dla stage `H_ex`; RK23/RK45 maja tez lokalny scaffold adaptive
  retry/error-control, ale nie sa jeszcze zaakceptowane na realnym CUDA/MFEM.
- `gpu_rk_exchange_only_step` nie wykonuje hot-loop AOS upload/download ani
  `cudaStreamSynchronize`; launch-checki sa nieblokujace po stronie hosta.
- CUB reduction temp storage jest prealokowany w `FemGpuState`; hot loop RK
  wykonuje device max na tym buforze zamiast pytac o rozmiar workspace w kroku.
- GPU RK potrafi promowac clean host/device copy do `device_source_of_truth` bez
  transferu, zeby inicjalny upload nie blokowal przyszlego device-owned hot loopu.
- Fixed-step RK23/RK45 GPU RK zachowuje device-side FSAL `k0` miedzy krokami
  przez D2D copy finalnego RHS metryki, bez host sync; finalna metryka
  zaakceptowanego stanu nadal jest liczona jawnie.
- `FemGpuState` ma device-side `m_backup`, a GPU RK wykonuje D2D backup
  magnetyzacji na poczatku kroku. To jest neutralne dla fixed-step i zamyka
  prerekwizyt pod adaptive reject/retry bez pelnego readbacku pola.
- `gpu_rk.cu` ma helper `restore_adaptive_reject_magnetization_device(...)`,
  ktory kopiuje `m_backup -> m` po odrzuconej probie i uniewaznia FSAL bez
  `cudaStreamSynchronize`.
- `kernels.cu` udostepnia `fullmag_cuda_adaptive_error_norm_blocks(...)` jako
  device-side max scaled embedded error norm dla RK23/RK45. Kernel obsluguje
  krotsze tablice RK23 bez dereferencji `k4..k6` i jest uzywany przez lokalny
  scaffold adaptive retry/error-control w `gpu_rk.cu`.
- `gpu_rk.cu` ma tez helper `compute_adaptive_error_norm_device(...)`, ktory
  uruchamia kernel error-norm blocks, redukuje wynik przez prealokowany CUB
  workspace i wykonuje pojedynczy skalarny readback.
- `gpu_rk.cu` ma helper `gpu_adaptive_pi_step(...)`, ktory uzywa tego samego
  `Context` PI state co CPU path: `prev_error_norm`, `safety_factor`,
  `pi_alpha`, `pi_beta`, `dt_grow_max`, `dt_shrink_min`, `dt_min`, `dt_max`
  oraz `rejected_steps`.
- `gpu_rk_exchange_only_step(...)` ma scaffold adaptive retry loop: ustawia
  `current_dt`, liczy error norm, uruchamia PI decision, przy reject wykonuje
  device restore `m_backup -> m`, aktualizuje `dt_seconds/current_dt`,
  kontynuuje probe i raportuje `error_estimate`, `dt_suggested` oraz
  `rejected_attempts`.
- `gpu_rk_plan_exchange_only(...)` nie blokuje juz adaptive RK23/RK45 osobnym
  powodem, a `context_step_explicit_rk_mfem(...)` dopuszcza RK23/RK45 GPU call
  site niezaleznie od `adaptive_dt_enabled`. Praktyczna aktywacja nadal wymaga
  `legacy_sparse_gpu`, device-resident exchange, CUDA/MFEM build, parity i
  profiler gates.
- Benchmark preflight publikuje `adaptive_gpu_rk_acceptance_ready` oraz
  `adaptive_gpu_rk_acceptance_blockers`, zeby odroznic lokalnie zielony scaffold
  od zaakceptowanej sciezki adaptive GPU RK na hoscie z CUDA/MFEM. Preflight
  sprawdza tez, czy adaptive RK nadal wykonuje hot-loop scalar D2H readback dla
  decyzji accept/reject; dopoki tak jest, acceptance pozostaje zablokowane nawet
  przy dostepnym CUDA/MFEM i `FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1`.
  Preflight wypelnia te pola takze dla `ok_prebuilt` i `invalid_prebuilt`, a `run_backend`
  przenosi je do wiersza CSV dla `fem_gpu`, rowniez gdy binarka GPU jest lokalnie
  niedostepna i wiersz ma `status=missing_binary`.
- Dla `status=missing_binary` w `fem_gpu + exchange_only` benchmark publikuje
  tez `phase2_compute_hot_loop_sync_clean=false` oraz
  `phase2_gate_reason=gpu_binary=missing` oraz jawne
  `error=GPU benchmark binary is missing`, zamiast zostawiac pusta bramke.
- CLI benchmarku ma `--require-adaptive-gpu-rk-acceptance`, ktory zamienia ten
  raport w twardy preflight failure dla akceptacyjnych uruchomien.
- Sam preflight benchmarku ma jawne aliasy `--preflight` i `--preflight-only`,
  a parser ma `allow_abbrev=false`, wiec smoke/CI nie opiera sie na
  automatycznym skrocie argparse.
- `context_step_explicit_rk_mfem` ma kontrolowany call site dla Heun/RK4/RK23/RK45
  exchange-only GPU RK, takze dla adaptive RK23/RK45 po przejsciu planu; CPU
  fallback zostaje aktywny, dopoki plan jest disabled.
- Pozostaje realna akceptacja adaptive RK23/RK45 w srodowisku CUDA/MFEM:
  kompilacja `.cu`, parity accept/reject, profiler, transfer gates, adaptive
  FSAL/error reuse oraz rozszerzenie poza waski wariant
  `exchange_only + Heun/RK4/RK23/RK45 + legacy_sparse + lumped mass + uniform/per-node damping`.
- `fem_gpu_rk_block_reason` ma wskazywac ten prawdziwy blocker, a nie ogolny
  lub nieaktualny opis host-sync.
- Statyczny gate potwierdza, ze hostowa sciezka
  `compute_exchange_for_magnetization` nadal wykonuje
  `copy_host_vector_to_mfem(...)` i `pack_components_to_aos(...)`, wiec nie
  moze byc mylona z device-resident stage exchange.
- Samo istnienie hostowej sciezki `compute_exchange_for_magnetization` nie
  blokuje waskiego `legacy_sparse_gpu`; GPU RK moze raportowac
  `fem_gpu_rk_stage_exchange_device_resident=true` dopiero wtedy, gdy plan
  przejdzie przez `gpu_exchange_plan_stage_exchange(...)` i stage `H_ex` omija
  ten hostowy fallback.
- `phase2_gate_reason` dopisuje teraz `gpu_rk_block_reason`, gdy stage exchange
  nie jest device-resident, gdy brakuje licznika compute sync albo dla
  `runtime_contract_violation`, jezeli provenance dostarcza konkretny powod
  blokady.
- Jezeli run GPU konczy sie `status=failed` zanim powstanie phase2 provenance,
  benchmark rozroznia to jako `phase2_gate_reason=run_failed_before_phase2_provenance`.
- Dla nieudanego runu kolumna CSV `error` zachowuje poczatek i koniec dlugiego
  stderr/stdout, zeby koncowy `fallback_reason` albo natywny powod awarii nie
  zostal obciety przez limit dlugosci.
- Bramka `phase2_compute_hot_loop_sync_clean` wymaga teraz dwoch warunkow:
  `hot_loop_compute_host_sync_count == 0` oraz
  `fem_gpu_rk_stage_exchange_device_resident == true`.
- Jezeli `fem_gpu_rk_exchange_only_enabled=true` przy
  `fem_gpu_rk_stage_exchange_device_resident != true`, benchmark raportuje
  `runtime_contract_violation=exchange_only_enabled_without_stage_exchange_device_resident`.
- `FULLMAG_FEM_ALL_IN_GPU=1` albo `FULLMAG_FEM_EXECUTION=all_in_gpu` sa
  fail-fast: runner odrzuca `hybrid_legacy_sparse` z
  `fallback_reason=all_in_gpu_contract_unmet` oraz `gpu_rk_block_reason`,
  zamiast pozwalac na cichy fallback albo pol-GPU runtime.
- Ten sam kontrakt obejmuje sciezke `RuntimeRegistry`: `FULLMAG_FEM_ALL_IN_GPU=1`
  wymusza `device=gpu` takze wtedy, gdy `runtime_selection.device=cpu` pochodzi
  z IR, wiec rejestrowy resolver nie moze obejsc all-in GPU przez CPU runtime.
- Natywny C ABI smoke test `fem_gpu_state_info` sprawdza rowniez, ze
  `fullmag_fem_backend_get_gpu_rk_plan_info(...)` nie raportuje
  `stage_exchange_device_resident=1` przed Phase 2 i zwraca niepusty powod
  blokady planu.
- `native/backends/fem/include/gpu_exchange.hpp` i
  `native/backends/fem/src/gpu_exchange.cpp` centralizuja plan operatora
  stage exchange. `gpu_rk_plan_exchange_only(...)` zalezy teraz od
  `gpu_exchange_plan_stage_exchange(...)`, wiec wlaczenie GPU RK wymaga
  jawnego przejscia kontraktu `stage_exchange_device_resident`.
- Tryb operatora exchange przechodzi maszynowo przez
  `fem_exchange_operator_mode` w C ABI, Rust provenance i CSV benchmarku.
  Tryb `legacy_sparse_gpu` jest dopuszczony tylko dla waskiego wariantu:
  MFEM+CUDA, device-resident runtime coefficients, device-resident CSR/mass,
  lumped mass, uniform/per-node damping, brak periodic exchange i brak
  consistent-mass projection.
- Bramka `phase2_compute_hot_loop_sync_clean` odrzuca teraz rowniez przypadek
  `stage_exchange_device_resident=true` z `fem_exchange_operator_mode=unsupported`
  albo brakujacym trybem operatora.
- Ten sam warunek obowiazuje w runtime fail-fast: `ALL_IN_GPU` odrzuca
  `fem_exchange_operator_mode=unsupported`, nawet gdy `exchange_only_enabled`
  i `stage_exchange_device_resident` sa ustawione na `true`.
- `Context` przechowuje teraz metadane zlozonego legacy sparse exchange
  (`gpu_exchange_legacy_sparse_*`) oraz gotowosc lumped mass po inicjalizacji
  MFEM. `gpu_exchange_plan_stage_exchange(...)` odroznia brak tych metadanych,
  brak uploadu CSR/mass oraz nieobslugiwane warianty mass/periodic.
- `FemGpuState` ma juz pola na device-resident legacy sparse exchange CSR
  oraz lumped/inv-lumped mass, wraz z funkcja
  `gpu_state_upload_exchange_legacy_sparse(...)`.
- Inicjalizacja MFEM przechwytuje `exchange_form->SpMat()` i przygotowuje
  lumped mass, ale sam upload CSR/mass jest wykonywany dopiero po
  `gpu_state_initialize(...)` oraz uploadzie wspolczynnikow runtime. To jest
  wazne: wczesniejszy upload przed alokacja `FemGpuState` bylby no-op i nie
  odblokowalby `legacy_sparse_gpu`.
- `kernels.cu` ma device-side legacy sparse exchange kernel
  (`K*m`, skalowanie przez `inv_lumped_mass` oraz `Ms`), a fixed-step
  `gpu_rk_exchange_only_step(...)` przelicza `H_ex` dla stage'y Heun/RK4/RK23/RK45
  bez `copy_host_vector_to_mfem(...)` / `pack_components_to_aos(...)`.
- Po zaakceptowaniu kroku Heun/RK4/RK23/RK45 GPU przelicza finalne `H_ex/H_eff` dla
  zaakceptowanego i znormalizowanego `m`, wiec device pola nie zostaja
  zatrzymane na predictor stage.
- `max_dm_dt` nie jest juz falszowany jako zero w GPU RK. Redukcja zostaje
  wykonana na device dla finalnego zaakceptowanego `m` po odswiezeniu
  finalnego `H_ex/H_eff`, a pojedynczy skalarny D2H jest wykonywany po wyjsciu
  z `TransferAuditScope::HotLoop`, jako dozwolona telemetryka.
- `gpu_rk_finalize_step_stats(...)` uzupelnia teraz device-side metryki dla
  waskiego exchange-only wariantu: `E_ex`, opcjonalne `E_ext` dla uniform
  Zeeman, opcjonalne `E_ani` dla uniaxial/cubic anisotropy, `E_total`,
  opcjonalne `E_mel` dla uniform albo per-node prescribed strain,
  `max |H_eff|`, `max |m x H_eff|` oraz srednia magnetyzacje `mx/my/mz` bez
  pelnego readbacku pola. Uniform external field, uniaxial anisotropy i cubic
  anisotropy, precomputed Oersted, uniform albo per-node magnetoelastic
  prescribed strain oraz Slonczewski STT z jawna albo geometry-derived gruboscia warstwy nie sa juz osobnymi blockerami
  planu GPU RK, bo ich pola, energie albo torque maja device-side sciezki na
  `Ms`, `Ku/Ku2`, `Kc1/Kc2/Kc3`, lumped mass, `H_ext`, `H_ani`,
  `H_cubic_ani`, `H_oe`, `H_mel` i Slonczewski RHS.
- Nieobslugiwane lokalne termy i torques maja teraz konkretne powody blokady
  w `gpu_rk_plan_exchange_only(...)` (`DMI`, `thermal`, `Zhang-Li STT`),
  zamiast ogolnego "local terms".
- Po wypelnieniu device-side metryk GPU RK wywoluje wspolna logike
  `stage_completion`, wiec kryteria relaksacji/limity krokow nie sa omijane
  przez wczesny powrot z `context_step_explicit_rk_mfem(...)`.
- Wczesny powrot GPU RK wypelnia `wall_time_ns`, zeby benchmark/provenance nie
  dostawaly kroku o zerowym czasie sciennym.
- `snapshot_stats` oraz `context_refresh_exchange_field_mfem(...)` synchronizuja
  device-source magnetyzacje do `ctx.m_xyz` przed CPU/MFEM rekalkulacja pol,
  wiec zaplanowany snapshot nie liczy energii ze starego hostowego stanu.
  Lokalna walidacja bez CUDA przechodzi dla `fem_gpu_rk_plan`,
  `fem_gpu_state_info`, `fem_transfer_audit`, statycznych kontraktow Python
  oraz testow runnera `fem-gpu` dla `gpu_rk` i `all_in_gpu`. Pozostaly warunek
  domkniecia to build/benchmark/parity/profiler na realnym MFEM+CUDA
  srodowisku oraz rozszerzenie poza waski `exchange_only + Heun/RK4/RK23/RK45`
  wariant.

Bramka:

```text
exchange_only:
  - phase2_compute_assertion_enabled == true
  - hot_loop_compute_host_sync_count == 0
  - phase2_compute_hot_loop_sync_clean == true
  - exchange host sync jest dozwolony tylko jako TransferAuditScope::ExchangeInterop
  - CPU vs GPU parity po 1, 10, 100 krokach
  - kernele z kernels.cu maja realne call sites
```

### Faza 3: exchange/mass bez host roundtrip

Cel: usunac `copy_host_vector_to_mfem`, `copy_mfem_vector_to_host`, `HostRead/HostWrite` ze sciezki exchange.

Pliki:

- Create: `native/backends/fem/include/gpu_exchange.hpp`
- Create: `native/backends/fem/src/gpu_exchange.cpp`
- Modify: `native/backends/fem/src/mfem_bridge.cpp`
- Modify: `native/backends/fem/examples/pa_benchmark.cpp`
- Modify: `scripts/analysis/fem_gpu_benchmark.py`

Kroki:

1. Zrobic MFEM GridFunction/Vector interop z device pointers z `FemGpuState`.
2. Wariant A: `legacy_sparse` assembled SpMV na GPU.
3. Wariant B: `partial_assembly`/libCEED.
4. Rozszerzyc `pa_benchmark` na realne meshe benchmarkowe.
5. Wybrac domyslna sciezke na podstawie pomiarow:
   - P1 tet small,
   - P1 tet medium,
   - P1 tet large,
   - mixed magnetic/air.
6. Wprowadzic `fem_exchange_operator_mode = legacy_sparse_gpu | partial_assembly_gpu`.

Bramka:

```text
exchange_only:
  - hot_loop_host_sync_count == 0
  - exchange_wall_time_ns raportowane osobno
  - selected operator mode zapisany w provenance
```

### Faza 4: lokalne oddzialywania na GPU

Cel: wszystkie lokalne termy przestaja byc CPU loops.

Pliki:

- Create: `native/backends/fem/include/gpu_local_terms.hpp`
- Create: `native/backends/fem/src/gpu_local_terms.cu`
- Modify: `native/backends/fem/src/context.cpp`
- Modify: `native/backends/fem/src/mfem_bridge.cpp`
- Modify: `crates/fullmag-runner/src/native_fem.rs`

Zakres:

1. Zeeman uniform/spatial/time-dependent.
2. Uniaxial anisotropy.
3. Cubic anisotropy.
4. Interfacial DMI.
5. Bulk DMI.
6. Zhang-Li STT.
7. Slonczewski STT.
8. Oersted precomputed field + time modulation.
9. Magnetoelastic prescribed strain.
10. Thermal field:
    - albo deterministic GPU RNG z seed/provenance,
    - albo jawny CPU-only fallback, ktory blokuje `ALL_IN_GPU=true`.

Status implementacji 2026-05-15:

- Waski slice `exchange_only` ma juz uniform Zeeman, uniaxial anisotropy,
  cubic anisotropy, interfacial/bulk DMI dla linear tetra weak residual,
  precomputed Oersted, uniform/per-node magnetoelastic prescribed strain,
  deterministic thermal field z jawnym seedem, Zhang-Li STT z device mesh geometry oraz
  Slonczewski STT z jawna albo geometry-derived gruboscia warstwy w istniejacej sciezce
  GPU RK: `h_ext`, `h_ani`, `h_cubic_ani`, `h_dmi`, `h_bulk_dmi`, `h_oe`, `h_mel` i `h_therm` sa dodawane do
  `H_eff` na device, `E_ext`, `E_ani`, `E_dmi` i `E_mel` sa redukowane na GPU,
  Slonczewski i Zhang-Li torque sa dodawane do RHS na device, a `E_total` obejmuje
  `E_ex + E_ext + E_ani + E_dmi + E_mel`.
- Spatial/time-dependent Zeeman i thermal bez jawnego seedu nadal
  pozostaja poza sciezka all-in GPU i musza failowac jawnie zamiast wpadac w
  cichy CPU/hybrid fallback.

Bramka:

```text
exchange_dmi, stt_oersted, anisotropy_cubic:
  - local_terms_host_sync_count == 0
  - parity z CPU native/reference w tolerancjach fizyki
  - readback tylko dla scheduled snapshots
```

### Faza 5: GPU demag Poisson

Cel: demag nie moze byc hostowym waskim gardlem.

Pliki:

- Create: `native/backends/fem/include/gpu_demag_poisson.hpp`
- Create: `native/backends/fem/src/gpu_demag_poisson.cpp`
- Create: `native/backends/fem/src/gpu_demag_recovery.cu`
- Modify: `native/backends/fem/src/mfem_bridge.cpp`
- Modify: `native/backends/fem/include/context.hpp`
- Modify: `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
- Modify: `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`

Kroki:

1. Utrzymac Poisson operator i solver workspace persistent.
2. Usunac tworzenie nowego `LinearForm` w kazdym RHS.
3. RHS assembly wykonac jako GPU kernel albo MFEM device integrator bez HostRead.
4. Hypre vectors maja pozostac w pamieci device.
5. Warm-start potencjalu zostaje na device.
6. `H_demag = -grad u` recovery wykonac na GPU.
7. Demag energy reduction wykonac na GPU.
8. `field_refresh.demag_interval_s` opisac jako inexact demag policy w provenance.
9. Dla RK dodac polityke tolerancji Poissona:
   - predictor/stage tolerance,
   - final/accepted-step tolerance,
   - adaptive coupling z bledem czasowym.

Bramka:

```text
exchange_demag:
  - demag_hot_loop_host_sync_count == 0
  - demag_solve_count == rhs_evals, chyba ze field_refresh jawnie zamraza demag
  - poisson_iterations i residual w telemetry
  - sphere/ellipsoid validation dla Dirichlet/Robin
```

### Faza 6: constraint projection i PBC na GPU

Cel: PBC i maski nie moga cofac hot loopu na CPU.

Pliki:

- Create: `native/backends/fem/src/gpu_constraints.cu`
- Modify: `native/backends/fem/include/context.hpp`
- Modify: `native/backends/fem/src/mfem_bridge.cpp`

Kroki:

1. Magnetic-node zeroing jako GPU kernel.
2. Periodic representative projection jako GPU gather/scatter kernel.
3. Reduced periodic mass operations bez hostowych `std::vector` reductions.
4. Compatibility matrix: jezeli dana kombinacja PBC/operator nie ma GPU implementation, `ALL_IN_GPU` musi failowac, nie fallbackowac po cichu.

Bramka:

```text
periodic exchange-only:
  - parity z reference reduction
  - no hot-loop host sync
```

### Faza 7: async output lane

Cel: artefakty nie moga blokowac compute.

Pliki:

- Create: `native/backends/fem/include/gpu_snapshot.hpp`
- Create: `native/backends/fem/src/gpu_snapshot.cu`
- Modify: `native/backends/fem/src/api.cpp`
- Modify: `crates/fullmag-runner/src/artifact_pipeline.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`

Kroki:

1. Dwa pinned host buffers dla field snapshots.
2. `compute_stream` i `io_stream` z eventami.
3. Scalar stats jako maly async D2H packet.
4. Field snapshots tylko zgodnie z output schedule.
5. Brak `copy_field()` pelnego pola po kazdym kroku.
6. Binary artifact path dla duzych pol.

Bramka:

```text
snapshot-heavy run:
  - compute stream nie czeka na writer poza backpressure limit
  - snapshot_wall_time_ns osobno raportowane
  - step_time p95 stabilne
```

### Faza 8: capability, fallback i runtime contract

Cel: uzytkownik i UI zawsze wiedza, czy dziala ALL IN GPU, hybrid czy CPU.

Pliki:

- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`

Nowe semantyki:

```text
fem_gpu_mode:
  hybrid_legacy_sparse
  all_in_gpu_legacy_sparse
  all_in_gpu_partial_assembly

fem_gpu_residency:
  host_source_of_truth
  mixed
  device_source_of_truth

fem_gpu_degraded_reason:
  unsupported_interaction
  unsupported_pbc
  missing_hypre_gpu
  partial_assembly_disabled
  thermal_cpu_only
  benchmark_gate_failed
```

Zasada: gdy uzytkownik wymaga `ALL_IN_GPU`, fallback do CPU albo hybrid jest bledem, nie ostrzezeniem.

Bramka:

```text
FULLMAG_FEM_EXECUTION=gpu FULLMAG_FEM_GPU_MODE=all_in_gpu:
  - unsupported term => clear error
  - supported term => provenance device_source_of_truth
```

### Faza 9: walidacja fizyczna i numeryczna

Cel: nie mylic szybkiego solvera z poprawnym solverem.

Walidacje:

1. Exchange:
   - CPU native vs GPU,
   - analytic spin wave / manufactured field.
2. Demag:
   - sphere/ellipsoid,
   - airbox factor convergence,
   - Robin beta variants.
3. DMI:
   - interfacial i bulk parity,
   - sign/orientation tests.
4. STT/Oersted:
   - known direction and amplitude tests.
5. Thermal:
   - seed reproducibility,
   - distribution moments.
6. Integrators:
   - Heun/RK4/RK23/RK45 consistency,
   - adaptive reject/accept parity.
7. Conservation/relaxation:
   - monotonic energy under damping-only relaxation where expected,
   - torque convergence.

Bramka:

```text
cargo test -p fullmag-runner --features fem-gpu native_fem
python3 scripts/analysis/fem_gpu_benchmark.py --meshes coarse,bench,fine --scenarios exchange_only,exchange_demag,exchange_dmi,stt_oersted --integrators heun,rk4,rk23,rk45 --steps 100
```

### Faza 10: performance gates i cutover

Cel: usunac hostowy hot loop jako domyslna sciezke GPU.

Metryki:

- median step_time_ms,
- p95 step_time_ms,
- RHS eval time,
- demag solve time,
- demag recovery time,
- local terms time,
- D2H/H2D bytes per step,
- host sync count,
- GPU memory usage,
- Poisson iterations,
- artifact backpressure.

Cutover:

1. `hybrid_legacy_sparse` zostaje jako debug/fallback.
2. `all_in_gpu_legacy_sparse` staje sie domyslnym GPU dla P1 tet, jezeli benchmark gate przechodzi.
3. `all_in_gpu_partial_assembly` zostaje wlaczone tylko dla mesh/operator families, gdzie wygrywa benchmark.
4. Dokumentacja i UI nie moga nazywac hybrid sciezki pelnym GPU.

Bramka koncowa:

```text
FULLMAG_FEM_GPU_MODE=all_in_gpu:
  - no hot-loop HostRead/HostWrite
  - no per-stage memcpy
  - CPU wykorzystanie ograniczone do orchestration/I/O
  - GPU profiler pokazuje operator/RK/reduction kernels w hot loop
  - provenance: fem_gpu_residency=device_source_of_truth
```

---

## 5. Kolejnosc implementacji bez polsrodkow

Nie zaczynac od demag. Najpierw trzeba usunac hostowy stepper, bo inaczej kazda optymalizacja demag nadal bedzie ladowac w CPU/GPU ping-pong.

Rekomendowana kolejnosc:

1. Faza 0: benchmark i TransferAudit.
2. Faza 1: `FemGpuState`.
3. Faza 2: RK/LLG/redukcje na GPU.
4. Faza 3: exchange bez host roundtrip.
5. Faza 4: lokalne termy.
6. Faza 5: demag Poisson GPU.
7. Faza 6: constraints/PBC.
8. Faza 7: async output lane.
9. Faza 8-10: capability, validation, cutover.

Pierwszy prawdziwy kamien milowy:

```text
exchange_only + Heun:
  - device_source_of_truth
  - no hot-loop host sync
  - CPU/GPU parity
  - GPU faster than CPU for medium mesh
```

Dopiero po tym przenosimy demag. Jesli zaczniemy od demag, ryzykujemy duzy patch bez systemowego usuniecia glownej choroby architektury.

---

## 6. Zasady zakazujace regresji

1. Nowy kod GPU nie moze czytac pelnego pola na host tylko po to, zeby policzyc skalar.
2. `HostRead/HostWrite` w hot loopie wymaga jawnego `TransferAuditScope` i testu, ktory pokazuje, ze nie jest wykonywany w `ALL_IN_GPU`.
3. Kazdy fallback z `ALL_IN_GPU` do hybrid/CPU musi byc bledem przy explicit request.
4. Snapshot pola nie moze byc ukrytym `copy_field()` po kazdym stepie.
5. Status "done" w planie oznacza:
   - call site istnieje,
   - benchmark przechodzi,
   - profiler potwierdza brak host sync,
   - provenance raportuje prawde.
6. `libCEED built` nie znaczy `libCEED used`.
7. `mfem::Device("cuda")` nie znaczy `device_source_of_truth`.

---

## 7. Minimalny podzial PR-ow

1. PR-0: physics note + benchmark harness fix + TransferAudit ABI.
2. PR-1: `FemGpuState` + init/upload/download only outside hot loop.
3. PR-2: GPU RK/LLG/reductions dla exchange-only skeleton.
4. PR-3: exchange/mass device path + operator mode provenance.
5. PR-4: local terms GPU pack.
6. PR-5: Poisson demag GPU path.
7. PR-6: PBC/constraints GPU.
8. PR-7: async snapshots/artifacts.
9. PR-8: capability/OpenAPI/UI telemetry.
10. PR-9: cutover gates + remove misleading hybrid defaults.

Kazdy PR musi miec:

- test jednostkowy lub parity test,
- benchmark smoke,
- provenance assertion,
- TransferAudit assertion,
- opis statusu "implemented today vs target-only".

---

## 8. Najwieksze ryzyka

1. MFEM/Hypre memory ownership moze wymusic host copies, jesli interop bedzie zrobiony naiwnie.
2. PA/libCEED moze byc wolniejsze lub niestabilne dla P1 tet; nie wolno blokowac all-in GPU na PA.
3. Demag recovery moze stac sie wiekszym kosztem niz solve; musi byc device-side.
4. Thermal GPU RNG moze rozjechac reproducibility; wymaga osobnego qualification gate.
5. Adaptive RK z rejectami moze ukryc dodatkowe solves; telemetry musi raportowac RHS evals, rejected attempts i demag solves.
6. UI/live artifacts moga wymuszac za czeste readbacki; output schedule musi byc twardym kontraktem.

---

## 9. Decyzja na teraz

Najlepsza produkcyjna droga to nie "dokleic kilka kernelow", tylko zmienic kontrakt runtime:

```text
Host-owned FEM context
  -> Device-owned FemGpuState
  -> GPU operators and integrator
  -> async output lane
  -> truthful runtime/provenance contract
```

Pierwsza implementacja powinna zaczac sie od Fazy 0 i Fazy 1. Bez benchmark harnessu i TransferAudit kazda dalsza praca bedzie niezweryfikowana.
