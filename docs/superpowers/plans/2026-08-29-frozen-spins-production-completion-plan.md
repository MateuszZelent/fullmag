# Frozen Spins — normatywny plan domknięcia wdrożenia produkcyjnego P0–P16

**Data audytu i planu:** 2026-08-29

**Repozytorium:** `C:\git\fullmag\fullmag`

**Audytowany commit:** `adec82a86b5623cade88ffc77652cb56ec81149a`

**Stan wyjściowy:** patrz wieloosiowy status w sekcji 3; procent gotowości nie jest bramką i został usunięty jako niereprodukowalny.
**Zakres:** IR, Python DSL, planner, session/engine, FDM CPU, FDM CUDA, FDM multilayer, FEM CPU, FEM GPU, API v2, Control Room, checkpoint/resume, capabilities, testy naukowe, zarządzane środowiska wykonawcze i dowody kwalifikacyjne.

## 1. Cel dokumentu

Ten dokument jest wykonawczym planem zakończenia wdrożenia Frozen Spins. Nie jest listą życzeń ani samym opisem architektury. Każdy etap P0–P16 określa:

- potwierdzony stan początkowy;
- zależności i granice zakresu;
- dokładne miejsca implementacji;
- kolejność zmian;
- wymagane testy i komendy;
- artefakty dowodowe;
- jednoznaczną bramkę `PASS`;
- warunki, przy których etap pozostaje `BLOCKED`.

Kolejność kontraktowa wynosi `P0 → P1 → P2 → P4 → P5 → P6 → P3`. Po zamknięciu P4–P6 gałęzie FDM P7–P10, FEM P11–P12 i niezależne części carrierów P13 mogą być wykonywane równolegle. Zależny etap nie może otrzymać `PASS`, jeżeli jego poprzednik kontraktowy nie ma trwałego dowodu.

## 2. Nienaruszalny kontrakt Frozen Spins V1

Każda implementacja i każdy test muszą zachować poniższe reguły:

1. Publiczne wywołanie `region.freeze_spins()` kompiluje się do kanonicznego, top-level `MagnetizationConstraintIR::FrozenSpins`; nie wolno wprowadzać osobnej semantyki tylko dla Python DSL.
2. `region_mask`, `active_mask` i `frozen_mask` są osobnymi nośnikami znaczeń. Maska stopni swobody wynosi `free_mask = active_mask AND NOT frozen_mask`.
3. Zamrożone spiny nadal uczestniczą w pełnym stanie fizycznym, energii, wymianie i polu demagnetyzującym oraz wpływają na swobodne stopnie swobody.
4. Maskowanie dotyczy całego złożonego prawego członu po zsumowaniu LLG, STT, SOT, termiki i innych aktywnych wkładów. Nie wolno maskować tylko części operatorów.
5. Po każdym stanie kandydackim, podkroku, normalizacji, retrakcji i zaakceptowanym kroku należy twardo przywrócić zapisany `frozen_reference`. Sam invariant restore wymaga bitwise equality w precyzji lane: zero ULP drift dla FP64 oraz equality z zakwantowaną referencją FP32. Tolerancje dotyczą parity między lane, nie hard restore.
6. Kryteria stopu, normy i redukcje solvera są liczone po swobodnych magnetic vector sites. Telemetria używa jednoznacznych nazw `active_site_count`, `frozen_site_count`, `free_site_count`, `scalar_component_dof_count` i `vector_dimension=3`; niejednoznaczne `dof_count` wymaga migracji albo jawnej definicji kompatybilności.
7. V1 wspiera `static` dla selektorów geometrycznych oraz `snapshot_at_activation` dla typowanych selektorów zależnych od stanu, np. `m_z > 0.5`. Selector snapshot jest oceniany dokładnie raz z jednej niezmiennej rewizji magnetyzacji w atomowej transakcji aktywacji i daje stałą maskę na całą epokę. `eval`, lambdy, callable oraz ponowne ocenianie podczas kroków, podkroków lub iteracji minimizera są zabronione.
8. `frozen_mask`, `frozen_reference`, per-constraint activation epochs, resolved-set revision, polityki i pełna proweniencja solvera są częścią checkpointu `ExactResume`. Przeniesienie samego stanu z resetem historii jest osobnym `PortableStateImport`.
9. Nieobsługiwany backend, urządzenie, precyzja, integrator, minimizer, tryb siatki lub polityka nie mogą przejść przez cichy fallback. Planner/API mają zwrócić stabilny kod `unsupported` przed uruchomieniem.
10. API v2 jest autorytatywne dla ciężkich danych maski/overlay. Realtime może unieważniać dane, ale nie może być jedynym nośnikiem payloadu.
11. Dla selectorów snapshot preview jest spekulatywny, dopóki start atomowo nie skonsumuje `activation_candidate_token`. Jeśli token jest stale, start musi go odrzucić albo solver publikuje nowy fingerprint i UI unieważnia preview. Nie wolno deklarować parity preview/solver wyłącznie na podstawie długości maski.
12. Status `QUALIFIED` wymaga dowodu z wykonywalnego, zarządzanego runtime. Sam test źródłowy, kompilacja lub syntetyczny oracle nie wystarczają.
13. Fingerprinty mają osobne znaczenia: `authored_selector_sha256` i `constraint_semantics_sha256` są wspólne między Python/API/FDM/FEM; `resolved_mask_sha256` oraz `carrier_fingerprint` są specyficzne dla dyskretyzacji, topologii i FE space. Nie wolno wymagać identycznego resolved mask hash FDM/FEM.
14. Pusta i nieaktywna selekcja są sterowane jawnymi enumami `empty_selection={error,allow_noop}` i `inactive_selection={error,warn_and_intersect}`. Overlap sumuje maski logicznie, ale różne resolved references dla wspólnego site powodują atomowe odrzucenie aktywacji.
15. `all-frozen` w relaksacji kończy się natychmiast z `all_active_sites_frozen`. W time evolution wykonuje zero-cost analytical time advance do `t_end`, zachowując harmonogram outputów i ewaluację czasowo zależnych observables bez integracji magnetyzacji.

## 3. Klasy dowodów i wieloosiowy słownik statusów

Każdy lane i finding zapisuje cztery niezależne osie:

- `scope_status`: `REQUIRED` albo `OUT_OF_SCOPE`;
- `implementation_status`: `NOT_IMPLEMENTED`, `SOURCE_CONFIRMED` albo `RUNTIME_CONFIRMED`;
- `qualification_status`: `UNQUALIFIED`, `BLOCKED` albo `QUALIFIED`;
- `gate_result`: `PASS`, `FAIL`, `SKIP` albo `NOT_RUN`.

`PARTIAL` wolno używać tylko jako opis agregatu, nigdy jako status lane. `NOT VERIFIED` migruje do `qualification_status=UNQUALIFIED, gate_result=NOT_RUN`. Capability runtime nie jest statusem kwalifikacji: `execution_supported=true` może współistnieć z `qualification_status=UNQUALIFIED`; produkcyjny release gate nadal wymaga `QUALIFIED`.

Każdy receipt kwalifikacyjny musi zawierać co najmniej:

```json
{
  "schema": "fullmag.frozen_spins_qualification.v1",
  "status": "PASS",
  "timestamp_utc": "...",
  "evidence_id": "FS-EV-...",
  "source_snapshot_id": "sha256:...",
  "source": {
    "git_sha": "...",
    "tree_sha": "...",
    "tracked_diff_sha256": "...",
    "staged_diff_sha256": "...",
    "untracked_manifest_sha256": "...",
    "git_dirty": false,
    "submodule_identities": {}
  },
  "runtime": {
    "recipe": "...",
    "image_digest": "...",
    "build_manifest": "..."
  },
  "lane": {
    "backend": "fdm|fem",
    "execution": "cpu|gpu",
    "device_name": "...",
    "device_uuid_or_pci": "...",
    "driver": "...",
    "runtime_version": "...",
    "precision": "fp64|fp32",
    "mesh_mode": "...",
    "integrator_or_minimizer": "..."
  },
  "contract": {
    "membership_policy": "...",
    "reference_policy": "...",
    "constraint_activation_epochs": {},
    "resolved_constraint_set_revision": 1,
    "fallback_used": false
  },
  "results": {
    "frozen_max_ulp_drift": 0,
    "frozen_max_abs_drift": 0.0,
    "free_max_displacement": 0.0,
    "max_torque_free": 0.0,
    "max_torque_all": 0.0,
    "energy_finite": true,
    "fallback_count": 0,
    "host_transfer_bytes_per_step": 0,
    "checkpoint_continuity_error": 0.0,
    "oracle_result": "PASS",
    "test_case_ids": []
  },
  "command": "...",
  "binary_sha256": "...",
  "toolchain": "...",
  "artifacts": [{"path": "...", "sha256": "..."}],
  "receipt_sha256": "..."
}
```

Receipt z `git_dirty=true` może służyć diagnostyce, ale nie może być finalnym dowodem release. Wartości `device_name="cuda_runtime"`, `driver="unknown"`, fikcyjny PCI `0000:00:00.0` albo brak digestu obrazu blokują status `QUALIFIED`.

## 4. Stan potwierdzony w audycie

### 4.1. Potwierdzone wyniki pozytywne

Poniższe wpisy są historycznymi obserwacjami audytowymi, nie trwałymi receiptami. P2 musi nadać każdemu `evidence_id`, `source_snapshot_id`, dokładną komendę, cwd, runtime, timestamps, exit code oraz hashe stdout/stderr i binarium; do tego czasu nie wolno ich używać jako finalnego dowodu release.

- IR i Python DSL przechodzą testy ukierunkowane; na Windows skrypty wymagają UTF-8 z powodu znaku kontrolnego w output.
- Rust IR: 3/3 `PASS`.
- Planner Frozen Spins: 22/22 `PASS`, przy czym obecnie celowo odrzuca FDM multilayer i ABM3.
- Engine: 1/1 `PASS`.
- Runner FDM CPU: 10/10 `PASS` dla single-grid, w tym exchange/demag, STT/SOT/thermal, publiczne integratory, telemetria free/all, all-frozen, minimizery bezpośrednie i zgodność bez maski.
- API: 26/26 `PASS`.
- UI: 13/13 testów skupionych oraz 181/181 testów Ribbon/Explorer, razem 194/194.
- Zarządzany test FDM CUDA zakończył się kodem 0: ABI + CUDA runtime 2/2, RK4 z historycznie raportowanym defektem `<1e-14`, Heun z zerowym defektem frozen, checkpoint i CPU-reference import. Wynik nie zamyka FS-005 ani ExactResume, dopóki nie wykaże zero ULP i nie rozdzieli PortableStateImport.
- Diagnostyczne uruchomienie `fem_frozen_spins_contract` w kontenerze przeszło 4/4: unit, architecture, solver step, direct minimizer.
- `git diff --check` przechodził dla audytowanego stanu.

### 4.2. Potwierdzone blokery i luki

