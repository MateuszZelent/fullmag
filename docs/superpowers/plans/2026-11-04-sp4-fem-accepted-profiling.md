# FEM SP4 Accepted Profiling Implementation Plan

> **For agentic workers:** realizować zadania krok po kroku przez subagent-driven-development albo executing-plans. Współdzielony worktree; nie stage'ować ani nie cofać zmian innych właścicieli.

**Goal:** Umożliwić deterministyczny, ograniczony profil faz rzeczywistego accepted FEM SP4 i następnie pełny ślad CUDA bez zmiany procesu solvera.

**Architecture:** Istniejący startup request przekazuje wersjonowany solver_profile przed RunIntent. Native pozostaje w tym samym workerze; istniejące SolverProfileState/resource dostają osobny step receipt. CUPTI stanowi kolejny, osobno kwalifikowany etap.

**Tech Stack:** Rust API/runner, Python managed Compose launcher, istniejący MFEM/HYPRE/CUDA backend, oryginalny Zarr.

**Spec:** `docs/superpowers/specs/2026-11-04-sp4-fem-accepted-profiling-design.md`.

## Global Constraints

- Brak flagi = dotychczasowe request bytes/semantyka i profiling off; nie dziedziczyć ambient FULLMAG_FEM_STEP_PROFILE.
- Jawny preset --solver-profile: wrapper accepted_solver_profile.v1, enabled=true, sample_every=1, sample_interval_wall_ms=0, max_samples=128, emit_engine_log=false, persist_artifact=true.
- Nie zmieniać fizyki, tolerancji, siatki, m0, solvera, timestep, output cadence, PID/claim/lease ani native stop/drain.
- Zachować operation profile v1; nowy worker_step_profile.v1.json, max4096 samples,32MiB read cap, tylko exact catalog/Start identity.
- Wszystkie app/native builds tylko przez managed launcher w stałym backendzie grupy zadania. Bez host cargo/cmake, sidecara i obcego target/cache.
- Nie dotykać 43 nieśledzonych plików scenariuszy ani cudzego external_solvers/3. Root odpowiada za commit, PR, CI, merge i managed execution.

## Review Focus

- Replay request_id z różnym profilem: odrzucenie, nie odzyskanie starego runu.
- Explicit disabled/absent i ambient env: brak pomiarów, writerów i profilu w niewłaściwym workerze.
- FDM, mieszany lub unsupported Study: odmowa przed RunIntent acceptance we wszystkich entrypoints.
- Finalizacja/cancel/CUDA error: brak podwójnych kroków i maskowania rzeczywistego native outcome.
- Duży/uszkodzony receipt lub inny attempt/config: bounded refusal, bez wczytania obcych danych i bez zielonej kwalifikacji.

### Task 1: Pythonowy transport jawnego opt-in

**Owner:** Luna worker `fem_mesh_scene_python`, wyłącznie `scripts/docker_startup_script.py`, `scripts/docker_volume_activate.py`, `scripts/docker_dev_run_script.py`, konieczny reader/reconcile w `scripts/docker_volume_dev.py` i `scripts/docker_volume_activation_reconcile.py`, parser/wiring w `scripts/docker_dev.py` i ich skupione istniejące testy.

**Consumes:** opcjonalny wrapper `solver_profile` opisany w spec; odpowiedź startup z opcjonalnym solver_profile_sha256. **Produces:** `--solver-profile` w activate-script/run-script, deterministic request/receipt identity i przekazanie wrappera do serwera przed acceptance.

- [ ] Dodać RED: absent zachowuje legacy payload, opt-in ma dokładny preset; odrzucić nieprawidłowy profil; różny profil zmienia semantic activation identity; brak/obcy response digest odmawia sukcesu.
- [ ] Dodać minimalny transport przez istniejące funkcje; nie dodawać arbitralnego shell, ambient env ani osobnego request file/controller.
- [ ] Uruchomić lekkie skupione testy Python, sprawdzić diff/legacy fixtures. Nie budować/uruchamiać usług i nie commitować samodzielnie.

### Task 2: Rust admission, worker profile i readback

