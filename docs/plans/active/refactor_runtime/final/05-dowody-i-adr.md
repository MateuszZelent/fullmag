# Rejestr dowodów, syntezy i zgodności ADR

Data: 20.09.2026. Baza źródeł: `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`. Stan: audyt statyczny; brak wykonania aplikacji, testów solverów i migracji. Numery linii są pomocnicze; podstawowym anchorem jest ścieżka + symbol. Poniższe ścieżki kodu są względem repozytorium. Przy nowej bazie implementacyjnej ponownie sprawdzić zmienione źródła, nie kopiować numerów linii jako dowodów.

## 1. Manifest materiałów wejściowych

Hash SHA-256 opisuje dokładne bajty lokalnego pliku odczytanego do syntezy, również raportu Claude niewersjonowanego w chwili audytu. Historia Git nie zastępuje tego manifestu.

| Dokument | SHA-256 |
|---|---|
| [01-architektura-cae.md](../01-architektura-cae.md) | `02257a4719e812407956f7e08273b5e2951982ca5a3eef81157cac22ea21ef5d` |
| [02-kontrakty.md](../02-kontrakty.md) | `04802915bc7630e0dbdffd17570f926713e69d2f5c99e0a000fc5880ae046a98` |
| [03-migracja.md](../03-migracja.md) | `2c130141a55036f2d906ed64ab49982f9d7265f27b3bba529e315239ea6e03e7` |
| [04-scenariusze.md](../04-scenariusze.md) | `6a258ee053293d576666131e3e4becc8949a3fcc200de87489f3377e8579cc89` |
| [05-dowody-i-adr.md](../05-dowody-i-adr.md) | `2329c5fc0b0566ca8e492f2c5a310fef119d54684d31043cde65f51a0fbd786b` |
| [raport_claude/00-werdykt-i-podsumowanie.md](../raport_claude/00-werdykt-i-podsumowanie.md) | `d860f7b6770fd75dce4bc333563a0bec14be7d9aeb316a292da00881c3aac518` |
| [raport_claude/01-weryfikacja-dowodow-E01-E16.md](../raport_claude/01-weryfikacja-dowodow-E01-E16.md) | `07f88681f609bd943c0c055a0a779a945615b07f4b40d3c88af0230759da7959` |
| [raport_claude/02-sprostowania-raportu-gemini.md](../raport_claude/02-sprostowania-raportu-gemini.md) | `06b333bc514abb9e55b1ce3363cc6fa45dabe90914b11d9e024dfa464efae6a7` |
| [raport_claude/03-luki-i-bledy-planu.md](../raport_claude/03-luki-i-bledy-planu.md) | `223a79eb51e59f8ddd02a6d1c173827ff0d888c0844da968900ff7756084a44c` |
| [raport_claude/04-poprawki-do-planu-i-migracji.md](../raport_claude/04-poprawki-do-planu-i-migracji.md) | `2ce643d5995c9c8ae69c535d76c920fb0ddaf2ff20c62f31f1cef93a8b7fd0e2` |
| [raport_claude/05-ocena-ui-vs-comsol-cst.md](../raport_claude/05-ocena-ui-vs-comsol-cst.md) | `2fa27dfcd6b8543e024d0d02d159d5edab6fb2ecf2aa81a4da0a6cfef2e57f0e` |
| [raport_claude/06-rejestr-dowodow-claude.md](../raport_claude/06-rejestr-dowodow-claude.md) | `3c0cc67f44431b631e7deb14167b230e10076da8643122965f1072003faf124f` |
| [raport_gemini/00-synteza-i-werdykt.md](../raport_gemini/00-synteza-i-werdykt.md) | `3bb480532076ebcbadc67e56b0576649872cf6bde7bc35812a3ecc47af44a6f4` |
| [raport_gemini/01-weryfikacja-kodu-i-faktow.md](../raport_gemini/01-weryfikacja-kodu-i-faktow.md) | `68c99dfbbe7ea6ef9de45e16436f6e6eca81b1244708e06a6259482f867d45f7` |
| [raport_gemini/02-analiza-architektury-i-kontraktow.md](../raport_gemini/02-analiza-architektury-i-kontraktow.md) | `b111df659a83edc5512bc06fb3ce168244396dfd1d3e46d685f4c507b111197c` |
| [raport_gemini/03-ocena-planu-migracji-i-ryzyk.md](../raport_gemini/03-ocena-planu-migracji-i-ryzyk.md) | `b1bb794bc4ddaf994ed72ed73711eede2d4b434b70b92995461ccc55c606eae3` |
| [raport_gemini/04-rekomendacje-dla-ui-comsol-cst.md](../raport_gemini/04-rekomendacje-dla-ui-comsol-cst.md) | `1601b67539260cdd21b316d11b75801c0798129e27d519ff2e01d17398475c08` |
| [raport_gemini/05-krytyczne-sprostowania-i-gleboka-analiza.md](../raport_gemini/05-krytyczne-sprostowania-i-gleboka-analiza.md) | `13062858182e29acff3c0909e321c5744f9693ee5e85b25a2364d84717a32f13` |