- Worktree był brudny i zmieniał się współbieżnie. Nie ma zamrożonej, czystej tożsamości źródła dla finalnych receiptów.
- `scripts/verify_frozen_spins_qualification.py` uruchamia tylko IR/Python, mimo nazwy i opisu sugerujących kwalifikację całego stosu.
- Macierz `docs/validation/frozen-spins-qualification-matrix.md` zawiera sprzeczne deklaracje backendów i algorytmów oraz błędnie nazywa Control Room kwalifikowanym.
- API `capabilities` deklaruje `interaction.frozen_spins` i `constraint.frozen_spins` bezwarunkowo dla każdego resolved lane, zamiast dla dokładnej krotki backend/device/precision/mesh/algorithm/policy.
- Planner obsługuje tylko statyczny selector oraz `CaptureCurrentAtActivation`; nie ma pełnego kontraktu tworzenia kolejnych activation epochs.
- Engine inicjalizuje `activation_epoch` stałą `1`; poza restore checkpointu nie ma pełnego lifecycle kolejnych aktywacji.
- `ExactResume` nie porównuje `problem_hash`.
- FDM multilayer ma helper restore tylko pod `#[cfg(test)]`, a planner odrzuca authored Frozen Spins przed wyborem runtime.
- ABM3 jest celowo odrzucone do czasu kwalifikacji checkpoint/history.
- CUDA FP32 kończy się fail-closed kodem `frozen_spins_cuda_fp32_unqualified`.
- FEM TPI kończy się fail-closed i nie ma zaakceptowanej decyzji: implementacja albo jawne wyłączenie z zakresu wersji.
- FEM GPU ma skompilowane źródła, lecz brak wykonanego dowodu urządzeniowego Frozen Spins.
- Zarządzany FEM CPU build przeszedł, ale kanoniczna recepta zakończyła się przed Frozen Spins przez niezależny błąd `fem_interaction_docs_contract` dotyczący ownership boundaries.
- CUDA receipt był efemeryczny w `/tmp`, nie miał rzeczywistej identyfikacji urządzenia/drivera/runtime i zniknął wraz z kontenerem.
- Historyczna implementacja przekazywała `femTrueDofPositions: null`. Audyt dyskretyzacji wykazał następnie, że obsługiwana ścieżka FEM P1 publikuje maskę w lokalnym porządku węzłów, a nie w true-DOF; właściwym kontraktem jest więc `fullmag.fem-local-node-render.v1` związany z opublikowaną topologią FMMT. Wyższy rząd, MPI/ghost i true-DOF pozostają fail-closed do czasu osobnego, jawnego carriera.
- Historyczny browser smoke sprawdzał jedynie Ribbon, canvas i WebGL. Został rozszerzony o realny katalog/payload quantity, HTTP v2, render ACK, network log, screenshot i receipt; pełny workflow create/activate/Explorer/Inspector oraz FEM live pozostaje oddzielną częścią P15.
- Typecheck ma `qualification_status=UNQUALIFIED, gate_result=NOT_RUN/BLOCKED`: wrapper Windows kończy się `spawnSync next.cmd EINVAL`, a bezpośredni `tsc` zgłasza brak typów `esrecurse` i `json-schema`. Nie jest to dowód defektu Frozen Spins, ale blokuje release gate UI.

### 4.3. Aktualizacja wykonawcza po rozpoczęciu realizacji planu

**Stan na 2026-08-29 po pierwszym pakiecie implementacyjnym:** `SOURCE CONFIRMED / RUNTIME QUALIFICATION INCOMPLETE`.

Zrealizowano następujący pionowy wycinek P13–P14, bez uznawania całych etapów za `PASS`:

1. Dodano kanoniczne quantity `frozen_spins` do `fullmag-quantities`:
   - wire ID: `frozen_spins`;
   - kompatybilny alias wejściowy: `frozen_mask`;
   - shape: `spatial_scalar`;
   - unit: `1`;
   - location: `node`;
   - domain: `magnetic_only`;
   - UI/3D preview: włączone;
   - publikacja: tylko przez standardowy provider spatial scalar.
2. Runner publikuje quantity wyłącznie wtedy, gdy istnieje rozstrzygnięta skompilowana maska. Nieobecność maski nie może tworzyć fikcyjnego pola z samych metadanych capability.
3. FDM CPU, FDM CUDA i FEM przechowują maskę w obiekcie runtime i materializują scalar `1.0` dla frozen DOF oraz `0.0` dla free DOF. CUDA i FEM mają synchroniczną i asynchroniczną ścieżkę host-backed preview; jest to implementacja źródłowa, a nie dowód device-resident ani managed runtime.
4. API v2 transportuje `frozen_spins` przez istniejące zasoby:
   - `GET /v2/sessions/current/data/quantities`;
   - `GET /v2/sessions/current/data/fields`;
   - `GET /v2/sessions/current/data/fields/frozen_spins/meta`;
   - `GET /v2/sessions/current/data/fields/frozen_spins/samples/vector`.
5. Dodano test integracyjny API potwierdzający jednocześnie descriptor quantity, descriptor field, source step/time, statystyki, FMVP v3, grid fingerprint, `n_comp=1`, point count oraz dokładny payload `[1, 0, 0, 1]`.
6. Naprawiono niezależny błąd ogólny katalogu pól: fallback `FieldDescriptor.location` używał wcześniej `quantity_spatial_domain`, przez co zwracał `magnetic_only/full_domain` zamiast `node`. Fallback korzysta teraz z kanonicznego `QuantitySpec.location`, a dla quantity dynamicznego bez specyfikacji z bezpiecznego `node`.
7. Control Room rozpoznaje `frozen_spins` jako standardowe scalar quantity, tak samo jak inne pola materiałowe/skalarne. Plan danych Viewport 3D żąda `component=full` i prowadzi quantity przez wspólny HTTP v2/FMVP/colormap pipeline; nie dodano osobnego renderera tylko dla nowego quantity.
8. Istniejący authored preview/overlay Frozen Spins pozostaje ścieżką przejściową dla wizualizacji constraintu przed/obok uruchomienia solvera. Nie jest źródłem prawdy dla standardowego pola `frozen_spins` i nie wolno go uznać za zamiennik quantity catalog/field data plane.

Dowody wykonane dla tego wycinka:

- `fullmag-quantities`: 9/9 testów `PASS`;
- FDM CPU materializacja maski i gate runnera: `PASS`;
- FDM CUDA host-backed sync/async scalar preview: `PASS` na poziomie testów źródłowych;
- FEM Rust `cargo check --tests --features fem-gpu`: `PASS` z podstawionym katalogiem biblioteki, wyłącznie dowód kompilacji;
- API catalog/schema oraz test end-to-end resource/data-plane: `PASS`;
- testy Control Room quantity ID, Ribbon i topology-aware scalar carrier FDM/FEM: 88/88 `PASS`;
- ukierunkowany ESLint: `PASS`;
- `git diff --check` dla zmienianych plików: `PASS`.

Pozostałe bramki tego wycinka:

- pełny typecheck Control Room: `PASS`; naprawiono kontrakt `react-resizable-panels` w `Resizable.tsx` oraz Windows wrapper, który uruchamia teraz lokalne entrypointy Next.js/TypeScript przez `process.execPath` zamiast zawodnego `next.cmd`/`tsc.cmd`;
- managed FEM runtime: `BLOCKED` przez istniejące błędy kompilacji natywnego C++/MSVC (`std::snprintf`, GNU `__atomic_*`, `M_PI` i pola Poisson);
- rzeczywista kwalifikacja CUDA/GPU: `qualification_status=UNQUALIFIED, gate_result=NOT_RUN`;
- live browser/WebGL z wyborem `frozen_spins` jako aktywnego quantity: FDM CPU `RUNTIME_CONFIRMED_DIRTY_SOURCE/PASS`; FEM live nadal `NOT_RUN`;
- P13 jako całość: `SOURCE CONFIRMED / INCOMPLETE`; autorytatywny FEM serial-P1 authored preview jest wdrożony z obsługą `ExplicitLocalToGlobal`, airboxu i incydencji elementów, a jednorazowa atomowa transakcja authoringowa `Preview → Commit` konsumuje token dopiero po commitcie. Preview jest jawnie spekulatywny, a CPU publikuje solver-owned certificate/epoch/status. `run/relax/solve` otrzymują wersjonowany `frozen_spins.runtime_plan_binding.v1`, związany z `command_id` i bieżącą `scene_revision`; payload przenosi kanoniczne `SelectionDefinitionIR` oraz `MagnetizationConstraintIR`. Mutacja podczas aktywnego solve kolejkuje `apply_frozen_spins`; po zaakceptowanym kroku CLI zatrzymuje etap, zachowuje continuation i pozostały budżet, replanuje z nowym bindingiem i wznawia. Nadal wymagane są pełne descriptor lifecycle revision/ETag/invalidation oraz natywny owner CUDA/FEM;
- P14 jako całość: `SOURCE CONFIRMED / INCOMPLETE`; quantity 3D FDM ma realny PASS, FEM local-node carrier ma testy źródłowe, a Inspector oferuje kontrolowane `Commit preview`, odświeża solver status, sprawdza ID/epoch/revisions/hash/counts i przełącza 3D na solver-owned quantity. Nadal otwarte są live FEM i realny browserowy workflow commit→solver→quantity.

Po korekcie audytu rozpoczęto również P0–P2:

- P0: dodano maszynowo walidowany `frozen-spins-v1-scope.yaml`; 27 funkcji ma status `REQUIRED`, a jedynie live/callable selector jest `OUT_OF_SCOPE` ze stabilnym reason code; walidator i 4 testy przechodzą;
- P1: dodano Frozen-Spins-specific source identity opartą o istniejący kanoniczny snapshot V2, rozszerzoną o osobne hashe tracked/staged/untracked, Git tree oraz rekurencyjne identity i dirty content submodułów; 2 testy przechodzą, a bieżący dirty checkout jest prawidłowo odrzucany przez `--require-clean`;
- P2: rozdzielono authoring od qualification. Skrypt authoringu przechodzi na Windows bez ręcznego `PYTHONUTF8`, natomiast agregator kwalifikacji wymaga clean source identity, trwałych artefaktów i pełnego pokrycia 47 test case IDs;
- agregator ma 6 testów fail-closed obejmujących brak receiptów, `SKIP`, dirty source, fallback, unknown driver, błędny hash artefaktu, mixed tree, duplicate evidence ID, niezgodność z przechwyconym source identity oraz append-only/idempotent evidence ledger;
- przy braku katalogu trwałych receiptów agregator prawidłowo kończy się niezerowym kodem i raportuje `0/47`, zamiast drukować fałszywe `PASS`.

P0 ma `gate_result=PASS` na poziomie zamrożenia zakresu. P1 i P2 pozostają `INCOMPLETE`: P1 wymaga jeszcze klasyfikacji zmian oraz czystego qualification tree, a P2 osobnych recept lane i realnych receiptów generowanych przez runtime. Append-only evidence ledger jest zaimplementowany, lecz pozostaje pusty do pierwszego kompletnego zestawu ważnych receiptów.

### 4.4. Aktualizacja wykonawcza P9–P14 po wdrożeniu runtime

**Stan na 2026-08-29 po wdrożeniu integratorów CUDA, FEM TPI, device-resident minimizerów FEM GPU i standardowego quantity:** nadal nie wolno użyć statusu zbiorczego `QUALIFIED`, ponieważ checkout jest brudny, a bramki P13 carrier, P15 i P16 pozostają otwarte.