**Owner:** Sol worker `cold_group_budget_restore`, wyłącznie `crates/fullmag-api/src/accepted_solver_profile.rs`, `accepted_study_worker.rs`, `accepted_fem_study_worker.rs`, `accepted_study_supervisor.rs`, usunięcie ambient env w `accepted_fem_preparation_supervisor.rs`, `docker_startup.rs`, `live_accepted_execution.rs`, helper profilu w `live_accepted_projection.rs`, właściwe call sites w `router_v2/handlers/persistence/{projects,run_intent_preparation}.rs` oraz odpowiednie skupione testy. Nowy mały moduł accepted step profile dopuszczony, jeżeli utrzymuje osobną odpowiedzialność.

**Consumes:** startup wrapper z Task1. **Produces:** zatwierdzony immutable RunSpec parameter, response digest, per-child env set/remove, bounded FEM samples/receipt i istniejący solver-profile resource.

- [ ] Dodać regresje dla dopuszczonego strict FEM CPU/GPU Run/Relax, odrzucenia FDM/unsupported, zmian profilu przy replay oraz niezmienionej ClosedLoopInspection.
- [ ] Walidować exact Study/catalog/plany przed acceptance we wszystkich entrypoints. Startup przekazuje jawnie profil, bez czytania mutowalnego snapshotu w oknie activating.
- [ ] Ustawić/usunąć FULLMAG_FEM_STEP_PROFILE na Command dziecka z immutable RunSpec; regresja dla ambient inherited value i default off.
- [ ] Użyć istniejącego SolverProfileState w callback/finalizacji; osobny wersjonowany step receipt, finite/bounded shape, exact identity/config/outcome i32MiB cap przed odczytem.
- [ ] Podłączyć accepted projection/load; zachować operation v1. Testy malformed/oversized/other-attempt, cancel/error i błędów persistence; nie maskować native result.
- [ ] Wykonać dostępne bez kompilacji kontrole. Rust unit tests uruchamia zgodne CI, a managed build/runtime root; nie wykonywać host cargo/cmake ani ręcznego Docker build/test. Nie stage'ować/commitować.

### Task 3: Integracja i rzeczywisty profil faz

**Owner:** Root — powyższa spec/plan, nota i source map `docs/physics/0431-fem-demag-mixed-order-potential.md`, testy/CI i operacje runtime. Istniejąca nota0817 jest kontekstem niezmienionych faz.

- [x] Zakończyć integrację PR394 po właściwych aktualnych kontrolach; zachować worktree jako aktywny konsument całego celu SP4. Merge/local master `7c38c65085a16c92f96f024f486156003bacfc3e`, 5/5 workflow success; nowy branch profilu bazuje na tym commicie.
- [ ] Przejrzeć źródła workerów, testy Python i CI Rust; zintegrować na branchu następnego etapu z najnowszego mastera. Nie powtarzać niezmienionego A/B CPU bez nowej przyczyny.
- [ ] Drain i managed build w tej samej grupie; przypiąć commit/snapshot/native library i required native gate. Oryginalne Zarr/lease/proweniencja pozostają zachowane.
- [ ] Wykonać krótkie R2 on/off przez ten sam managed run-script. Potwierdzić RunSpec/profile digest, native nonzero detailed samples, receipt/resource readback, m/osiem energii/torque i koszt profilu. Zarr każdego biegu zachować.

### Task 4: Pełny ślad CUDA i domknięcie celu

**Owner:** Root, kolejny bounded worker dopiero po doprecyzowaniu ABI z oficjalnych CUPTI12.6 headers/samples. Owning native module pod `backends/fem/gpu/cuda/runtime/`.

- [ ] Ustalić osobny jawny opt-in, bounded capture/format i lifecycle w tym samym PID; dopisać osobny kontrakt/testy przed implementacją. To nadal niewykonana część pełnego profilu.
- [ ] Zakwalifikować native capture, dropped/partial/error behavior oraz prawdziwe records runtime/driver/kernel/memcpy/sync/allocation na produkcyjnym SP4; porównać on/off naukę i overhead.
- [ ] Na podstawie pomiaru poprawić wykazane wąskie gardła, zweryfikować before/after i włączyć poprawki do najnowszego mastera.
- [ ] Dokończyć cztery pełne FEM A/B po1ns, finalny replay FDM CPU, wszystkie energie/torque/static states z MuMax3 GPU i UI, zachowując każdy Zarr; dopiero wtedy qualified cleanup i zamknięcie całego celu.
