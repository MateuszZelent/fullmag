# P0-E — Baseline fixture’ów, receiptów i progów przed pomiarem

Status tego dokumentu: **inventory read-only, 2026-09-20**. Nie uruchomiono
builda, kompilacji testów, zadania runtime, przeglądarki ani GC. Maszynowa lista
tożsamości znajduje się w
[`02-baseline-manifest.json`](02-baseline-manifest.json).

## Decyzja audytowa

Fixture jest zachowaną referencją wejściową, a receipt jest dowodem wykonania
tylko wtedy, gdy zawiera kompletną tożsamość źródła, budowy, hosta, urządzenia,
lane, precision, fixture’u i artefaktów. Sam plik scenariusza, `metadata.json`,
`qualification.json` albo raport opisany jako „verified” nie podnosi statusu
runtime.

Nie zamrażam bieżącego stanu jako golden baseline. Główne checkout jest na
`master@14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, ale ma zmiany submodułów oraz
nieśledzone materiały audytu. Dopóki nie ma niezmiennego snapshotu źródła i
receiptu z pełnym `fullmag-build-info`, każdy nowy wynik ma status
`NOT_VERIFIED`. To rozdziela zachowanie znane z historii od normatywnego
kontraktu po refaktoryzacji.

## Co można zachować

| Identyfikator | Referencja | Stan | Ograniczenie |
|---|---|---|---|
| `P0E-FIX-FEM-BOX500-V1` | `examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json` | `PRESERVE_REFERENCE` | Tożsamość fixture’u, `problem_ir_sha256`, mesh hash i mesh signature są zapisane; brak bieżącego receiptu. |
| `P0E-FIX-FEM-BOX500-V2` | `examples/assets/fem_performance/box500_airbox_exchange_demag_v2.fixture.json` | `PRESERVE_REFERENCE` | Wersja v2 jest wejściem fixture suite; brak pomiaru nie jest dowodem poprawności runtime. |
| `P0E-FIX-FEM-BOX500-SUITE-V2` | `examples/assets/fem_performance/amg_qualification_suite_v2.json` | `PRESERVE_REFERENCE` | Suite opisuje trzy tożsamości fixture/mesh, nie wynik solvera. |
| `P0E-FIX-FDM-SP4-DERIVED` | `tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json` | `REFERENCE_ONLY` | Plik jawnie deklaruje „SP4-derived, not canonical SP4 qualification”. |
| `P0E-FIX-SINC-LAYER-SCRIPTS` | `tests/fem_fdm_mumax3_sinc_layer/` — FDM/FEM/FK/MuMax3 scripts | `PRESERVE_REFERENCE` | Wiele wariantów nie stanowi jednego, wspólnego receiptowego przypadku produkcyjnego. |

Hashy plików, rozmiary i pola osadzone w fixture’ach są w manifeście. Hash
fixture’u nie zastępuje hashy osadzonego ProblemIR/meshu: oba poziomy muszą
zgadzać się w przyszłym receipt.

## Receipt’y i raporty znalezione w checkout

| Identyfikator | Artefakt | Odczytany status | Klasyfikacja |
|---|---|---|---|
| `P0E-RECEIPT-SINC-FDM-GPU` | `tests/fem_fdm_mumax3_sinc_layer/results/current/fdm_gpu/qualification.json` | `status=not_evaluated`, `validation_state=unvalidated`, `device=cuda`, `precision=double` | `REJECTED_AS_GOLDEN`; dokument sam mówi, że utworzenie artefaktów nie jest walidacją. |
| `P0E-RECEIPT-SINC-FDM-GPU-DIAGNOSTIC-RETRY` | `tests/fem_fdm_mumax3_sinc_layer/results/current/fdm_gpu_dt50fs_diagnostic_retry/qualification.json` | identyczny hash i ten sam `not_evaluated` | Nie jest niezależnym receipt’em i nie podnosi statusu. |
| `P0E-HIST-K0-S00` | `docs/audits/2026-09-10-fem-k0-s00-baseline-and-evidence.ledger.json` | historyczny bundle, 15 punktów Kittel, max względny błąd `5.194679480952314e-14`; jednocześnie `validation_state=unvalidated`, `window_complete=false`, `fit_status=partial` | `HISTORICAL_REFERENCE_ONLY`; zachować także negatywne wyniki, ale nie przypisywać ich bieżącemu masterowi. |
| `P0E-HIST-FEM-GPU-DOC-MANIFEST` | `docs/performance/fem-gpu-performance-remediation-2026-09-01/.../manifest.json` | `verification_scope=source_contracts_and_justfile_only`, `managed_gpu_runtime=NOT VERIFIED` | Dokumentacja kontraktowa, nie receipt runtime. |
| `P0E-FEM-CPU-BASELINE-DOC` | `docs/performance/fem_cpu_baselines.md` | accepted baseline CSV pozostaje open | Brak przenośnego, zaakceptowanego baseline’u CPU. |

Historyczny K0 ma własną tożsamość: base commit
`1620d2762d99b58cddcfc93f7eb505b84dfbf178`, build commit
`4c7897f218eb0c32612db1f43a844502a316b4f6`, dirty source snapshot
`e5679faa14d8f6fc5010aef436c117aad52194e02caab50f3411d49ae5a8fd3a`. Te dane
pozostają częścią historii dowodów, ale nie są tożsamością obecnego checkoutu.

## Trasy, które mogą dostarczyć przyszły baseline

Poniższe trasy są wskazanymi wejściami repozytorium. W tym audycie każda ma
`NOT_RUN`; nazwa recepty nie oznacza, że została wykonana.

| Trasa | Rola | Receipt/output, który trzeba zachować | Minimalny warunek identyfikacji |
|---|---|---|---|
| `just verify-fem-performance-fixture-v2` (`justfile:4490`) | fixture identity + managed FEM CPU contract | `.fullmag/reports/fem-performance-fixture-v2/` | v2 fixture/suite hash, managed runtime manifest, source/build identity |
| `just capture-fem-gpu-pre-remediation-performance-baseline` (`justfile:4713`) | historyczny pre-remediation reference | `.fullmag/reports/fullmag_fem_gpu_pre_remediation_performance_baseline.*` | v1 fixture + accepted GPU environment; nie promować automatycznie do golden |
| `just verify-fem-gpu-performance-regression` (`justfile:4524`) | regression na identycznym GPU | `.fullmag/reports/fem_gpu_performance_regression.*` | UUID/name/compute capability, v1 fixture, accepted CSV, source/build identity |
| `just verify-fem-relaxation-production-benchmark` (`justfile:4220`) | managed FEM relaxation | `.fullmag/reports/fullmag_relaxation_production_benchmark.*` | source, build, host, lane/device/precision, repeats, solver oracle i p50/p95 |
| `just verify-fem-gpu-demag-performance-benchmark` (`justfile:4753`) | demag timing/parity | `.fullmag/reports/fullmag_fem_gpu_demag_performance_benchmark.*` | GPU identity, mesh signature, parity oracle, iteration/residual evidence i p50/p95 |
| `just verify-fem-fk-sinc-layer-validator` (`justfile:1865`) | Fredkin–Koehler sinc-layer oracle | route-owned validator outputs | dokładny scenariusz, lane/device/precision, source/build identity |
| `just run-scratch-authoring-fdm-browser-smoke` (`justfile:5105`) | frontend authoring/browser smoke | browser proof manifest/receipt | browser build identity, URL/commit, visible canvas and API evidence |
| `just verify-scratch-authoring-browser-matrix` (`justfile:5113`) | frontend FDM/FEM authoring matrix | matrix receipt + per-case artifacts | case id, browser/runtime identity, requested/resolved/executed lane |
| `just verify-managed-fem-runtime-source-provenance` (`justfile:5996`) | prerequisite provenance, nie benchmark | temporary provenance + runtime manifest | exact source-input manifest and runtime bundle identity |

`crates/fullmag-bench` jest harness’em źródłowym, ale w bieżącym `justfile` nie
znaleziono repozytorium zarządzanej recepty odwołującej się do `fullmag-bench`.
Bez wrappera z preflightem i receipt’em bezpośredni binarny run pozostaje
`SOURCE_ONLY_NOT_APPROVED_AS_QUALIFICATION_ROUTE`. Przed użyciem P0-E należy
dodać trasę, która wymusi `FULLMAG_BENCH_COMMIT`, `FULLMAG_BENCH_BUILD_ID` i
pełny `fullmag-build-info`.

## Progi przed pomiarem

Nie wpisuję czasów ani rozmiarów pamięci, których nie zmierzono. Poniższe
zasady są tabelą wejściową do pierwszego nowego receiptu.

| Obszar | Źródło progu/kontraktu | Reguła przed pomiarem | Status teraz |
|---|---|---|---|
| Source/build identity | `crates/fullmag-build-info/src/lib.rs:2-26`, `build.rs:38-64` | wymagane `built_at_utc`, commit, clean/dirty, `source_snapshot_sha256`; brak któregoś pola blokuje promocję | `NOT_RUN` |
| Fixture identity | v1/v2 fixture + suite | zgodność pliku, ProblemIR hash, mesh hash/signature i environment; mismatch blokuje porównanie | `SOURCE_VERIFIED`, runtime `NOT_RUN` |
| FDM CPU timing | `crates/fullmag-bench/qualification/fdm_cpu_production_thresholds.v1.json` | minimum 20 powtórzeń; median ratio ≤1.15, p95 ratio ≤1.25; porównanie tylko przy tej samej fixture/host policy | próg istnieje, pomiar `NOT_RUN` |
| Frozen Spins | `crates/fullmag-bench/qualification/frozen_spins_performance_thresholds.v1.json` | minimum 5 powtórzeń, ale polityka ma `draft_pending_owner_approval`; nie jest jeszcze golden | `PROVISIONAL`, pomiar `NOT_RUN` |
| FEM CPU | `docs/performance/fem_cpu_baselines.md` | najpierw wybrać i zarchiwizować kontrolowany CSV; p50/p95, pamięć, iteracje, mesh signature i toolchain | `NO_ACCEPTED_BASELINE` |
| FEM GPU regression | `justfile:4524` | route ma porównywać ten sam accepted environment; domyślna granica recepty to 5% regression, lecz nie jest to dowód bez receiptu | próg recepty, pomiar `NOT_RUN` |
| FEM GPU demag | `justfile:4753` | route-specific defaults include `max-performance-regression-percent=10`; zachować solver iteration/residual, CPU/GPU oracle i transfer/readback telemetry | próg recepty, pomiar `NOT_RUN` |
| FDM multilayer | `tests/.../thresholds.v1.json` | rtol/atol oraz moment/energy residual mogą być użyte tylko w deklarowanym SP4-derived scope | referencja, pomiar `NOT_RUN` |
| Frontend/browser | `justfile:5105,5113` + final/04 | przed pierwszym runem zdefiniować p50/p95 dla shell/project open, Apply, first accepted, export oraz limity RAF/subscriptions/memory; nie wymyślać wartości | `THRESHOLD_NOT_SET` |
| Storage/session | final/02–04, CAE-62/64/65/70 | najpierw syntetyczny store i receipt poprawności; pomiary GC/flush/lock dopiero po bezpiecznym kontrakcie, nigdy na danych użytkownika | `NOT_RUN`, blokada dla produkcyjnego GC |

Progi są porównywalne tylko w obrębie tej samej klasy: fixture, schema/ABI,
source snapshot, host/OS, compiler/runtime, requested/resolved/executed lane,
device, precision, thread policy, cold/warm cache i liczba powtórzeń. Zmiana
któregokolwiek z tych pól tworzy nowy baseline albo wymaga jawnego mapowania;
nie wolno dopisywać wyniku do istniejącego CSV po nazwie pliku.

## Minimalny receipt do następnego pomiaru

Każdy przyszły P0-E receipt musi zawierać:

1. `case_id`, plan/package i dokładną ścieżkę fixture’u oraz SHA256 pliku;
2. source commit, dirty-state/diff lub `source_snapshot_sha256` oraz wersję
   schema/ABI;
3. pola `fullmag-build-info`: `built_at_utc`, `git_commit`,
   `worktree_state`, `source_snapshot_sha256`;
4. host/OS, CPU/GPU identity, driver/toolchain, threads, cache profile;
5. requested, resolved i executed backend/device/precision/mode;
6. dokładną receptę, argumenty i zmienne środowiskowe;
7. exit status, elapsed time, repetitions, p50/p95/spread oraz peak memory,
   transfer/readback/alloc/subscription/RAF telemetry tam, gdzie dotyczy;
8. manifesty i artefakty z hashami, a dla nauki także oracle, residual,
   convergence i status `passed`/`failed`/`not_evaluated`.

Receipt bez któregoś z punktów pozostaje `NOT_VERIFIED`, nawet gdy pojedynczy
wynik liczbowy wygląda poprawnie. Historyczne `verified` oznacza wyłącznie
zweryfikowany zakres tamtego audytu; nie oznacza bieżącego runtime ani zgody na
cleanup.

## Bezpieczna kolejność po odblokowaniu pomiarów

Najpierw zachować i zhashować fixture’y oraz odtworzyć source/build identity na
czystym lub jawnie zamrożonym snapshotcie. Następnie wykonać jeden kontrolny
receipt per lane na zatwierdzonej trasie, osobno dla cold/warm i z ustaloną
liczbą powtórzeń. Dopiero po przejściu kontroli tożsamości i oracle wybrać
accepted baseline oraz policzyć progi p50/p95. Wyniki z obecnych
`not_evaluated`, `unvalidated`, dirty historical bundles i pre-remediation
raportów pozostają zachowane jako dowody historii i nie mogą zasilać GC,
regresji ani promocji produkcyjnej.
