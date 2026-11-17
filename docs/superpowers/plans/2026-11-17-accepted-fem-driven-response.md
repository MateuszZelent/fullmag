# Accepted FEM driven response — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uruchomić bezpośrednie FMR FEM/GPU BuckyBall z zabezpieczonego stanu, zapisać odpowiedź i udostępnić ją w istniejącym UI3350.

**Architecture:** Osobny producent analizy korzysta ze wspólnego accepted lifecycle i istniejącego native frequency-response runnera. Input M0, preparation, bounded wynik i CAS publication są weryfikowane przed Complete; analiza nie tworzy accepted magnetization state. Kompaktowa projekcja oddziela skalarny control plane od zespolonych pól.

**Tech Stack:** Rust workspace, native FEM/MFEM/CUDA, istniejące CAS i artifact generation, API v2, Zarr v2, Control Room resource hooks.

**Spec:** `docs/specs/accepted-fem-driven-response-v1.md`, `docs/adr/0082-accepted-fem-driven-response.md`.

## Global Constraints

- Użytkownik wybrał bezpośrednie FMR GPU w UI 2026-11-17; nie pytać ponownie o wybór tej drogi.
- Nie uruchamiać ponownej relaksacji. Snapshot25017 pozostaje approximate i equilibrium_verified=false.
- Ms=400000 A/m, Aex=8e-12 J/m, alpha=0.01, B=0 T, gamma0=221100 m/(A s), k=0/free, z-drive=1 A/m.
- Wymuszone GPU pozostaje GPU; gpu_operator_host_krylov jest jawnie hybrydowy.
- Fizyczny case_id nie zmienia się. Declared port_id jest unikalny dla każdego bundle.
- JSON indeksu <=1 MiB; global/point bundle <=256 MiB; całkowity RAM i scratch podlegają osobnym boundom.
- Jedna grupa Compose fullmag-worktree-fullmag-31aac17f56ce61b8; backend3044ee... i frontend7f3498...; brak hostowego Cargo/CMake i osobnego kontenera build.
- Zachować cudze dirty pliki viewportu/frontendu. Workerzy nie są sami w checkoutcie, nie cofają cudzych zmian ani nie delegują dalej.
- Nie otwierać admission, dopóki preparation, input, producer i outputs nie stanowią kompletnej ścieżki.

## Review Focus

- Taka sama liczba próbek przy innej topologii/kolejności ma zostać odrzucona, bez normalizowania lub wypełniania M0.
- Jeden mały plik nie dowodzi, że cały sweep zmieści się w RAM/dysku; native sweep v1/v2 duplikuje dense arrays.
- Stop podczas punktu i complete-before-ACK mają zachować epoch, partial status i brak ponownego Solve.
- CAS-only reopen ma zachować kompletną scientific closure, bez zależności od mutable native output path.
- Hybrid CUDA/host Krylov nie może otrzymać certyfikatu fully-device-resident ani etykiety modal_eigen.

## Task 1: Snapshot M0 i native preparation

**Właściciel:** bounded worker; root koordynuje testy/build.
**Files:** `crates/fullmag-plan/src/preparation.rs`, `crates/fullmag-runtime-control/src/study.rs`, `crates/fullmag-api/src/accepted_fem_preparer.rs`, `crates/fullmag-runner/src/lib.rs`, `crates/fullmag-runner/src/artifacts.rs`; nowe skupione moduły/testy wejścia pod `fullmag-runner/src/fem/` według istniejących wzorców.

**Interfaces:**
- Nowe `PreparationMaterialization::from_fem_frequency_response_execution_plan_for_accepted_run(...)` przyjmuje te same typed argumenty co wersja time-domain i dokładny `NativeFemMeshSpaceEvidence`; odrzuca plan innej rodziny/rzędu.
- `AcceptedStudySnapshot::materialize_fem_frequency_response_preparation_receipt(preparation_id, step_id, native)` wiąże receipt z dokładnym RunSpec/problem/step.
- Existing `study_magnetization_layout_for_plan`, sample-count validator i `materialize_study_magnetization_input_with_overlay` obejmą realne equilibrium M0 FR, bez zmiany output layoutu analizy.

