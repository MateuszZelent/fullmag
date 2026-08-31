# Time-Domain Spectral Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zbudować produkcyjny, backend-neutralny workflow `time_domain_spectral_analysis`, który wykonuje dynamikę LLG, zapisuje `m(t,r)`, oblicza FFT i pola odpowiedzi, publikuje zasoby API, integruje opcjonalne MMPP oraz udostępnia kompletny Control Room i eksport.

**Architecture:** Fullmag jest właścicielem kanonicznego time-series, natywnego baseline FFT, artefaktów i API. Postprocessing jest niezależnym etapem konsumującym immutable source artifact; MMPP działa wyłącznie jako opcjonalny adapter/izolowany worker. Implementacja jest podzielona na cztery specjalistyczne plany z bramkami CPU oracle → storage/API → GPU → produkcyjna kwalifikacja.

**Tech Stack:** Python 3 Fullmag DSL, Rust `fullmag-ir`/`fullmag-plan`/`fullmag-runner`/`fullmag-api`, FDM CPU/CUDA, FEM MFEM/hypre/libCEED/CUDA, Zarr v2, HDF5, FMS, OpenAPI v2, React/Next.js 16/TypeScript/Zustand/ECharts/R3F, opcjonalny Python MMPP worker.

## Global Constraints

- `time_domain_spectral_analysis` pozostaje osobnym produktem od `modal_eigen` i kanonicznego `driven_response`; symbole `DrivenFrequencyResponse*` są szczegółem implementacji istniejącego produktu.
- Fullmag musi wykonywać bazowe FFT i odczytywać wyniki bez zainstalowanego MMPP.
- MMPP nie jest importowane do krytycznej ścieżki Rust/native; worker działa w osobnym procesie.
- `requested_analysis_engine=auto|native|mmpp` jest rozwiązywane deterministycznie przed wykonaniem; manifest zachowuje requested/resolved/reason/capability snapshot, a po rozwiązaniu nie istnieje fallback ani niejawny podział produktów między producentów.
- Certyfikowane FFT konsumuje równomierny `exact_physical_time_series`, nie surowe accepted solver steps.
- Resampling jest jawnym derived artifact z metodą, błędem, hashami i statusem kwalifikacji.
- Zarr v2 jest pierwszym nośnikiem fizycznym; HDF5 zachowuje identyczny model logiczny.
- Ciężkie tablice są data-plane; JSON i realtime pozostają bounded control-plane.
- FDM/FEM oraz CPU/GPU zachowują jeden kontrakt fizyczny i osobne realizacje wykonawcze.
- Forced GPU musi fail-closed; brak cichego CPU fallbacku i brak CPU hot-loop w lane GPU.
- FEM zachowuje `tet4`, `prism6` i `pyramid5`; brak ukrytej konwersji topologii.
- Zmienna szerokość/taper anteny wymaga pełnego 3D conductor/current solve.
- Control Room używa generated OpenAPI → `ControlRoomApi` → resource hooks → moduły.
- Moduły Control Room nie importują innych modułów; wspólne typy trafiają do kernel/shared.
- Zustand przechowuje tylko bounded IDs i preferencje, nigdy pełne dane naukowe.
- Jedyny WebGL canvas należy do aktywnego `viewport-3d`; nieaktywne ciężkie center surfaces są odmontowane.
- Nie obniżaj jakości danych ani wizualizacji jako niejawnej optymalizacji.
- Native FEM/MFEM/CUDA/hypre/libCEED verification używa container-backed repo `just` recipes.
- Windows jest podstawową ścieżką produktu; FEM/GPU używa zatwierdzonych managed/container launcherów.
- Każdy status produkcyjny wymaga source identity, runtime manifest, device/precision i completed receipt.
- Plany, audyty i dokumentacja są po polsku; symbole, kod i commit messages pozostają po angielsku.
- Nie zmieniaj, nie stashuj i nie resetuj niezależnego dirty worktree.
- Nie commituj, nie pushuj i nie merguj bez osobnej zgody użytkownika.