1. **P9 / FDM CUDA FP64 — `RUNTIME_CONFIRMED`, qualification `UNQUALIFIED`:** Heun, RK4, RK23, DP45 i ABM3 wykonują device-side hard restore przed pełnym RHS i po stanie kandydackim/zaakceptowanym. Zarządzany test na NVIDIA GeForce RTX 4080 SUPER (CC 8.9, UUID `fcb9fbf1828437c7af5b76bcbf2d2937`, PCI `0000:01:00.0`) potwierdził bitową niezmienność nieosiowej referencji oraz ruch swobodnego spinu. Recepta obejmuje również rzeczywisty interaktywny rebuild po accepted-step: zachowuje continuation `m`, zwiększa activation epoch i resolved-set revision, utrzymuje mask identity, przechwytuje nową reference identity oraz publikuje quantity `frozen_spins`. Recepta zapisuje te bramki w trwałym receipcie, lecz obecny dirty tree nie może dać finalnego dowodu release.
2. **P10 / FDM CUDA FP32 — `RUNTIME_CONFIRMED`, qualification `UNQUALIFIED`:** publiczny C ABI dopuszcza lane po usunięciu przejściowego guardu. Kanoniczna recepta potwierdziła na RTX 4080 SUPER pełną macierz Heun/RK4/RK23/DP45/ABM3 dla FP32 i FP64, zero-ULP hard restore, ruch free spinu oraz zachowanie checkpointu. Trwały receipt znajduje się w `artifacts/qualification/frozen-spins/fdm-cuda/fdm-frozen-spins-cuda-runtime-evidence-v1.json`; nie jest receipt'em release, ponieważ nie wiąże jeszcze kompletnego clean-tree source identity P16.
3. **P11 / FEM CPU — `RUNTIME_CONFIRMED`, qualification `UNQUALIFIED`:** explicit RK, PG-BB, NCG i TPI zachowują nieosiową referencję `(0.36, 0.48, 0.8)` bitowo, a swobodny węzeł pozostaje mobilny. TPI eliminuje zamrożone tangent DOF przez inactive/identity rows i korzysta ze wspólnego free-only gradient/restore. Capability CPU obejmuje `tangent_plane_implicit`; końcowy ABI `fullmag-fem-sys` przeszedł 42/42 z przypiętym `RUSTUP_TOOLCHAIN=nightly`.
4. **P12 / FEM GPU — explicit RK, PG-BB i NCG `RUNTIME_CONFIRMED`, qualification `UNQUALIFIED`:** maska free-node i frozen reference są przesyłane raz podczas bootstrapu i pozostają na urządzeniu. PG-BB/NCG liczą gradienty, normy, iloczyny skalarne, krzywiznę, kierunki i retrakcję tylko po free nodes, po każdej projekcji okresowej wykonują exact restore i nie używają CPU fallbacku. Kanoniczne `just verify-frozen-spins-fem-gpu` wykonało prawdziwe binarium na RTX 4080 SUPER (MFEM 4.9, Hypre 3.1.0, CUDA CC 8.9), potwierdziło przypadki non-axis, free mobility, all-frozen, no-mask bitwise parity i `hot_loop_*_h2d/d2h_bytes=0`. Receipt: `artifacts/qualification/frozen-spins/fem-gpu/fem-frozen-spins-gpu-runtime-evidence-v1.json`, ze statusem `RUNTIME_CONFIRMED_DIRTY_SOURCE`. GPU TPI pozostaje fail-closed kodem `frozen_spins_fem_gpu_tpi_unqualified`; wymaganie `algorithm.fem_tpi` jest pokryte lane CPU P11, nie wolno reklamować TPI na GPU.
5. **P13–P14 / quantity, spekulatywny Preview → Commit i Viewport 3D — FDM `RUNTIME_CONFIRMED_DIRTY_SOURCE`, FEM `SOURCE_CONFIRMED`:** `frozen_spins` jest kanonicznym `spatial_scalar`, unit `1`, location `node`, z aliasem `frozen_mask`. Jest publikowane tylko przy resolved mask i przechodzi przez ten sam HTTP v2/FMVP/colormap/topology-aware scalar pipeline co `mat_ms` i `mat_aex`. Naprawiono ogólny lifecycle render adoption: `Viewport3DFrame` przekazuje session provenance do WebGL scene, FDM rejestruje receipt ponownie po zmianie session/buffer identity, a replay używa rzeczywistego `target.id`. Ukierunkowane testy quantity po poprawce: 290/290 `PASS`; typecheck, ESLint i produkcyjny static build: `PASS`. FEM authored preview używa rzeczywistego `EntityMapping`: dla kompaktowego pola `m` mapuje local-node → global mesh node przez `ExplicitLocalToGlobal`, a incydencję magnet/air i region membership buduje z tej samej connectivity oraz `object_segments`. Brak segmentu, nakładające się segmenty, niejednoznaczny owner, błędna cardinality albo topology kończą się fail-closed. API generuje domenowo separowany jednorazowy `activation_candidate_token`; endpoint `POST /v2/sessions/current/model/frozen-spins/previews/{preview_id}/activate` sprawdza session, source/topology/scene revision, token, selector, reference i stage, atomowo zatwierdza definicję, a token zapisuje jako skonsumowany dopiero po sukcesie. Kontrakt jawnie oznacza preview jako `speculative_authoring_preview`, commit jako `authoring_commit`, a solver binding jako `pending_runtime_activation`; nie przedstawia authoring commit jako aktywacji solvera. Każda mutacja create/patch/delete/commit zwraca typed `runtime_application={state:pending_runtime_plan,pending_revision,current_runtime_unchanged:true}`. Idle używa `apply_boundary:next_runtime_plan`; aktywny solve kolejkuje śledzone `apply_frozen_spins`, zwraca `apply_boundary:accepted_step` i `application_command_id`. Callback zatrzymuje etap po zaakceptowanym kroku, a orkiestrator zachowuje continuation magnetization, pozostały budżet i solver policy, stosuje command-bound binding i wznawia. Inspector pokazuje obie granice oraz ID komendy, odświeża `simulation/solver/status`, sprawdza constraint ID, epoch, topology/source revision, mask SHA-256 i site counts, rozróżnia `pending/confirmed/mismatch`, unieważnia overlay preview i pozwala przełączyć 3D na solver-owned quantity `frozen_spins`. Wygenerowany OpenAPI/TypeScript i ręczna fasada są aktualne. Testy bindingu i hot-apply API/callback/rebind są `PASS`; Inspector 14/14, celowany kontrakt OpenAPI, typecheck i kompilacja API+CLI również `PASS`. Pełna suite Control Room nadal ma niezależny błąd promocji ścieżki command-failure w bieżącym dirty tree, dlatego nie jest bramką `PASS` P16. Właściciel monotonicznych epok i resolved-set revision przez rebuild runtime CUDA/FEM jest `SOURCE_CONFIRMED`, a managed FDM CUDA hot-rebuild z quantity ma `PASS`; nadal otwarte są managed FEM hot-apply oraz live FEM browser.
6. **Managed FEM regression:** natywna sekwencja wykonała Frozen 6/6, STT, strict GPU, termikę i macierz pochodnych energii. Kruchy LF-only kontrakt snapshotu zastąpiono granicą odporną na CRLF, a Rust ABI uniezależniono od synchronizacji kanału stable. Nadal wymagany jest jeden końcowy clean-tree run tworzący trwały receipt z pojedynczym exit code 0.
7. **P14 / bezpieczna konsumpcja FEM carrier — `SOURCE_CONFIRMED`:** po weryfikacji pamięci backendu renderer wymaga `fullmag.fem-local-node-render.v1`, bo maska obsługiwanej ścieżki serial P1 jest local-node AoS. Carrier wiąże `mesh_fingerprint`, `topology_hash`, P1 FE order, `by_nodes`, cardinality i dokładne local-node → published render vertex. Wadliwy ordering, cardinality albo fingerprint kończy się fail-closed bez overlay. Test komponentowy 5/5 i pełny typecheck przechodzą. Higher-order, MPI/ghost i true-DOF są jawnie nieobsługiwane, a nie aproksymowane.
8. **P15 / browser quantity gate — FDM CPU `RUNTIME_CONFIRMED_DIRTY_SOURCE/PASS`:** `smoke-frozen-spins.mjs` zweryfikował realny katalog i field `frozen_spins`, metadata i payload `0/1`, HTTP v2 `/samples/vector`, render ACK `rendered`, aktywny WebGL 703×478 bez context loss oraz brak krytycznych błędów konsoli. Trwałe artefakty: `artifacts/qualification/frozen-spins/browser/frozen-spins-browser-5061bc04-6edd-442d-bdef-09ad3d3e634a.json` i odpowiadający PNG. Receipt wskazuje lane `fdm_cpu_reference`, double, min `0`, max `1`, mean `0.09375`. Authoringowe `Preview → Commit → solver certificate → quantity` ma testy komponentowe i API, lecz P15 jako całość pozostaje `INCOMPLETE`, bo nie wykonano live FEM ani realnego browserowego workflow commit→solver→quantity/Explorer/Inspector.
9. **P5 / lifecycle runtime — `RUNTIME_CONFIRMED_CPU_AND_CUDA/SOURCE_CONFIRMED_FEM/INCOMPLETE`:** runtime FDM nie zeruje już lifecycle do `activation_epoch=1` podczas jawnej reaktywacji. Pierwsza aktywacja tworzy epoch 1, jawna reaktywacja tej samej aktywnej definicji zwiększa per-constraint epoch oraz `resolved_constraint_set_revision`, ponownie przechwytuje referencję nawet przy niezmienionej masce i bezwarunkowo unieważnia FSAL oraz historię ABM. Ciągłe przejście stage zachowuje epoch i referencję aktywnego constraintu. Przejście A→inactive czyści fizyczną maskę bez utraty historii epoch, a ponowne wejście w C nadaje epoch 2 i przechwytuje nową referencję. Persistent CPU FDM runtime stosuje zmianę constraintu atomowo bez przebudowy solvera, zachowuje historię przez A→inactive→C oraz przechwytuje pierwszą referencję z faktycznego continuation state. Wrapper `InteractiveRuntime` jest właścicielem monotonicznego `FrozenSpinsActivationSet`: nie kopiuje backend-local epoch po rebuildzie, rozróżnia zmianę resolved identity od zwykłej zmiany sterowania stage i przenosi historię per-constraint do nowego runtime CUDA/FEM. Jawna reaktywacja natywnego backendu wymusza rebuild, zwiększa wszystkie aktywne epoki i resolved-set revision; testy reaktywacji, stage gap i rebuild carry przechodzą 3/3. Managed CUDA hot-rebuild na RTX 4080 SUPER dodatkowo potwierdza accepted-step continuation, mask/reference identity oraz solver-owned quantity i zapisuje wynik jako `managed_recipe_gates.interactive_hot_rebuild=PASS`. Lekki solver-owned certificate jest publikowany CLI→API jako `simulation/solver/status.frozen_spins`; zawiera per-constraint epochs, resolved-set revision, topology/source revision, mask/reference SHA-256 i jednoznaczne site counts. Authoring preview ma typed authority/binding: `speculative_authoring_preview → authoring_commit → pending_runtime_activation`; Inspector odświeża status solvera i potwierdza lub odrzuca parity po pełnej tożsamości oraz counts, po czym kieruje 3D do solver-owned quantity. Mutacja idle pozostaje `next_runtime_plan`; mutacja podczas aktywnego solve zwraca `accepted_step` i ID śledzonej komendy. Callback bezpiecznie pauzuje po zaakceptowanym kroku, a orkiestrator zachowuje stan kontynuacji i pozostały budżet przed replanem/wznowieniem. Native FEM materializuje teraz continuation magnetization w planie aktywacyjnym przed konstrukcją backendu; w przeciwnym razie późniejszy upload zmieniał `m`, ale pozostawiał frozen reference z authored initial state. Regresja kolejności 1/1 `PASS`. Pozostałe testy: pełny `fullmag-engine` `361 PASS / 1 ignored`, celowany runner lifecycle `PASS`, transport/status API `PASS`, CRUD/receipt API `PASS`, binding CLI 2/2 i API 1/1 `PASS`, kolejka 1/1 `PASS`, hot-apply API/callback/rebind 3/3 `PASS`, Inspector `14/14 PASS`, celowany kontrakt OpenAPI, kompilacja API+CLI, wygenerowany OpenAPI/TypeScript i typecheck `PASS`. Bieżący `cargo check` API+CLI+runner oraz osobny build runner+CLI z featurem `cuda` przechodzą. Pełny `fullmag-runner` wykonał wcześniej `1007 PASS / 17 FAIL`; wszystkie 17 błędów leżą poza zmienionym lifecycle i obejmują bieżące niezależne zmiany dirty tree, dlatego nie są promowane ani ukrywane. P5 nadal wymaga zarządzanego runtime proof hot-apply dla lane FEM oraz końcowego clean-tree proof CPU/CUDA/FEM.

### 4.5. Findings register

| ID | Finding | Severity | Owner stage | Closure evidence |
|---|---|---|---|---|
| FS-001 | state-dependent snapshot selector był sprzecznie zakazany | critical | P0/P4/P5 | typed AST `m_z > 0.5`, single-revision activation test |
| FS-002 | błędna parity resolved mask hash FDM/FEM | critical | P4/P13/P15 | rozdzielone fingerprinty i convergence test |
| FS-003 | capability miesza execution support z qualification | high | P3 | wieloosiowy capability response i planner parity |
| FS-004 | dirty HEAD nie identyfikuje audytowanego drzewa | critical | P1/P2 | source snapshot manifest z diff/untracked/submodule hashes |
| FS-005 | hard restore używa tolerancji zamiast exact equality | critical | P7/P9/P10/P11/P12 | zero ULP restore evidence |
| FS-006 | empty/inactive/overlap policies nie były zamknięte | high | P0/P4/P5 | typed policies i atomic conflict tests |
| FS-007 | activation epoch nie ma właściciela i stage semantics | critical | P5/P6 | per-constraint epochs + resolved-set revision tests |
| FS-008 | ExactResume nie zachowuje pełnej historii | critical | P6/P8 | negative matrix i continuous/resumed parity |
| FS-009 | brak all-frozen time-evolution semantics | high | P0/P7–P12 | analytical time advance receipt |
| FS-010 | FEM overlay nie miał nośnika zgodnego z faktycznym local-node AoS mask ordering | critical | P13/P14 | `fullmag.fem-local-node-render.v1`, exact published topology mapping; fail-closed poza serial P1 |
| FS-011 | preview/solver snapshot race | critical | P5/P13/P14 | activation token consume albo stale invalidation test |
| FS-012 | brak macierzy shapes/frames/CSG | high | P4/P15 | geometry test IDs i refinement convergence |
| FS-013 | brak performance qualification | high | P7–P16 | overhead, memory i transfer metrics w receiptach |
| FS-014 | brak trwałych evidence IDs dla wyników audytu | high | P2 | evidence ledger z hashami |

