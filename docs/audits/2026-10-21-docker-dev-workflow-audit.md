# Audyt ścieżki Docker DEV: budowanie, kompilacja, uruchamianie symulacji

Data: 21.10.2026 · Analiza na `7c16297b1` (master z niezacommitowanymi zmianami Docker), uzupełniona o `72cd5efcd`, który pojawił się w trakcie audytu · Tryb: audyt, tylko odczyt kodu, logów i stanu Dockera; bez buildów, restartów i testów.

## 0. Werdykt

Teza jest potwierdzona dowodami. Ścieżka Docker DEV przestała być narzędziem do
szybkiej pracy nad Fullmagiem i stała się osobnym, dużym produktem o semantyce
transakcyjnego systemu produkcyjnego. Rdzeń tego, co ma robić — zamontować
checkout, wykonać przyrostowy `make install-cli-dev`, uruchomić API i Next.js —
to jedna linia `make` (`docker/all-in-one/backend_dev.py:4548`) i kilkaset linii
orkiestracji. Wokół niej powstało **~71 tys. LOC Pythona + ~40 tys. LOC testów**,
**~150 schematów JSON**, 17 receptur `docker-dev*` (10 z nich wymaga ręcznie
podawanych UUID/SHA-256) i około 1000 normatywnych reguł w dokumentacji.

Najważniejsze fakty z żywego systemu (21.10, rano):

1. **Backend nie działa w żadnej z 5 grup DEV na hoście.** Cztery są `Exited (2)`/`Exited (255)`,
   jedna `unhealthy`. Frontendy działają.
2. **Sama faza „capture źródeł” trwa 256–461 s**, czyli dłużej niż kompilacja (`make` 217 s).
   Trzy z czterech ostatnich startów zakończyły się błędem *w tej fazie*, zanim cokolwiek
   skompilowano: dwa razy „live source changed while creating its closed manifest” (ktoś
   edytował plik), raz „git status timed out after 300 s”.
3. Zmierzona kompilacja w DEV biegła z **`-j2`** (Cargo i CMake; commit `72cd5efcd` z nocy 21.10
   podnosi Cargo do 4, bez pomiaru). CUDA kompiluje się dla **4 architektur**, a hash
   snapshotu źródeł jest **wejściem kompilacji**. Każda edycja dowolnego pliku runtime
   relinkuje więc wszystkie 12 binariów i rekonfiguruje CMake FEM.
4. Ctrl+C w trakcie `just docker-dev`, stop kontenera w trakcie `make`, restart w Docker
   Desktop albo 64 próby startu prowadzą do stanów, z których **nie ma jednej komendy wyjścia**.
   Nie istnieje `docker-dev-down`/`reset`, a dokumentacja zabrania `compose down -v`.
5. W tygodniu 12–18.10 było 130 commitów Docker/runtime wobec 263 w kodzie fizyki/solverów.
   W dniach 14–21.10 proporcja zmian lifecycle/Docker do rdzenia fizyki wynosiła ~9:1.
   Kod Docker urósł z ~2,9 tys. do ~60,6 tys. LOC w 8 dni; 20.10 przybyło +23,5 tys. LOC
   w jeden dzień.

Przyczyna nie leży w jednym błędzie, tylko w zestawie decyzji projektowych (§9).
Najważniejsza z nich: **na pętlę developerską przeniesiono gwarancje produkcyjne**
(provenance każdego buildu, „nigdy nie powtórz Solve”, trwały owner, accepted-run
reattach). Każdy incydent tej warstwy rodzi kolejny moduł recovery zamiast
uproszczenia. Rekomendowana naprawa (§10) to oddzielenie **szybkiej pętli DEV**
(proste, idempotentne, resetowalne) od **ścieżki kwalifikacji/release**
(provenance, receipty, piny), która może zachować obecną surowość.

---

## 1. Zakres, metoda, ograniczenia

**Zakres:**
- `justfile` (receptury `docker-dev*`, `docker-all-*`, `runner-*`), `Makefile` (`install-cli*`) i 11 plików `compose*.yaml`;
- `scripts/docker_*.py` (48 modułów), `bootstrap_docker_toolchain.py`, `setup_docker.py`, `fullmag_docker_runtime.py`, `fullmag_storage.py`, `recover_docker_orphan.py`, `just_storage_shell.sh`;
- `docker/all-in-one/*.py` i Dockerfile'e;
- wybrane `build.rs`;
- ADR 0059–0066, przewodniki Docker, `AGENTS.md`, `.agents/instructions/backend.md`, skill `fullmag-docker-build`;
- historia Git od 01.07.2026.

**Metoda:**
- statyczna lektura kodu (5 równoległych przeglądów cząstkowych, potem weryfikacja kluczowych twierdzeń bezpośrednio w kodzie);
- `git log` i `git diff --shortstat`;
- odczyt stanu Dockera tylko do odczytu: `docker ps -a`, `docker volume ls`, `docker logs --tail`, `docker inspect`.

**Ograniczenia:**
- Nie uruchamiano buildów, restartów ani testów (zakaz z AGENTS.md i charakter audytu).
- Liczby wywołań `docker` na start i koszty I/O poza zmierzonymi logami są **szacunkami z kodu (NOT VERIFIED)**.
- Klasyfikacja commitów jest heurystyczna (słowa kluczowe w tematach).
- Wnioski oznaczone „statycznie” (np. limit 64 prób bez przycinania) wymagają potwierdzenia w działającej grupie.

---

## 2. Skala

| Element | Wielkość |
|---|---|
| Moduły hosta `scripts/*docker*.py` (bez testów) | **48 plików, 49 969 LOC** |
| Kod w kontenerze `docker/all-in-one/*.py` | **20 980 LOC** (`backend_dev.py` 5514, `runtime_service.py` 5428, `frontend_dev.py` 2755, `backend_source.py` 2084) |
| Pozostałe wspierające (`fullmag_storage.py`, `storage_capabilities.py`, `docker_startup_script.py` w obrazie, `just_storage_shell.sh`) | ~5 tys. LOC |
| Testy `scripts/test_*docker*.py` | **79 plików, 39 765 LOC** |
| Różne schematy JSON `fullmag.*.vN` w kodzie Docker | **~150** |
| Słownictwo w kodzie Docker | `receipt` 3881×, `ledger` 974×, `authorization` 775×, `lease` 630×, `provenance` 626×, `certificate` 618×, `attestation` 501×; dla porównania `cargo` 29×, `cmake` 9× |
| `justfile` | 7574 linii, **501 receptur** (01.07: 2396 linii / 114 receptur) |
| Receptury `docker-dev*` | 17, w tym 10 wymagających pinów (`attempt`, `config_sha256`, ID kontenerów, SHA receiptów); `docker-dev-stop-unadmitted` ma **11 argumentów pozycyjnych** |
| Pliki `compose*.yaml` | 11 (aktywnie w DEV używany jest głównie `compose.dev.yaml`; Compose dokument i tak składa `docker_volume_dev.py:1475-1560`) |
| Dokumentacja Docker (ADR 0059–0066, 7 przewodników, plany aktywne, backend.md, skill) | ~8,5 tys. linii; ~980 sformułowań normatywnych; `NOT VERIFIED` 41× |
| Rust lifecycle/recovery od 12.10 (`git diff --shortstat`) | `fullmag-api` +57 tys., `fullmag-session` +36 tys., `fullmag-runner` +64 tys., `fullmag-runtime-control` +10 tys. linii (nie wszystko to Docker, ale m.in. `host_resource_ledger.rs` 11,8 tys., `development_accepted_restore.rs` 4,5 tys.) |
| Rdzeń fizyki od 12.10 | `fullmag-engine` +363, `fullmag-fem-sys` +315, `fullmag-fdm-sys` +11 linii |

---

## 3. Pomiary na żywym systemie (21.10.2026)

### 3.1 Stan grup DEV (`docker ps -a`)

| Grupa | backend | frontend |
|---|---|---|
| `fullmag-master` | **Exited (2)** | Up (healthy) |
| `worktree-docker-volume-only-implementation` | **Exited (2)** | Up (healthy) |
| `worktree-frontend-modularity-navigation-2` | **Exited (2)** | Up (healthy) |
| `worktree-viewport-visual-quality-20261020` | **Up (unhealthy)** | Up (healthy) |
| `worktree-eigensolve-dispersion-plan` | Exited (255) | Exited (255) |