---

## 1. Dokumenty składowe i odpowiedzialność

| Dokument | Odpowiedzialność |
|---|---|
| `docs/superpowers/specs/2026-08-31-time-domain-spectral-analysis-design.md` | zatwierdzony model produktu i architektura |
| `docs/audits/2026-08-31-time-domain-spectral-analysis-audit.md` | stan zastany, dowody, luki i NO-GO |
| `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-contracts-and-storage.md` | jedyny właściciel physics note 0997, ADR 0029, Python, IR, planner, `fullmag-analysis`, artifact/storage i MMPP protocol |
| `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-backends.md` | runner bindings, legacy adapters, recorder integration, FDM/FEM CPU/GPU, drive i finite-k; konsumuje zamrożone kontrakty |
| `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-api-ui.md` | OpenAPI, resources, Control Room, eksport i browser |
| `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-validation-rollout.md` | oracles, parity, performance, evidence i rollout |

Plany składowe nie nadają równoległej własności tym samym plikom. Jeśli plan backendowy opisuje test lub interfejs `fullmag-analysis`, jest to rozwinięcie kryterium akceptacji, nie uprawnienie do utworzenia konkurencyjnego modułu. Kolejność i jedyny owner są następujące:

| Plik/rodzina | Jedyny owner zmian | Konsumenci read-only lub późniejsi |
|---|---|---|
| `docs/physics/0997-time-domain-spectral-analysis.md` i source map | contracts/storage | backends, validation, API/UI |
| `docs/adr/0029-time-domain-spectral-analysis-artifact-and-engine.md` | contracts/storage | wszystkie pozostałe plany |
| `crates/fullmag-ir/src/time_domain_spectral.rs` | contracts/storage | planner, runner, API |
| `crates/fullmag-analysis/**` | contracts/storage | runner/backends przez publiczny trait |
| `crates/fullmag-runner/src/time_series_recorder.rs` i writers | contracts/storage, następnie serialny integration patch backends | API i validation |
| `backends/fdm/**`, `backends/fem/**`, runner lane bindings | backends | validation |
| `crates/fullmag-api/**`, `apps/control-room/**` | API/UI | validation |
| validators, receipts i qualification scope | validation/rollout | wszystkie gate reports |

Żaden agent nie rozpoczyna kolejnego ownera przed zielonym kontraktem poprzednika; pliki wspólne są przekazywane serialnie, nigdy edytowane równolegle.

## 2. Zależności wykonania

```text
M0 audit/spec freeze
  -> M1 physics + public contracts
  -> M2 exact-time source artifact + validator
  -> M3 native FFT CPU oracle
  -> M4 FDM CPU end-to-end
  -> M5 FEM CPU end-to-end
  -> M6 run-scoped API + Control Room
  -> M7 MMPP adapter + HDF5 parity
  -> M8 FDM GPU regional drive + sampling
  -> M9 FEM GPU parity
  -> M10 solved antenna 3D
  -> M11 immutable production candidate
```

Prace API schema i neutralne modele UI mogą rozpocząć się po zamrożeniu M1/M2, ale nie mogą deklarować `ready` bez prawdziwego M3/M4 artefaktu.

## 3. Bramki obowiązkowe

### G0 — source i scope

Wymagane dowody:

- pełny commit hash;
- branch/worktree path;
- lista lokalnych zmian;
- scope ID;
- canonical docs hierarchy;
- capability snapshot.

### G1 — kontrakt naukowy

Wymagane dowody:

- równania i SI;
- FFT/phasor convention;
- sampling/Nyquist/df;
- source subtraction;
- susceptibility floor/mask;
- spatial transform semantics;
- Python → IR → Python round-trip.

### G2 — source artifact

Wymagane dowody:

- exact requested/actual time;
- bounded Zarr writer;
- carrier descriptor;
- mesh/topology hash;
- atomic ready publication;
- corruption rejection;
- no silent resampling.