Finding może zostać zamknięty wyłącznie trwałym `evidence_id`; samo usunięcie tekstu z planu nie zamyka findingu.

## 5. Mapa etapów

| Etap | Nazwa | Główna bramka |
|---|---|---|
| P0 | Zamrożenie zakresu V1 | jawny status każdego lane/policy i brak decyzji odkładanych do P10/P11 |
| P1 | Tożsamość snapshotu audytowego i czystego źródła | tree+diff+untracked+submodule identity oraz czysty qualification tree |
| P2 | Naprawa infrastruktury weryfikacyjnej i prawdy dokumentacyjnej | jedna niesprzeczna macierz oraz uczciwe recepty |
| P3 | Dokładne capabilities i fail-closed routing | execution support oddzielone od qualification |
| P4 | Domknięcie semantyki IR/Python i selektorów V1 | jeden kanoniczny IR i stabilne błędy |
| P5 | Lifecycle aktywacji, snapshot i activation epoch | atomowa aktywacja/re-aktywacja |
| P6 | Checkpoint, ExactResume i proweniencja | pełne wykrywanie niezgodnego resume |
| P7 | FDM CPU single-grid — kwalifikacja produkcyjna | trwały receipt CPU dla pełnej macierzy |
| P8 | FDM CPU multilayer i ABM3 | produkcyjny restore i kwalifikacja historii |
| P9 | FDM CUDA FP64 — pełna macierz | realny, trwały receipt GPU FP64 |
| P10 | FDM CUDA FP32 | jawna, zweryfikowana ścieżka FP32 |
| P11 | FEM CPU i decyzja TPI | kanoniczna recepta managed `PASS` |
| P12 | FEM GPU | wykonany, device-resident dowód GPU |
| P13 | API v2, zasoby maski i carrier FEM | roundtrip i autorytatywny payload |
| P14 | Control Room — pełny workflow | authoring, Inspector i overlay zgodne z solverem |
| P15 | E2E browser/WebGL i walidacja naukowa | realny smoke + parity/influence/no-mask |
| P16 | Zbiorcza kwalifikacja, CI i release gate | jedna recepta końcowa i komplet receiptów |

---

## P0. Zamrożenie zakresu V1

### Cel

Podjąć wszystkie decyzje zakresowe przed budową agregatora, capability registry i dodatnich lane. P0 nie może pozostawić decyzji „implementować czy wyłączyć” do P10 lub P11.

### Wymagany scope ledger

Dla każdego wpisu ustawić `scope_status=REQUIRED` albo `OUT_OF_SCOPE`, właściciela decyzji, reason code fail-closed i wymagany evidence set:

- state-dependent `snapshot_at_activation` selectors — **REQUIRED V1**;
- geometry `static` selectors — **REQUIRED V1**;
- `CaptureCurrentAtActivation` — **REQUIRED V1**;
- `InitialState` i `ExplicitFieldAsset` — jawna decyzja;
- FDM multilayer, ABM3, CUDA FP32, FEM TPI i FEM GPU — osobna jawna decyzja dla każdego lane;
- empty/inactive selection policies;
- all-frozen relaxation i time evolution;
- supported geometry/CSG operators oraz frame `world/object`.

### Implementacja

1. Dodać wersjonowany `docs/validation/frozen-spins-v1-scope.yaml` albo równoważny typowany manifest.
2. Każdy `OUT_OF_SCOPE` musi mieć stabilny typed reason code, negatywny test planera/API i brak pozytywnego capability.
3. Każdy `REQUIRED` musi wskazywać obowiązkowe test case IDs i receipty P16.
4. Agregator P2/P16 generuje listę obowiązkowych receiptów z tego manifestu, nie z ręcznie zapisanej tabeli.
5. Zmiana zakresu wymaga wersji manifestu i jawnej akceptacji właściciela produktu; brak sprzętu nie zmienia automatycznie `REQUIRED` na `OUT_OF_SCOPE`.

### Bramka P0

`PASS`, gdy wszystkie osie zakresowe mają rozstrzygnięty status, reason codes i test IDs. `NOT_RUN`, jeśli choć jedna decyzja nadal jest delegowana do późniejszego etapu.

---

## P1. Zamrożenie baseline i tożsamości źródła

### Cel

Utworzyć jednoznaczny, odtwarzalny punkt startowy. Bez P1 żaden późniejszy receipt nie może być dowodem release, ponieważ nie da się przypisać wyniku do konkretnego źródła.

### Stan wejściowy

Audyt dotyczył SHA `adec82a86b5623cade88ffc77652cb56ec81149a`, ale checkout zawierał liczne modyfikacje użytkownika i zmiany w submodułach. Nie wolno ich resetować, stashować, formatować ani włączać do Frozen Spins bez klasyfikacji.

### Implementacja

1. Zarejestrować dwie niezależne tożsamości: snapshot audytowy oraz finalne źródło kwalifikacyjne.
2. Snapshot audytowy musi zawierać: `HEAD SHA`, `tree SHA`, SHA-256 tracked diff, staged diff, manifest i content hashes wszystkich untracked files, submodule HEADs oraz hashe dirty diffów submodułów.
3. Sklasyfikować każdy zmieniony plik jako:
   - `frozen-spins-owned` — niezbędny dla tego wdrożenia;
   - `pre-existing-related` — istniejąca powiązana praca, której nie wolno nadpisać;
   - `unrelated-user-change` — poza zakresem;
   - `generated-artifact` — nie należy do źródła.
4. Utworzyć manifest `artifacts/qualification/frozen-spins/source-baseline.json` generowany przez skrypt kwalifikacyjny, nie ręcznie. Musi hashować także untracked files; `git diff --check` nie jest ich manifestem.
5. Finalna kwalifikacja odbywa się na czystym, zacommitowanym tree zawierającym dokładnie kwalifikowaną implementację. Może to być nowy SHA, nie HEAD brudnego audytu.
6. Generator porównuje clean qualification tree z zatwierdzonym source snapshotem/patch setem i zapisuje relację pochodzenia.
7. P1 nie upoważnia do commita, push, merge, resetu ani stashu; operacje wykonuje właściciel repo albo wymagają osobnej zgody.
8. Wszystkie recepty odczytują tożsamość z checkoutu i wpisują ją do receiptu; zewnętrzna zmienna nie może nadpisać wyniku Git.

### Pliki i narzędzia

- `scripts/` — dodać mały walidator/generator manifestu źródła albo współdzielony moduł używany przez kwalifikatory;
- `justfile` — dodać read-only recipe do wytworzenia i walidacji source identity;
- katalog trwałych receiptów wskazany przez P2.

### Testy i dowody

```powershell
git status --short --branch
git rev-parse HEAD
git submodule status --recursive
git diff --check
```

Test skryptu musi wykazać, że:

- dirty checkout daje `git_dirty=true` i nie może przejść release gate;
- czysty checkout daje `git_dirty=false`;
- zmiana tree, tracked/staged diff, untracked content lub submodułu unieważnia istniejący receipt;
- brak repozytorium nie jest zastępowany wartością `unknown` w trybie release.

### Bramka P1

`PASS` wyłącznie gdy istnieją odtwarzalne identity snapshotu audytowego i czystego qualification tree, zmiany użytkownika są sklasyfikowane, a każdy receipt wskazuje dokładny tree. Sam SHA brudnego HEAD nie spełnia bramki.

---

## P2. Naprawa infrastruktury weryfikacyjnej i prawdy dokumentacyjnej

### Cel

Sprawić, aby nazwy recept, dokumentacja i statusy odpowiadały temu, co faktycznie wykonano. Ten etap nie rozszerza jeszcze backendów; usuwa fałszywe pozytywne wyniki.

### Miejsca implementacji

- `scripts/verify_frozen_spins_qualification.py`;
- `docs/validation/frozen-spins-qualification-matrix.md`;
- `justfile`;
- istniejące skrypty `scripts/verify_frozen_spins_*.py` i testy kontraktowe;
- nowy schemat receiptu, jeżeli nie istnieje wspólny schemat kwalifikacyjny.

### Implementacja

1. Zmienić `scripts/verify_frozen_spins_qualification.py` w prawdziwy orkiestrator albo przemianować obecny skrypt na wąski `verify_frozen_spins_authoring.py`. Nie wolno pozostawić nazwy „qualification” dla skryptu uruchamiającego tylko IR/Python.
2. Zaimplementować osobne recepty `just`:
   - `verify-frozen-spins-ir`;
   - `verify-frozen-spins-python`;
   - `verify-frozen-spins-fdm-cpu`;
   - `verify-frozen-spins-fdm-cuda`;
   - `verify-frozen-spins-fdm-multilayer`;
   - `verify-frozen-spins-fem-cpu`;
   - `verify-frozen-spins-fem-gpu`;
   - `verify-frozen-spins-api`;
   - `verify-frozen-spins-ui`;
   - `verify-frozen-spins-browser`;
   - `verify-frozen-spins-qualification` jako agregator.
3. Agregator ma zakończyć się `PASS` tylko wtedy, gdy wszystkie lane wymagane przez docelową macierz V1 mają ważne receipty. `SKIP`, brak GPU, brak pola urządzenia lub brak artefaktu to wynik niepełny, nie `PASS`.
4. Na Windows skrypty Python muszą jawnie wymusić UTF-8 albo nie emitować znaków zależnych od strony kodowej. Test uruchomić również bez ręcznego ustawienia `PYTHONUTF8=1`.
5. Przepisać macierz jako predykaty capability plus pairwise/covering-array test set. Nie generować pełnego iloczynu potęgowego wszystkich podzbiorów physics. Każdy konkretny receipt nadal zapisuje pełną krotkę `backend × execution × precision × mesh_mode × algorithm × active_physics × membership_policy × reference_policy`.
6. Centralny invariant final-RHS projection owner musi automatycznie objąć każdy nowy torque. Dodać test pojedynczego źródła dla każdego physics term oraz celowo dobrane testy kombinowane/pairwise.
7. Usunąć sprzeczność pomiędzy tabelą backendową i tabelą algorytmów. Status powstaje z P0 scope ledger oraz trwałego receiptu; brak wykonania oznacza `UNQUALIFIED/NOT_RUN`.
8. Control Room pozostawić `SOURCE_CONFIRMED/UNQUALIFIED` do P15. Pozostałe lane opisać czterema osiami, bez rozszerzania `QUALIFIED`.
9. Receipt zapisywać na hoście w trwałym katalogu. Kontener może użyć katalogu tymczasowego wyłącznie jako staging, po czym agregator kopiuje i weryfikuje checksumę.
10. Dodać append-only evidence ledger. Każda obserwacja ma `evidence_id`, source snapshot, command, cwd, environment, timestamps, exit code, stdout/stderr hash i test binary hash.
11. Dodać test negatywny agregatora: brak wymaganego receiptu, inny tree, `fallback_used=true`, `driver=unknown` albo `SKIP` dla required lane powoduje niezerowy exit code.

### Bramka P2

`PASS`, gdy pojedyncze recepty mówią prawdę o swoim zakresie, agregator nie daje fałszywego `PASS`, macierz nie zawiera sprzeczności, a receipt jest trwały i walidowany schematem. Etap jest `BLOCKED`, jeśli jakikolwiek status nadal pochodzi wyłącznie z deklaracji dokumentacyjnej.

---

## P3. Dokładne capabilities i routing fail-closed

### Cel

Capability musi odpowiadać dokładnie wybranej ścieżce runtime, ale implementacyjne wsparcie wykonania jest niezależne od statusu kwalifikacji release.

### Miejsca implementacji

- `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs`, szczególnie logika wokół obecnych deklaracji `interaction.frozen_spins` i `constraint.frozen_spins`;
- `crates/fullmag-plan/src/fdm.rs` i odpowiednie moduły FEM;
- typy capability w API/IR oraz wygenerowany OpenAPI;
- testy API capabilities i testy planera.

### Implementacja