Przyczyny z `docker logs --tail`:

- **master:** `capture state=failed … duration_ms=460847`, „live source changed while creating its closed manifest”.
- **docker-volume-only:** „Git source query status-runtime timed out after 300 seconds”, faza capture 437 s.
- **frontend-modularity:** „live source changed while creating its closed manifest” po 423 s.
- **viewport:** sonda `GET /v2/platform/openapi.json` przekroczyła czas przez 31 s, więc „Startup or runtime failed; admission closed”. API zostaje zabite, a kontener żyje jako `unhealthy` (`runtime_service.py:89` `SUPERVISION_GRACE_SECONDS`).

Dodatkowo na hoście:
- **476 wolumenów Docker**, w tym dziesiątki osieroconych po wcześniejszych trasach (`source-snapshot*`, `spin-transport*`, 19× `fullmag-fem-<hash>_{cargo,target,pnpm}`);
- pozostałości kontenerów: `Fullmag_build_runner`, `fullmag-worker-*`, `fullmag-v8-probe-*`, `buildx_buildkit_fullmag-windows0`.

### 3.2 Czasy faz backendu (log `fullmag-master-backend-1`)

| Start | capture pass 1 | capture pass 2 | razem capture | sync | make | package | wynik |
|---|---|---|---|---|---|---|---|
| 20.10 20:35 | 117 s (`git status` 73 s) | 139 s (`git status` 95 s) | **256 s** | 8,6 s | **217 s** | 2,3 s | pakiet OK; od `begin` do „Building” 5 min 9 s |
| 20.10 22:28 | 253 s (`git status` 141 s) | 208 s (`git status` 164 s) | **461 s** | — | — | — | **FAIL**, exit 2 |

Frontend dla porównania: sondy narzędzi < 5 s, `Next ✓ Ready in 412 ms`.

Raport `docs/reports/2026-10-20/mx3-master-3806-recovery.md` opisuje sytuację, w której
po udanym `make` (100 s) API nadal nie wstało, bo backend „sprawdza stare pakiety
rollback przed API”. Przejściowy `StoreWriterBusy` zamienił się tam w stan
`409 accepted_run_recovery_required`, z którego aktywacja „nie będzie odtwarzana”.

**Wniosek:** dominującym kosztem i najczęstszą przyczyną awarii nie jest
kompilacja, tylko warstwa provenance wokół niej.

---

## 4. Obecna architektura w skrócie

```
just docker-dev <checkout> <port> [script]
 └─ just_storage_shell.sh (regex-walidacja treści receptury, exec)
    └─ docker_dev.py up → docker_dev_up.ensure_up
       ├─ _discover_group: resolve_layout, compose identity (git), compose config,
       │   BuildControl (helper docker run), ps×2, odczyty control volume (docker run/plik)
       ├─ _reconcile_group: _build_inputs_match (hash docker/fem-gpu/**), _source_matches
       │   (docker exec → PODWÓJNY capture całego checkoutu)
       └─ start / restart_idle / resume / recreate (docker_volume_dev.py, 4638 LOC)
          ├─ build_volume_toolchain + 2 obrazy (lease, receipty, 32 GiB admission)
          ├─ wolumeny cache (kontener maintenance), seed frontendu (kontener), host-ledger
          │   (ext4 128 MiB, uprzywilejowany nsenter), compose up
          └─ _finish: polling inspect+logs co 3 s do 4 h, preflight storage, delegacja cgroup
             (uprzywilejowany kontener pid/cgroup host), weryfikacja ledgera, gotowość
backend (PID 1 = backend_dev.py start)
 ├─ lock, odzysk rotacji, hash bieżącego pakietu, audyt kandydatów
 ├─ CAPTURE: 2× (git ls-tree/ls-files/check-attr/status/ls-files --others + SHA każdego pliku)
 ├─ cache-hit? (source_digest obejmuje też docs/ i frontend)
 ├─ SHADOW SYNC do /build/workspace (rehash, kopia zmienionych, fsync, chmod ro)
 ├─ make install-cli-dev   ← właściwa praca (Cargo -j2, od 72cd5efcd -j4; CUDA ×4 arch)
 ├─ ponowny hash shadow, kopia pakietu, patchelf, ~6× hash pakietu, rotacja z journalem,
 │   backup poprzedniego pakietu (bez limitu), receipt, provenance
 └─ serve: hash pakietu, bramka windows-folder (≤120 s), bramka cgroup (300 s / 30 s),
    entrypoint preflight (probe FS), accepted-store, reattach, recovery, API, service-ensure,
    nadzór co 1 s / 5 s (+ healthcheck co 5 s)
frontend (frontend_dev.py, 2755 LOC) → pnpm install (gdy brak receiptu) → next dev --webpack, polling 5 s
```

---

## 5. Analiza po etapach

### 5.1 Obraz toolchainu (`docker/fem-gpu/Dockerfile`, `just docker-dev-toolchain`)

- **Zasadne:** przypięte wersje MFEM/libCEED/hypre/PETSc/SLEPc i obraz CUDA. To jedyna część, w której pinowanie realnie chroni powtarzalność.
- **Narzut:** około 25–30 wywołań `docker` przy trafieniu w cache, w tym ~15 jednorazowych `docker run --rm` do odczytu i zapisu plików w wolumenie kontrolnym. Do tego lease z `flock`, admission 32 GiB wolnego miejsca i 4–7 receiptów na operację.
- `docker-dev-toolchain` jest funkcjonalnie zbędny jako osobny krok, bo `start()` i tak wywołuje `build_volume_toolchain` (`docker_volume_dev.py:1238-1240`). Dokumenty są ze sobą sprzeczne: AGENTS.md każe uruchamiać go zawsze, a przewodniki mówią, że jest opcjonalny.
- Dockerfile domyślnie ustawia `FULLMAG_CUDA_ARCHITECTURES="80-real;89-real;90-real;90-virtual"` (`docker/fem-gpu/Dockerfile:47`), a obraz eksportuje tę wartość do środowiska. Dev nie może jej zawęzić bez przebudowy obrazu.
- Nowy plik w `docker/fem-gpu` musi być `git add`, inaczej build jest odrzucany (`docker_build_control.py:663-665`).

### 5.2 Launcher hosta (`just docker-dev`)

- **Happy path „nic się nie zmieniło”:** ~22 wywołania `docker`, w tym ~8 krótkotrwałych kontenerów. Do tego hashowanie wejść toolchainu na hoście i **podwójny pełny capture źródeł w backendzie** przez `docker exec` (`docker_dev_up.py:614`). W praktyce oznacza to minuty, nie sekundy (patrz §3.2).
- **Pierwszy start:** ~120–150 stałych wywołań `docker` (~50–60 to `docker run --rm` do I/O wolumenu kontrolnego). Do tego polling `inspect`+`logs` co 3 s przez cały czas kompilacji (`docker_volume_dev.py:1599-1628`), co przy 20 min zimnego buildu daje ~800 dodatkowych wywołań (szacunek).
- **Około 45 dokumentów JSON** w wolumenie kontrolnym na pierwszy start.
- **Lease operacji** (`/control/active` + `flock`). Przy przerwaniu (`KeyboardInterrupt`, `SystemExit`) receipt dostaje stan `outcome-unknown-resources-retained`, a lease zostaje celowo zachowany (`docker_build_control.py:560-570`). Każde następne `up` kończy się wtedy komunikatem „Existing DEV operation is active … use the explicit recovery route” (`docker_dev_up.py:437-440`). Dla fazy `development` nie znaleziono reconcilera. Ponieważ `up` może czekać do 4 h na build, **Ctrl+C jest naturalnym odruchem, który trwale blokuje środowisko.**
- **Limit 64 prób na fazę** (`MAX_ATTEMPTS = 64`, `docker_build_control.py:30`, sprawdzenie w :508). Nie znaleziono kodu przycinającego `*/attempts` (statycznie). Po 64 operacjach admission kończy się błędem; jedynym wyjściem jest rotacja/kwarantanna namespace.
- **Walidacja treści receptury regexem** w `just_storage_shell.sh:119,207`. Każda nowa flaga wymaga zmiany wrappera; `--include-untracked` nie jest przyjmowane przez `just docker-dev`.
- **Martwy kod:** ~57% `docker_dev.py` (~1580 LOC, 43 funkcje) jest nieosiągalne z `main` i utrzymywane wyłącznie przez testy. Dotyczy to m.in. `compose.backend-build*.yaml` (`docker_dev.py:44-45`) i receptury `docker-dev-recreate`, którą wrapper odrzuca jako „retired”.
- **Duplikacje:**
  - 16 definicji kanonicznego JSON;
  - ~16 helperów SHA-256;
  - 4 implementacje I/O wolumenu kontrolnego;
  - 3 inwentarze plików helperów obrazu;
  - `BuildControl` i `toolchain_configuration` budowane 2–3 razy na jedno `up`.

