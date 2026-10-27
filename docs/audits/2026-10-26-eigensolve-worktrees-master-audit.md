# Audyt worktree eigensolve i integracji z masterem

Data: 26.10.2026. Zakres: stan Git, kodu i zachowanych deklaracji dowodów; bez buildów, testów, Solve, publikacji, merge i sprzątania.

## Werdykt

**Nie wszystkie ważne zmiany są na masterze.** Fundament FEM K0/Floquet, publiczny DSL/IR, artefakty i podstawowy interfejs są zintegrowane. Pozostały jednak dwie duże, rozbieżne linie implementacji, starsze poprawki K0 wymagające uzgodnienia oraz niezacommitowany WIP. Wdrożenie jest na etapie **istniejących ograniczonych ścieżek ze starszymi dowodami wykonania oraz dalszej remediacji/integracji**, nie zamkniętej kwalifikacji produkcyjnej.

Najistotniejsze ustalenia:

1. PR [#97](https://github.com/MateuszZelent/fullmag/pull/97) został scalony 13.10.2026 o 22:23:01 UTC jako `911902d6d545d1471c77290eedef1a1b6937fb62`. Historyczna treść checkpointu zachowana w opisie PR nadal mówi „Nie scalono PR do mastera”; aktualne pole `merged=true` i graf Git mają pierwszeństwo. Późniejszy tip tego samego brancha **nie jest** scalony.
2. `eigensolve-dispersion-plan-20260912`: 238 commitów poza historią mastera, w tym 237 niemerge; dodatkowo **40 zmienionych plików working tree względem indeksu, poza commitem**. Zmiany dotyczą także operatorów, capability i artefaktów, nie tylko dokumentacji.
3. `dispersion-mode-ui-20261008`: 97 commitów poza historią mastera, w tym 96 niemerge. Nazwa „UI” nie oddaje zakresu: są tu poprawki native K0, walidacji, worker identity i dzienników admission.
4. Historyczne worktree WSL `eigensolve-k0-demag`, `eigensolve-master-integration`, `eigensolve-master-rescue` i stara finalizacja K0 mają tipy w historii mastera. Nie są tym samym stanem co późniejsza finalizacja K0 w checkoutcie Windows.
5. Integracja kodu nie zamyka pełnego okna Γ, serial/adaptive parity, zbieżności filmu i airboxu, COMSOL A1, produkcyjnego modal GPU ani browser/WebGL/FMS. Te bramki pozostają otwarte lub nieweryfikowane dla bieżącego mastera.

## Punkt odniesienia i metoda

W chwili sprawdzania oba lokalne mastery (Windows i WSL), lokalne `origin/master` oraz zdalny GitHub master wskazywały:

`1afcb531630d6cd5b8caba1f8a4d4593bb29cdb7`

Zdalny stan sprawdzono przez GitHub connector, bez fetch/pull. [Commit bazowy audytu](https://github.com/MateuszZelent/fullmag/commit/1afcb531630d6cd5b8caba1f8a4d4593bb29cdb7).

Odczytano rejestry Git obu repozytoriów, katalogi worktree, tematy commitów poza masterem, związane refy i operatorowe rekordy w `E:\git\storage\index`. Rejestr operatorowy jest wskazówką: część wpisów zatrzymała się na wcześniejszych HEAD i nie odpowiada bieżącemu Git. Przykładowo wpis dyspersji wskazuje `4334e971…`, a aktualny tip to `9063e52c…`.

Rozróżniono:

- ancestry: czy commit jest przodkiem mastera;
- `git cherry`: identyczność pojedynczego patcha, z pominięciem merge commitów;
- obecność i semantykę kodu: squash, późniejszy refaktor lub inna implementacja mogą realizować poprawkę mimo odmiennego patch-id;
- HEAD, index i working tree: push brancha nie obejmuje niezacommitowanych zmian;
- deklaracje historycznych testów i runtime od świeżego dowodu dla aktualnego SHA.

`git status` i pełny diff na Windows/9p nie zakończyły się w ograniczonym czasie. Natywny Windows Git zwrócił `UtilBindVsockAnyPort: socket failed 1`. Zastosowano odczyt indeksów Git v2, porównanie blob SHA-1 plików z indeksem z uwzględnieniem CRLF, porównanie indeksu z drzewem HEAD i inwentaryzację `rg --files --hidden` respektującą ignore. Nie podążano za symlinkami ani submodułami; ignorowane cache/wyniki nie są częścią inwentaryzacji WIP. To ograniczenie jest jawne w załączniku.

Nie wolno interpretować oznaczeń `prunable` dla `C:/...` z linuxowego `git worktree list` jako dowodu usunięcia katalogu: te ścieżki sprawdzono po mapowaniu do `/mnt/c/...` i istnieją. Dla dawnych ścieżek WSL brak katalogu potwierdzono osobno; niezapisanej pracy na niedostępnym mountcie nie da się wykluczyć.

## Worktree Windows

Ścieżki poniżej są względem `C:\git\fullmag\worktrees`. Pełne hashe i listy commitów/pliki zawiera sąsiedni plik JSON. „Ahead” oznacza różnicę grafu, nie liczbę gotowych do cherry-picku zmian.

| Worktree / branch | HEAD | Ahead / behind master | Ocena |
|---|---|---:|---|
| `eigensolve-dispersion-plan-20260912` / `codex/eigensolve-dispersion-plan-20260912` | `9063e52cbdeb5d805bd23da7703ea7c582548fc8` | 238 / 458 | Główna późniejsza remediacja. 237 patch-unique commitów; 40 plików WIP; brak staged. |
| `dispersion-mode-ui-20261008` / `codex/dispersion-mode-ui-20261008` | `f0ad762b599bef2d48e41dbd9bb64c8e38aabf6a` | 97 / 2301 | Osobna linia backend/API/UI i kwalifikacji; 96 patch-unique commitów. Odczytane pliki zgodne z indeksem i HEAD. |
| `eigensolve-k0-finalization` / `codex/eigensolve-k0-finalization-20260829` | `ecdbbc6fd7c23fe6748b5351b44509b7072451b8` | 1 / 3461 | Jeden duży checkpoint: 98 plików, +14648/-473. Nie jest scalony jako commit. 981 brakujących plików wyłącznie `_to_delete_legacy_web`; pozostałe sprawdzone pliki zgodne z indeksem. |
| `k0-exchange-only-diagnosis` / `codex/k0-exchange-only-diagnosis-20260901` | `93e1ca38423ddb661a21c76b05bb02bfaf5c9826` | 2 / 3664 | Merge i `f0986ede…` z poprawką exact Γ. WIP tylko `.gitignore`. Historyczne rozwiązanie trzeba uzgodnić z późniejszym kodem, nie scalać w ciemno. |
| `k0-remediation-s00-20260910` / `codex/k0-production-remediation-20260910` | `999e6b287d95e9e5f85ddccbcb2c1d87ef7d1297` | 49 / 3465 | 48 patch-unique commitów i merge; 4 pliki WIP; brak staged. Kontynuacja wykracza daleko poza scalony baseline S00. |
| `sphinx-physics-audit-20261005` / `codex/sphinx-physics-audit-20261005` | `563ca90165add23b20bcc2ada64f7b45e036f15b` | 5 / 3002 | Część opublikowano PR #133; pozostaje 128 zmienionych plików wstrzymanego audytu, brak staged. Sam brak ancestry pięciu commitów nie oznacza braku opublikowanej części. |
| `multi-project-hpc-r2-20261005` / `codex/multi-project-hpc-r2-20261005` | `3219d4d810b5028209ceb433eb380d9ddd93cd7d` | 29 / 2967 | Powiązana linia HPC: poza masterem są commity ordered FEM eigen path fan-in i bounded case map. 86 plików zmienionych i 7 nieśledzonych; brak staged. Nie jest głównym solverem eigensolve. |

Nie należy sumować ahead różnych branchy jako liczby niezależnych brakujących zmian. Duże gałęzie dyspersji mają wspólny merge-base `1195663c67943cb57f6716bdd73639d9fe917e4f`, ale żadna nie zastępuje w całości drugiej. Ich integracja wymaga uzgodnienia nakładających się kontraktów.

## Stare worktree WSL i refy bez aktywnego katalogu

Główne repo: `/home/kkingstoun/git/fullmag/fullmag`.

| Worktree | HEAD | Ahead / behind | Stan |
|---|---|---:|---|
| `.worktrees/eigensolve-k0-demag-recovery` | `24ca296fbb5dbb312d154f2b2cf667de026006ed` | 0 / 4783 | Commit na masterze, katalog niedostępny. |
| `/mnt/fullmag-zfn2-native/worktrees/eigensolve-k0-finalization-20260829` | `5e5849c8acf8ec0f80c0f463fc5d9109ea9a4e14` | 0 / 3851 | Stary etap na masterze; nie jest późniejszym Windows `ecdbbc6f…`. Katalog niedostępny. |
| `/mnt/fullmag-zfn2-native/worktrees/eigensolve-master-integration` | `d9518082eaee2131c3e7160bd8ae952ed2f45899` | 0 / 4476 | Zintegrowany tip, katalog niedostępny. |
| `/tmp/fullmag-eigensolve-master-rescue` | `bc5ca20f67645145fa0a9c3250fd9d905ed4e135` | 0 / 4345 | Zintegrowany lokalny tip, katalog niedostępny. |

Dodatkowe zachowane refy:

- `origin/codex/eigensolve-master-rescue` = `e587df3c5ade76026346cc36671fc885a9d95d18`: jeden późniejszy commit audytu poza masterem (`docs/audits/eigensolve-master-rescue-cpu-gpu-fem-audit.md`).
- `origin/codex/fem-k0-deep-audit-20260829` = `e69733a0d7f7fcab62aa9a043d4a80df4e9cdb63`: 14 commitów audytu/planu poza masterem, historyczny werdykt NO-GO. Jest materiałem do ponownej oceny, nie dowodem aktualnego błędu każdego późniejszego solvera.
- `codex/k0-remediation-s00-20260910` / remote = `9c4b2bfc3aaac7e616357d80ad4f940648f65609`: dokumentacyjny baseline S00 jest na masterze; nie utożsamiać go z późniejszym `codex/k0-production-remediation-20260910`.
- Dokumentacja eigensolve/LLG z PR [#170](https://github.com/MateuszZelent/fullmag/pull/170) została scalona 14.10.2026 jako `81a49c3f08da2b97054cb02c006babe2dbc7403c`; rejestr wskazuje zakończone sprzątanie jej worktree.

- `origin/codex/fem-mesh-helper-modal-20261014` = `e6f18c03d87e3f6e28b51a3fad3ef20435269f3a`: tip jest na masterze (0 ahead / 985 behind).

## Co już jest na masterze

| Obszar | Obecna implementacja / źródło | Granica dowodu |
|---|---|---|
| Publiczny model | `packages/fullmag-py/src/fullmag/model/eigen.py`, walidacja `eigenmodes` w `crates/fullmag-ir/src/lib.rs`; frequency-window, k-sampling i intent | Obecność DSL/IR nie dowodzi każdej kombinacji runtime. |
| FEM CPU K0 | Native Poisson-airbox, `assemble_native_magnetic_a_qq` w `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`; ścieżki PETSc/SLEPc i window | Ograniczony zakres materiałów/mesh/BC, brak pełnej kwalifikacji okna i wszystkich skal. |
| FEM CPU nonzero-k | Capability dispatch w `crates/fullmag-runner/src/fem/eigen_capability.rs`; Floquet modal w `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` i `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.*` | Istnieje dynamiczny demag-k i zespolone pola; nie ma blanket claimu kompletnego widma i dowolnej geometrii. |
| Artefakty i requested/resolved/validation | `crates/fullmag-runner/src/fem/eigen_native_window.rs` publikuje `implementation_state`, `validation_state`, `validated_scope`; manifesty, residuale, tożsamość modów | `executable` oraz `unvalidated` są odrębnymi stanami; `production_periodic_airbox_claim=false` nie może być przemilczane. |
| Multi-k i produkt | Orkiestracja puli k, eksport, podstawowe widoki dyspersji/modów oraz Inspector są już obecne | Późniejsze naprawy publikacji i UI są poza masterem; brak nowego browser proof w tym audycie. |
| FEM GPU K0 | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`, CUDA guards/telemetria | Nie promować wąskiej ścieżki K0 do produkcyjnego nonzero-k GPU. |
| Dokumentacja | PR #97, #133 i #170, noty 0600/0828/0831, ADR reprezentacji dyspersji, plan S00–S12 | Plan i opublikowana nota nie są receiptami bieżącego runtime. |

Historyczne raporty na masterze zawierają rzeczywiste próby CPU, m.in. runtime #231 i sześć prób DE +10/+25 rad/µm dla trzech zagęszczeń powietrza (`docs/raports/2026-10-04-de-air-matrix-runtime231.md`), oraz signed15 (`docs/raports/2026-10-04-de-signed15-runtime.md`). Odnotowane residuale 1,54e-11–2,48e-11 przy progu 1e-8 i trend zbieżności powietrza są wartościowymi dowodami ograniczonego przypadku. Okna pozostawały `not_certified`; nie jest to nowy pomiar dla `1afcb531…` ani zakończenie zbieżności filmu/paddingu.

## Istotne rzeczy poza masterem

### Główna gałąź dyspersji

Potwierdzona odrębna implementacja obejmuje m.in.:

- native P1 tracking mass: `backends/fem/cpu/frequency_domain/modal/tracking_mass_provider.{cpp,hpp}`, `backends/fem/src/frequency_domain/tracking_mass_snapshot.{cpp,stub.cpp}` i kontrakty ABI; commit `2976b2bdd806ec197e5b2ed9a93dc58dc73a78dd`;
- dalszą pracę nad dokładną topologią warstw, zamrożonym body i powietrzem oraz integralnością map/artefaktów;
- naprawy API/Results/viewport i kontekstów właściciela wyniku;
- dużą domieszkę zmian Docker/runner/ledger — 238 ahead nie jest wyłącznie 238 poprawkami solvera.

**40 plików WIP** obejmuje `poisson_airbox_shared_domain.{cpp,hpp}`, `eigen_capability.rs`, `eigen_execution.rs`, `eigen_projection.rs`, `eigen_reduction.rs`, `eigen_shared_domain.rs`, manifesty/path artifacts, Inspector dyspersji/gałęzi/kompozycji modów, Results Navigator, projekcję viewportu, chart models, noty i walidator COMSOL. Pełna lista z hashami jest w JSON. Ta część nie jest w HEAD brancha i wymaga osobnego review oraz zachowania przed integracją.

### Konkretny lokalny WIP poprawności — wysoki priorytet

Porównanie symboli i konsumentów wykazało istotne różnice, których nie wolno zgubić przy scalaniu:

- `eigen_projection.rs::project_complex_mode_to_tangent_basis`: master nadal rozdziela `Re(a)e1` i `Im(a)e2`; lokalna poprawka rekonstruuje zespolony mod, zachowując polaryzację i globalną fazę.
- Lokalny `expand_reference_mode_to_periodic_nodes` wraz z wywołaniem w `eigen_execution.rs` odtwarza węzły periodyczne; symbolu nie ma na masterze.
- Lokalny `eigen_reduction.rs::validate_materialized_tangent_frame_transport` kontroluje transport baz po materializacji równowagi; nie ma go na masterze.
- Guardy nonzero-k obejmują lokalnie otwarte osie, mieszane składowe k, pusty wybór par Floqueta i identyfikatory; poprawki manifestów usuwają fałszywe deklaracje dynamic-demag.
- Master ma tetrahedralny `ConsistentP1TrackingMetric` w `eigen_path.rs`; nowy provider/snapshot native P1 jest poza masterem. **Nawet na branchu integracja provider → produkcyjny tracking pozostaje otwarta.**

Źródło statusu WIP: początkowe checkpointy w worktree `docs/superpowers/plans/2026-09-12-eigensolve-dispersion-implementation-status.md` (sekcje dotyczące mixed topology, rekonstrukcji, guardów i provenance). Zapisane regresje nie były skompilowane ani wykonane; build, runtime, GPU, seamy i kwalifikacja naukowa są tam jawnie `NOT VERIFIED`. To kandydaci do naprawy i walidacji, nie już potwierdzone rozwiązanie.

### Gałąź dispersion-mode-ui

Poza masterem znajdują się m.in.:

- `DispersionModeAction`, `EigenModePhaseControls`, `DispersionAxisControls`, `EigenModeInspectorModel`, `dispersionChartAxes`, `frequencyAxisPresentation` i `scripts/verify_dispersion_mode_ui.mjs`;
- `crates/fullmag-runner/src/fem/eigen_worker_identity_publication.rs`: publikacja zweryfikowanych parent identities (`fde6516e95aa9f20e578c827448b256e4ecafc04`);
- trwałe terminal admission journals (`f0ad762b599bef2d48e41dbd9bb64c8e38aabf6a`);
- walidator signed15 serial/adaptive campaign evidence (`57e531848bb8904e8e76552a90e2142ed00c8d89`);
- hash binding opcjonalnych natywnych artefaktów (`4ea3da4ebda4288233c9a7c3c78899b848753474`);
- import równowagi przez granicę Γ/Floquet (`8ea04862f2630f0e7d55988ed7ebe6d6b798e227`);
- rozdzielenie budżetu wyszukiwania K0 od liczby fizycznych modów (`f0f2930815c00514317b0d9917a0b150511af948`) i odzyskiwanie bezpiecznego wyczerpania iteracji EPS (`13d9d71f6f365768038dd27e73af037f28b64255`).

Dodatkowe porównanie konsumentów potwierdza:

- master ma prywatny best-effort `AdmissionJournalGuard` zapisujący `admission-journal.v1.json`, ale nie publikację `eigen/admission_journal.v1.json` i jego dokładnych bajtów jako dowodu kampanii;
- w masterze brak `eigen_equilibrium_boundary_import.rs` i `publish_worker_identity`;
- w masterze brak readera `frequency_domain_owner.rs::{PublishedOwner,read_owner,resolve_owner}` z bindingiem ownera manifest/metadata;
- master posiada już `load_spectrum_v3_modes(..., verified_bytes=...)` w `scripts/validate_de_smoke_rows.py`; benchmark mastera waliduje wymagane artefakty, ale nie późniejszą pętlę hash-binding opcjonalnego `spectrum.v3`, parallel execution i admission journal;
- plan `docs/superpowers/plans/2026-10-08-dispersion-mode-ui.md` na branchu uznaje U1–U6 za demonstrator, a U7/integrację za blocked. Audyt `docs/audits/2026-10-15-signed15-parity-publication-audit.md` oddziela istniejący serial15 od niewykazanego adaptive parity i pozostawia świeży sweep po poprawkach jako `NOT VERIFIED`.

To istotne poprawki poprawności i provenance. Ich obecność na branchu nie zastępuje kwalifikacji ani nie uzasadnia automatycznego merge wszystkich 97 commitów.

### Starsze K0 i dokumentacja

Cztery dokumenty bazowego S00 (baseline Markdown, ledger JSON, patch inventory i plan remediation) zostały porównane z masterem i są zgodne. To dowód integracji baseline, nie późniejszych zmian solvera.

Finalizacja `ecdbbc6f…` łączy solver Schur, equilibrium/handoff/sweep, exact-layer meshing, walidatory i historyczny Windows build executor. Współczesny master zmienił część tych obszarów i ma inną codzienną ścieżkę Docker DEV. Nie wolno przywrócić starego launchera jako skutku integracji fizyki. Checkpoint sam nie deklaruje wykonania buildów/testów ani kwalifikacji runtime/GPU. Poza masterem są także `_exact_layer_periodic_tet4.py` i osobne dokumenty starego Windows executora; współczesny meshing/launcher trzeba uzgodnić semantycznie. Historyczny rejestr wskazuje niewykonane bramki x34 thickness/mesh; remediation pozostawia Q1/Q2/Q3/R10. Ich nowa realizacja musi użyć obecnych zarządzanych recept, nie automatycznie starej procedury.

Remediation `999e6b28…` zawiera m.in. exact shifted Schur factorization/cache (`3a8a75dc…`, `97e7c08b…`), propagację niekompletności widma przez producenta, manifest i API oraz tolerancje demagu i obsługę Neumanna. Cztery pliki WIP to audyt K0, `docs/physics/0800-fem-static-pbc-demag.md`, `scripts/local_runner/build_entrypoint.py` i jego test. Część zachowań ma już późniejsze odpowiedniki na masterze; wymagają porównania kontraktów, nie hurtowego cherry-picku.

### Powiązany HPC i wstrzymany audyt Sphinx

W `multi-project-hpc-r2-20261005` commity `710abd52b1148efce5788564022bed80724b948a` i `326637a9ea6b1e29b5e71638d5b08d59ed9f3e9d` dodają bounded case map i ordered fan-in w `eigen_path_cases.rs` oraz orkiestratorze. Lokalny WIP obejmuje także `eigen_equilibrium_contract.rs`, `eigen_path.rs`, `eigen_path_cases.rs` i nowy nieśledzony `crates/fullmag-application/src/study_eigen_path_case_artifact.rs`. To dodatkowa linia integracji wykonania, wymagająca uzgodnienia z obecnym schedulerem i artefaktami. Nie wolno uznać jej za zabezpieczoną wyłącznie przez commit brancha.

128 lokalnych zmian Sphinx nie oznacza 128 brakujących funkcji solvera. Część treści mogła zostać zastąpiona dokumentacją z #170. Pozostaje porównanie semantyczne tej nieopublikowanej części, a nie automatyczny merge starego tekstu.

## Co nadal nie jest zamknięte

| Realizacja | Stan audytowy |
|---|---|
| FDM CPU | Brak natywnego modal eigensolvera w zakresie tej funkcji; dynamika/FFT nie jest jego zamiennikiem. |
| FDM GPU | Analogicznie: nie kwalifikować eigensolve na podstawie time-domain CUDA. |
| FEM CPU | K0 i Floquet mają implementacje i ograniczone historyczne runtime evidence. Pełne window/completeness, Γ, zbieżność, skale i COMSOL wymagają domknięcia. |
| FEM GPU | Wąskie K0 i eksperymentalne ścieżki istnieją. `gpu_device_krylov.hpp` ma `production_loop_available=false`; `modal_krylov.cu` ogranicza claim przez `validation_only=true` / `production_implication=false`. Brak produkcyjnego nonzero-k modal GPU. |

Otwarte bramki:

1. Jeden przypięty build i wspólna kampania Γ + signed15 na aktualnym kodzie, bez mieszania źródeł i receiptów.
2. Pełne okno częstotliwości, rozróżnienie znalezionych modów od certyfikowanej kompletności, kontrola true/full residual.
3. Serial/adaptive parity, admission, zasoby CPU/RAM, anulowanie i trwałość publikacji workerów.
4. Zbieżność filmu, airboxu, paddingu, liczby modów; tracking i porównanie COMSOL A1 (61 próbek/8 pasm).
5. S09: produkcyjny provider/routing MFEM 2.5D; typy i guardy nie są zakończonym solverem.
6. Exact damping oraz pełny zakres interakcji/BC tylko po właściwych capability i naukowych dowodach.
7. Modal GPU: wykonanie, residency, skalowanie i CPU/GPU parity dla deklarowanego zakresu; driven-response GPU nie jest takim dowodem.
8. API/FMS/eksport/ponowny odczyt oraz rzeczywisty browser/WebGL dla modów, kompozycji i Inspectorów.

Readiness matrix `25_frequency_domain_readiness_matrix.json` ma `as_of=2026-08-05` i `runtime_revalidated_in_this_update=false`. Jest historyczną projekcją zakresów; nie wolno ani traktować jej jako świeżego PASS, ani wyciągać z niej wniosku, że późniejsze implementacje nie istnieją. Również stare wpisy masterplanu o ABI/bundlach wymagają interpretacji razem z bieżącym kodem.

## Zalecana kolejność dalszej pracy

1. Zachować i zreviewować WIP dyspersji oraz dokumentacji; ustalić właściciela i aktualny checkpoint każdej linii. Nie kasować worktree.
2. Zbudować selektywną mapę integracji: tracking mass/topologia, worker identity/journals, solver/window, API/UI, walidacja. Oddzielić przestarzałe build/runner zmiany od aktualnego kontraktu Docker DEV.
3. Dla starszego K0 uzgodnić każdy istotny fix z obecnym odpowiednikiem. Najpierw guards/provenance/completeness, następnie numerics; nie traktować samego patch-id jako dowodu semantycznego braku.
4. Zintegrować spójne zmiany przez kontrolowany PR i wymagane review/CI. Dopiero na wynikowym SHA wykonać dozwolone managed bramki runtime/nauki/browser.
5. Zaktualizować rejestry i readiness na podstawie nowych dowodów. Cleanup dopiero po potwierdzeniu integracji, czystości i braku aktywnych właścicieli/mountów.

Ten audyt nie autoryzuje ani nie wykonuje integracji, restartów, usuwania worktree lub danych. Zakaz kompilowania testów jednostkowych zachowano. Nie wykonano nowych testów solvera, builda ani symulacji.

## Załącznik dowodowy

[Pełna inwentaryzacja JSON](2026-10-26-eigensolve-worktrees-master-audit.evidence.json) zawiera wszystkie odczytane wpisy Windows worktree, wybrane refy i worktree WSL, pełne hashe, listy patch-unique commitów, aktualny WIP z hashami plików, porównanie staged oraz skrócone rekordy operatorowe.

## Kontrola audytu

Wykonano niezależne review treści względem źródeł. Skorygowano rozróżnienie historycznego wykonania od świeżego runtime, prywatnego admission journal od publicznego artefaktu i istniejącej walidacji spectrum.v3 od brakującego optional hash-binding. Końcowa kontrola obejmuje parser JSON, hashe WIP, spójność tabel z dowodami oraz link do załącznika; nie jest testem solvera.