1. Zdefiniować kanoniczny klucz capability zawierający backend, CPU/GPU, precision, mesh mode, integrator/minimizer, predykaty aktywnych physics terms, membership policy i reference policy.
2. Wyprowadzać capability z tego samego registry/decision code, którego używa planner. Nie tworzyć drugiej, ręcznie utrzymywanej listy w handlerze statusu.
3. Zastąpić pojedyncze `supported` strukturą:
   - `authoring_supported`;
   - `preview_supported`;
   - `execution_supported`;
   - `qualification_status`;
   - `qualification_receipt_id`;
   - `reason_code`.
   Planner fail-closed wyłącznie dla `execution_supported=false`. Brak receiptu blokuje `QUALIFIED` i `strict-production`, ale nie musi blokować development runtime.
4. Zastąpić rozproszone stringi jednym typowanym enumem/registry diagnostycznym współdzielonym przez planner, runner, API, UI i recepty. Zachować kompatybilne wire codes, w tym:
   - `frozen_spins_fdm_reference_policy_unsupported`;
   - `frozen_spins_fdm_membership_policy_unsupported`;
   - `frozen_spins_fdm_state_dependent_selection_unsupported`;
   - `frozen_spins_cuda_fp32_unqualified`.
5. Dodać kody dla brakujących osi, np. multilayer, ABM3 history, FEM TPI i FEM GPU runtime. Kod powinien identyfikować oś, a nie zwracać ogólne `unsupported`.
6. Zwracać `qualification_receipt_id`/fingerprint dla krotki zakwalifikowanej. Niezgodny receipt obniża `qualification_status`, lecz nie może sam zmieniać deterministycznego `execution_supported`.
7. Wygenerować API i zaktualizować klienta TypeScript. Ręczne rozjechanie typów UI od OpenAPI jest zabronione.

### Testy

Utworzyć test tabelaryczny obejmujący co najmniej:

- FDM CPU single-grid FP64 + Heun/RK4 — supported po P7;
- FDM CPU multilayer — unsupported przed P8, supported po P8;
- FDM CUDA FP64 Heun/RK4 — supported po P9;
- FDM CUDA FP32 — unsupported przed P10;
- ABM3 — unsupported przed P8;
- FEM CPU explicit/direct minimizer — supported po P11;
- FEM TPI — zgodnie z decyzją P11;
- FEM GPU — unsupported/unqualified przed P12;
- geometry-only + `static` — execution supported zgodnie z lane;
- state-dependent typed AST + `snapshot_at_activation` — execution supported po P5 i zgodnie z lane;
- state-dependent + `static` — fail-closed `frozen_membership_static_state_dependent`;
- callable/eval/live/per-step selector — fail-closed typed `unsupported`.

Każdy przypadek musi potwierdzić zgodność API capability, decyzji planera i faktycznego kodu błędu runnera.

### Bramka P3

`PASS`, gdy API i planner zgadzają się co do authoring/preview/execution, qualification jest niezależną osią, a żadna kombinacja nie używa cichego fallbacku. Bramka obejmuje wygenerowane typy API i typed reason registry.

---

## P4. Domknięcie semantyki IR/Python i selektorów V1

### Cel

Ustalić jeden, wersjonowany kontrakt authoringu i kompilacji constraintu. Usunąć niejasność pomiędzy regionem, selektorem, polityką członkostwa i polityką referencji.

### Miejsca implementacji

- kanoniczne typy Frozen Spins w IR;
- Python DSL i serializacja/deserializacja;
- `crates/fullmag-plan/src/fdm.rs`, zwłaszcza gałęzie błędów wokół `frozen_spins_fdm_*_unsupported`;
- analogiczny compiler/planner FEM;
- API roundtrip oraz testy migracji wersji `frozen_spins.v1`.

### Implementacja

1. Spisać i zakodować jawne enumy:
   - `MembershipPolicy::Static`;
   - `MembershipPolicy::SnapshotAtActivation` albo równoważny istniejący wariant;
   - `ReferencePolicy::CaptureCurrentAtActivation`;
   - opcjonalna statyczna referencja tylko wtedy, gdy obecny spec ją przewiduje i wszystkie warstwy potrafią ją zachować.
2. Nie kodować polityk jako dowolnych stringów w głównym modelu. Parser może mapować tekst na enum, ale nieznana wartość ma dać stabilny błąd walidacji.
3. `region.freeze_spins()` ma tworzyć dokładnie ten sam IR co jawnie utworzony zasób Frozen Spins wskazujący ten sam region/polityki. Dodać porównanie kanonicznego JSON oraz hash planu.
4. Oddzielić `StaticGeometrySelector` od typowanego `StateSnapshotSelector`. AST V1 obejmuje porównania skalarne, `m.x/m.y/m.z`, norm/dot/abs oraz boolean `and/or/xor/not`; `m_z > 0.5` i złożone warunki są wymagane. Callable/eval/live/per-step selector są odrzucane przed runtime.
5. Zakodować jawne enumy `EmptySelectionPolicy::{Error,AllowNoop}` i `InactiveSelectionPolicy::{Error,WarnAndIntersect}`. Brak pola przy migracji używa wersjonowanego defaultu, nigdy niejawnego zachowania.
6. Dla overlap maska jest OR, lecz resolved reference jest walidowana per site. Identyczne wartości w precyzji lane są dozwolone; konflikt powoduje atomowe odrzucenie bez priorytetu kolejności deklaracji.
7. Wersjonować serializację jako `frozen_spins.v1`; deserializacja musi być fail-closed dla nieznanej wersji.
8. Emitować osobno `authored_selector_sha256`, `constraint_semantics_sha256`, `resolved_mask_sha256` i `carrier_fingerprint`. Tylko pierwsze dwa są wymagane identycznie Python/API/FDM/FEM.
9. Dla resolved mask parity porównywać obszar fizyczny, miarę/objętość, refinement convergence i observables, nie SHA różnych tablic DOF.
10. Dodać geometry matrix: cylinder/disk w środku i przesunięty, finite extrusion through object, world/object frame, translacja/rotacja obiektu, częściowe wyjście poza active domain, union/intersection/difference oraz xor/not jeśli są w P0, inclusive/exclusive boundary, pojedynczy site/true DOF, empty/full i mesh refinement.

### Testy

- Python → IR → JSON → IR roundtrip;
- jawny constraint kontra `region.freeze_spins()` — identyczny IR i plan hash;
- geometry static oraz state-dependent snapshot-at-activation selector, w tym `(m.z > 0.5) & (abs(m.x) < 0.2)`;
- pusta, pełna, częściowa i nakładająca się maska;
- state-dependent + `static` — `frozen_membership_static_state_dependent`;
- callable/eval/live/per-step — ten sam typed reason code w Python, API i plannerze;
- nieznana wersja/polityka — fail-closed;
- authored/semantics fingerprint parity oraz FDM/FEM physical-region/refinement convergence bez resolved-mask hash equality;
- jawna matrix disk/cylinder, frames, transforms, clipping, CSG i boundary membership.

### Bramka P4

`PASS`, gdy Python/API roundtripują do jednego IR, typed snapshot selector działa dokładnie raz przy aktywacji, cztery fingerprinty mają poprawne zakresy tożsamości, a live/callable forms są odrzucane przed runtime.

---

## P5. Lifecycle aktywacji, atomowy snapshot i `activation_epoch`

### Cel

Zastąpić stałe `activation_epoch = 1` pełnym lifecycle constraintu: aktywacja, dezaktywacja, ponowna aktywacja i atomowe przechwycenie referencji.

### Miejsca implementacji

- `crates/fullmag-engine/src/fdm/shared/frozen_spins.rs`, obecna inicjalizacja epoki;
- session/engine lifecycle i komendy modyfikacji constraints;
- planner payload przekazywany do runnerów;
- stan runtime FDM i FEM;
- checkpoint i telemetria.

### Implementacja

1. Wprowadzić `constraint_activation_epoch` osobno dla każdego constraintu oraz monotoniczny `resolved_constraint_set_revision` dla złożonego aktywnego zestawu. Nie używać jednego nieokreślonego epoch.
2. Pierwsza aktywacja constraintu tworzy epoch 1. Zwykły krok nie zmienia epoki. Ciągła aktywność w kolejnych stage zachowuje epoch; aktywność w A i C rozdzielona nieaktywnym B tworzy nowy epoch w C. Resume w środku aktywnej epoki nie wykonuje recapture.
3. Przy aktywacji wykonać atomową transakcję:
   - rozwiązać geometry selector lub ocenić typed state selector dokładnie raz z jednej `source_state_revision`;
   - skopiować aktualne `m` jako reference tylko dla frozen DOF;
   - obliczyć fingerprint maski i referencji;
   - utworzyć certyfikat `(constraint_id, epoch)[]`, mask/reference hashes, topology fingerprint i source-state revision;
   - opublikować epochs oraz resolved-set revision dopiero po powodzeniu wszystkich operacji.
4. Błąd podczas przechwycenia nie może pozostawić częściowo aktywnej maski ani nowej epoki.
5. Re-aktywacja dla `CaptureCurrentAtActivation` pobiera bieżące `m`. Zmiana reference przy niezmienionej masce nadal unieważnia FSAL, ABM history, adaptive-controller history oraz gradient/search direction minimizerów.
6. W ścieżce GPU utrzymać atomowość także względem streamów: event/barrier musi poprzedzać publikację aktywnego constraintu. Nie wolno wymuszać host roundtripu po każdym kroku.
7. Edycja podczas solve jest wersjonowana i stosowana dopiero na bezpiecznej granicy kroku; UI dostaje pending revision zamiast mutacji in-place.
8. Preview typed state selector zwraca `source_state_revision`, mask/reference hashes i `activation_candidate_token`. Launch atomowo konsumuje token albo odrzuca `stale_activation_candidate`; alternatywna ścieżka musi jawnie oznaczyć preview jako spekulatywny i po starcie pobrać maskę solvera.
9. Telemetria/status zwraca `(constraint_id, epoch)[]`, resolved-set revision, fingerprinty i site counts bez ciężkiej maski w realtime.

### Testy

- activation epoch 1;
- wiele kroków bez zmiany epoki;
- deactivate/reactivate daje epoch 2 i nową referencję;
- nieudana reaktywacja zachowuje poprzedni spójny stan;
- restore zachowuje epoch;
- równoległy odczyt statusu nie widzi częściowego snapshotu;
- state selector jest oceniony raz mimo wielu podkroków;
- stage A→B aktywny zachowuje epoch, A→inactive→C zwiększa epoch;
- zmiana samej reference unieważnia wszystkie historie solvera;
- stale preview token jest atomowo odrzucony;
- CPU/GPU tego samego carriera dają zgodny resolved hash; FDM/FEM porównują wyłącznie authored/semantics hash.

### Bramka P5

`PASS`, gdy ownership epoch/set revision jest jednoznaczny, stage semantics i preview transaction są przetestowane, a re-aktywacja atomowo publikuje mask/reference i unieważnia komplet historii.

---

## P6. Checkpoint, `ExactResume` i proweniencja

### Cel

Zapewnić bitowo/numerycznie poprawne wznowienie Frozen Spins i odrzucać checkpoint niezgodny z problemem, planem, backendem lub ABI.

### Miejsca implementacji

- `crates/fullmag-session/src/capture.rs`, szczególnie porównanie `ExactResume`;
- format checkpointu i jego wersja;
- FDM CPU/CUDA, multilayer oraz FEM CPU/GPU state restore;
- testy runnera checkpoint/resume.

### Implementacja

1. Dodać `problem_hash` do walidacji `ExactResume`; obecne porównanie `restart_abi`, `plan_hash`, discretization, precision i field layout jest niewystarczające.
2. Zapisać w checkpointcie:
   - wersję kontraktu Frozen Spins;
   - `frozen_mask` lub jego kanoniczny nośnik plus checksumę;
   - `frozen_reference` plus checksumę;
   - per-constraint epochs i resolved-set revision;
   - membership/reference policy;
   - identyfikator constraintu i plan/problem hash;
   - aktywny `stage_id`, czas lokalny i absolutny stage;
   - FSAL cache, adaptive-controller state i consecutive rejected-step count;
   - pełną historię ABM3;
   - thermal RNG state/counter;
   - PG-BB previous state/gradient, wariant BB i step size;
   - NCG search direction, beta i restart counter;
   - preconditioner cache identity;
   - layout/partition metadata dla multilayer i FEM true DOF;
   - MPI partition/ownership;
   - runtime build ABI i backend implementation version;
   - precision oraz endianness/ABI, jeśli format jest binarny.