### 5.3 Kontener backend: capture, shadow, make, package, serve

**Capture (`backend_source.py:1650-1734`).** Dwa pełne przebiegi i porównanie; każda różnica oznacza fail (`:1663-1667`).

Każdy przebieg uruchamia 7 zapytań Git oraz SHA-256 każdego śledzonego pliku (~9,2 tys. plików, ~357 MiB, łącznie z `docs/` i `apps/`) przez bind mount NTFS→Linux.

`git status` działa z `GIT_OPTIONAL_LOCKS=0` na read-only `.git` i z `core.autocrlf=true` (`:662-688`). Nie może więc odświeżyć indeksu zapisanego przez Gita z Windows, a statystyki plików z perspektywy Linuksa nigdy nie pasują do indeksu. Dlatego przy każdym starcie ponownie czyta i filtruje treść plików: zmierzone 73–300 s na jeden `git status`.

Skutki:
- start jest wolniejszy od kompilacji;
- **edycja pliku (autosave, formatter, agent) w oknie 4–8 min zabija backend z exit 2**, a polityka `restart: "no"` nie podnosi go ponownie;
- przewodnik zaleca wprost „nie edytuj źródeł do końca próby” (`docs/guides/docker-volume-development.md:60`), co jest sprzeczne z istotą trybu deweloperskiego.

**Pliki nieśledzone są po cichu wykluczane** (`backend_source.py:1557`). Nowy moduł `.rs` bez `git add` kończy się błędem kompilacji „file not found for module”. Jedynym obejściem jest `--include-untracked` per plik, a zmiana tej listy wymusza recreate usług.

**Cache-hit** opiera się na `source_digest` ze **wszystkich** plików, także `docs/*.md` i frontendu (`backend_dev.py:2211-2252`). Edycja dokumentacji lub TSX i restart backendu uruchamia więc pełny pipeline (nowy kandydat, kopie, hashe, rotacja, nowy backup), nawet jeśli Cargo nie ma nic do zrobienia.

**Shadow sync** (`backend_dev.py:1061-1169`) robi rehash całego shadow, kopiuje zmienione pliki z fsync i wykonuje chmod read-only ~10 tys. razy. Po `make` następuje drugi pełny hash shadow (`_verify_shadow_source`, `:1172`).

**Python ładowany z shadow, nie z live mounta** (`compose.dev.yaml` `PYTHONPATH=/build/workspace/packages/fullmag-py/src`). Edycja `.py` w `fullmag-py` wymaga restartu backendu i pełnego cyklu.

**Package:**
- pakiet (12 binariów) jest hashowany ~6× na jeden rebuild i 2× przy cache-hit;
- rotacja ma journal i backup, a funkcja retencji backupów `_retain_package_backups` (`:4230`) **nie ma wywołań**, więc wolumen rośnie bez limitu;
- stop kontenera w trakcie `make` zostawia kandydata w stanie `building`. Każdy kolejny start kończy się wtedy błędem „candidate from an incomplete prior build is preserved” (`:3443-3447`). W kontenerze nie znaleziono automatycznego odzysku, a `backend_dev.py` nie obsługuje SIGTERM.

**Serve:**
- `windows_folder_probe` (fsync, rename, flock, symlink, transakcje SQLite) przy **każdym** starcie;
- bramka cgroup: po zwykłym restarcie (Docker Desktop) czeka 30 s, zwraca `deferred`, a **admission pracy wymagającej quota CPU pozostaje zamknięty** do następnego uruchomienia launchera (`worker_cgroup_gate.py:29,45-56`). To przeczy AGENTS.md, który przedstawia restart w Docker Desktop jako zwykłą drogę do przebudowy;
- nadzór sprawdza `OWNER.json` i `GET /runtime-service` co 1 s, pełne `openapi.json` co 5 s, a do tego działa healthcheck co 5 s. 31 s degradacji zamyka admission i zabija API (zmierzone w grupie viewport).

**Proporcje kodu (szacunek):** `backend_dev.py` ~21% core / ~79% provenance i recovery; `runtime_service.py` ~17% / ~83%; `backend_candidate_retirement.py`, `worker_cgroup_gate.py` i sondy storage w całości poza rdzeniem build/run.

### 5.4 Kompilacja: wzmacniacze kosztu

| Problem | Dowód | Skutek |
|---|---|---|
| **`-j2`** (częściowo naprawione w trakcie audytu) | Do `7c16297b1`: `backend_dev.py:5469,5487` (`CARGO_BUILD_JOBS` domyślnie 2), ścieżka DEV tej zmiennej nie ustawiała. Zmierzone 217 s `make` (§3.2) to build z `-j2`. Commit `72cd5efcd` (21.10, 00:56) ustawia `CARGO_BUILD_JOBS: "4"` w `compose.dev.yaml` (lub zapisany budżet) i `CMAKE_BUILD_PARALLEL_LEVEL=1` ze współdzielonym jobserverem Cargo | Do pomiaru po zmianie. Ten sam commit dodaje też kolejny moduł recovery (`docker_volume_pre_api_stop.py`, 441 LOC), co potwierdza wzorzec z §9.5 |
| **Limit kontenera 4 CPU / 8 GB** | `compose.dev.yaml` (`cpus: 4`, `mem_limit: 8g`) | Zmiana limitu powstała jako nowy moduł `docker_volume_resources.py` (344 LOC, `docker update` na żywym kontenerze, commit `9864fd59f`) zamiast zmiennej w compose |
| **CUDA ×4 architektury** | `docker/fem-gpu/Dockerfile:47`, `crates/fullmag-fem-sys/build.rs:258-261` | Każdy plik `.cu` FEM kompilowany 4 razy |
| **Snapshot źródeł jako wejście kompilacji** | `crates/fullmag-build-info/build.rs:12` (`rerun-if-env-changed=FULLMAG_SOURCE_SNAPSHOT_SHA256`); zależą od niego api, cli, runner, runtime-control; `crates/fullmag-fem-sys/build.rs:103,222-225` przekazuje go do CMake; `fullmag-session` używa `option_env!("FULLMAG_SOURCE_GIT_COMMIT")` (`docker_desktop_storage.rs:796,1320`) | Edycja dowolnego pliku runtime (`.rs`, `.py`, `.cu`) wymusza rebuild `build-info`, relink 12 binariów i **rekonfigurację CMake FEM**; każdy commit lub zmiana brancha przebudowuje `fullmag-session` i wszystko nad nim |
| **Klucz cache Cargo zawiera ID obrazu toolchainu i worktree** | `docker_backend_volume_cache.py:195-243` | Każda zmiana Dockerfile i każdy nowy worktree oznacza nowy wolumen i **zimny build** |
| **Zakaz kompilacji testów jednostkowych** (od 14.09) i zakaz hostowego `cargo check` | AGENTS.md | Jedyny sygnał kompilacji to pełny cykl kontenera |

`Makefile` (`install-cli*`) zawiera 6 trybów budowy. Ścieżka hostowa ma cichy fallback FEM GPU → CUDA-only z `cargo clean -p fullmag-fem-sys`. DEV wymusza `FULLMAG_FORCE_LOCAL_FEM_GPU=1`, więc tego fallbacku nie dotyczy, ale pozostałe gałęzie są balastem dla czytającego.

### 5.5 Frontend

**Część zdrowa:** edycja `.tsx` w `app/`, `src/`, `public/`, `scripts/` to czyste HMR przez read-only bind. Next startuje w < 1 s.