### G3 — native CPU oracle

Wymagane dowody:

- analytic sinusoid;
- phase and normalization;
- two-tone resolution;
- Kittel/precession fixture;
- response field;
- deterministic cache identity.

### G4 — backend lane

Wymagane osobno dla każdego lane'u:

- requested/resolved execution;
- real runtime;
- exact-time sampling;
- artifact validator;
- time/mesh convergence;
- no fallback;
- receipt.

### G5 — API/UI

Wymagane dowody:

- generated OpenAPI;
- run-scoped resources;
- binary heavy data;
- revision/ETag/404;
- historical run;
- spectrum → peak → field → 3D;
- export;
- browser i WebGL proof.

### G6 — production candidate

Wymagane dowody:

- jeden immutable artifact root;
- jeden source identity;
- spójny manifest/capability/session/UI;
- CPU/GPU parity w deklarowanym scope;
- MMPP/storage parity;
- bounded performance;
- brak niezaklasyfikowanych luk.

## 4. Statusy promocji

Poniższy łańcuch jest `promotion_gate`, a nie replacementem statusów runtime. Runtime używa `execution_status`; bundle używa `artifact_status`; dowód naukowy używa `validation_state`; capability używa `product_status`; klient ma lokalny resource lifecycle. Crosswalk i legalne kombinacje są zamrożone w zatwierdzonej specyfikacji, sekcja 13.3.

```text
unvalidated
-> contract_validated
-> algebra_validated
-> physics_validated
-> runtime_validated
-> browser_validated
-> production_qualified
```

Nie wolno przeskakiwać poziomów. `source_visible`, `executable`, `partial_production_executable` i `production_qualified` nie są synonimami.

### Task 1: Zamrozić baseline i utworzyć scope registry