3. Restore ma najpierw zweryfikować cały manifest, a dopiero potem mutować runtime. Nie wolno częściowo załadować `m` i następnie odkryć niezgodności maski.
4. Po restore sprawdzić bitwise equality `m[frozen] == reference` w zapisanej precision. Jakakolwiek różnica jest błędem integralności.
5. `ExactResume` wymaga zgodnego backendu, precision, solvera, runtime build i pełnej historii. Nieznana wersja lub brak pola jest fail-closed.
6. Dodać osobny `PortableStateImport`, który przenosi magnetyzację, mask/reference, epochs i policies, ale jawnie resetuje historie solvera i publikuje nowy provenance event. CPU import checkpointu CUDA może być tylko tym trybem, nie `ExactResume`.
7. Dla GPU zachować referencję i maskę w pamięci urządzenia po restore. Host może walidować checksumę podczas ładowania, ale kroki nie używają periodycznego host fallbacku.

### Testy

- exact resume z identycznym problemem;
- zmiana `problem_hash` przy tym samym plan hash — odrzucenie;
- zmiana maski/reference/epoch — odrzucenie;
- uszkodzona suma kontrolna — odrzucenie przed mutacją runtime;
- ExactResume same-lane oraz osobny PortableStateImport cross-lane z resetem historii;
- GPU checkpoint/resume bez fallbacku;
- ABM3 z pełną historią po P8;
- multilayer/FEM z poprawnym layoutem i negatywnym testem zmiany partycji.

### Bramka P6

`PASS`, gdy checkpoint zachowuje pełny stan solvera i Frozen Spins, ExactResume jest same-contract fail-closed przed mutacją, a PortableStateImport ma osobny typ, event i test resetu historii.

---

## P7. FDM CPU single-grid — domknięcie produkcyjne

### Cel

Podnieść istniejący szeroki dowód źródłowy FDM CPU do trwałej kwalifikacji managed runtime.

### Stan wejściowy

Testy runnera 10/10 już potwierdzają większość kontraktu na CPU single-grid, lecz brakuje jednego, trwałego receiptu z czystego źródła i kompletnej macierzy lane.

### Implementacja

1. Upewnić się, że każdy publiczny integrator single-grid stosuje pełne maskowanie RHS oraz hard restore po każdym podkroku/candidate/normalize/retract.
2. Skatalogować wszystkie publiczne integratory i minimizery. Lista testów ma pochodzić z registry runtime, a nie z ręcznej listy, aby nowy algorytm nie ominął gate.
3. Potwierdzić osobno:
   - exchange only;
   - demag only;
   - exchange + demag;
   - LLG + STT;
   - LLG + SOT;
   - LLG + thermal z deterministycznym seedem;
   - połączone dodatkowe torque;
   - all-frozen;
   - no-frozen/no-mask parity;
   - direct minimizer PG-BB/NCG, jeśli należą do V1.
4. Kryteria stopu operują na free sites. All-frozen relaxation kończy się w 0 iteracji; time evolution wykonuje analytical time advance do `t_end` z outputami i czasowo zależnymi observables.
5. Dodać test wpływu: zamrożone spiny zmieniają pole/energię i trajektorię sąsiednich free DOF. Test samego „frozen się nie porusza” jest niewystarczający.
6. Recepta `verify-frozen-spins-fdm-cpu` ma budować i uruchamiać rzeczywisty runner w kanonicznym środowisku, generować receipt i kopiować go na hosta.
7. Mierzyć no-mask overhead, partial-frozen overhead, activation wall time, mask/reference bytes oraz koszt preview dla co najmniej jednego przypadku milion-sites.

### Kryteria numeryczne

- `frozen_max_ulp_drift = 0` i bitwise equality po każdym restore FP64;
- free DOF wykazują niezerową zmianę w teście dynamiki;
- no-mask parity mieści się w ustalonej tolerancji backendu;
- brak NaN/Inf w stanie, energii i telemetrii;
- site/component counts dokładnie odpowiadają masce;
- all-frozen time evolution kończy z `time=t_end` i poprawnym output schedule;
- metryki performance są zapisane, nawet jeśli P0 nie ustali jeszcze twardych limitów regresji.

### Bramka P7

`PASS`, gdy recipe managed runtime na czystym SHA tworzy trwały, kompletny receipt FDM CPU single-grid dla każdego algorytmu/physics wymaganego przez macierz V1.

---

## P8. FDM CPU multilayer i ABM3

### Cel

Usunąć dwa świadome wyłączenia: produkcyjne Frozen Spins w multilayer oraz ABM3 z poprawnym checkpoint/history.

### Miejsca implementacji

- `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs`, w tym helper obecnie dostępny tylko pod `#[cfg(test)]`;
- planner FDM i test `multilayer_fdm_rejects_authored_frozen_spins_before_runtime_selection`;
- implementacja ABM3, jego history buffers i checkpoint;
- multilayer layout/offset mapping.

### Implementacja — multilayer

1. Przenieść `restore_frozen_reference_by_layer_offsets` albo równoważną logikę do produkcyjnego modułu; nie eksportować API testowego bezpośrednio, tylko wydzielić wspólny, typowany komponent.
2. Zbudować per-layer mapowanie `logical cell → layer offset → storage index` i zweryfikować jego fingerprint względem skompilowanej maski.
3. Stosować restore po każdym podkroku wszystkich publicznych integratorów multilayer i po każdej operacji normalizacji/retrakcji.
4. Zachować pełny udział frozen spins w inter-layer exchange/demag i innych couplingach. Nie wolno zerować ich wkładu fizycznego razem z DOF.
5. Usunąć odrzucenie planera dopiero po przejściu testów produkcyjnych. Test odrzucenia zamienić w test wyboru poprawnego runtime; pozostawić negatywne przypadki dla nieobsługiwanych layoutów.

### Implementacja — ABM3

1. Określić, które bufory historyczne zawierają pochodne/stany i w którym miejscu należy maskować oraz restore’ować frozen entries.
2. Przy aktywacji Frozen Spins w trakcie sesji zresetować albo przeliczyć historię ABM3 w sposób zdefiniowany przez solver; nie mieszać pochodnych sprzed aktywacji z nową maską.
3. Zapisać historię ABM3 w checkpointcie wraz z mask fingerprint i activation epoch.
4. Po resume potwierdzić ciągłość trajektorii free DOF względem biegu bez przerwy.
5. Usunąć planner rejection ABM3 dopiero po przejściu testów historii, aktywacji i resume.

### Testy

- constraint w jednej warstwie, wielu warstwach i na granicy offsetów;
- coupling frozen layer → free layer;
- pusta i pełna maska w każdej warstwie;
- restart z innym layer layout — fail-closed;
- ABM3: aktywacja przed pierwszym krokiem, po zapełnieniu historii, re-aktywacja, checkpoint/resume;
- porównanie biegu ciągłego i wznowionego;
- no-mask parity dla multilayer i ABM3.

### Bramka P8

`PASS`, gdy planner wybiera produkcyjną ścieżkę multilayer i ABM3, helper restore nie jest test-only, a trwały managed receipt potwierdza invariant, influence, parity i resume. Do tego czasu oba przypadki muszą nadal fail-closed.

---

## P9. FDM CUDA FP64 — pełna macierz i trwały dowód

### Cel

Przekształcić istniejący pozytywny test CUDA w produkcyjny receipt rzeczywistego urządzenia oraz rozszerzyć go na całą wymaganą macierz FP64.

### Stan wejściowy

`just verify-frozen-spins-fdm-cuda` przeszedł dla Heun/RK4 i checkpointu, ale receipt był efemeryczny, zawierał `device_name="cuda_runtime"`, nieznany driver/runtime i fikcyjny PCI. Jest to `RUNTIME CONFIRMED`, nie `QUALIFIED`.

### Miejsca implementacji

- `backends/fdm/api/c_api.cpp`;
- `backends/fdm` CUDA kernels, w tym `llg_fp64.cu` i wszystkie ścieżki integratorów/minimizerów;
- FDM sys/runner bridge oraz capability manifest;
- skrypt/recepta kwalifikacyjna i runtime manifest.

### Implementacja

1. Pobierać realną tożsamość GPU przez CUDA API/NVML dostępne w zarządzanym obrazie: nazwa, UUID lub PCI bus ID, compute capability, driver version i runtime version.
2. Receipt musi dowodzić, że użyto kerneli CUDA i że `fallback_used=false`. Dodać licznik/marker aktywacji GPU sprawdzany przez test, nie tylko przez log tekstowy.
3. Utrzymać maskę i reference device-resident przez cały solve. Dodać diagnostyczny licznik transferów lub test kontraktowy wykluczający per-step D2H/H2D Frozen Spins.
4. Dla każdego integratora zapewnić kolejność:
   - oblicz wszystkie wkłady RHS;
   - zastosuj końcową maskę do złożonego RHS;
   - utwórz candidate/substep;
   - normalize/retract;
   - przywróć frozen reference;
   - zaakceptuj stan.
5. Objąć co najmniej wszystkie algorytmy FP64 deklarowane w capability registry, nie tylko Heun/RK4. Jeżeli minimizery GPU są publiczne, muszą mieć analogiczny restore i receipt.
6. Dodać STT, SOT, thermal, exchange/demag influence, oba warianty all-frozen, no-mask parity i checkpoint/resume na GPU.
7. Mierzyć activation H2D/D2H, per-step transfer bytes, dodatkową pamięć per site oraz runtime overhead no-mask/partial mask; per-step Frozen Spins H2D/D2H musi wynosić zero.
8. Kopiować receipt oraz logi testowe na hosta, obliczyć checksumy i powiązać z source/runtime manifestem.

### Testy numeryczne i rezydencji

- bitwise equality i `frozen_max_ulp_drift=0` dla FP64 po każdym podkroku i stanie zaakceptowanym;
- free displacement wyraźnie większy od tolerancji zera;
- wpływ frozen na free zgodny z CPU reference;
- brak fallbacku i brak per-step host roundtripu;
- checkpoint/resume zgodny z P6;
- wynik CPU/GPU zgodny w ustalonej tolerancji dla deterministycznego przypadku.

### Bramka P9

`PASS`, gdy trwały receipt z czystego SHA wskazuje prawdziwe GPU/driver/runtime, obejmuje pełną macierz FP64 i dowodzi `fallback_used=false`. Sam exit code recepty bez tych pól nie wystarcza.

---

## P10. FDM CUDA FP32

### Cel

Zrealizować decyzję P0 dla FP32: implementować i zakwalifikować, jeśli `REQUIRED`, albo utrzymać formalny fail-closed, jeśli `OUT_OF_SCOPE`. P10 nie podejmuje już decyzji zakresowej.

### Miejsca implementacji

- `backends/fdm/api/c_api.cpp`, obecny fail-closed `frozen_spins_cuda_fp32_unqualified`;
- FP32 kernels i integratory CUDA;
- ABI, runner bridge, capabilities i macierz kwalifikacji.

### Implementacja

1. Odwzorować poprawną kolejność z FP64 w każdym FP32 kernelu bez współdzielenia wskaźników o niewłaściwym typie.
2. Przechowywać maskę w formacie jednoznacznym logicznie; reference w FP32, z jawną wersją/precision w checkpointcie.
3. Hard restore FP32 wymaga bitwise equality z referencją zakwantowaną do FP32 i zero ULP drift. Osobne tolerancje dotyczą CPU/GPU parity i free trajectory.
4. Powtórzyć macierz Heun/RK4/pozostałych publicznych integratorów, STT/SOT/thermal, all-frozen, influence, no-mask parity i checkpoint.
5. Usunąć `frozen_spins_cuda_fp32_unqualified` z drogi pozytywnej dopiero po pojawieniu się ważnego receiptu. Kod pozostawić dla obrazów/runtime bez zakwalifikowanego wsparcia, jeśli capability jest runtime-dependent.
6. Zaktualizować API capabilities z pełną osią precision.

### Realizacja statusu `OUT_OF_SCOPE` z P0

Jeżeli P0 oznaczy FP32 poza V1, należy jednocześnie:

- zmienić zaakceptowaną specyfikację V1;
- oznaczyć FP32 jako `scope_status=OUT_OF_SCOPE`, nie `QUALIFIED`;
- utrzymać fail-closed w plannerze i API;
- dodać test stabilnego kodu błędu;
- uzyskać osobną akceptację właściciela produktu. Bez tej decyzji P10 pozostaje otwarte.

