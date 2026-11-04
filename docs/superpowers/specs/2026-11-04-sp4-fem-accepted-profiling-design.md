# FEM SP4: profil przyjętego przebiegu i pełny ślad CUDA

## Cel i aktualny dowód

Ustalić rzeczywiste koszty FEM CPU/GPU, transfery i oczekiwanie CPU/GPU w tym samym zarządzanym SP4 R2. Nie zmieniać siatki, m0, materiałów, tolerancji, integratora, timestep ani cadence zapisu. Każdy rzeczywisty bieg ma oryginalny Zarr. Krótki profil nie zastępuje czterech pełnych FEM A/B po1ns ani końcowego porównania MuMax3 GPU.

CPU fixed-coupling A/B d34/e311 zakwalifikowano dla 1/2/6 wątków: średni callback interval spadł 2.60/3.35/3.45 raza, a solve Poissona pozostał dominującym kosztem. To nie jest dowód przyspieszenia GPU. Historyczne szczegółowe timery HYPRE były wyłączone; liczniki Fullmag nie obejmują wszystkich operacji wewnątrz MFEM/HYPRE.

## Pierwszy etap: istniejący profil faz

Wykorzystać istniejący `solver_profile`, `SolverProfileState` i zasób `diagnostics/solver-profile`. Nie dodawać endpointu ani osobnego workspace. Profil pozostaje off domyślnie. Accepted wymaga `persist_artifact=true`, `emit_engine_log=false`; obowiązują istniejące normalizacja i limit `max_samples<=4096`.

Konfiguracja musi trafić do RunSpec przed acceptance. Dodać opcjonalne `solver_profile` do istniejącego startup requestu: dokładnie wersjonowany wrapper `accepted_solver_profile.v1` z sześcioma istniejącymi polami config. CLI `activate-script` i `run-script` otrzymują jawne `--solver-profile`; wybiera preset enabled=true, sample_every=1, sample_interval_wall_ms=0, max_samples=128, emit_engine_log=false, persist_artifact=true. Brak flagi pomija pole i zachowuje dotychczasowy kontrakt.

Wybrany profil jest częścią semantycznej tożsamości activation request/receipt/provenance, a odpowiedź potwierdza `solver_profile_sha256` zgodne z przyjętym parametrem. Ten sam request_id z innym profilem nie może być przyjęty jako replay. Walidować konfigurację przed skutkami ubocznymi. Nie polegać na wyścigu komendy podczas placeholdera activating ani na zmianie już przyjętego RunSpec. `wait_for_solve` pozostaje wyłącznie bramką Compute.

Admission dopuszcza istniejące ClosedLoopInspection i FEM primitive Run/Relax zgodne z dokładnym Study/catalog/planem. Inne etapy i FDM z tym parametrem nadal mają zostać odrzucone przed acceptance, także w ścieżkach projektu/batch. Worker ponownie sprawdza immutable parametry przed dispatch. Nie poszerzać praw do fizyki, solverów, fallbacku, device lub precision.

Supervisor jawnie ustawia `FULLMAG_FEM_STEP_PROFILE=1` tylko dla odpowiedniego przyjętego FEM profilu; w pozostałych workerach usuwa zmienną z dziedziczonego środowiska. Nie zmieniać PID, claim, lease, CPU/GPU allocation, heartbeat, stop/drain ani procesu native.

Callback FEM używa istniejącego bounded `SolverProfileState`. Sampling, warmup i finalizacja nie tworzą dodatkowych scientific steps ani podwójnych accepted-step counters. Nie dodawać osobnej implementacji wzorów faz w API.

Nowy `worker_step_profile.v1.json` jest osobny od `worker_operation_profile.v1.json`. Wiąże immutable attempt identity, config digest, outcome completed/cancelled/failed i snapshot. Snapshot ma ograniczoną liczbę samples, brak operation samples, poprawne skończone wartości/identyfikatory faz oraz spójne sequence/span. Odczyt odmawia pliku większego niż32MiB przed alokacją. Persist/load nie zmienia znaczenia starych operation receipts. Błędny lub częściowy zapis nie jest zielonym dowodem profilu; błąd diagnostyki nie może maskować rzeczywistego błędu solvera ani fabrykować wyniku naukowego.

Istniejący accepted projector czyta wyłącznie attempt należący do aktualnego catalog/Start i publikuje snapshot przez ten sam resource. Zmiana samych writerów bez readera nie spełnia kontraktu. Publiczny kształt `SolverProfileResource` pozostaje ten sam; jeśli implementacja potrzebuje zmiany schematu, trzeba jawnie zmienić OpenAPI i wygenerowany transport.

## Drugi etap: pełny ślad CUDA

Decyzja roota: osobny moduł CUPTI pod `backends/fem/gpu/cuda/runtime/`, w tym samym PID. Zwykły wrapper nsys zmieniłby spawn-root PID zapisany przez supervisor w process-exit receipt; nie jest przezroczystą podmianą. Istniejący nsys2024.3.2 nie daje potwierdzonego attach do już działającego PID. Własny CUPTI hook jest wyborem implementacyjnym, obecnie niewykonanym.

Capture CUDA ma osobny jawny opt-in i limity czasu, buforów oraz rozmiaru; nie włącza się automatycznie z tanim profilem faz. Przed ustaleniem ABI i formatu odczytać oficjalne headers/samples faktycznego CUPTI12.6. Rejestrować runtime/driver API, kernele, memcpy/memset, synchronizacje, alokacje oraz correlation/stream/context IDs. Raportować dropped records, overflow, timestamp domain, overhead i partial/failed outcome. Disabled nie aktywuje CUPTI i nie tworzy trace. Nie dodawać GPU synchronizacji dla samego pomiaru, nie zmieniać polityki Stop i nie wyciszać CUDA719.

## Weryfikacja i znaczenie wyniku

Etap1 wymaga testów admission, startup identity/replay, explicit child env, bounded receipt/readback, błędów persistence, finalizacji i zgodności ClosedLoopInspection. Etap2 wymaga osobnego native contract i rzeczywistych activity records. Sam profil faz nie kwalifikuje pełnego śladu CUDA.

W runtime wykonać identyczne krótkie SP4 R2 on/off z oryginalnym Zarr. Osobno setup, warmup, steady state, autosave/UI i finalizacja. Sprawdzić m, osiem energii, torque, accepted/rejected attempts, iterations/residual i końcowy czas. Raportować koszt profilera. Rozróżniać host blocking, device event waits, enqueue wall i kernel elapsed; nie sumować nakładających się okien. Nie zastępować tych dowodów fixture, samym wykryciem GPU lub licznikami Fullmag.