- [ ] RED: dodać regresje zgodnego M0, permutacji/mismatch topology, air support, count/hash mismatch, FE order2 i prepared receipt z innego step. Dla poprawnego fixture wszystkie wartości po materializacji są bitowo równe wejściu, a input plan nie jest mutowany.
- [ ] Uruchomić odpowiedni focused managed Rust filter i zapisać rzeczywisty RED przed implementacją.
- [ ] Implementować powyższe granice; nie dodawać fallbacku ani dispatch FR do time-domain worker.
- [ ] GREEN: ten sam filter, dotychczasowe FEM/inspection preparation i ordinary M0 input regresje.
- [ ] Review/diff, commit jednego spójnego etapu wraz z dowodem; bez częściowego otwarcia capability.

## Task 2: Bounded response codec i compact published closure

**Właściciel:** root.
**Files:** nowe `crates/fullmag-application/src/study_frequency_response_artifact.rs`, moduł export w `lib.rs` i rejestr w `study_artifact.rs`; nowe `crates/fullmag-runner/src/frequency_response/accepted_artifacts.rs`, wywołanie w `frequency_response.rs`, istniejący `artifact_generation.rs`.

**Interfaces:**
- `encode/decode_frequency_response_index_bundle` i `encode/decode_frequency_response_point_bundle`: typed identity, manifest bytes, explicit payload table i max_bytes; deterministic binary framing i length/SHA przed alokacją.
- `FrequencyResponseArtifactSet`: exact owner identity, status, global files, ordered per-point files, input/topology fingerprint, declared ports i required resource bounds.
- `collect/publish_frequency_response_artifacts(plan, identity, native_root, published_root, limits)`: tworzy compact sweep v3 oraz manifest/generation z jawnej native allow-listy, bez directory scan i bez full-sweep JSON DOM.

- [ ] RED: roundtrip exact payload bytes; ambiguous JSON, unsafe path, duplicate/case-fold path, truncated/extra payload, corrupt SHA, partial-as-complete oraz sumaryczne RAM overflow odrzucone.
- [ ] Implementować framing osobno od walidacji fizycznej; register nowych tuple Artifact/codec/v1, pozostawiając stare codeki bez zmian.
- [ ] Compact projection zachowuje skalary/residual/chi i referencje do pełnych native Zarr/Cartesian complex XYZ. Legacy native v1/v2 pozostają nietknięte jako source; nowy manifest nie referuje ich dense kopii jako control plane.
- [ ] GREEN: codec i native-fixture publisher bez uruchomienia solvera; brak pliku/skanowania, zero payload fabricated, exact generation hashes.
- [ ] Zrzut samowystarczalnego Zarr zachowuje mesh, M0/mapę, parametry, częstotliwości, response i complex fields na WSL obok kanonicznego skryptu. Weryfikować readback, nie samo istnienie katalogu.
- [ ] Review/diff i commit etapu bez zmiany live admission.

## Task 3: Producent analizy i durable lifecycle

**Właściciel:** root, bounded review po implementacji.
**Files:** nowy `crates/fullmag-api/src/accepted_fem_frequency_response_worker.rs`, rejestr modułu/main, routing i receipt output binding w `accepted_study_worker.rs`, wspólne publication/recovery checks w `fullmag-runtime-control/src/study.rs`.

**Interfaces:**
- `AcceptedFemFrequencyResponsePreparedExecution` zawiera zamrożony problem/plan, stage mesh, owner identity, lease device/UUID, typed ports i resource bounds.
- `prepare_accepted_fem_frequency_response_execution(...)` bez side effect solvera i bez replan z mutable sceny.
- `execute_accepted_fem_frequency_response_attempt(...) -> Completed{outputs, terminal_stats, output_root}|Cancelled{completed_frequency_count, output_root}` bez accepted_state_ref.
- Runner call: istniejący `run_planned_problem_with_live_preview_and_artifact_identity`; native callback/interrupt zachowuje wspólne Stop/control fencing.

- [ ] RED: obcy lease/device/UUID/preparation, niepełne ports, brak Start release i state-output masquerading odrzucone.
- [ ] Implementować separate producer oraz explicit Artifact bindings w completed receipt i recovery. Jeden fizyczny case, unikalne porty.
- [ ] Index/point consistency i wszystkie hashe muszą być zweryfikowane przy publication, Complete i CAS-only recovery.
- [ ] Test Stop przed pierwszą częstotliwością, po ukończonym prefiksie i complete-before-ACK. Counter frequency jest prawdziwy; time/dt LLG nie są wymyślane.
- [ ] GREEN w fixed backend; commit spójnego etapu z receipt, admission nadal zamknięte.

## Task 4: Admission i deterministyczne porty