### Bramka P10

`PASS` przez jeden z dwóch jawnych rezultatów: produkcyjny FP32 receipt albo formalnie zaakceptowane zawężenie V1 z pełnym fail-closed. Techniczna preferencja zespołu nie zastępuje decyzji zakresowej.

---

## P11. FEM CPU managed runtime i decyzja TPI

### Cel

Przejść kanoniczną receptę FEM CPU od początku do końca i jednoznacznie rozstrzygnąć ścieżkę TPI.

### Stan wejściowy

Build FEM zakończył się sukcesem, a bezpośredni `fem_frozen_spins_contract` przeszedł 4/4. Kanoniczna recepta `verify-fem-time-domain-native-contract` zatrzymała się wcześniej na niezależnym `fem_interaction_docs_contract` z brakiem deklaracji ownership boundaries w `operator_dependency.hpp`. Dlatego FEM CPU jest `SOURCE/RUNTIME DIAGNOSTIC CONFIRMED`, ale managed qualification jest `BLOCKED`.

### Miejsca implementacji

- `backends/fem/cpu/mfem/interactions/operator_dependency.hpp` — naprawić kontrakt dokumentacyjny zgodnie z rzeczywistą własnością, bez wstawiania tekstu tylko pod test;
- `backends/fem/cpu/mfem/relaxation/relaxation_step.cpp` — obecny fail-closed TPI;
- runner FEM selection;
- `fem_frozen_spins_contract` oraz kanoniczne recepty FEM.

### Implementacja

1. Naprawić blokujący docs contract poprzez prawdziwe opisanie ownership/lifetime/threading granic wymaganych przez kontrakt. Uruchomić ukierunkowany test docs przed pełnym buildem.
2. Ponownie uruchomić pełną `verify-fem-time-domain-native-contract`; nie omijać poprzedzających testów i nie uznawać bezpośredniego binarium za substytut recepty.
3. Dla wszystkich zakwalifikowanych explicit steps i direct minimizers potwierdzić:
   - maskowanie residual/update po wszystkich wkładach;
   - hard restore true DOF reference po candidate/retraction;
   - free-only norms i convergence;
   - all-frozen oraz influence.
4. Zrealizować decyzję TPI z P0.
   - `REQUIRED`: włączyć constraint do residual, tangent/preconditioner i acceptance, z free-only convergence oraz restore.
   - `OUT_OF_SCOPE`: utrzymać fail-closed, `execution_supported=false` i stabilny typed reason code.
5. Receipt FEM CPU ma zawierać konfigurację MFEM, compiler/runtime manifest, precision, solver, mesh/true DOF counts i dowód braku fallbacku.

### Testy

```powershell
wsl.exe -d Ubuntu2 -- bash -lc 'cd /mnt/c/git/fullmag/fullmag && just verify-fem-time-domain-native-contract'
```

Ponadto uruchomić dedykowaną `just verify-frozen-spins-fem-cpu`, która nie może zakończyć się `PASS`, jeśli dowolny wcześniejszy kontrakt kanonicznej ścieżki FEM nie przeszedł.

### Bramka P11

`PASS`, gdy pełna recepta managed przechodzi bez ręcznego omijania testów, trwały receipt obejmuje wszystkie wspierane algorytmy FEM CPU, a status TPI jest jawnie zaimplementowany albo formalnie wyłączony z V1.

---

## P12. FEM GPU — device-resident constraint i kwalifikacja

### Cel

Przejść od „źródła kompilują się” do wykonanego kontraktu Frozen Spins na rzeczywistym GPU FEM.

### Miejsca implementacji

- `backends/fem/CMakeLists.txt`, gdzie kernel Frozen Spins jest już włączony;
- źródła FEM GPU RK/relaxation i wrappery urządzeniowe;
- MFEM/device vector integration;
- runner/planner/capabilities;
- nowy `fem_frozen_spins_gpu_contract` lub równoważne produkcyjne binarium testowe.

### Implementacja

1. Zidentyfikować kanoniczny layout FEM true DOF na urządzeniu. Maska i reference muszą indeksować dokładnie ten layout, nie kolejność węzłów wizualizacyjnych.
2. Załadować maskę/reference raz na aktywację lub restore checkpointu. Zachować je device-resident przez solve.
3. Po pełnym residual/RHS zastosować maskowanie update, a po każdej operacji candidate/normalization/retraction uruchomić kernel restore.
4. Redukcje norm/convergence wykonywać po free DOF na urządzeniu albo w istniejącej zakwalifikowanej ścieżce redukcji bez kopiowania całego stanu na hosta.
5. Dodać marker aktywacji urządzenia i telemetrię transferów pozwalającą udowodnić brak CPU fallbacku oraz brak per-step transferu całej maski/reference.
6. Obsłużyć MPI/partitioned true DOF, jeśli lane FEM GPU jest publicznie deklarowane. Maska ghost/shared DOF musi mieć jednoznaczną własność i komunikację.
7. Zbudować test kontraktowy obejmujący explicit solver, direct minimizer, exchange/demag influence, all-frozen, no-mask parity, checkpoint i re-aktywację.

### Dowód urządzeniowy

Receipt ma zawierać rzeczywiste GPU UUID/PCI, driver, runtime, MFEM device configuration, precision, MPI rank count, true DOF counts, kernel activation marker, `fallback_used=false` oraz checksumy logów.

### Bramka P12

`PASS`, gdy `just verify-frozen-spins-fem-gpu` wykonuje rzeczywiste binarium na GPU i tworzy kompletny receipt. Kompilacja pliku `.cu`, symbol w bibliotece albo test CPU nie są wystarczające.

---

## P13. API v2, zasoby maski i carrier FEM

### Cel

Zapewnić pełny, wersjonowany roundtrip constraintu oraz autorytatywny nośnik danych preview/overlay dla FDM i FEM.

### Miejsca implementacji

- zasoby API v2 constraintów i session status;
- generowany OpenAPI i klient TypeScript;
- field/geometry carrier descriptors;
- backend/runner serializujący compiled mask metadata;
- Control Room data hooks używane w P14.

### Implementacja

1. Utrzymać dwa równoważne wejścia: `region.freeze_spins()` oraz jawny zasób constraintu. Po roundtripie oba muszą dawać ten sam kanoniczny JSON/IR hash.
2. Endpoint create/update/delete constraintu musi zwracać resource id, revision, policy, selector fingerprint i stan kompilacji.
3. Dodać lekki descriptor maski zawierający counts, mask fingerprint, carrier fingerprint, activation epoch i URL/identyfikator ciężkiego payloadu.
4. Ciężki payload maski/overlay pobierać przez HTTP v2, wersjonować revision/ETag i walidować carrier fingerprint. WebSocket ma jedynie sygnalizować zmianę revision.
5. Dla FDM payload jednoznacznie określa grid/layout i mapowanie sites. Dla obsługiwanej ścieżki FEM serial P1 carrier `fullmag.fem-local-node-render.v1` zawiera `mesh_fingerprint`, `topology_hash`, `fe_space_order=1`, `vector_ordering=by_nodes`, `local_node_count`, opublikowane pozycje/wierzchołki FMMT i dokładne local-node → render vertex. Nie wolno nazywać tej maski true-DOF ani tworzyć fikcyjnego CSR. Higher-order, periodic/shared/hanging oraz MPI/ghost wymagają przyszłego, osobno wersjonowanego carriera i do tego czasu kończą się fail-closed.
6. API ma odrzucić mieszanie maski z inną geometrią/carrierem. Nie wolno renderować po samych długościach tablic.
7. Descriptor publikuje cztery rozdzielone fingerprinty zgodnie z P4 i activation certificate zgodnie z P5.
8. Preview state-dependent zwraca activation candidate token i source-state revision. Endpoint launch atomowo konsumuje token albo zwraca typed stale error; w trybie spekulatywnym publikuje nowe solver revision i wymusza HTTP refetch.
9. Usunięcie/edycja constraintu unieważnia payload i zwiększa revision; klient nie może używać starej maski po invalidate.
10. Wygenerować OpenAPI/TypeScript i zapewnić clean diff wygenerowanych artefaktów.

### Testy

- Python/API roundtrip equality;
- create/read/update/delete i stabilne ID/revision;
- FDM carrier match/mismatch;
- FEM local-node-to-render mapping dla serial P1 oraz negatywne fixtures dla higher-order, periodic/shared/hanging i MPI/ghost;
- ETag/conditional GET;
- websocket invalidation prowadzi do ponownego HTTP GET;
- stale payload i carrier mismatch — fail-closed;
- activation token consume oraz stale race;
- capabilities z P3 zgadzają się z authoring/preview/execution, niezależnie od qualification status.

### Bramka P13

`PASS`, gdy API v2 zwraca autorytatywny, wersjonowany mask resource z activation transaction, FEM serial P1 używa zweryfikowanego local-node carrier mappingu, a wszystkie pozostałe przestrzenie FE kończą się jawnie fail-closed.

---

## P14. Control Room — authoring, Explorer, Inspector i overlay

### Cel

Domknąć pełny workflow użytkownika, a nie tylko obecność przycisku i canvasu.

### Miejsca implementacji