Problemy:
- **Polling co 5000 ms** (`compose.dev.yaml` `FULLMAG_WATCHPACK_POLLING_MS`) plus webpack zamiast Turbopacka w kontenerze z 4 CPU daje realne opóźnienie HMR 3–8 s.
- **Pliki konfiguracyjne z korzenia `apps/control-room`** (`tsconfig.json`, `postcss.config.mjs`, `instrumentation-client.ts`, `eslint.config.mjs`) są **kopiami** w wolumenie, a nie bindem. Ich edycja nie ma efektu. Przy recreate kończy się twardym błędem „Frozen frontend configuration changed” lub „Frontend metadata changed” (`docker_volume_dev.py:533,556`).
- **Zmiana `package.json`/`pnpm-lock.yaml`** (np. po pull lub zmianie brancha) nie jest wykrywana na działającej grupie. Restart nie reinstaluje zależności; potrzebny jest `recreate-volume --attempt … --config-sha256 …`, który tworzy **nowy pusty wolumen** (zimny store pnpm i `.next`).
- `frontend_dev.py` ma 2755 LOC, z czego rdzeń (install + spawn `next dev`) to ~100 linii. Reszta to receipty tożsamości procesu, inspektor, rotacja logu i walidacje.
- Inwentarz plików seed frontendu występuje w 3 kopiach (`docker_development_inputs.py:221,376,694`), do tego inline-seeder i walidator. Klucz cache frontendu ma 2 niezgodne definicje.

### 5.6 Uruchamianie symulacji

- **`just docker-dev-script <script>`** to właściwa pętla „popraw skrypt → uruchom ponownie”. Restart nie jest potrzebny, ale każde wywołanie przechodzi przez:
  - odkrycie pinów z receiptów;
  - `docker inspect`;
  - `assert_no_unresolved_activation`;
  - hash helpera;
  - zapisy provenance i autoryzacji;
  - `docker exec` retirement poprzedniego workspace;
  - `docker exec` start.

  Retirement **odmawia, gdy poprzedni run nie jest terminalny**, więc nie da się przerwać i od razu uruchomić ponownie bez osobnego cancel. Wyjątek „outcome unknown” wymaga ręcznej rekoncyliacji. Nierozstrzygnięta aktywacja **trwale blokuje każdą nową aktywację i Solve** (`docker_volume_activation_reconcile.py:794-822`).
- **`just docker-dev <wt> <port> examples/foo.py`** najpierw robi pełny podwójny capture, a przy niezgodności restartuje backend. To pułapka dla iteracji nad skryptem.
- **Zatrzymanie w trakcie symulacji, timeout drain (60 s grace), OOM przy 8 GB lub crash Docker Desktop** zostawia `OWNER.json` w stanie innym niż `Drained`. Przy następnym starcie Rust `ensure` kończy się błędem „outcome unknown, restart refused”, entrypoint przechodzi w `failed_outcome_retained` (PID 1 żyje z zamkniętym admission), a odzysk wymaga autoryzacji wygenerowanej przez hosta (`runtime_service.py:422-500`, `entrypoint.py:567-599`).
- Zmiana `FULLMAG_SCRIPT_OUTPUT_DIRECTORY` wymusza drain i recreate (`docker_dev_up.py:1152-1160`).

### 5.7 Warstwa recovery: maszyna stanów

20 modułów, **~20 tys. LOC**, prawie wszystkie powstały w dniach 16–21.10. Każdy kolejny incydent dawał nowy moduł i nowy wariant dowodu. Z kodu wynika co najmniej **12 stanów grupy**:

| Stan | Opis |
|---|---|
| S0 | brak grupy |
| S1 | operacja aktywna |
| S1u | wynik nieznany |
| S2 | build trwa |
| S3 | healthy |
| S4 | `failed-confirmed`, z 6 podtypami dowodu stopu: native, after-READY, api-start, pre-marker, unadmitted, pre-API, pre-ACK, capture-failure |
| S5 | admitted / pre-admission |
| S6 | accepted run held |
| S7 | aktywacja nieznana |
| S8 | pending container recovery |
| S9 | kwarantanna namespace |
| S10 | recreation-resume |
| S11 | orphan (legacy) |

**Nakładanie się modułów:**
- „Stop kontenera”: 7 niezależnych implementacji.
- „Recreate po awarii”: 6 punktów wejścia, a wewnątrz recreate 9 wariantów dowodu (`docker_volume_dev.py:4192-4361`).
- Logika recreate jest zduplikowana między `_retained_operation` a `_resume_recreated_operation`.
- Kwalifikacja stanu zależy od dokładnych łańcuchów błędów (np. `"API binding did not become ready:"`, `docker_volume_stop_failed.py:28,428`).

**Martwe lub legacy dla bieżącego DEV:**
- `recover_docker_orphan.py`, `docker_orphan_recovery.py`, `docker_orphan_namespace_grant.py`: moduł sam deklaruje „fails closed” dla volume DEV (`recover_docker_orphan.py:5-9`);
- `docker_runtime_recovery.py`: dostępny tylko przez wycofaną trasę (`docker_dev.py:2456`).

**Autoryzacja operatora dla `container_recovery`** (`…operator-authorization.v1`) nie jest produkowana przez żadne narzędzie; istnieje tylko jej walidator.

**Liczba miejsc odmowy:**
- 1504 linie `raise`/`SystemExit` i 1384 wywołania `fail()` w 20 modułach;
- 672 na samej ścieżce `up`;
- 17 komunikatów każe wykonać „explicit/dedicated recovery” lub `--fresh-state`, **żaden nie podaje konkretnej komendy**.

**Ocena:** dane użytkownika (sesje, wyniki, projekty) chronią w rzeczywistości cztery rzeczy, mieszczące się w kilkuset LOC:
- bind `/state` poza kontenerem;
- fence `request_id` przeciw podwójnemu Solve;
- zakaz przerywania działającej symulacji przez `up`;
- ewentualnie ledger GPU między grupami.

Reszta chroni ciągłość dowodów: warianty proof, sidecar i attestation, surowe digesty journali, dowody prywatnego PID namespace (Docker sam gwarantuje brak procesów po exit kontenera), trwały `Failed OWNER`, rotację generacji, kwarantannę. **Ta warstwa sama generuje stany, z których trzeba wychodzić kolejnymi modułami.**

### 5.8 Cache i storage

- **Wolumeny są tylko tworzone, nigdy usuwane.** `docker_backend_volume_cache.py:16`: „No function removes a volume”. Każda zmiana locka, obrazu toolchainu i każdy worktree zostawia wolumeny po kilka GB. Na hoście jest 476 wolumenów.
- **Brak współdzielenia:** `CARGO_HOME`/registry, store pnpm i target są per worktree i per toolchain. Nowy worktree oznacza pełny zimny build Rust/CMake/CUDA.
- **Host storage:**
  - `fullmag_storage.resolve_layout` wylicza ~30 zmiennych starej ścieżki hostowej (`CARGO_HOME`, `cargo-target` w storage), które w DEV są martwe, a kłócą się z decyzją z 18.10 („build data tylko w volumes”);
  - host-ledger to obraz ext4 128 MiB w host storage, montowany przez uprzywilejowany `nsenter`, plus 3 dodatkowe kontenery (ensure, probe, verify) przy każdym starcie.
- **Sondy storage przy każdym starcie i przy każdej zmianie `image_id`** (certyfikat wiąże obraz). Fakt „NTFS przez Docker Desktop obsługuje fsync/rename” nie zmienia się wraz z obrazem.
- **Martwy kod adapterów:**
  - `docker_frontend_cache.py` (1566 LOC, aktywne ~50);
  - `docker_backend_cache.py` (1064, 0 aktywnych);
  - `compose.frontend-cache.yaml`, `compose.backend-cache.yaml`;
  - `storage_capabilities.py` + `probe_docker_storage.py` (tylko runner).

### 5.9 Dokumentacja, instrukcje i historia

**Instrukcje:**
- ~71% treści `AGENTS.md` (≈2240 z 3153 słów) dotyczy buildu, storage i worktree; kontrakt fizyki i architektury Fullmag to ~180 słów.
- **Nie ma strony „start w < 5 krokach”.** Dwa przewodniki (`docker-development-architecture.md` §Start, `docker-volume-development.md` §Uruchomienie) konkurują o tę rolę. `docker-new-windows-host.md` prowadzi przez wycofany `Fullmag_build_runner`.

**Sprzeczności:**
- toolchain obowiązkowy (AGENTS) vs opcjonalny (przewodniki);
- restart w Docker Desktop zalecany (architecture) vs „ręczny Docker” zakazany (AGENTS) vs `docker-dev-restart-idle <attempt> <sha>` (volume-dev);
- hostowe `cargo` dozwolone do smoke (backend.md) vs zakazane (AGENTS);
- natywna trasa Windows nadal opisana w backend.md;
- skill `fullmag-build-stage-cleanup`, wymagany przez AGENTS.md, **nie istnieje w repo** (jest tylko w `~/.codex/skills`).