## 2. Rozliczenie wszystkich materiałów

| Materiał | Zachowana wartość | Korekta / docelowe miejsce |
|---|---|---|
| Bazowy 01 architektura CAE | Ontologia, cztery grafy, parametry, geometria, studies, procesy, wyniki, Python i UI | 02 final; doprecyzowane Open/Restore, ADR-0009, authority FDM CPU i bounded renderer lifecycle. |
| Bazowy 02 kontrakty | K01–K18 w pełnym zakresie | 02 final; odrębne epoki, durable journal, leases, identity-only artifacts i typed reachability. |
| Bazowy 03 migracja | Kolejność P0–P8, extraction, single writer i rollback | 03 final; P0 safety, P3a identity, osobny strumień B i konkretne gates. |
| Bazowy 04 scenariusze | Wszystkie CAE-01–60 | 04 final zawiera pełne warunki/wyniki oraz mapę etapów. |
| Bazowy 05 dowody/ADR | E01–E16 i ADR-CAE-01–18 jako historyczne propozycje | Aktualne anchors i relacje ADR poniżej; nie nowe formalnie accepted ADR. |
| Gemini 00 synteza | Projektowy root, immutable runs, stopniowa migracja | Odrzucono scoring i „100%/gwarantuje”; 01 final §§5/9. |
| Gemini 01 kod/fakty | Wskazanie scene/scratch/startup sprzężeń | Zawężono universal claims, zaktualizowano SHA i anchors. |
| Gemini 02 kontrakty | Complex fields, function space, chunked I/O | 02 §§7–8; metadata zamiast wymagania C64/C128 lub dowolnego JSON DOF. |
| Gemini 03 migracja | Use-case extraction, Python context i kompatybilność | 03 P1–P6; brak nowego mutable global context i brak podwójnej kolejki. |
| Gemini 04 UI | Model Builder, Inspector, lokalny progress i contextual views | 02 §9; odrzucono permanent hidden canvases i niezweryfikowane presety/liczby. |
| Gemini 05 sprostowania | Istniejące stores i realne punkty admission GPU | Nie przyjęto unmount jako błędu ani benchmarków bez pomiaru. |
| Claude 00 werdykt | Priorytety L1–L6, reuse quantities i storage | 01 §§3/6; historyczny HEAD oznaczony jako historyczny. |
| Claude 01 E01–E16 | Kontrola istniejących struktur i korekty cytowań | Rejestr bieżących anchors; line count nie jest dowodem zgodności treści. |
| Claude 02 sprostowania Gemini | ADR-0016 i centralizacja API | 01 §§4–6; skorygowano twierdzenie „regeneracja wystarczy”. |
| Claude 03 luki | GC, durability, lock, trwałe URL i quantity owner | Rozszerzono o capture/export reachability, ID path validation i current IDs. |
| Claude 04 poprawki | CAE-61–70, wcześniejsze storage gates | 04 §4; pełne pośrednie session API nie jest obligatoryjne; copy-on-write migracja. |
| Claude 05 UI | ViewDocument, progress per node, settings provenance i display units | 02 §9; reuse Results/Mesh Jobs, odrzucono „jedyną powierzchnię tworzenia” i rankingi konkurencji. |
| Claude 06 dowody | Katalog miejsc do ponownej kontroli | Użyty jako indeks; aktualne dowody poniżej, nie przejęto historycznego stanu Git. |