- Ribbon action tworząca Frozen Spins;
- Explorer child node i selection model;
- dedykowany Inspector constraintu;
- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx` i `layers/FrozenSpinsOverlay.tsx`, szczególnie budowa carriera z rzeczywiście opublikowanej topologii;
- hooks/cache API v2, overlay renderer i error states;
- testy React/Vitest oraz generowany klient.

### Implementacja

1. Ribbon ma tworzyć constraint dla aktualnie wybranego regionu/obiektu poprzez API v2, a nie tylko lokalny model. Po sukcesie zaznaczyć nowy constraint w Explorerze.
2. Explorer ma prezentować constraint jako poprawne dziecko właściwego zasobu. Selection identity constraintu ma działać niezależnie od opcjonalnego `objectId`; nie przywracać naprawionego błędu z ID zależnym od obiektu.
3. Inspector ma pokazywać i edytować dozwolone pola: selector/region, membership policy, reference policy, activation state, epoch, counts, capability/status i stabilny błąd. Pola niedozwolone po aktywacji mają być read-only albo wymagać jawnej reaktywacji.
4. Preview ma pobrać autorytatywną maskę API, sprawdzić revision i carrier fingerprint, a następnie przekazać ten sam fingerprint do statusu solvera.
5. FDM overlay renderować według grid carrier. FEM serial P1 renderować przez `fullmag.fem-local-node-render.v1` z P13, utworzony z `sceneModel.topologyModel`; nie wolno mieszać go z true-DOF. Dla innych przestrzeni FE zwrócić stabilny fail-closed reason.
6. Dodać czytelne stany: loading, stale/reloading, empty mask, all frozen, unsupported lane, carrier mismatch, backend disconnected, WebGL context lost.
7. Cache unieważniać po revision event. Nie czyścić poprawnego overlay przy niezwiązanej telemetrii.
8. Wyświetlać active/frozen/free site counts, scalar component DOF count, vector dimension, per-constraint epochs i resolved-set revision ze statusu, nie wyliczać ich z grafiki.
9. Typecheck naprawić w kanonicznym środowisku. Rozwiązać `spawnSync next.cmd EINVAL` w wrapperze Windows lub prowadzić oficjalny typecheck w zarządzanym środowisku; uzupełnić deterministycznie brakujące typy `esrecurse`/`json-schema` zgodnie z lockfile, bez globalnej instalacji.

### Testy komponentowe

- Ribbon create success/error/unsupported;
- Explorer poprawny parent/child i niezależne constraint selection ID;
- Inspector roundtrip i read-only/re-activation;
- FDM oraz FEM overlay z poprawnym carrierem;
- stale revision i carrier mismatch;
- empty/all-frozen;
- WebGL context lost/recovery;
- site/component counts, per-constraint epochs i resolved-set revision;
- clean `pnpm --dir apps/control-room typecheck` w kanonicznym środowisku.

### Bramka P14

`PASS`, gdy testy komponentowe przechodzą, typecheck jest potwierdzony, a aplikacja potrafi od API do renderera obsłużyć zarówno FDM, jak i FEM maskę bez lokalnego fałszowania pozycji.

---

## P15. Realny E2E browser/WebGL i walidacja naukowa

### Cel

Udowodnić w działającym systemie, że użytkownik może utworzyć constraint, zobaczyć poprawny overlay i uruchomić solver zachowujący kontrakt fizyczny.

### Miejsca implementacji

- `apps/control-room/scripts/smoke-frozen-spins.mjs` lub nowy kanoniczny test Playwright;
- fixture/scenario Frozen Spins dla FDM i FEM;
- endpointy diagnostyczne tylko wtedy, gdy są częścią jawnego kontraktu testowego;
- artefakty screenshot/video/trace/log/receipt.

### Implementacja E2E

1. Uruchomić rzeczywisty backend API, runner i Control Room w zarządzanym środowisku. Mock backend nie kwalifikuje E2E.
2. Test ma wykonać kolejno:
   - utworzenie lub otwarcie kanonicznego problemu;
   - wybór regionu;
   - kliknięcie Frozen Spins w Ribbon;
   - potwierdzenie nowego child node w Explorerze;
   - otwarcie dedykowanego Inspectora;
   - weryfikację policy, counts i capability;
   - aktywację constraintu;
   - pobranie maski przez HTTP v2;
   - wyświetlenie overlay o właściwym carrier fingerprint;
   - uruchomienie solvera;
   - weryfikację epoch i telemetrii free/all;
   - zmianę/dezaktywację i sprawdzenie invalidation/reload;
   - kontrolowane zakończenie bez błędów konsoli/WebGL.
3. Wykonać osobne scenariusze FDM i FEM. FEM musi faktycznie przejść przez local-node carrier i opublikowaną geometrię P1, nie tylko canvas; przypadek nieobsługiwanej przestrzeni FE ma potwierdzić fail-closed.
4. Zapisać screenshot overlay, trace, log konsoli, network log dla zasobu maski oraz session/solver receipt. Artefakty powiązać wspólnym run ID.
5. Test negatywny ma potwierdzić czytelny fail-closed dla nieobsługiwanej krotki, np. przed kwalifikacją FP32/TPI.

### Walidacja naukowa

Dla każdej zakwalifikowanej klasy backendu wykonać co najmniej:

1. **Invariant:** frozen DOF pozostają równe reference w całym biegu.
2. **Mobility:** free DOF poruszają się w tym samym scenariuszu.
3. **Influence:** zmiana orientacji frozen reference zmienia pole/energię/ewolucję free DOF w przewidywany sposób.
4. **No-mask parity:** wyłączenie Frozen Spins odtwarza historyczne zachowanie solvera w tolerancji.
5. **Energy accounting:** frozen spins pozostają w energii i couplingach.
6. **Free-only stopping:** zamrożone DOF nie zaniżają ani nie zawyżają kryterium zbieżności.
7. **Checkpoint continuity:** bieg ciągły i wznowiony są zgodne.
8. **CPU/GPU parity:** deterministyczny przypadek porównawczy mieści się w tolerancji właściwej precision.
9. **Preview/solver parity:** fingerprint i counts maski UI odpowiadają solverowi.
10. **Independent oracle:** analityczny test dwóch spinów exchange oraz tłumiona relaksacja jednego free spinu względem frozen sąsiada.
11. **Minimizer oracle:** monotoniczny spadek właściwej energii PG-BB/NCG.
12. **Cross-discretization:** authored/semantics fingerprint parity, spatial measure i refinement convergence FDM/FEM, bez porównania resolved mask SHA.
13. **Thermal:** reproducibility/statistical contract ze wspólnym RNG policy; nie wymagać niezdefiniowanej trajectory parity.

### Kwalifikacja wydajności

Dla każdego required lane receipt zapisuje: no-mask overhead, partial-mask overhead, activation wall time, preview wall time, mask/reference memory bytes, H2D/D2H activation bytes, per-step frozen transfer bytes oraz skalowanie co najmniej do przypadku milion-sites. `per_step_frozen_H2D_D2H_bytes=0` jest twardą bramką GPU. Limity regresji czasu/pamięci są wersjonowane w P0 scope/performance policy.

### Bramka P15

`PASS`, gdy realny browser smoke przechodzi dla FDM i FEM, artefakty są trwałe, nie ma błędów konsoli/WebGL, a walidacja naukowa potwierdza invariant, influence, parity i resume. FDM quantity/WebGL ma trwały PASS; FEM live oraz pełny workflow authoring/activation pozostają wymagane.

---

## P16. Zbiorcza kwalifikacja, CI, dokumentacja i release gate

### Cel

Zamknąć wszystkie dowody w jednej odtwarzalnej ścieżce i uniemożliwić regresję po dodaniu nowego lane lub algorytmu.

### Implementacja

1. `just verify-frozen-spins-qualification` ma uruchomić lub zweryfikować wszystkie obowiązkowe recepty P2, w kontrolowanej kolejności i na tym samym source identity.
2. Dla ciężkich GPU/FEM jobs dopuszczalne jest zebranie osobnych receiptów CI, ale agregator waliduje wspólny clean tree identity, runtime manifest, schema, P0 scope ledger i kompletność covering-array.
3. Dodać CI matrix generowaną z capability predicates oraz P0 scope ledger. Nowy publiczny integrator/backend/precision może mieć `execution_supported=true`, lecz domyślnie ma `qualification_status=UNQUALIFIED` i nie przechodzi strict-production/release gate.
4. Dodać gate wykrywający:
   - macierz dokumentacyjna mówi `QUALIFIED`, lecz brak receiptu;
   - receipt dotyczy innego tree/source snapshot;
   - `fallback_used=true`;
   - brak identyfikacji urządzenia/runtime;
   - brak testu dla publicznego algorytmu;
   - browser smoke bez artefaktów;
   - wygenerowane API niezgodne ze źródłem;
   - brak zero-ULP hard restore;
   - brak performance/transfer metrics;
   - otwarty critical finding FS-001–FS-014.
5. Zaktualizować:
   - design/spec Frozen Spins;
   - macierz kwalifikacji;
   - instrukcję authoringu Python/API;
   - listę wspieranych lane i stabilnych błędów;
   - checkpoint compatibility/migration;
   - runbook diagnostyczny i lokalizację receiptów.
6. Przeprowadzić końcowy audit od czystego checkoutu bez używania starych artefaktów. Skopiować manifest zbiorczy, indywidualne receipty, logi i artefakty browsera do trwałego katalogu.
7. Nie wykonywać commit/push/merge/release bez osobnej dyspozycji właściciela repo. P16 przygotowuje dowody gotowości; publikacja jest osobną operacją.

### Końcowa macierz obowiązkowa

Macierz release musi mieć jednoznaczny wynik dla co najmniej:

- IR/Python/API authoring i roundtrip;
- FDM CPU single-grid FP64;
- FDM CPU multilayer zgodnie z P0;
- ABM3 zgodnie z P0;
- FDM CUDA FP64;
- FDM CUDA FP32 albo formalne `scope_status=OUT_OF_SCOPE`;
- FEM CPU explicit/direct minimizer;
- FEM TPI albo formalne `scope_status=OUT_OF_SCOPE`;
- FEM GPU zgodnie z P0;
- checkpoint/exact resume;
- Control Room component/typecheck;
- browser/WebGL FDM i FEM;
- scientific invariant/influence/no-mask/CPU-GPU parity, independent oracle i refinement convergence;
- performance/no-transfer receipts.

### Bramka P16 — Definition of Done

Frozen Spins V1 można uznać za zakończone wyłącznie, gdy wszystkie poniższe zdania są prawdziwe:

1. `region.freeze_spins()` i jawny constraint API roundtripują do identycznego kanonicznego IR.
2. Typed state snapshot selectors są oceniane raz, a preview/launch używają activation token albo jawnej stale invalidation; overlay adoptuje maskę solvera.
3. Każdy required backend/precision/mesh/algorithm zachowuje frozen reference bitwise i liczy dynamikę/redukcje po free sites.
4. Zamrożone spiny nadal wpływają na free DOF przez energię i oddziaływania.
5. Każda nieobsługiwana krotka fail-closed przed uruchomieniem, ze stabilnym kodem.
6. Checkpoint zachowuje maskę, reference, per-constraint epochs, resolved-set revision, pełną historię, RNG, partition i hashes; ExactResume jest odrębny od PortableStateImport.
7. Capabilities API oddzielają authoring/preview/execution od qualification i są zgodne z plannerem.
8. Control Room tworzy zasób, pokazuje child/Inspector, oferuje `frozen_spins` jako standardowe quantity i renderuje FDM/FEM przez topology-aware carrier, w FEM serial P1 przez zweryfikowany local-node mapping.
9. Realny browser/WebGL smoke oraz typecheck przechodzą w kanonicznym środowisku.
10. Każdy status `QUALIFIED` ma trwały receipt z clean tree identity, runtime manifestem, realnym urządzeniem, `fallback_used=false`, zero-ULP restore oraz metrykami performance/transfer.
11. Zbiorcza recepta kończy się kodem 0 bez `SKIP` w obowiązkowej macierzy.
12. Dokumentacja i generowane API odpowiadają dokładnie wykonanym dowodom.

Jeżeli choć jeden punkt jest niespełniony, agregat ma `gate_result=FAIL/NOT_RUN` i odpowiednią oś qualification; nie wolno zastępować brakującego dowodu procentem ani nieformalnym `PARTIAL` dla lane.

## 6. Zalecana kolejność realizacyjna i punkty kontrolne

Praktyczna kolejność bezpiecznych batchy:

1. **Batch A — zakres i proweniencja:** P0–P2.
2. **Batch B — kontrakt stanu:** P4–P6.
3. **Batch C — final capability registry:** P3.
4. **Batch D — równoległe lane:** FDM P7–P10, FEM P11–P12 i niezależne carriers P13.
5. **Batch E — API/UI/E2E:** pozostałe P13–P15.
6. **Batch F — zamknięcie:** P16.

Po każdym batchu należy przygotować krótki raport zawierający: SHA, diff scope, testy source, testy managed runtime, receipt IDs, status każdej lane, znane blokery i decyzję `GO/NO-GO` dla kolejnego batchu.

## 7. Zakazane skróty

- Nie nazywać kompilacji testem runtime.
- Nie nazywać bezpośrednio uruchomionego binarium dowodem pełnej recepty, jeżeli kanoniczna recepta kończy się wcześniej błędem.
- Nie mieszać `execution_supported` z `qualification_status`; brak receiptu nie zmienia deterministycznej możliwości wykonania, ale blokuje release.
- Nie akceptować receiptów z `unknown` device/driver/runtime w release gate.
- Nie przechowywać jedynego receiptu w `/tmp` kontenera.
- Nie omijać multilayer, ABM3, FP32, TPI lub FEM GPU bez formalnej decyzji zakresowej.
- Nie zastępować browser E2E testem komponentowym ani sprawdzeniem, że canvas istnieje.
- Nie wyliczać maski drugi raz w UI niezależnie od activation transaction.
- Nie porównywać resolved mask SHA FDM i FEM.
- Nie nazywać cross-lane state import `ExactResume`.
- Nie używać tolerancji zamiast bitwise hard restore invariant.
- Nie usuwać udziału frozen spins z energii/interakcji.
- Nie resetować, stashować ani nadpisywać niepowiązanych zmian użytkownika.
- Nie wykonywać commit/push/merge/release bez osobnej autoryzacji.

## 8. Pierwszy konkretny krok wykonawczy

Najpierw zatwierdzić P0 scope ledger, następnie wygenerować P1 source snapshot identity i P2 evidence ledger. Potem wdrożyć P4 typed snapshot selector `m_z > 0.5`, domknąć P5 natywny CUDA/FEM activation owner oraz zarządzany runtime proof zaimplementowanego hot-apply, a także P6 pełne resume semantics. Dopiero z zamkniętych semantyk P4–P6 należy wygenerować dodatnie wpisy P3 capability. Pion quantity/API/Viewport 3D ma już FDM live, źródłowo zweryfikowany FEM authored preview/local-node carrier, atomowy spekulatywny `Preview → Commit`, command-bound konsumpcję na następnym `run/relax/solve` i na granicy zaakceptowanego kroku aktywnego solve, CPU solver-owned epoch/status oraz Inspector parity/adoption; jego pełny status P13/P14 wymaga teraz live dowodu FEM carriera `fullmag.fem-local-node-render.v1` i browserowego workflow commit→solver→quantity.