**Pivoty bez wygaszania** (żadna trasa nie została usunięta):

| Data | Trasa |
|---|---|
| 09.09 | resolver/storage governance |
| 11.09 | `Fullmag_build_runner` |
| 03–05.10 | natywny Windows + RAM-disk |
| 14.10 | all-in-Docker przez runner |
| 16.10 | direct Compose live (ADR 0061) |
| 18.10 | volume-only |
| 19.10 | Linux/WSL |

**Historia:**

| Okres | Commity Docker/runtime | Commity `crates`/`native`/`backends`/`fullmag-py` |
|---|---|---|
| W29–W34 | 12 | 772 |
| W41 | 70 | 370 |
| **W42 (12–18.10)** | **130** | 263 |
| **W43 (19–21.10)** | **80** | 49 |

- W dniach 14–21.10: 282 commity Docker+lifecycle wobec 30 w rdzeniu fizyki.
- Od 17.10 **13 z 15 zmergowanych PR** dotyczy Dockera.
- Z 232 commitów Docker od 12.10 86 to jawnie defensywne (fix/preserve/retain/recover/harden/pin/fence…), a duża część pozostałych to również recovery.

**Cykle „poprawka poprawki”:**
- budżety readiness (15→16→21.10);
- wątki FS frontendu na mountach Windows (zwiększ → ogranicz → polling);
- rozmiar cache (40 → 50 GiB → przeniesienie do volumes);
- retencja rollbacków (17→18→20.10, potem incydent „sprawdza stare kopie przed API” i niezacommitowany `docker_volume_pre_api_stop.py`);
- accepted-run reattach (ponad 10 commitów w 2 dni).

**Żaden ADR Docker (0059–0066) nie ma statusu zweryfikowanego runtime.** Wszystkie są „NOT VERIFIED” albo „w toku”.

**Rejestr worktree:**
- 60 wpisów `git worktree list`, 40 katalogów, 247 branchy `codex/*`;
- 4 katalogi bez wpisu w rejestrze;
- worktree zmergowanego PR #226 nadal istnieje.

Na `master` leży niezacommitowana praca Docker (7 plików + nowy moduł), co przeczy regule izolacji w worktree.

---

## 6. Scenariusze pracy dewelopera

Czasy oznaczone „zm.” pochodzą z logów §3.2; pozostałe to szacunki z kodu.

| # | Scenariusz | Co musi zrobić deweloper | Co robi system / koszt | Gdzie utyka |
|---|---|---|---|---|
| a | Świeży host | `setup_docker.py` → `just docker-dev-toolchain` → `just docker-dev <wt> <port>` | Obraz toolchainu (godziny), ~120–150 wywołań `docker`, zimny Cargo/CMake/CUDA (×4 arch, `-j2`), polling do 4 h | Ctrl+C (lease), < 32 GiB wolnego miejsca, plik toolchainu spoza Git, nierejestrowana ścieżka, timeout gotowości; przewodnik nowego hosta prowadzi przez wycofany runner |
| b | Edycja jednego `.rs` | Restart backendu: `just docker-dev` (→ `restart_idle`) albo restart w Docker Desktop | Stop/drain → capture **256–461 s (zm.)** → sync → `make`: rebuild `build-info`, relink 12 binariów, rekonfiguracja CMake FEM (**217 s zm.** przy `-j2`) → ~6× hash pakietu → rotacja → bramki serve. **≈ 8–12 min** | Edycja w trakcie capture: exit 2. Aktywna sesja: „idle restart refused”. Restart przez Docker Desktop: +30 s i zamknięte quota. Nowy plik `.rs` bez `git add`: błąd kompilacji |
| c | Edycja `.tsx` | Nic | HMR, 3–8 s (polling 5 s) | Konfiguracja w korzeniu `apps/control-room` nie działa bez recreate |
| d | Edycja `fullmag-py` (`.py`) | Jak (b) | Python z shadow; zmiana snapshotu daje tę samą kaskadę relink + CMake | Jak (b) |
| e | Zmiana Dockerfile/zależności | `just docker-dev` | Automatyczny drain + recreate, przebudowa obrazu, **nowy wolumen Cargo, zimny build** | Nowy plik w `docker/fem-gpu` bez `git add`: odmowa |
| f | Restart w Docker Desktop | Klik | Pełny cykl backendu jak (b); bramka cgroup 30 s → `deferred` → **quota-admission zamknięte** | Restart w trakcie kompilacji: `up` odmawia („running but not healthy”); stop w trakcie `make`: kandydat `building` blokuje kolejne starty |
| g | `just docker-dev` na działającej grupie | — | ~22 wywołania `docker` + podwójny capture (minuty) | Inny port: błąd; build w toku: odmowa |
| h | Błąd kompilacji, poprawka, ponowienie | Poprawić, `just docker-dev` | `resume(restart_backend=True)` → pełny cykl (b) | Jeśli wcześniej był Ctrl+C: zablokowany lease bez wyjścia |
| i | Przełączenie worktree | `just docker-dev <inny-wt> <inny-port>` | Nowy projekt, nowe wolumeny: **zimny build od zera** | Kolizja portu; brak współdzielonego cache |
| j | Iteracja nad skryptem symulacji | `just docker-dev-script <script>` | Kilka `docker exec`/`inspect` i zapisy receiptów (sekundy) | Poprzedni run nieterminalny: odmowa; „outcome unknown”: blokada wszystkich nowych aktywacji i Solve |
| k | Pełny reset | **Brak komendy.** `recreate-volume --fresh-state` wymaga `attempt` i `config_sha256` z wnętrza wolumenu; nie działa w stanie S1u | — | `compose down -v` zakazany; ręczne usunięcie wolumenów sprzeczne z polityką |

Dla porównania typowa pętla w projekcie Rust/C++ w kontenerze: `docker compose exec backend cargo build` (przyrostowo 10–60 s) + restart procesu API (sekundy).

---

## 7. Pułapki blokujące (P0, codzienne)

| # | Pułapka | Mechanizm | Dowód |
|---|---|---|---|
| T1 | Edycja kodu w trakcie startu zabija backend | Dwuprzebiegowy capture i porównanie | `backend_source.py:1663-1667`; 2 z 4 obecnych awarii |
| T2 | `git status` > 300 s zabija backend | Read-only indeks + `autocrlf` przez bind NTFS | `backend_source.py:46,662-688`; awaria docker-volume-only |
| T3 | Ctrl+C w `just docker-dev` blokuje środowisko | `KeyboardInterrupt` → outcome-unknown, lease zachowany, brak reconcilera fazy `development` | `docker_build_control.py:560-570`, `docker_dev_up.py:437-440` |
| T4 | Stop w trakcie `make` blokuje kolejne starty | Kandydat `building` bez automatycznego odzysku, brak handlera SIGTERM | `backend_dev.py:3443-3447` |
| T5 | 64 próby na fazę i koniec | Brak przycinania `*/attempts` (statycznie) | `docker_build_control.py:30,508` |
| T6 | Restart w Docker Desktop zamyka quota-admission | Bramka cgroup `deferred` | `worker_cgroup_gate.py:29,45-56` |
| T7 | Nieczysty stop symulacji: „outcome unknown, restart refused” | Trwały owner, odzysk tylko z autoryzacją hosta | `runtime_service.py:422-500`, `entrypoint.py:567-599` |
| T8 | Nieśledzony plik nie trafia do builda | Ciche wykluczenie | `backend_source.py:1557` |
| T9 | Aktualizacja zależności frontendu wymaga recreate z hashami i zimnego wolumenu | Zależności są kluczem wolumenu, brak auto-reinstalacji | `docker_volume_dev.py:504,533,556`, `docker_dev_up.py:846-916` |
| T10 | Brak resetu | Brak `down`/`reset`; `--fresh-state` wymaga pinów | `justfile:27-101`, `docker-development-architecture.md:215,405` |
| T11 | Chwilowe przeciążenie API zabija API | Nadzór 31 s → admission closed | log grupy viewport, `runtime_service.py:89` |
| T12 | Wolumeny rosną bez końca | Brak GC wolumenów i retencji backupów | `docker_backend_volume_cache.py:16`, `backend_dev.py:4230` (bez wywołań) |