## 3. Aktualne anchors i granice wniosków

| ID | Źródło + symbol (orientacyjne linie) | Potwierdzono | Nie dowodzi |
|---|---|---|---|
| D01 | Git HEAD / merge-base / diff base..HEAD | Baza planu jest przodkiem o 2 commity; lokalny master wskazuje nowy SHA | Bieżącego remote bez fetch. |
| D02 | `crates/fullmag-authoring/src/scene.rs` — `SceneDocument` (14), `SceneStudyState` (290), `Transform3D` (165), `SceneEditorState` (567) | Szeroki model i editor w tym samym dokumencie | Że każdy ruch kamery uruchamia PUT/solve. |
| D03 | `crates/fullmag-authoring/src/builder.rs` — `StudyPipelineDocument`, `StudyPrimitiveStageKind`, `StudyMacroStageKind` | Primitive/macro/group; ParameterSweep jest macro | Pełnej realizacji każdej opcji. |
| D04 | `crates/fullmag-authoring/src/region_revisions.rs` — `RegionRealizationImpact`, `classify_region_realization_impact` | Osobne topology/membership/coefficients/initial-state impacts | Wszystkich przyszłych zależności cache. |
| D05 | `crates/fullmag-cli/src/scratch_runtime.rs` — `spawn`/`run`, `render_current_scene`, `spawn_attached_runtime` (137–152,421–468) | Scene ownership i script/spawn branch | Każdej ścieżki uruchamiania ani latency. |
| D06 | `apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx` — `WorkspaceStartupGateView` (594–616); `WorkspaceShellClient.tsx` | Globalny gate zastępuje children | Zaobserwowanej utraty kamery w tej sesji. |
| D07 | `apps/control-room/src/kernel/layout/ViewportTabHost.tsx` — `ViewportTabHost` (74–81); `apps/control-room/scripts/audit-viewport-main-tab-memory.mjs` — `assertInactiveTabObservation` | Active-only mounting i guard nieaktywnego 3D | Browser PASS bez wykonania audytu. |
| D08 | `crates/fullmag-session/src/store.rs` — `collect_live_refs`, `gc` (314–345); `cas.rs` — `CasStore::gc` (91–107) | Niepełny live set i bezpośredni sweep | Że usunięcie danych użytkownika nastąpiło. |
| D09 | `crates/fullmag-cli/src/args.rs` — `SessionSubcommand::Gc` (142–147); `main.rs` obsługa Gc (467–471) | Publiczne wywołanie GC bez preview/apply | Żadnego wykonanego GC w tym audycie. |
| D10 | `crates/fullmag-session/src/capture.rs` — `capture_checkpoint` (62–116); `types.rs` — `TensorDescriptor::new_f64` | Descriptor nie wiąże zapisanych chunks; aux hash porzucony | Pełnego zakresu szkody dla każdego eksportu. |
| D11 | `crates/fullmag-session/src/fms.rs` — `plan_cas_entries` (205–239); `crates/fullmag-api/src/session_persistence.rs` — `read_checkpoint_magnetization` (2802–2814) | Eksport CAS wybiera descriptor refs, restore oczekuje common-state blob | Poprawnego roundtripu rzeczywistego pola. |
| D12 | `crates/fullmag-session/src/store.rs` — `commit_checkpoint`, `list_checkpoints`, `atomic_write` (114–164,351–357); `cas.rs::put` (28–47) | Manifest przed common state; brak jawnego sync_all | Power-loss guarantee albo zaobserwowanej awarii. |
| D13 | `crates/fullmag-session/src/store.rs` — `try_lock`, `unlock`, `is_pid_alive` (273–309,385–405); `types.rs::SessionFileLock` | PID/host fields, nieatomowa sekwencja, unlock bez owner tokena | Produkcyjnego enforcement; caller search nie wykazał podłączenia locka do wszystkich writerów. |
| D14 | `crates/fullmag-session/src/fms.rs` — `preflight_fms`, `unpack_fms` (636–667,942–956); `store.rs` — `commit_session`, `write_document` (53–63,210–216) | Niezwalidowany content ID trafia do ścieżki writer-a | Przeprowadzonego ataku; to source-level luka do regression check. |
| D15 | `crates/fullmag-runner/src/eigen/artifacts/common.rs` — `FrequencyDomainResourceIndex`, `eigen_mode_field_resource_key`; `field_sweep.rs`; `fmr.rs`; `modal_manifest.rs` | Trwałe resource keys i placeholdery current/run:current | Odzyskiwalnego prawdziwego RunId z każdego starego pliku. |
| D16 | `crates/fullmag-runner/src/fem/eigen_output.rs`, `eigen_path_manifest.rs`, `eigen_sweep.rs` — generatory manifestów | Ta sama klasa powiązań sesyjnych również w FEM | Równego zakresu kwalifikacji CPU/GPU. |
| D17 | `apps/control-room/src/kernel/api/generated/openapi-v2.json::paths`; `crates/fullmag-api/src/router_v2/handlers` adnotacje `path` | Unique 246/239 current; annotations 293/288 current | Pełnej zgodności live router ↔ schema bez regeneracji/testu. |
| D18 | `apps/control-room/src/kernel/resources/sessionResourceIdentity.ts` — `SessionResourceIdentity`, `sessionScopedResourceKey`; `ResourceRuntimeStore.ts` | SessionId/epoch namespace, dedup/retry i revision-based resource lifecycle | Fencing workera ani durable accepted state. |
| D19 | `apps/control-room/src/modules/results-navigator/ResultsNavigatorModule.tsx`, `ResultDatasetBrowser.tsx`; `kernel/resources/studyRuntimeResources.ts` | Results i sweep resources już istnieją | Trwałego CAE SolutionSet bez current. |
| D20 | `apps/control-room/src/modules/footer` — `FooterModule`, `MeshJobsPanel`, `FooterTelemetry` | Częściowy progress/log/job UI | Uniwersalnego durable Task modelu. |
| D21 | `crates/fullmag-api/src/types.rs` — command queue/cache/ledger (160–168,1435–1453); `main.rs` (2452–2456,2872–2914) | In-memory command infrastructure | Recovery idempotency po restarcie. |
| D22 | `crates/fullmag-runner/src/solver_runtime/engine.rs` — `FdmEngine`; `selection.rs`; `solvers/fdm/execute.rs` | CPU reference/CUDA dispatch w aktualnych źródłach | Uzgodnionej authority CPU między dokumentami. |
| D23 | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` — `FdmSpinTransportWorkflow::commit/rollback`; `fem/relax/preview.rs`; `types.rs` — accepted-state revision | Lokalne mechanizmy candidate/accepted/revisions | Pełnego ADR-0025 i globalnego publication protocol. |
| D24 | `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-ir/src/plan.rs`, `fullmag-runner/src/native_fem/runtime_info.rs`, `capabilities.rs`, `backends/fem/CMakeLists.txt` | Osobne demag strategies, ślady FK i capability-reporting do uzgodnienia | Qualified FK GPU/CPU z samego kodu. |
| D25 | `crates/fullmag-session/src/types.rs` — `SaveProfile`, `RestoreClass`, `FmsSessionManifest`, `TensorDescriptor`, `TensorChunk` | Profiles, run_refs, compatibility i real dtypes | Bezstratnego nowego formatu ani complex convention w każdym consumerze. |
| D26 | `crates/fullmag-quantities/src/lib.rs`, `catalog.rs`, `descriptor.rs`, `eval.rs`, `registry.rs` | Istniejący quantity owner | Implementacji każdego proposed derived evaluator. |
| D27 | `packages/fullmag-py/src/fullmag/world.py` — `_WorldState` / `_state`; `model/problem.py` | Obecny flat context i cache/materialization kontrakty | Bezpiecznej wieloprojektowości albo tezy „każdy constructor mesh’uje”. |

## 4. ADR: status i sposób wykorzystania wszystkich 35 plików

To rejestr relacji planu, nie deklaracja wykonania wszystkich ADR. Statusy odczytano z nagłówków. Pogłębione uzgodnienie dotyczy granic bezpośrednio zmienianych: 0009/0010, 0011, 0016, 0025, 0029, 0030 i backend authority. Pozostałe pozycje wyznaczają constraints dla implementacji; szczegółowy review ich dotkniętych sekcji pozostaje bramką konkretnego pakietu.

`A` = accepted; `AI` = accepted for implementation; `P` = proposed; `AM` = accepted for active migration only. Polskiego statusu ADR-0026 nie reinterpretujemy jako runtime qualification. Pełne nazwy plików rozstrzygają zduplikowane numery 0019, 0021 i 0023.

| ADR / plik | Status | Relacja i obowiązek planu |
|---|---|---|
| [0001 physics-first Python](../../../../adr/0001-physics-first-python-api.md) | A | Konsumowany K15/P2; jeden DSL/IR, bez GUI-only semantics. |
| [0002 container-first](../../../../adr/0002-container-first-monorepo.md) | A | Zachowany; managed execution i packaging P8. |
| [0003 STNO FDM-only](../../../../adr/0003-stno-v1-fdm-only.md) | A | Zachować ograniczenia capability; nie promować do FEM przez wspólny formularz. |
| [0004 quantities](../../../../adr/0004-backend-canonical-quantities.md) | A | Konsumowany P6/B-OBS; jeden katalog wielkości. |
| [0005 docking](../../../../adr/0005-stable-docking-layout-lifecycle.md) | A | Konsumowany P1/P6; layout trwały, surface resources zwalniane. |
| [0006 selection/focus](../../../../adr/0006-selection-is-not-focus.md) | A | Zachowany w WorkspaceContext i drzewie. |
| [0007 camera/manipulation](../../../../adr/0007-viewport-camera-manipulate-modes.md) | A | Zachowany P2/P6; ViewDocument nie łączy focus z selection. |
| [0008 Inspector](../../../../adr/0008-inspector-draft-apply-transaction.md) | A | Rozszerzyć P2 o pending forms/Compute i projektowy Undo. |
| [0009 geometry/mesh](../../../../adr/0009-geometry-invalidates-mesh.md) | A | Zachować invalidation matrix. Scoped amendment przed P4: jawne Compute+PreparationPlan może zlecić mesh; żaden GET/Apply nie auto-build. Manual-only zachowany. |
| [0010 magnetization/mesh](../../../../adr/0010-magnetization-does-not-invalidate-mesh.md) | A | Konsumowany; default no remesh i jawne zależności recipe dla wyjątków. |
| [0011 resource-first](../../../../adr/0011-resource-first-api.md) | A | Scoped amendment API identity przed P1/P3a; HTTP owner, thin JSON/binary data i WS invalidation bez zmian. |
| [0012 canonicalization](../../../../adr/0012-canonicalization-backbone.md) | A | Konsumowany P2; AST/units mają wspólną deterministyczną normalizację. |
| [0013 module kernel](../../../../adr/0013-frontend-v2-module-kernel.md) | P | Wykorzystać istniejący kernel i wiążące reguły frontend; ten plan nie zmienia statusu ADR. |
| [0014 native FEM](../../../../adr/0014-native-fem-backend-modularization.md) | P | Materiał dla B-FEM; aktualny backend masterplan/reguły pozostają authority. |
| [0015 cutover governance](../../../../adr/0015-frontend-v2-migration-governance-boundary.md) | AM | Konsumowany P8; legacy cleanup tylko według wykazanych consumers. |
| [0016 active viewport](../../../../adr/0016-center-viewport-tabbed-surfaces.md) | A | Zachowany; odrzucenie hidden persistent canvases. |
| [0017 antenna basis](../../../../adr/0017-staged-antenna-field-basis-workflow.md) | P | Zachować definicje/porty i jawny support; brak automatycznej kwalifikacji workflow. |
| [0018 relaxation](../../../../adr/0018-algorithm-specific-relaxation-contract.md) | A | Konsumowany B-WORKFLOW/P7; stop criteria właściwe dla algorytmu. |
| [0019 regional drive/time](../../../../adr/0019-regional-field-drive-and-stage-time-semantics.md) | A | Konsumowany steering/checkpoint/ports; stage/global time niezmienione przez refaktor. |
| [0019 transport/SOT](../../../../adr/0019-spin-transport-and-prescribed-sot-semantics.md) | P | Zachować granicę prescribed vs solved; macierz źródeł/realizacji bez promocji. |
| [0020 planar monitor](../../../../adr/0020-planar-field-map-and-monitor.md) | A | Konsumowany P6; online monitor odrębny od historycznego przekroju. |
| [0021 crossover](../../../../adr/0021-fem-runtime-crossover-policy.md) | AI | Zachować requested intent i jawny resolved policy; brak GPU fallbacku. |
| [0021 mixed P1](../../../../adr/0021-native-mixed-p1-fem-topology.md) | A | Konsumowany P4/B-FEM; zachować topology certificates i istniejący zakres FE order. |
| [0022 live/analysis](../../../../adr/0022-live-charts-analysis-boundary.md) | A | Konsumowany P6; bounded online history, analiza jawna. |
| [0023 physical sweep](../../../../adr/0023-physical-bias-sweep-and-frequency-domain-analysis-boundary.md) | A | Konsumowany P7; fizyczny sweep nie jest tylko przeliczeniem wykresu. |
| [0023 results explorer](../../../../adr/0023-physics-first-results-explorer.md) | A | Konsumowany P6; rozszerzyć istniejący Results, nie budować drugi. |
| [0024 object model](../../../../adr/0024-compositional-physics-object-model.md) | A | Zachować immutable object_id, name/type i explicit physics; nazwa nie aktywuje modułu. |
| [0025 persistent runtime](../../../../adr/0025-persistent-runtime-and-observation-sources.md) | A | Konsumować AcceptedStateRef i D09. Scoped amendment D07: Open dokumentu bez runtime, jawny RestoreRuntime z candidate/swap. Scope lease/residency jawny. |
| [0026 Frozen Spins](../../../../adr/0026-frozen-spins-constraint-and-selection-model.md) | zaakceptowany projekt implementacyjny | Konsumowany P2/B-STATE; capture/activation/constraints we wszystkich dotkniętych lane’ach. |
| [0027 mesh policy](../../../../adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md) | AI | Zachować Python→IR→mesh receipts i quality; kontrakt nie oznacza wykonanej kwalifikacji. |
| [0028 FDM precision](../../../../adr/0028-fdm-cuda-precision-policy.md) | AI | Konsumowany B-FDM/P8; requested/resolved/executed, double/single gates. |
| [0029 dataset/slice](../../../../adr/0029-analysis-result-dataset-and-slice-selection.md) | AI | Rozszerzyć P6 o receptury bez zmiany immutable dataset/sample/item identity. |
| [0030 project storage](../../../../adr/0030-project-storage-and-build-concurrency.md) | AI | Doprecyzować terminologię CAE Project vs build project; root/resolver/queue bez zmiany. Hostowe ścieżki z `.env`, nie z historycznych przykładów ADR. |
| [0031 runner UI](../../../../adr/0031-runner-observability-storage-ui.md) | AI | Build-runner UI pozostaje własnym bounded context; nie mylić z nowym scientific coordinator. Zachować auth i partial/stale statuses. |
| [0033 hostowy Save projektu](../../../../adr/0033-project-document-host-save-bridge.md) | AI | Nowy most Tauri dla hostowego Open/Save; jeden application/repository writer, bytes-only web, ProjectId/revision i jawna durability. Fizyczny desktop smoke pozostaje gate'em. |

Nie nadajemy automatycznie nowych numerów 0032–0049. Część ADR-CAE opisuje istniejące decyzje i wymaga konsumpcji lub scoped amendment, nie 18 nowych dokumentów. Bramka P0-D wybiera minimalny zestaw zmian normatywnych z ownerem i odpowiednimi testami.

## 5. Rozliczenie ADR-CAE-01–18

| ID wejściowy | Decyzja finalna | Relacja |
|---|---|---|
| ADR-CAE-01 | Project root jako dokument CAE | Rozszerzenie 0011/0030; P1. |
| ADR-CAE-02 | Jedna semantyka authoring/IR | Konsumpcja 0001/0012; P2. |
| ADR-CAE-03 | Scena jako projekcja | Rozszerzenie 0024 + granice authoring. |
| ADR-CAE-04 | Parametry/feature graph | Rozszerzenie 0012/0009; typed support. |
| ADR-CAE-05 | Study/config/profile odrębne | Rozszerzenie 0018/0021 crossover/0028. |
| ADR-CAE-06 | Immutable run i bound dependencies | Konsumpcja 0025 + durable journal. |
| ADR-CAE-07 | Steering jako eksperyment | Konsumpcja 0019 regional time/0025/0026. |
| ADR-CAE-08 | Cztery grafy i typed ports | Nowa kompozycja istniejących kontraktów, bez uniwersalnego graph engine. |
| ADR-CAE-09 | Scientific assessment odrębne | Konsumpcja relaxation/capability contracts. |
| ADR-CAE-10 | Jeden viewport/context | 0016 pozostaje w mocy; ViewDocument poza rendererem. |
| ADR-CAE-11 | Dataset/plot niezależne od live | Konsumpcja 0020/0022/0023 results/0029. |
| ADR-CAE-12 | `.fms`/CAS reuse | 0025 D07 scoped amendment + P0 storage safety. |
| ADR-CAE-13 | Application kernel i worker protocol | Nowa bounded biblioteka; nie nowy solver ani build runner. |
| ADR-CAE-14 | Project-scoped API | Amendment 0011/spec/instructions, etapowy adapter z removal gate. |
| ADR-CAE-15 | Fingerprint/certified invalidation | Konsumpcja 0009/0010/0027, bez zastąpienia region revisions. |
| ADR-CAE-16 | Four-lane receipts | Konsumpcja backend masterplan/precision/capabilities. |
| ADR-CAE-17 | Incomplete save | Rozszerzenie Inspector/storage/Python contracts; draft nie trafia do IR. |
| ADR-CAE-18 | Trust boundary | P0-F/P1/P8; Open nie wykonuje kodu, ID i namespace walidowane osobno. |

## 6. Źródła zewnętrzne i ich ograniczony zakres

Sprawdzone 20.09.2026:

- [COMSOL Model Builder](https://www.comsol.com/comsol-multiphysics/model-builder) — sekwencje geometrii, parametry/selekcje oraz przepływ danych między studies; wzorzec funkcjonalny, nie dowód implementacji Fullmag.
- [CST Electromagnetic Systems Modeling](https://www.3ds.com/products/simulia/cst-studio-suite/electromagnetic-systems-modeling) — kontekst systemowego łączenia analiz; bez wnioskowania o wewnętrznym schedulerze.
- [Rust File::sync_all](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_all) — dokumentacja bariery synchronizacji pliku; sama ta metoda nie ustanawia pełnego wieloplikowego protokołu commit ani gwarancji każdego filesystemu.

Nie przejmujemy rankingów „lepsze niż COMSOL”, twierdzeń że konkurencja nie ma danej funkcji, liczb VRAM/latency ani domniemanej architektury CAD. Nauka Fullmaga jest opisywana przez własne canonical notes/source maps, a kwalifikowana przez pomiary i referencje w przyszłych etapach.

## 7. Kontrola dokumentów finalnych

Weryfikacja końcowa obejmuje pliki Markdown pakietu finalnego i podkatalogów, lokalne linki, spójność CAE-01–70 i FINAL-01–18, zakres K01–K18 i P0–P8 oraz zachowanie materiałów wejściowych. Kontrola rewalidacyjna 21.09.2026 obejmuje 29 plików Markdown i 115 lokalnych odnośników:

| Kontrola dokumentacji | Wynik |
|---|---|
| Pliki i lokalne odnośniki | 29 plików, 115 sprawdzonych odnośników, brak brakujących lokalnych linków. |
| Scenariusze | 70 unikalnych CAE w kolejności i 18 FINAL; wszystkie 60 bazowych zachowane. |
| Materiały wejściowe | 18 zapisanych hashy zgodnych z bieżącymi bajtami plików; tracked materiały bazowe/Gemini bez diff. |
| ADR inventory | Linki pokrywają wszystkie 35 aktualnych plików, także zduplikowane numery. |
| Struktura Markdown | Zrównoważone fences; brak nierozwiązanych markerów i znaków zastępczych kodowania. |
| Git scope | Nowy `final/`; istniejące dirty submoduły i niewersjonowany raport Claude zachowane. Bez staging/commit. |

To kontrole dokumentacji, nie wyniki testów aplikacji. Przeglądy niezależnych zakresów i finalny review korygowały m.in. metryki API, capture/export reachability, lifecycle viewportu oraz rozdział source evidence od runtime qualification.