**Files:** `crates/fullmag-api/src/live_accepted_execution.rs`, odpowiednie application Study output defaults/bindings, `docs/specs/capability-matrix-v0.md` oraz ADR0082 status evidence.

- [ ] RED: FrequencyResponse free/Gamma provided/strict/double + explicit native GPU hybrid dopuszczony dopiero z kompletnym producerem; modal/device-krylov/Floquet/P2 pozostają jawnie poza zakresem.
- [ ] Wyprowadzić `response` i `response-frequency-NNNNNN` z immutable ordered frequency list przed acceptance. Explicit unsupported ports nie są cicho podmieniane.
- [ ] Resource preflight liczy rzeczywisty native magnetic-node descriptor oraz cały sweep/bundle RAM i scratch. Brak dowodu bounds kończy admission.
- [ ] GREEN, brak zmiany obsługi Run/Relax/inspection; zaktualizować capability jako implemented/source-only do czasu rzeczywistego runtime.
- [ ] Commit etapu, dopiero teraz możliwe uruchomienie przyjętego FR w przebudowanym backendzie.

## Task 5: Publiczne zasoby i reopen

**Files:** existing `router_v2/handlers/analysis/frequency_domain.rs`, `analysis/results.rs`, data-plane field readers, accepted stage projection; tylko konieczne frontend resource parsers/tests, bez cudzych zmian viewport material.

- [ ] Typed readers preferują compact v3 dla nowego published manifestu; v1/v2 czytają starsze wyniki. Jeden existing resource contract, bez host-path endpointu.
- [ ] Native compact mapping zapisany z rzeczywistego magnetic_node_indices oraz source topology/M0 hash; API odrzuca count-only dopasowanie i podaje zweryfikowaną ordered mapę do existing FMVP5 ExplicitNodeIndices. Test same-count permutation i obcy mesh muszą nie przejść.
- [ ] Root published location wynika z immutable attempt/output receipt; wszystkie source revisions i session/run/stage/runtime muszą pasować.
- [ ] Test spectrum/response field reads i CAS-only reopen z usuniętą wyłącznie testową mutable kopią. Nie uruchamiać ponownie Solve w recovery.
- [ ] Source lint/typecheck/API contract gates dla dotkniętych warstw; commit.

## Task 6: Managed GPU proof i BuckyBall

**Files:** managed scope w `scripts/docker_authoring_contract_checks.py`/`docker_volume_checks.py`, focused Rust/native fixtures i browser QA; skrypty/wyniki BuckyBall w istniejącym CASE na E.

- [ ] Source regression scope działa przez launcher/BuildControl w stałym backendzie; żadnego hostowego Cargo/CMake i ręcznego alternatywnego kontenera.
- [ ] Przed rebuild potwierdzić run=None i pustą queue, zachować scenę2/asset hashes i pełny snapshot25017. Managed restart tylko tej grupy.
- [ ] Mały actual CPU/GPU free/Gamma FR z niską liczbą punktów: device/engine/UUID, residual, output publication i reload. Stop/cancel test oddzielny od pełnego sukcesu.
- [ ] Nowy fenced BuckyBall Compute (poprzednie422 nie przyjęto); nie powtarzać po unknown result bez ledger audit.
- [ ] Sprawdzić native M0 hash/map/mesh, alpha=.01, brak Relax i GPU hybrid bez fallbacku. Doprowadzić scout sweep do terminalnego stanu; przy numerical failure zachować wyniki i poprawiać przyczynę bez fałszywego Complete.
- [ ] Zapisać samowystarczalny Zarr/kanoniczny script na E, wykres widma i response fields w rezonansach; zweryfikować odczyt.
- [ ] Real browser: spectrum, wybrany response field, canvas i WebGL oraz reload z tą samą tożsamością. Driven pattern nie jest eigenmode.
- [ ] PR/review/CI/merge według repo. Aktywna grupa i cudzy dirty checkout blokują cleanup; zachować dane i zapisać dokładny stan zamiast wymuszać usunięcie.

## Stan na start

Kod backendu pozostaje HEAD6846e3d4a5b60e2bfa19202be7b075fb34f08110.
Brak aktywnego runu, ledger0, sesja buckyball_fmr_k0_pilot, scena2.
Snapshot/state+mesh są sprawdzone i zapisane na E; FMR nie jest uruchomiony.
Wybrane przez użytkownika rozszerzenie ma być wykonane, a nie zastąpione FFT.