---

## 8. Duplikacje i martwy kod (do usunięcia)

**Martwe lub legacy względem bieżącego DEV (szacunek):**

| Element | LOC | Uwagi |
|---|---|---|
| `docker_dev.py`, część nieosiągalna | ~1580 | |
| `docker_frontend_cache.py` | ~1500 | |
| `docker_backend_cache.py` | 1064 | |
| `recover_docker_orphan` + `docker_orphan_*` + `docker_runtime_recovery` | ~4,5 tys. | |
| `backend_dev.py`: retencja/archiwizacja, legacy-stage, archive/frozen | ~1,5 tys. | |
| `storage_capabilities` + `probe_docker_storage` | 1128 | tylko runner |
| `compose.backend-build*.yaml`, `compose.frontend-cache.yaml`, `compose.backend-cache.yaml` | — | |
| usługi `dev`/`fem-gpu`/`fem-cpu` w `compose.yaml` | — | stary świat bind-mount z postgres/minio/nats |
| receptury `docker-dev-recreate`, `docker-dev-build`, `runner-*`, `docker-all-*` | — | dla DEV |

Razem **≈ 12–14 tys. LOC** do usunięcia przy niskim ryzyku, plus odpowiadające im testy.

**Duplikacje do zastąpienia jedną biblioteką `scripts/lib/docker_common.py`:**
- kanoniczny JSON: 16 kopii;
- SHA-256: ~16;
- wrappery Docker CLI / `inspect`: ≥8;
- I/O wolumenu kontrolnego: 4;
- `_control_bytes`: 4;
- atomowy zapis JSON: ~10;
- odczyt bez symlinków z limitem: ~12;
- odrzucanie zduplikowanych kluczy JSON: 4;
- polityka „non-runtime paths”: 3 (`backend_source.py:83-123`, `runtime_source_change_policy.py`, `capture_source_snapshot_identity.py`);
- tożsamość źródeł liczona w 4 miejscach;
- inwentarz helperów obrazu: 3.

---

## 9. Przyczyny źródłowe

1. **Gwarancje produkcyjne na pętli deweloperskiej.** Owner, lease, generacje, `Consumed` token, accepted-run reattach, „nigdy nie powtórz Solve”, „nie resetuj ownera”, „nie twórz fikcyjnego terminala”. Restart kontenera DEV stał się transakcją z kilkunastoma bramkami. Każdy nieprzewidziany przebieg (Ctrl+C, OOM, timeout drain) jest stanem „unknown”, którego nie wolno uprościć, więc potrzebuje nowego modułu.
2. **Provenance każdego buildu jako warunek startu.** Podwójny capture, digesty, receipty, certyfikaty storage, hashe konfiguracji jako argumenty receptur. Koszt czasowy (minuty) i awaryjność (T1, T2) wynikają bezpośrednio z tej decyzji.
3. **Checkout NTFS jako bind mount źródła dla kontenera Linux.** Wolny `git status` i hashowanie, polling HMR, cykle tuningu wątków Watchpack, osobny profil `windows-folder-v1` z sondami.
4. **Brak szybkich ścieżek.** Zakaz kompilacji testów (od 14.09), zakaz hostowego `cargo check`, Python z shadow, brak `exec cargo build` w działającym kontenerze. Jedynym sygnałem kompilacji jest pełny restart, a restart uruchamia ścieżki recovery, które potem trzeba poprawiać.
5. **Pętla „awaria → nowy guard/ADR/reguła” wykonywana przez agentów.** ADR 0061 dostał ~13 uzupełnień w 4 dni. Moduły recovery powstawały w tempie około jednego dziennie. Reguły w AGENTS.md też rosły, a nic nie było usuwane.
6. **Pivoty bez wygaszania poprzednich tras.** 7 tras w 6 tygodni, wszystkie nadal obecne w `justfile`, compose i dokumentacji.
7. **Wolumen pracy nieproporcjonalny do weryfikacji.** 60 tys. LOC w 8 dni przy statusie NOT VERIFIED każdego ADR. 40 tys. LOC testów sprawdza głównie fixture'y protokołów recovery, a nie realny cykl edit→build→run (a ten na hoście obecnie nie działa, §3.1).

---

## 10. Co wymaga poprawy — rekomendacje

Zasada nadrzędna: **rozdzielić „DEV fast loop” od „qualification/release”.** DEV ma być
szybki, idempotentny i resetowalny jedną komendą. Kwalifikacja, release i dowody
naukowe zachowują pełną provenance (przypięty SHA, frozen snapshot, receipty),
ale **nie leżą na ścieżce codziennej pracy**.

Co trzeba zachować w DEV (realna ochrona danych):
- sesje, wyniki i projekty na host storage (bind `/state`), nieusuwane przez żadną komendę DEV;
- brak automatycznego ponownego Solve (fence `request_id`);
- `up`/restart nie przerywa działającej symulacji bez jawnej flagi;
- GPU nie spada po cichu na CPU, a `auto` widnieje w provenance runu (kontrakt Fullmaga);
- przypięty obraz toolchainu.

### Fala 0: szybkie poprawki (dni, niskie ryzyko, duży zysk)

| # | Zmiana | Zysk | Ryzyko |
|---|---|---|---|
| R0.1 | Dokończyć zmianę z `72cd5efcd`: `CARGO_BUILD_JOBS` zawsze równe faktycznemu limitowi `cpus`. Limity `cpus`/`mem_limit` jako zwykłe zmienne w `.env`, zamiast `docker update` na żywym kontenerze przez moduł 344 LOC. Zmierzyć `make` przed i po | build ~1,5–2× szybszy | niskie (pamięć) |
| R0.2 | `FULLMAG_CUDA_ARCHITECTURES` dla DEV = architektura lokalnego GPU (z `nvidia-smi --query-gpu=compute_cap`), przekazywana przez env backendu | ~3–4× mniej pracy nvcc | niskie; release zachowuje pełną macierz |
| R0.3 | Usunąć snapshot i commit z wejść kompilacji: `build-info` bez `rerun-if-env-changed` na snapshocie (tożsamość z pliku obok binarium w runtime), bez `-D…SNAPSHOT` w CMake FEM, bez `option_env!` commitu w `fullmag-session` | edycja jednego `.rs` przestaje relinkować 12 binariów i rekonfigurować CMake | średnie: wiązanie API↔CLI (`require_api_identity`) czytać z pliku provenance |
| R0.4 | Capture: **jeden** przebieg; tożsamość = `git rev-parse HEAD` + lista zmienionych plików z hashami tylko tych plików; brak twardego failu przy zmianie w trakcie (zapisz „dirty-during-capture” w provenance i kontynuuj) | −4 do −8 min na start, koniec T1 | niskie dla DEV |
| R0.5 | Nieśledzone pliki domyślnie włączone (z respektowaniem `.gitignore`) | koniec T8 | niskie |
| R0.6 | Cache-hit backendu liczyć z plików runtime, nie z `docs/` i frontendu | restart po edycji docs/TSX = no-op | niskie |
| R0.7 | Receptury `just docker-dev-down` (compose stop/down bez `-v`), `docker-dev-reset` (down + nowy control namespace, bez ruszania host storage i cache) i `docker-dev-logs`, bez pinów; komunikaty „explicit recovery” podają dokładną komendę | koniec T3, T5, T10 | średnie: wymaga decyzji, że reset DEV nie jest „fikcyjnym terminalem” |
| R0.8 | Ctrl+C: host nie trzyma lease przez czas kompilacji; przerwanie obserwacji ≠ outcome-unknown, jeśli demon nie był w trakcie mutacji | koniec T3 | średnie |
| R0.9 | Kandydat `building` po poprzednim starcie: automatycznie odrzucany (kontener i tak był zatrzymany); jeden backup pakietu | koniec T4, T12 (część) | niskie |
| R0.10 | Polling HMR 5000 → 500–1000 ms; nadzór API: tolerancja > 31 s lub brak zamykania admission przy chwilowym timeoucie `openapi.json` | HMR 1–2 s; koniec T11 | niskie |

### Fala 1: szybka pętla edycji (1–2 tygodnie)