**Files:**
- Create: `docs/validation/time-domain-spectral-analysis-v1-scope.yaml`
- Create: `docs/validation/time-domain-spectral-analysis-qualification-matrix.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Test: `scripts/test_validate_time_domain_spectral_scope.py`

**Interfaces:**
- Consumes: obecny HEAD, zatwierdzoną specyfikację i audyt.
- Produces: `scope_id=time_domain_spectral_analysis.v1`, machine-readable lane status i wymagane receipt fields.

- [ ] **Step 1: Utworzyć izolowany worktree wykonawczy**

Użyć `using-git-worktrees` przed pierwszą zmianą kodu. Worktree ma startować z pełnego, jawnie zapisanego commita, bez kopiowania niezależnych zmian bieżącego checkoutu.

- [ ] **Step 2: Zapisać failing scope-validator fixture**

Test ma zbudować scope bez `source_commit`, `backend`, `device`, `precision`, `artifact_root` i `completed_receipt`, uruchomić walidator i oczekiwać kodu 1 oraz nazw wszystkich brakujących pól.

Run:

```powershell
python -m pytest scripts/test_validate_time_domain_spectral_scope.py -q
```

Expected przed implementacją:

```text
FAILED scripts/test_validate_time_domain_spectral_scope.py::test_missing_required_fields
```

- [ ] **Step 3: Zaimplementować ścisły schema validator**

Schema odrzuca skrócone commity, puste identity, status bez wymaganych receipts i nieznany lane. Dopuszczalne lane'y to dokładnie:

```text
fdm_cpu
fdm_gpu
fem_cpu
fem_gpu
```

- [ ] **Step 4: Uruchomić test i walidację scope**

```powershell
python -m pytest scripts/test_validate_time_domain_spectral_scope.py -q
python scripts/validate_time_domain_spectral_scope.py docs/validation/time-domain-spectral-analysis-v1-scope.yaml
```

Expected:

```text
all tests passed
time-domain spectral scope: valid
```

- [ ] **Step 5: Review checkpoint**

Sprawdzić `git diff --cached --name-only` osobno. Nie wykonywać commita bez zgody użytkownika.

### Task 2: Wykonać plan kontraktów i storage do bramki G2

**Files:**
- Plan: `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-contracts-and-storage.md`
- Produces: physics note, Python/IR/planner types, Zarr/HDF5 descriptors, validators i MMPP protocol.
- Test: testy wyszczególnione w planie kontraktów i storage.

**Interfaces:**
- Consumes: `scope_id`, zatwierdzony phase convention i lane vocabulary.
- Produces: `TimeDomainSpectralAnalysisIR`, `TimeSeriesArtifactDescriptor`, `SpectralArtifactManifest`, `SpectralWorkerProtocol`.

- [ ] **Step 1: Wykonać zadania physics/Python/IR w kolejności planu składowego**

Każdy publiczny typ ma failing Python round-trip test przed implementacją.

- [ ] **Step 2: Wykonać exact-time sampling contract**

Test musi dowieść rozdziału accepted-step i requested output grid przy RK45.

- [ ] **Step 3: Wykonać Zarr writer/reader/validator**

Test obejmuje partial chunks, checksums, topology identity, phase convention i atomic ready.

- [ ] **Step 4: Wykonać logiczny HDF5 mirror**

Test porównuje logical hashes, units, axes i values z Zarr.

- [ ] **Step 5: Zamknąć G1 i G2**

G1/G2 są zamknięte tylko po zapisaniu konkretnych receipt paths w qualification matrix.

### Task 3: Wykonać natywny spectral engine i FDM CPU oracle

**Files:**
- Plan: `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-backends.md`
- Produces: `TimeSeriesRecorder`, `NativeSpectralEngine`, FDM CPU end-to-end artifact.
- Test: analytic FFT, FDM drive/time-series/response field fixtures.

**Interfaces:**
- Consumes: `TimeSeriesArtifactDescriptor`, resolved analysis request i artifact writer.
- Produces: `spectra.zarr`, `peaks.v1.json`, `response_fields.zarr`, execution receipt.

- [ ] **Step 1: Zaimplementować spectral engine przez analytic fixtures**

Pierwszy passing scope obejmuje sinusoidę, dwuton, fazę, PSD, Hann coherent gain i susceptibility mask.

- [ ] **Step 2: Podłączyć FDM CPU exact-time recorder**

Recorder nie może zmieniać solver physics ani używać numeru kroku jako czasu fizycznego.

- [ ] **Step 3: Wykonać mały FDM CPU workflow**

```text
relax -> regional sinc drive -> LLG -> m(t,r) -> native FFT -> peak -> response field
```

- [ ] **Step 4: Uruchomić artifact validator**

Expected: wszystkie identity, osie, jednostki, checksumy i status `ready` są spójne.

- [ ] **Step 5: Zamknąć G3 dla FDM CPU**

Nie promować FDM GPU ani FEM na podstawie FDM CPU receipt.

### Task 4: Wykonać FEM CPU i mixed-topology contract

**Files:**
- Plan: `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-backends.md`
- Produces: FEM node-carrier time-series, P1/probe `S(k,f)`, mixed-topology status.
- Test: managed FEM CPU fixtures i artifact validators.

**Interfaces:**
- Consumes: backend-neutral recorder/engine contracts.
- Produces: FEM CPU receipt, probe operator identity i DSF artifact.

- [ ] **Step 1: Podłączyć recorder przez właściwy native FEM adapter**

Nie dodawać cross-cutting physics do `Context` ani `mfem_bridge.cpp`.

- [ ] **Step 2: Rozszerzyć finite-k z runtime metadata do typed analysis request**

Compatibility reader może odczytać stary request, lecz nowy writer emituje wyłącznie typed contract.

- [ ] **Step 3: Walidować `tet4`, `prism6`, `pyramid5`**

Każdy typ ma jawny supported/unsupported status per operator. Nie konwertować topologii po cichu.

- [ ] **Step 4: Uruchomić container-backed FEM CPU recipes**

Użyć recept wskazanych w planie backendowym po zweryfikowaniu ich rzeczywistego zakresu w `justfile`.

- [ ] **Step 5: Zamknąć G3/G4 dla FEM CPU**

Receipt musi wskazywać source commit, container image, mesh hash, device CPU i precision double.

### Task 5: Wykonać run-scoped API i Control Room na prawdziwym CPU artifact

**Files:**
- Plan: `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-api-ui.md`
- Produces: OpenAPI resources, generated types, hooks, Explorer/Inspector/Analysis/3D/export.
- Test: Rust API, TypeScript unit/integration, browser i WebGL.

**Interfaces:**
- Consumes: immutable FDM/FEM CPU artifact roots i manifest schema.
- Produces: run-scoped `ControlRoomApi` methods, resource hooks, UI selection/overlay flow i browser receipt.

- [ ] **Step 1: Dodać OpenAPI schemas i run-scoped routes**

Najpierw failing API tests dla ready/partial/missing/corrupt/historical run.

- [ ] **Step 2: Regenerować transport i rozszerzyć facade**

Komponenty nie mogą składać URL ani wywoływać `fetch()`.

- [ ] **Step 3: Dodać Study authoring i derived sampling metrics**

Python export musi round-tripować wszystkie pola stage'y.

- [ ] **Step 4: Dodać Results flow**

```text
spectrum point -> peak identity -> Inspector -> field meta -> binary field -> 3D overlay
```

- [ ] **Step 5: Dodać export i historical run**

Historyczny run nie może korzystać z current-session fallback.

- [ ] **Step 6: Zamknąć G5 przez live browser**

Receipt zawiera screenshoty, request log, `gl.isContextLost() == false`, non-zero drawing buffer i export checksum.

### Task 6: Wykonać adapter i isolated worker MMPP

**Files:**
- Plan: `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-contracts-and-storage.md`
- Produces: Python adapter package, worker handshake/cancel/limits i parity fixtures.
- Test: Fullmag-without-MMPP, adapter parity, worker failure injection.

**Interfaces:**
- Consumes: immutable manifest/Zarr/HDF5 i resolved analysis request.
- Produces: wynik w tej samej rodzinie schema `fullmag.time_domain_spectral_analysis.v1` z `producer=mmpp`, `requested_analysis_engine`, `resolved_analysis_engine`, `engine_resolution_reason` i capability snapshot.

- [ ] **Step 1: Zaimplementować reader adapter bez implicit reshape**

FE carrier wymaga topology/probe descriptor.

- [ ] **Step 2: Zaimplementować versioned worker protocol**

Handshake odrzuca niezgodny protocol, manifest hash i limits.

- [ ] **Step 3: Dodać cancellation, timeout i atomic output**

Killed worker nie pozostawia `ready`.

Awaria po `resolved_analysis_engine=mmpp` nie uruchamia native; retry z innym engine ma nową analysis execution identity.

- [ ] **Step 4: Porównać native/MMPP**

Porównanie obejmuje complex amplitude, phase, frequency, peak selection, response field i DSF.

- [ ] **Step 5: Dowieść działania bez MMPP**

Usunięcie/wyłączenie pakietu nie może zmienić native workflow ani odczytu artefaktów.

### Task 7: Wykonać FDM GPU bez fallbacku

**Files:**
- Plan: `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-backends.md`
- Produces: CUDA regional drive, GPU recorder i strict receipt.
- Test: planner fail-before/pass-after, CPU/GPU double parity, residency.

**Interfaces:**
- Consumes: shared field-drive physics, recorder ABI i CPU oracle.
- Produces: `fdm_gpu` qualification candidate.

- [ ] **Step 1: Zachować failing planner gate do chwili istnienia implementacji**

Nie usuwać `fdm_cuda_regional_field_drive_unsupported` przed testem realnego CUDA field/energy/time evolution.

- [ ] **Step 2: Zaimplementować CUDA regional drive i multilayer propagation**

Znaki, jednostki i energy accounting pochodzą ze wspólnego kontraktu.

- [ ] **Step 3: Zaimplementować bounded GPU sampling**

Receipt zapisuje transfer bytes, staging buffers i device residency.

- [ ] **Step 4: Wykonać forced-GPU double parity**

Każdy resolved CPU backend jest błędem kwalifikacji.

- [ ] **Step 5: Zamknąć G4 dla FDM GPU**

Single precision pozostaje osobnym, późniejszym scope.

### Task 8: Wykonać FEM GPU przez managed runtime

**Files:**
- Plan: `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-backends.md`
- Produces: FEM GPU time-series/FFT artifacts i parity receipts.
- Test: container-backed `just` recipes, artifact/source identity validators.

**Interfaces:**
- Consumes: FEM CPU oracle, shared contracts i native GPU realization.
- Produces: `fem_gpu` qualification candidate.

- [ ] **Step 1: Sprawdzić canonical recipes w `justfile`**

Nie używać host-first Cargo/CMake/direct binary jako finalnego dowodu.

- [ ] **Step 2: Wymusić GPU i double precision**

Brak urządzenia lub wymaganej funkcji kończy się fail-closed.

- [ ] **Step 3: Wykonać source/runtime identity check**

Manifest i native binary muszą odpowiadać aktywnemu checkoutowi.

- [ ] **Step 4: Wykonać CPU/GPU parity i profiler receipt**

Profil rozdziela solver, sampling transfer, writer i postprocessing.

- [ ] **Step 5: Zamknąć G4 dla FEM GPU**

Nie rozszerzać validated scope poza wykonane mesh/integrator/drive cases.

### Task 9: Wykonać pełny `AntennaFieldSolve`

**Files:**
- Plan: kontrakty/backendy/API-UI według ownership.
- Produces: `antenna_field_solution.v1`, `SolvedAntennaDrive` i UI stage.
- Test: 3D conductor/current/field oracles, taper geometry i end-to-end spectroscopy.

**Interfaces:**
- Consumes: antenna geometry, terminal conditions, target sampling domain.
- Produces: `H_ant_basis`, `J_charge`, `V_electric`, hashes i solver diagnostics.

- [ ] **Step 1: Zamrozić 3D conductor physics contract**

Test odrzuca próbę użycia 2.5D modelu dla width variation along current.

- [ ] **Step 2: Zaimplementować `AntennaFieldSolve` jako osobny stage**

Stage publikuje field basis artifact przed LLG.

- [ ] **Step 3: Zaimplementować `SolvedAntennaDrive`**

Drive wskazuje immutable solution identity i waveform; nie kopiuje pola do `ProblemIR` JSON.

- [ ] **Step 4: Podłączyć API/UI**

Inspector pokazuje authored geometry, realized conductor, current i field basis provenance.

- [ ] **Step 5: Wykonać end-to-end taper case**

Artifact i UI muszą wskazywać tę samą antenna solution identity.

### Task 10: Wykonać pełną kwalifikację i immutable release candidate

**Files:**
- Plan: `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-validation-rollout.md`
- Produces: completed qualification matrix, receipts, evidence index i go/no-go report.
- Test: wszystkie gates w planie walidacji.

**Interfaces:**
- Consumes: candidates ze wszystkich deklarowanych lane'ów i UI.
- Produces: jeden immutable candidate albo jawny `NO-GO` z brakującymi gates.

- [ ] **Step 1: Uruchomić analytic/manufactured suites**

Każda tolerancja ma źródło i jednostkę.

- [ ] **Step 2: Uruchomić convergence i parity suites**

Brak danych jest `NOT VERIFIED`, nie przejściem.

- [ ] **Step 3: Uruchomić storage/MMPP/failure-injection suites**

Corruption, timeout, cancellation i mismatch mają fail-closed.

- [ ] **Step 4: Uruchomić API/UI/browser/WebGL suites**

Dowód dotyczy tych samych artifact hashes co runtime receipt.

- [ ] **Step 5: Wygenerować go/no-go report**

`GO` jest dozwolone wyłącznie, gdy wszystkie required gates dla deklarowanego scope są kompletne.

## 5. Kolejność review

Po każdym Task:

1. przejrzeć diff tylko dla task scope;
2. porównać publiczne typy z wcześniejszymi `Produces`;
3. uruchomić focused tests;
4. uruchomić `git diff --check`;
5. zapisać evidence paths;
6. nie rozszerzać statusu capability bez receipt;
7. sprawdzić staging osobną komendą;
8. nie commitować bez zgody użytkownika.

## 6. Completion ledger

| Wymaganie | Plan właścicielski | Gate |
|---|---|---|
| publiczna semantyka i nazwy | contracts/storage | G1 |
| Python/IR/planner round-trip | contracts/storage | G1 |
| exact-time `m(t,r)` | contracts/storage + backends | G2 |
| native FFT w `fullmag-analysis` | contracts/storage | G3 |
| runner/backend binding do native FFT | backends | G3/G4 |
| Γ/susceptibility | backends | G3 |
| response fields | backends | G3 |
| `S(k,f)` | backends | G3/G4 |
| Zarr/HDF5 | contracts/storage | G2/G5 |
| MMPP adapter/worker | contracts/storage | G5 |
| FDM CPU/GPU | backends | G4 |
| FEM CPU/GPU | backends | G4 |
| solved antenna | contracts + backends + API/UI | G4/G5 |
| run-scoped API | API/UI | G5 |
| Control Room automation | API/UI | G5 |
| peak → 3D field | API/UI | G5 |
| export/FMS | contracts + API/UI | G5 |
| scientific validation | validation/rollout | G6 |
| browser/WebGL | API/UI + validation/rollout | G5/G6 |
| production promotion | validation/rollout | G6 |

## 7. Końcowe polecenia dokumentacyjne

Przed rozpoczęciem implementacji sprawdzić pakiet dokumentów:

```powershell
git diff --check -- docs/superpowers/specs/2026-08-31-time-domain-spectral-analysis-design.md docs/audits/2026-08-31-time-domain-spectral-analysis-audit.md docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-*.md
rg -n "T[B]D|T[O]DO|implement[ ]later|fill[ ]in[ ]details|similar[ ]to[ ]Task" docs/superpowers/specs/2026-08-31-time-domain-spectral-analysis-design.md docs/audits/2026-08-31-time-domain-spectral-analysis-audit.md docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-*.md
```

Expected:

- `git diff --check` kończy się kodem 0;
- skan niedozwolonych wzorców nie zwraca dopasowań;
- wszystkie ścieżki oznaczone `Read-only`, `Modify` lub istniejący punkt wejścia istnieją w baseline; wyjątkiem jest jawnie opisane przyszłe `Read-only prerequisite owned by ...` albo `Modify after <Task/plan> Create`, które może pojawić się dopiero po wykonaniu wskazanej zależności; każda taka zależność musi być sprawdzona na wejściu Task; ścieżki oznaczone `Create` są nieobecne przed implementacją albo odpowiadają jawnie utworzonemu wynikowi właściwego Task;
- każdy plan składowy posiada wymagany header, `Global Constraints`, `Interfaces`, checkbox steps, exact commands i expected outcomes.

## 8. Warunek zakończenia masterplanu

Masterplan jest wykonany wyłącznie wtedy, gdy completion ledger posiada konkretny artifact/receipt/test path dla każdego wiersza, a qualification report potwierdza spójność:

```text
source commit
= runtime binary/container identity
= ProblemIR hash
= mesh/topology hash
= time-series hash
= spectral manifest hash
= API resource identity
= Control Room selected run/stage/artifact identity
```

Jeżeli którekolwiek równanie tożsamości jest nieudowodnione, końcowy status pozostaje `NO-GO`.