| # | Zmiana | Zysk |
|---|---|---|
| R1.1 | **`just docker-dev-rebuild`**: `docker compose exec backend make install-cli-dev` (przyrostowo, bez restartu kontenera i bez capture), potem restart *procesu* API/runtime w tym samym kontenerze (supervisor obsługuje sygnał). Pełny restart kontenera tylko przy zmianie obrazu | pętla `.rs` ≈ czas kompilacji przyrostowej + kilka sekund |
| R1.2 | Python `fullmag-py` z live mounta (read-only), nie z shadow | edycja `.py` bez rebuildu Rust |
| R1.3 | **Odwołać zakaz kompilacji testów jednostkowych** lub zastąpić go `just docker-dev-test <crate>` (`cargo test -p` w kontenerze backend, z limitem zasobów). Dopuścić `cargo check` w kontenerze jako szybki sygnał | regresje wykrywane w sekundach, nie przy runtime |
| R1.4 | Szybka ścieżka `up`: grupa healthy i obraz bez zmian → `compose ps` + healthcheck i koniec; pełna weryfikacja wejść tylko z `--verify` lub po zmianie `docker/` | `just docker-dev` na działającej grupie < 5 s |
| R1.5 | Frontend: cały `apps/control-room` jako read-only bind, `node_modules`/`.next` jako wolumeny; przy starcie `sha256(lock+package.json)` ≠ zapisany → `pnpm install --frozen-lockfile` w tym samym wolumenie; usunąć freeze i klucz-z-zależności | koniec T9 i cichych nieaktualności konfiguracji |
| R1.6 | Wspólne wolumeny `CARGO_HOME`/registry i store pnpm na host (content-addressed); per worktree tylko `target`, `node_modules`, `.next`. Klucz `target` bez ID obrazu toolchainu (Cargo sam unieważnia artefakty po zmianie `rustc`) | nowy worktree i zmiana Dockerfile bez zimnego pobierania |
| R1.7 | `docker-dev-script --replace`: anuluj bieżący run i uruchom nowy; usunąć `--script` z `up` | iteracja nad skryptem bez capture |
| R1.8 | `docker-dev-gc` (dry-run domyślnie): wolumeny `fullmag-*` bez konsumentów, niebędące bieżącym kluczem grupy; usunięcie dopiero po jawnej zgodzie | koniec T12 |

### Fala 2: redukcja kodu (2–4 tygodnie, po Fali 0–1)

| # | Zmiana | Szacunek |
|---|---|---|
| R2.1 | Usunąć martwy i legacy kod z §8 oraz jego testy | −12–14 tys. LOC |
| R2.2 | Scalić `stop_failed`, `stop_unadmitted`, `pre_api_stop`, `pre_ack_retry`, `capture_failure_reconcile`, `namespace_attest` w jedno `docker-dev stop`/`reset` (= `docker stop` + zapis exit code i logów) | −4–5 tys. LOC |
| R2.3 | Zastąpić `post_build_generation`, `pre_admission_recreate` i `selector` regułą: backend zatrzymany i brak runu Running/Claimed w SessionStore → recreate dozwolony na tym samym rootcie | −2,6 tys. LOC |
| R2.4 | Przenieść logikę „run w locie przy starcie” do Rust API: przy starcie oznacz jako `interrupted/held`, nigdy nie wznawiaj automatycznie. Usuwa hostowy producent dowodu `accepted_reattach` i dużą część `activation_reconcile` | −3,4 tys. LOC Python; Rust i tak rewaliduje |
| R2.5 | `container_recovery` + `control_namespace` → `docker-dev reset` + automatyczne zwolnienie `active`, gdy proces lease nie żyje | −2,4 tys. LOC |
| R2.6 | Scalić `docker_dev.py`, `docker_dev_up.py` i `docker_volume_dev.py` w jeden moduł lifecycle; jedna biblioteka wspólna (§8); I/O wolumenu kontrolnego przez jeden długożyjący kontener lub mount do `backend`, nie `docker run --rm` na każdy plik | −50–60 kontenerów na start; mniej rozjazdów |
| R2.7 | `frontend_dev.py` → ~150 linii (deps + `exec next dev`); logowanie przez driver Docker | −2,5 tys. LOC |
| R2.8 | `backend_dev.py` dla DEV: rename `package.new → package` zamiast journala, retirementu, retencji i legacy-stage; pakiet hashowany raz | −3,5 tys. LOC |
| R2.9 | Sondy storage raz na host/root (certyfikat bez `image_id`); host-ledger jako zwykły plik z `flock` w named volume zamiast ext4 + `nsenter` | −kilkanaście s na start; brak kontenerów uprzywilejowanych w DEV |
| R2.10 | Bramka cgroup: w DEV wystarczy `cpus` z Compose; usunąć uprzywilejowany helper `pid: host` / `cgroup: host` z pętli DEV | −30 s na restart, koniec T6 |

### Fala 3: model docelowy i porządek dokumentacji

- **Model docelowy DEV** (≤ ~3 tys. LOC orkiestracji):

  ```
  just dev-up [wt] [port]   → compose up (toolchain, jeśli obraz brak)
  just dev-rebuild          → exec make install-cli-dev + restart procesu API
  just dev-test <crate>     → exec cargo test -p <crate>
  just dev-script <file>    → POST do API (fence request_id), --replace
  just dev-logs / dev-down / dev-reset / dev-gc
  ```

- **Rozważyć przeniesienie checkoutu DEV do systemu plików Linuxa** (WSL2 ext4 lub named volume z synchronizacją). Usuwa przyczynę §9.3: `git status` i inotify działają natywnie, HMR bez pollingu. ADR 0064 już otwiera ścieżkę WSL; problemem do rozstrzygnięcia jest edycja z Windows IDE (VS Code Remote-WSL).
- **Dokumentacja:**
  - jedna strona „Start DEV” ≤ 1 ekran;
  - jeden ADR „Separacja DEV fast loop vs qualification”, który zastępuje rozszerzenia ADR 0061/0063/0065/0066 w zakresie DEV;
  - przeniesienie przewodników starych tras do archiwum;
  - skrócenie części build/storage w AGENTS.md do kilku reguł z linkiem;
  - dodanie brakującego skilla cleanup do repo albo usunięcie wymogu.
- **Zasada procesu:** nowy guard lub moduł recovery w DEV wymaga wskazania, którą *daną użytkownika* chroni. Bez tego naprawa polega na uproszczeniu albo na `reset`, a nie na kolejnym wariancie dowodu.

### Szacowany efekt

| Pętla | Dziś | Po Fali 0 | Po Fali 1 |
|---|---|---|---|
| Edycja `.rs` → działające API | ≈ 8–12 min, awaria przy edycji w trakcie | ≈ 2–4 min | ≈ 0,5–2 min (rebuild przyrostowy + restart procesu) |
| Edycja `.py` (`fullmag-py`) | jak `.rs` | ≈ 1–3 min | sekundy (restart procesu, bez rebuildu) |
| Edycja `.tsx` | 3–8 s | 1–2 s | 1–2 s |
| `just docker-dev` na działającej grupie | minuty (capture) | ≈ 30–60 s | < 5 s |
| Wyjście z zablokowanego stanu | brak komendy / ręczne piny | `just docker-dev-reset` | jw. |

(Szacunki; Fala 0 wymaga pomiaru przed i po, patrz §12.)

---

## 11. Decyzje wymagane od użytkownika

Kilka rekomendacji zmienia reguły zapisane w `AGENTS.md`/ADR, więc wymaga jawnej decyzji:

1. **Odwołanie lub zastąpienie zakazu kompilacji testów jednostkowych** (obowiązuje od 14.09 „do odwołania”).
2. **Dopuszczenie `docker compose exec backend …`** (rebuild, `cargo check`/`test`) w grupie checkoutu jako oficjalnej ścieżki DEV. Obecnie „ręczny Docker” jest zakazany.
3. **Reset DEV bez dowodu drain** — że `docker-dev-reset` może oznaczyć ownera/aktywacje jako `abandoned-dev` zamiast wymagać recovery. Dotyczy reguły „nie resetuj ownera”.
4. **Provenance w DEV jako informacyjna, nie blokująca.** Pełna i blokująca tylko w kwalifikacji/release.
5. **Usunięcie tras runner / all-in-Docker / native Windows z `justfile` i dokumentacji DEV** (archiwum lub osobny plik `release.just`).
6. **Ewentualne przeniesienie checkoutu DEV na ext4 (WSL2).**

---

## 12. Kryteria weryfikacji poprawek

Dla każdej fali zmierzyć na tym samym hoście i zapisać w raporcie (z logów `phase=… duration_ms`):

1. Czas od `just docker-dev` do healthy API: zimny start, start bez zmian i start po edycji jednego `.rs`.
2. Czas pętli `.rs` → API i `.py` → API.
3. Brak awarii przy zapisie pliku w trakcie startu (test: `touch` pliku `.rs` co 5 s przez cały start).
4. Ctrl+C w trakcie `just docker-dev`, potem `just docker-dev` działa bez ręcznych pinów.
5. `docker stop` w trakcie `make`, potem start działa.
6. `just docker-dev-reset` przywraca działającą grupę; sesje i wyniki w host storage są nienaruszone (porównanie listy plików i hashy przed/po).
7. Opóźnienie HMR (edycja `.tsx` → zmiana w przeglądarce) i dowód viewportu wg reguł frontendowych.
8. Liczba LOC i receptur `docker-dev*` po Fali 2; liczba wolumenów po `docker-dev-gc`.
9. Brak cichego fallbacku GPU → CPU (wymuszone GPU kończy się błędem, gdy GPU brak).

---

## 13. Stan realizacji Fali 0 (21.10.2026)

Branch `codex/docker-dev-fast-loop-wave0-20261021`, grupa
`fullmag-worktree-docker-dev-fast-loop-wave0-20261-2d13a57d2f1ac818` (port 3241),
host Windows 11 + Docker Desktop WSL2, 40 CPU / ~196 GiB VM, jedno GPU (`89-real`).

### Zrealizowane

| # | Stan | Commit |
|---|---|---|
| R0.2 | CUDA FEM i FDM tylko dla architektury widocznego GPU | `c8d4e7123`, `2d20fae3b` |
| R0.4 | jeden przebieg capture; zapis pliku w trakcie startu powoduje ograniczone (3×) ponowne wczytanie zamiast `exit 2`; cache hashy plików kluczowany `(rozmiar, mtime_ns, tryb)` | `c8d4e7123`, `9144299d9` |
| R0.5 | nieśledzone pliki runtime trafiają do builda | `c8d4e7123` |
| R0.6 | edycja tylko `docs/` lub frontendu używa gotowego pakietu (`cache-hit`) | `c8d4e7123` |
| R0.9 | przerwany kandydat `building` jest odrzucany przy następnym starcie | `c8d4e7123`, `0cfb8ba82` |
| R0.10 | nadzór API toleruje 120 s, pełna sonda co 30 s. Polling Watchpack 2000 ms został cofnięty do 5000 ms: każdy działający frontend odpytuje drzewo przez ten sam serwer 9p (ok. 30% CPU na bezczynny frontend), a HMR nie przyspieszył | `c8d4e7123`, PR 229 |

Poza planem, wymagane do uruchomienia jakiejkolwiek grupy na tym hoście:

- `7a2becd07` — kontrola cgroup2 akceptuje układ Docker Desktop WSL2;
- `97f94d627` — migracja pojemności hosta nie wymaga identycznego
  `inventory_sha256` (skrót obejmuje kwotę i maskę CPU, które migracja z zakresu
  kontenera do `docker_vm_root` z definicji zmienia). Bez tej poprawki każda
  migracja kończyła się „changes native ABI or GPU compatibility”, a od
  `bbf3b2f44` żadna nowa grupa DEV nie mogła wystartować. Zmiana zatwierdzona
  przez użytkownika.

Migracja globalnego ledgera została wykonana z tej grupy
(`--migrate-host-capacity`) po zatrzymaniu za zgodą użytkownika dwóch
konsumentów: `docker-volume-only-implementation` (stop z drain, exit 0) oraz
`viewport-visual-quality` (API martwe od 15 h; stop niepotwierdzony, exit 1 —
grupa wymaga recovery przed kolejnym startem). Receipt
`host_capacity_migration.v1`: polityka `eec1062a…` → `bd18bb4b…`, ledger v5.
Grupy z kodem sprzed `ac8f72ffd` odrzucą ledger v5 i wymagają aktualizacji.

### Pomiary (log `backend-dev phase=… duration_ms`)

| Scenariusz | Baza (§3.2) | Fala 0 |
|---|---|---|
| Capture źródeł | 256–461 s, 3 z 4 startów błąd | zimny 126 s; z cache hashy **31–34 s** (Git ~31 s, hashe 0,3 s przy 9190 trafieniach) |
| Sync shadow | 8,6 s | zimny 86 s; potem 3–5 s |
| Edycja jednego `.rs` (`fullmag-session`) → API | ≈ 8–12 min (szacunek) | **2 min 50 s** od startu kontenera (`make` 75 s); `just docker-dev` → API ≈ 3,5 min z migracją |
| Restart bez zmian → API | pełny pipeline | **85 s**, `cache-hit`, bez `make` |
| Restart po edycji tylko `docs/` → API | pełny pipeline + nowy pakiet | **81 s**, `cache-hit`, 1 plik przeliczony |
| `just docker-dev` na działającej grupie bez zmian | minuty (capture) | **66 s**, backend bez restartu |
| Zapis pliku w trakcie startu | `exit 2` | ponowne capture 50 s, start kontynuowany |
| Zimny `make` w nowym wolumenie | — | 997 s (`cargo_jobs=4`) |

Po `cache-hit` ok. 40–45 s zajmuje inicjalizacja runtime i ledgera przed
`Ready: API`; capture bez zmian to dziś prawie wyłącznie zapytania Git przez
mount 9p.

### Niezweryfikowane lub otwarte

- **HMR: NOT VERIFIED.** Po edycji `.tsx` zmiana nie pojawiła się w otwartej
  stronie w ciągu 61 s (panel przeglądarki był ukryty). Po przeładowaniu
  `Compiling /workspace` trwało 82 s (zimne 117 s) i pokazało zmianę. Wąskim
  gardłem jest kompilacja Next na mouncie `C:\` przez 9p (§9.3), nie polling.
  Deklaracja „HMR do 2 s” nie jest potwierdzona.
- R0.1 (`CARGO_BUILD_JOBS` = limit CPU, limity w `.env`) — w PR budżetów grup
  (branch `claude/zen-nobel-82d0ae`, ADR 0067); tu nadal `cargo_jobs=4`.
- R0.3 (snapshot i commit poza wejściami kompilacji) — nie rozpoczęte.
- R0.7, R0.8 — czekają na decyzje z §11.
- Ctrl+C w trakcie `just docker-dev` i `docker stop` w trakcie `make` (§12 p. 4–5)
  — sprawdzone tylko testami źródłowymi.

---

## Załącznik A. Kluczowe miejsca w kodzie

- Właściwy build: `docker/all-in-one/backend_dev.py:4547-4548` (`make install-cli-dev`), `Makefile:121-330`.
- Podwójny capture: `docker/all-in-one/backend_source.py:1650-1667`; opcje Git: `:662-688`; timeout: `:46`; wykluczenie untracked: `:1557`.
- `-j2`: `docker/all-in-one/backend_dev.py:5469,5487` (stan `7c16297b1`); `CARGO_BUILD_JOBS: "4"` w `compose.dev.yaml` od `72cd5efcd`; środowisko builda: `:1926-1990`.
- Snapshot jako wejście kompilacji: `crates/fullmag-build-info/build.rs:9-45`, `crates/fullmag-fem-sys/build.rs:103,222-225`, `crates/fullmag-session/src/docker_desktop_storage.rs:796,1320`.
- CUDA arch: `docker/fem-gpu/Dockerfile:47,74,254`, `crates/fullmag-fem-sys/build.rs:258-261`.
- Limity kontenera i healthcheck: `compose.dev.yaml` (usługa `backend`: `cpus`, `mem_limit`, `start_period: 14400s`; `frontend`: `FULLMAG_WATCHPACK_POLLING_MS`).
- Lease i outcome-unknown: `scripts/docker_build_control.py:30,500-570`; komunikat: `scripts/docker_dev_up.py:437-440`.
- Bramka cgroup: `docker/all-in-one/worker_cgroup_gate.py:26-56,88-100`.
- Kandydat `building`: `docker/all-in-one/backend_dev.py:3443-3447`; retencja bez wywołań: `:4230`.
- Receptury z pinami: `justfile:43-101`.
- Brak usuwania wolumenów: `scripts/docker_backend_volume_cache.py:16`.
- Recovery nieaktywne dla volume DEV: `scripts/recover_docker_orphan.py:5-9`.
