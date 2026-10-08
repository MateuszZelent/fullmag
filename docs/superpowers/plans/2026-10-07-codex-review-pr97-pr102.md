# Rozpatrzenie uwag Codex Review — PR #97 i #102

## Zakres i stan

Pełny rejestr obejmuje 259 komentarzy liniowych Codex oraz jedną dodatkową uwagę w treści review (ID5440044234) w PR #97. Wszystkie pobrano stronicowanym API. PR #102 nie zawiera sugestii do kodu od Codex; komentarze o limitach i podsumowania nie są żądaniami implementacji.

PR #102 zamknięto 2026-10-07, zachowując remote branch `codex/launcher-instance-isolation-20261002` przy `954ba797307c4cc773772d380123893210cfa447`. PR #97 pozostaje otwarty do ukończenia rozpatrzenia i uzasadnionych poprawek. Merge ani usuwanie branchy nie są częścią polecenia zamknięcia PR-ów. Wcześniejszy WIP meshing zachowany osobno.

Stan rejestru: `already_fixed`: 23, `duplicate`: 89, `implemented`: 64, `implemented_pending_ci`: 10, `not_actionable`: 2, `unsupported_recommendation`: 3, `valid_unfixed`: 69. Łącznie 260 wpisów; wszystkie wpisy oceniono; zasadnych nienaprawionych i brakujących bramek nie uznaje się za zakończone.

Legenda: `pending` — nierozpatrzona; `valid_unfixed` — zasadna, nie naprawiona; `already_fixed` — poprawka potwierdzona aktualnym kodem; `duplicate` — powtórzenie; `unsupported_recommendation` — konkretna rekomendacja nie odpowiada kontraktowi; `implemented` — poprawka z potwierdzoną regresją CI; `implemented_pending_ci` — poprawka przygotowana, regresja oczekuje CI; `implemented_pending_browser` — pokrywające CI przeszło, nadal wymaga celowanego dowodu z przeglądarki; `not_actionable` — uwaga zastąpiona późniejszą jawną decyzją użytkownika.

## Wszystkie uwagi

| ID / PR | Plik | Rozstrzygnięcie | Uzasadnienie |
|---|---|---|---|
| [4060116218](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116218) / #97 | `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp` | valid_unfixed | Realifikacja daje q oraz i*q; przekazanie tylko N spośród 2N może nieodwracalnie usunąć wyższą gałąź. |
| [4060116229](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116229) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | implemented | Spójny próg airbox i blokada kwalifikacji przy failed check |
| [4060116236](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116236) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | implemented | Zwykły wynik free_modes/frequency_response odrzucany jest przez odpowiadający mu subview mimo zgodnej rodziny wykresu. |
| [4060116242](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116242) / #97 | `packages/fullmag-py/src/fullmag/world.py` | valid_unfixed | Python waliduje scope i emituje go w eigen_spectrum, ale aktywny OutputIR::EigenSpectrum ma tylko quantity. Python→ProblemIR traci rozróżnienie global/per_sample; planner i runner widzą ten sam wariant. |
| [4060116248](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116248) / #97 | `scripts/local_runner/container_main.py` | already_fixed | health zwraca sorted(self.allowed_profiles), a submit waliduje tę samą skonfigurowaną allow-listę. |
| [4060116253](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116253) / #97 | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | implemented_pending_ci | Walidacja k jest uzależniona od predykatu, który sam ukrywa NaN. Dotyczy bezpośredniej granicy ABI; publiczny runner może odrzucić wcześniej. |
| [4060116262](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116262) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | implemented_pending_ci | Bieżący adapter przekazuje cancel_requested/user_data; owner Floqueta instaluje EPS stopping test, odpytuje callback przed próbą i retry oraz zachowuje one-shot cancellation. EPS_CONVERGED_USER jest przerwaniem, nie dowodem zbieżności. |
| [4060116271](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116271) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | valid_unfixed | Obie ścieżki wymagają serializacji runtime, ale blokady nie współdzielą granicy; oba używają PETSc/SLEPc globalnej inicjalizacji. |
| [4060116277](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116277) / #97 | `scripts/run_fem_cpu_slepc_modal_contract.sh` | implemented_pending_ci | Exact CMake target path oraz SHA256/size prywatnej i runtime biblioteki muszą być identyczne. Loader każdego CTest wymaga private FEM; runtime dlopen osobno jawny. Pre/post sprawdzenie i trwała atestacja są bramką pass, bez kopiowania runtime. |
| [4060116283](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116283) / #97 | `packages/fullmag-py/src/fullmag/world.py` | implemented | indices, branches, sample_indices i sample_labels są konwertowane przez `tuple(value or ())`. Dla wieloelementowej numpy.ndarray test prawdziwości rzuca ValueError przed walidacją SaveMode; dla np.array([0]) selektor jest potraktowany jak pusty. |
| [4060116295](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116295) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | implemented | Gmsh operuje w micrometrach, jakość jest wyliczana przed konwersją, a zwrócone węzły są dzielone przez 1e6. volume_min/max/mean/std i element_volume są przekazywane bez przeliczenia i pozostają w µm³, czyli są zawyżone względem SI o 1e18; to samo dotyczy per_domain_quality. |
| [4060116302](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116302) / #97 | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | duplicate | Ta sama luka strict validation co w komentarzu #4061684303: exact-cell ring nie woła validate_strict, a asset_pipeline wyklucza single_geometry_geo_ring z _drop_degenerate_tetrahedra. Nie znaleziono późniejszego wspólnego walidatora dla tej gałęzi. Powtórzenie 4061684303. |
| [4060116309](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116309) / #97 | `crates/fullmag-plan/src/validate.rs` | implemented | Walidacja ogólna dopuszcza branches i sample_selector bez kontroli KSampling::Path; dispatch single-k i requested_mode_indices_for_result konsumują tylko indeksy. |
| [4060116318](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116318) / #97 | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | duplicate | Ta sama utrata konfiguracji outputów per stage co w #4061684295. Renderer wybiera pierwszy stage z outputami i emituje jego save globalnie; _render_outputs jest wywołane tylko raz, przed renderowaniem stage'y. Powtórzenie 4061684295. |
| [4060116330](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116330) / #97 | `scripts/run_comsol_dispersion_benchmark.py` | implemented | docker image inspect jest wywołane bez timeout i funkcja przechwytuje tylko OSError; zawieszony Docker może trzymać build_lock bez końca. |
| [4060116342](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116342) / #97 | `crates/fullmag-runner/src/eigen/tracking.rs` | implemented | Publikowane confidence jest równym scalar overlap; assignment score, fallback i subspace transport zachowane. Regresja rzeczywistego trackera do JSON/CSV. |
| [4060116349](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116349) / #97 | `crates/fullmag-runner/src/eigen/tracking_subspace.rs` | implemented | Nota0600 i komentarz opisują aktualną heurystykę 1e−6Hz +1e−4 względnie, zgodnie z0831 i kodem. Usunięto nieudowodnione zapewnienie o odstępie fizycznych pasm. Stałe/algorytm bez zmian; regression obejmuje kotwicę, próg i część urojoną. |
| [4060116354](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116354) / #97 | `tests/standard_problems/mumag/comsol_nonzero_k_dispersion/materialize_real_asset.py` | implemented | Odrzucony benchmark mesh daje overall summary/receipt failed i exit1. Udana serializacja zachowuje materialization_statuspassed, artefakty i rejection reasons; progów nie zmieniono. |
| [4060116361](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116361) / #97 | `backends/fem/CMakeLists.txt` | implemented | Komentarz nad kodem deklaruje odrzucenie stubu, lecz faktyczne wyszukiwanie go dopuszcza. P1 oryginału niepoparte katastrofą produkcyjną; P2 dla build/runtime contracts. |
| [4060116372](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116372) / #97 | `apps/runner-console/src/views/StorageView.js` | already_fixed | Backend ma per-hub _resources_scan_lock i cache publication po skanie. Równoległe HTTP requests/retries współdzielą jeden pełny scan, więc zgłoszone mnożenie rekursywnych skanów jest naprawione. Krótki UI timeout to odrębne #4061898648. |
| [4060116379](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060116379) / #97 | `scripts/local_runner/build_entrypoint.py` | duplicate | Ten sam hard-coded release timeline dla runtime_only/contract receipts co #4106577193. Powtórzenie 4106577193. |
| [4060687814](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687814) / #97 | `apps/control-room/src/modules/field-map/FieldMapModule.tsx` | already_fixed | Aktualny HEAD ma retencję klatki oraz regresję identity-scoped; zgłoszone pending refresh nie odmontowuje już PlanarSurface. |
| [4060687822](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687822) / #97 | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | valid_unfixed | Algebraiczny kontrprzykład: M=diag(1,100), a=(10,1), b=(10,-1): a^T M b=0, overlap Euclidean=99/101>0.9. To dowodzi niewłaściwej metryki, nie runtime wystąpienia w konkretnym benchmarku. Kopie do overlap są normalizowane, lecz obecny kod 1400-1402 zachowuje oryginalną wspólną skalę q/phi. |
| [4060687829](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687829) / #97 | `scripts/run_comsol_dispersion_benchmark.py` | implemented | Dry-run bierze Path(args.output_dir) i buduje Compose plan bez _new_output_dir; zwykła ścieżka waliduje containment/canonical storage. |
| [4060687834](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687834) / #97 | `packages/fullmag-py/src/fullmag/world.py` | already_fixed | Obecny HEAD serializuje wszystkie trzy pola solver policy w stage draft i przenosi je do SceneDocument. test_scratch_authoring_ui_roundtrip.py:212-263 sprawdza import, draft i ponowny export z zachowaniem limitów. |
| [4060687842](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687842) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | valid_unfixed | overlap_values filtruje published_mode_ids z union spectrum i field; tracking IDs są pomijane. |
| [4060687853](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687853) / #97 | `crates/fullmag-runner/src/dispatch.rs` | already_fixed | Final state pochodzi z ostatniej zaakceptowanej magnetyzacji albo handoffu; pierwotny brak poprawiono. initial_magnetization nadal opisuje stan wejściowy planu, co samo nie dowodzi zgłoszonego błędu końcowego stanu. |
| [4060687861](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687861) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | already_fixed | Wszyscy trzej aktualni producenci zapisują wymagane ID; obecny parser je zachowuje. |
| [4060687869](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687869) / #97 | `scripts/comsol_modal_field_certificate.py` | implemented | Dowolny metadata_path jest odczytywany bez containment względem case_dir; _file_record zapisuje path absolutny, gdy relative_to(case_dir) nie działa. |
| [4060687877](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687877) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | implemented | numeric bundle files bound to declared run root |
| [4060687890](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4060687890) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | implemented | complete case set independent of ordering |
| [4061061284](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061061284) / #97 | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | already_fixed | Bieżące oba admission helpers akceptują certified_shared_domain przy wskaźniku operatora. Nie zmieniać markerów na ślepo. |
| [4061061288](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061061288) / #97 | `crates/fullmag-ir/src/lib.rs` | already_fixed | Aktualny ProblemIR::validate uwzględnia EigenDiagnostics w has_diagnostics_output; planner akceptuje i kopiuje jawne wyjścia. Historyczny diagnostics-only test przeszedł. Nowa zmiana 3ec16da01 poprawia wyłącznie nieaktualny tekst błędu i rozszerza kontrolę mixed/illegal outputs; semantyki nie zmieniono. |
| [4061061294](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061061294) / #97 | `crates/fullmag-runner/src/eigen/output_selection.rs` | valid_unfixed | Pattern odczytuje tylko include_tracking; inne flagi nie są przenoszone do selekcji/writera. |
| [4061061301](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061061301) / #97 | `apps/runner-console/browser-smoke.cjs` | implemented | Smoke kolejki rozwiązuje Playwright z istniejącego workspace Control Room; zachowuje jawne override i używa bundlowanego Chromium/os.tmpdir zamiast prywatnych ścieżek hosta. |
| [4061061308](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061061308) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | valid_unfixed | To odrębny entrypoint od generic SLEPc, ten sam mechanizm utraty gałęzi. |
| [4061061315](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061061315) / #97 | `crates/fullmag-runner/src/eigen/output_selection.rs` | valid_unfixed | Quantity walidowane tylko jako niepusty string; selektor scala EigenSpectrum w bool. |
| [4061061322](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061061322) / #97 | `apps/runner-console/src/api.js` | valid_unfixed | createRetentionPlan dziedziczy globalny 15s timeout; długi serwerowy scan może kontynuować po abort klienta, a ręczne ponowienie może utworzyć kolejny plan. |
| [4061061326](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061061326) / #97 | `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` | implemented | Native production bez validation wpada do analytic_comparison tokenu. |
| [4061343690](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061343690) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | implemented | Zwykły wynik free_modes/frequency_response odrzucany jest przez odpowiadający mu subview mimo zgodnej rodziny wykresu. Powtórzenie 4060116236. |
| [4061343698](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061343698) / #97 | `backends/fem/include/frequency_domain/mode_kinematics.hpp` | valid_unfixed | Założenie benchmarku o najmniejszej interesującej częstotliwości nie jest kontraktem publicznego eigensolvera. |
| [4061343703](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061343703) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | implemented | Obie trasy ring zwracają nowy MeshData z ponownie certyfikowanymi końcowymi współrzędnymi SI. Nie kopiują certyfikatu µm, nie mutują frozen input; błąd walidacji blokuje publikację kandydata. |
| [4061343714](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061343714) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | implemented | Spójny próg airbox i blokada kwalifikacji przy failed check |
| [4061343721](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061343721) / #97 | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | valid_unfixed | Dla q=2 oryginalne K/G mają 4 wpisy i n=2, demag ma 16. Adapter n nie zmienia się. |
| [4061343735](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061343735) / #97 | `backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp` | already_fixed | Obecny C_q transportuje lokalną bazę i sprawdza ortonormalność, a mismatched m odrzuca. |
| [4061343743](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061343743) / #97 | `scripts/local_runner/container_main.py` | duplicate | Powtarza allow_profiles health mismatch z #4060116248; obecny HEAD zwraca skonfigurowaną allow-listę. Powtórzenie 4060116248. |
| [4061684269](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684269) / #97 | `scripts/compare_de_100nm_pilot.py` | implemented | Comparator wiąże dokładne bajty dispersion.csv z contained path, size i SHA256 run-result. Te same bajty trafiają do walidatora naukowego, parsera i hasha raportu; companion artifacts i fizyka nie są kwalifikowane tą poprawką. |
| [4061684277](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684277) / #97 | `scripts/run_de_100nm_pilot.py` | already_fixed | subprocess.run ma host watchdog, TimeoutExpired jest obsługiwany, a finally uruchamia cleanup po timeout/niezerowym wyniku. |
| [4061684283](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684283) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | implemented | Serial i adaptivebootstrap checkpointują raw bytes przedCompleted admission. Cancelled/Paused wracają typedterminal z ostatnią zaakceptowaną równowagą i fullprovenance, Failed pozostajeErr, brakkolejnejpróbki/promocji. OptionalNone-root zachowuje safe nonaccepted rawdiagnosticclosure. |
| [4061684290](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684290) / #97 | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | implemented | Result.status=status może Cancelled, completion bierze literal Completed. |
| [4061684295](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684295) / #97 | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | valid_unfixed | Gdy bazowe study nie ma outputów, renderer bierze pierwszy stage z outputami i emituje save przed wszystkimi stage'ami. Brak wywołań _render_outputs wewnątrz _render_stages oznacza, że późniejsze outputy znikają, a wcześniejsze stają się retroaktywnie aktywne. |
| [4061684299](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684299) / #97 | `crates/fullmag-session/src/reachability.rs` | valid_unfixed | Walidator wiąże session/run i trzy dokumenty, nie persisted.artifacts. Nowy inspect_live_snapshot skanuje CAS/ref keys, nie zwykłe artifact paths. |
| [4061684303](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684303) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | valid_unfixed | Exact-cell ring buduje MeshData i zwraca ją bez validate_strict(require_positive_orientation=True). Wspólna ścieżka _drop_degenerate_tetrahedra jest pomijana dla single_geometry_geo_ring, a wcześniejsza strict validation dotyczy wyłącznie conformal OCC attempts. Zerowy lub ujemny Jacobian może przejść dalej. |
| [4061684310](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684310) / #97 | `packages/fullmag-py/src/fullmag/world.py` | duplicate | Powtarza utratę spectrum_scope opisaną w #4060116242: Python emituje scope, ale OutputIR nie ma odpowiadającego pola. Powtórzenie 4060116242. |
| [4061684318](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061684318) / #97 | `scripts/compare_de_100nm_pilot.py` | duplicate | Ten sam brak hash bindingu wejściowego dispersion.csv co #4061684269. Powtórzenie 4061684269. |
| [4061898639](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898639) / #97 | `apps/control-room/src/modules/field-map/FieldMapModule.tsx` | duplicate | Aktualny HEAD ma retencję klatki oraz regresję identity-scoped; zgłoszone pending refresh nie odmontowuje już PlanarSurface. Powtórzenie 4060687814. |
| [4061898643](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898643) / #97 | `backends/fem/cpu/frequency_domain/floquet_waveguide_demag_k.cpp` | implemented | Końcowe L już zawiera przyszłe row swaps; nie wolno używać go do eliminacji przed zastosowaniem kompletu permutacji RHS. SPD reproducer do przyszłego testu: A=[[4,1,2],[1,1,3],[2,3,10]], b=[7,5,15], oczekiwane x=[1,1,1]; drugi pivot zamienia wiersze 1/2. Nie uruchamiano kodu. |
| [4061898648](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898648) / #97 | `apps/runner-console/src/views/StorageView.js` | valid_unfixed | Resources GET ma 7s timeout. Serwerowy single-flight zapobiega drugiemu scanowi, ale dłuższy prawidłowy scan nadal kończy się UI error i nie publikuje inventory do widoku. |
| [4061898655](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898655) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | already_fixed | Metric używa wszystkich physical magnetic nodes z dodatnim volume, a nie representatives; adapter bierze node_indices tej metryki. |
| [4061898659](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898659) / #97 | `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs` | valid_unfixed | Caller bumpuje revision i zwalnia lock; synchronizer zmienia demand bez nowej revision. |
| [4061898663](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898663) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | A1 nie wymaga geometrii otworu ani zweryfikowanego magnetycznego support; require_uniform_slab stosuje się tylko do C1. |
| [4061898669](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898669) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | Brak wymaganej kontroli A1 ±k w mapie checks oraz brak ładowania hash-bound ujemnego k. |
| [4061898673](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898673) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | Certyfikat nadal odczytuje pola magnetyczne; brak odczytu i kontroli pełnego potencjału. |
| [4061898678](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898678) / #97 | `scripts/local_runner/build_entrypoint.py` | duplicate | Receipt contract-* stages nie są mapowane przez ten sam hard-coded release timeline opisany w #4106577193. Powtórzenie 4106577193. |
| [4061898685](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4061898685) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | Weryfikacja equilibrium jest ograniczona do ścieżki KS; nie jest wspólną bramką wszystkich primary case. |
| [4069106586](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106586) / #97 | `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp` | duplicate | Ten sam obecny entrypoint i przyczyna jak 4060116218. Powtórzenie 4060116218. |
| [4069106589](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106589) / #97 | `crates/fullmag-ir/src/lib.rs` | duplicate | Pattern odczytuje tylko include_tracking; inne flagi nie są przenoszone do selekcji/writera. Powtórzenie 4061061294. |
| [4069106593](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106593) / #97 | `apps/runner-console/src/views/StorageView.js` | already_fixed | loadStorageData zwraca istniejący storageLoadPromise przed zwiększeniem generation. Kolejny polling update nie superseduje requestu, a embedded view ma ten sam guard. |
| [4069106604](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106604) / #97 | `crates/fullmag-runner/src/fem/eigen_execution.rs` | valid_unfixed | emit progress z ? daje RunError na Stop/Pause; return result literal Completed. |
| [4069106608](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106608) / #97 | `crates/fullmag-ir/src/lib.rs` | duplicate | Walidacja ogólna dopuszcza branches i sample_selector bez kontroli KSampling::Path; dispatch single-k i requested_mode_indices_for_result konsumują tylko indeksy. Powtórzenie 4060116309. |
| [4069106611](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106611) / #97 | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | valid_unfixed | Oba JSONy pozostają validation_error. Dodatkowo provider_status==ok z brakującym ready wynikiem nie może dawać enum ok. |
| [4069106616](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106616) / #97 | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | already_fixed | Aktualny API akceptuje trwałe mode_field_id bez transport key; results sprawdza mode_field_available=false. Zgłoszone 500 z obu-identyfikatorów nie obowiązuje. |
| [4069106619](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106619) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | already_fixed | Na wskazanym HEAD outer_surfaces pochodzi z boundary połączonych body_volumes + air_volumes; wspólne magnet-air surfaces są jawnie wydzielane jako interface_surfaces, a komentarz przy linii 2075 wyjaśnia, że combined boundary je wyklucza. Gamma_out tworzone jest wyłącznie z outer_surfaces po odjęciu periodycznych powierzchni, więc bbox-owe poziome interfejsy nie trafiają do grupy zewnętrznej. |
| [4069106623](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106623) / #97 | `apps/runner-console/browser-smoke.cjs` | duplicate | Powtarza prywatne fallback paths z #4061061301. Powtórzenie 4061061301. |
| [4069106629](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4069106629) / #97 | `apps/runner-console/browser-smoke.cjs` | valid_unfixed | Smoke przełącza fixture na healthy przed wpisaniem tokenu. Healthy handler przyjmuje dowolne body i następne requesty nie sprawdzają Authorization, więc setToken propagation może być zepsuty, a test nadal przejdzie. |
| [4080421103](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080421103) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | duplicate | Powtórzenie 4060116262. Historyczny brak callbacku jest już poprawiony w źródłach: adapter i EPS stopping test; aktualna weryfikacja provider pozostaje pending przy uwadze głównej. |
| [4080421110](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080421110) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | control_samples to nadal 0,10,20,40,50,60 zamiast całej kwalifikowanej ścieżki. |
| [4080421116](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080421116) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | implemented | Zwykły wynik free_modes/frequency_response odrzucany jest przez odpowiadający mu subview mimo zgodnej rodziny wykresu. Powtórzenie 4060116236. |
| [4080421122](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080421122) / #97 | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | valid_unfixed | Brak Floquet sparse/model adapter rozpoznania; K0/ogólna lista pozostaje. Stary Floquet guard nie certyfikuje dynamic demag. |
| [4080421126](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080421126) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | already_fixed | Aktualny helper generuje zewnętrzne poziomy z krokiem h_inner, zwiększając go geometrycznie najwyżej do h_outer. Ekstruzja tworzy jeden element na każdy z tych krótkich przedziałów, a nie jeden element przez całą kilkumikrometrową szczelinę. Zgłoszony pojedynczy gruby element nie odpowiada kodowi obecnemu w HEAD. |
| [4080421130](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080421130) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | Porównania używają tego samego branch_id w niezależnych bundle bez fizycznego dopasowania cross-run. |
| [4080421133](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080421133) / #97 | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | valid_unfixed | Eksport physical potential bierze synthetic tracking outputs (wszystkie modes), nie public publication outputs. |
| [4080421140](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080421140) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | implemented | numeric bundle files bound to declared run root |
| [4080865441](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080865441) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | Sprawdzane są limity solvera, lecz primary count i pełne frequency window nie są związane z parameter sheet. |
| [4080865445](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080865445) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | duplicate | Wszyscy trzej aktualni producenci zapisują wymagane ID; obecny parser je zachowuje. Powtórzenie 4060687861. |
| [4080865453](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080865453) / #97 | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` | already_fixed | Usunięto wadliwy bbox heuristic. Mechaniczne zastąpienie go universal phase threshold również nie dowodzi conditioning; obecna polityka opiera się na operatorze. |
| [4080865455](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080865455) / #97 | `packages/fullmag-py/src/fullmag/world.py` | implemented | Ta sama regresja truthiness numpy.ndarray co w #4060116283, z dodatkowym przykładem singleton np.array([0]). Powtórzenie 4060116283. |
| [4080865461](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080865461) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | implemented | Spójny próg airbox i blokada kwalifikacji przy failed check |
| [4080865467](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080865467) / #97 | `crates/fullmag-api/src/session_persistence.rs` | duplicate | Walidator wiąże session/run i trzy dokumenty, nie persisted.artifacts. Nowy inspect_live_snapshot skanuje CAS/ref keys, nie zwykłe artifact paths. Powtórzenie 4061684299. |
| [4080865475](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4080865475) / #97 | `scripts/local_runner/container_main.py` | valid_unfixed | Application przechowuje allow-listę utworzoną przy starcie. configure zapisuje nową listę, ale start z istniejącym kontenerem jedynie go atestuje i zwraca; działający proces nadal odrzuca nowy profil. |
| [4081470332](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4081470332) / #97 | `apps/control-room/src/modules/field-map/FieldMapModule.tsx` | duplicate | Aktualny HEAD ma retencję klatki oraz regresję identity-scoped; zgłoszone pending refresh nie odmontowuje już PlanarSurface. Powtórzenie 4060687814. |
| [4081470349](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4081470349) / #97 | `backends/fem/CMakeLists.txt` | duplicate | Powtórzenie tego samego CMake defect. Powtórzenie 4060116361. |
| [4081470358](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4081470358) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | duplicate | Po native return nie sprawdza executed.result.status przed checkpoint/parsing; outer result zawsze Completed. Powtórzenie 4061684283. |
| [4081470369](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4081470369) / #97 | `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs` | duplicate | Caller bumpuje revision i zwalnia lock; synchronizer zmienia demand bez nowej revision. Powtórzenie 4061898659. |
| [4081470379](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4081470379) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | Mapa checks nie zawiera porównania zewnętrznego COMSOL A1 ani odpowiadającej mu hash-bound referencji. |
| [4081470388](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4081470388) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | already_fixed | Wymienione pola są obecnie aktualizowane w realnej pętli. |
| [4081470393](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4081470393) / #97 | `apps/runner-console/src/api.js` | duplicate | Ten sam domyślny 15s limit POST createRetentionPlan co #4061061322. Powtórzenie 4061061322. |
| [4081470410](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4081470410) / #97 | `crates/fullmag-runner/src/eigen/artifacts/kittel.rs` | valid_unfixed | validation_status=passed zależy tylko od frequency error; residual może None. |
| [4082209264](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209264) / #97 | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | duplicate | Ten sam dedup metric defect. Powtórzenie 4060687822. |
| [4082209270](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209270) / #97 | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | duplicate | Ten sam root cause co w #4061684295; przykład eigenmodes spectrum po którym frequency-response czyści outputy i ustawia response. Powtórzenie 4061684295. |
| [4082209278](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209278) / #97 | `crates/fullmag-runner/src/eigen/tracking_subspace.rs` | already_fixed | checked_mul(3)==vector_len już wymusza dokładnie 3 składowe na wagę. |
| [4082209284](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209284) / #97 | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | already_fixed | Helper preferuje point.tracking_edge.score_source; tracker nadaje ModalSubspaceTransportScore. |
| [4082209289](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209289) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | valid_unfixed | Dimensional fixed threshold runner/native jest niespójny. Nie mylić go z gamma gyromagnetic consistency tolerance. |
| [4082209300](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209300) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | Dowolny poprawnie parsowany override CSV jest używany jako expected path; brak zgodności z repozytoryjnym artefaktem. |
| [4082209310](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209310) / #97 | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | duplicate | Powtórzenie metryki dedup. Powtórzenie 4060687822. |
| [4082209319](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209319) / #97 | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | duplicate | Ten sam root cause co w #4061684295 dla SequenceStudy: fallback emituje outputy pierwszego stage globalnie i gubi późniejsze zestawy. Powtórzenie 4061684295. |
| [4082209324](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209324) / #97 | `crates/fullmag-runner/src/eigen/tracking_subspace.rs` | duplicate | checked_mul(3)==vector_len już wymusza dokładnie 3 składowe na wagę. Powtórzenie 4082209278. |
| [4082209334](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209334) / #97 | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | duplicate | Helper preferuje point.tracking_edge.score_source; tracker nadaje ModalSubspaceTransportScore. Powtórzenie 4082209284. |
| [4082209340](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209340) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | unsupported_recommendation | Sugerowany względny próg kGammaConsistencyRelativeTolerance dotyczy gyromagnetic Gamma, nie wavevector Gamma ani fazy. Bez skali ma niewłaściwą semantykę i jednostki. Rzeczywisty fixed k mismatch pozostaje valid 4082209289. |
| [4082209350](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209350) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | duplicate | Powtórzenie luki w kanoniczności k-path. Powtórzenie 4082209300. |
| [4082209360](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209360) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | duplicate | overlap_values filtruje published_mode_ids z union spectrum i field; tracking IDs są pomijane. Powtórzenie 4060687842. |
| [4082209371](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4082209371) / #97 | `backends/fem/include/frequency_domain/mode_kinematics.hpp` | duplicate | Ten sam globalny cutoff. Powtórzenie 4061343698. |
| [4105055173](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055173) / #97 | `packages/fullmag-py/src/fullmag/world.py` | implemented | Python obecnie umieszcza trzy solver fields w stage payloadzie, a osobny stage ProblemIR może mieć modal_solver_policy. Jednak pipeline base może być TimeEvolution, więc Problem.to_ir nie dodaje global modal_solver_policy (problem.py:2899-2907). Konsument materialize_pipeline_eigenmodes odczytuje count/target/BC i inne pola, ale nie czyta solver_rtol/max_outer/max_linear ani nie ustawia solver policy przy budowie StudyIR::Eigenmodes. Żądana polityka nadal ginie w aktywnym pipeline. |
| [4105055188](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055188) / #97 | `crates/fullmag-runner/src/fem/eigen_capability.rs` | implemented_pending_ci | Native dynamicdemag admission wymaga dokładnego niepustego requested/node/boundary pairID set; odrzuca subset/duplicates/unknown, orderindependent, zachowuje legacyboundary_pair_idfallback. Nie implementuje nowej semantyki wybiórczych par. |
| [4105055199](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055199) / #97 | `apps/runner-console/src/views/StorageView.js` | duplicate | Powtarza supersede przez global polling z #4069106593; guard storageLoadPromise jest już obecny. Powtórzenie 4069106593. |
| [4105055209](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055209) / #97 | `backends/fem/cpu/frequency_domain/floquet_waveguide_demag_k.cpp` | implemented | Przy reduced_phi=4096 jeden complex block=256MiB, budżet estymuje384MiB dla phi², ale dwie realne complex retention=512MiB; pozostałe struktury powiększają peak. |
| [4105055222](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055222) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | duplicate | Ta sama kwestia wewnętrznego magnet-air interface w Gamma_out co w #4069106619; obecny HEAD tworzy outer boundary z połączonej geometrii, więc zgłoszenie jest już naprawione. Powtórzenie 4069106619. |
| [4105055234](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055234) / #97 | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | duplicate | Eksport physical potential bierze synthetic tracking outputs (wszystkie modes), nie public publication outputs. Powtórzenie 4080421133. |
| [4105055246](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055246) / #97 | `crates/fullmag-ir/src/lib.rs` | duplicate | Walidacja ogólna dopuszcza branches i sample_selector bez kontroli KSampling::Path; dispatch single-k i requested_mode_indices_for_result konsumują tylko indeksy. Powtórzenie 4060116309. |
| [4105055258](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055258) / #97 | `backends/fem/cpu/frequency_domain/floquet_bloch_scalar.cpp` | already_fixed | Nie negować assemblera S: current owner transformuje jego kopię do A_phiq, a full-field operator zachowuje kanoniczne S. To poprawia i sparse, i dense convention. |
| [4105055268](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055268) / #97 | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | already_fixed | Binder używa planned_magnetostatic_bc(plan), funkcja rozróżnia Floquet airbox i K0. |
| [4105055280](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055280) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | valid_unfixed | Complete branches są sortowane po branch_id, a tylko pierwsza wybrana jest związana z lowest positive frequency. |
| [4105055286](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055286) / #97 | `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | duplicate | Brak Floquet sparse/model adapter rozpoznania; K0/ogólna lista pozostaje. Stary Floquet guard nie certyfikuje dynamic demag. Powtórzenie 4080421122. |
| [4105055294](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055294) / #97 | `crates/fullmag-ir/src/lib.rs` | duplicate | Allow-list zawiera tylko Spectrum/Mode/Dispersion, fallback nie uwzględnia Diagnostics. Powtórzenie 4061061288. |
| [4105055299](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4105055299) / #97 | `scripts/compare_comsol_a1_frequency_reference.py` | implemented | Pusty/whitespace residual opcjonalny jest None; porównanie pozostaje frequency_only_unqualified. Niepusty nonfinite,negative,invalid odrzucany. |
| [4106577136](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4106577136) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | implemented | Spójny próg airbox i blokada kwalifikacji przy failed check |
| [4106577156](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4106577156) / #97 | `apps/control-room/src/modules/field-map/FieldMapModule.tsx` | duplicate | Aktualny HEAD ma retencję klatki oraz regresję identity-scoped; zgłoszone pending refresh nie odmontowuje już PlanarSurface. Powtórzenie 4060687814. |
| [4106577193](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4106577193) / #97 | `scripts/local_runner/observability.py` | valid_unfixed | Timeline zawiera stałe native/frontend stages i mapuje tylko trzy release nazwy. runtime-only pozostawia pominięte frontend pending, a contract-* stages są całkiem pominięte lub udają native stage. |
| [4106577202](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4106577202) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | implemented | Zwykły wynik free_modes/frequency_response odrzucany jest przez odpowiadający mu subview mimo zgodnej rodziny wykresu. Powtórzenie 4060116236. |
| [4106577220](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4106577220) / #97 | `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` | implemented_pending_ci | Full path manifest requested_execution.outputs zawiera diagnostics dla rzeczywistego EigenDiagnostics; emptyoutputs nie deklaruje diagnostics. Nie zmienia selekcji publikowanych modów/flag writera. |
| [4106577229](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4106577229) / #97 | `packages/fullmag-py/src/fullmag/world.py` | duplicate | Powtarza problem utraconego spectrum_scope opisany w #4060116242. Powtórzenie 4060116242. |
| [4204074481](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074481) / #97 | `scripts/local_runner/ui_dist/src/views/StorageView.js` | valid_unfixed | ui_dist zawiera async plan polling/getRetentionPlan, ale source tworzy plan jednokrotnie i renderuje odpowiedź; source API nie ma singular getRetentionPlan. npm build usuwa ui_dist i kopiuje source, więc usuwa działające async flow. |
| [4204074486](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074486) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | implemented | complete case set independent of ordering |
| [4204074492](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074492) / #97 | `crates/fullmag-ir/src/study_v04.rs` | valid_unfixed | Walidator kończy po representation/BC/k_sampling, bez count/target/dynamics/output validators. |
| [4204074499](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074499) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | already_fixed | Aktualny parser odtwarza klucz zasobu z ID i nadal respektuje jawne mode_field_available=false. |
| [4204074508](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074508) / #97 | `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` | implemented | Data-bearing stale/error snapshot utrzymuje subscription identity; telemetry ujawnione tylko dla exactsession/epoch/run. Inny run czyści stare dane, refresherror pozostaje widoczny. |
| [4204074511](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074511) / #97 | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | implemented | Importedparallel_executionnull normalizowany do IRdefaultserial; fullobjectserialization i validnondefaultserialintent/limitvalidation zachowane. Nie dodano nowegoresetaction ani CPUdefaultchange. |
| [4204074518](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074518) / #97 | `crates/fullmag-runner/src/eigen/output_selection.rs` | duplicate | Pattern odczytuje tylko include_tracking; inne flagi nie są przenoszone do selekcji/writera. Powtórzenie 4061061294. |
| [4204074522](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074522) / #97 | `scripts/compare_comsol_a1_frequency_reference.py` | implemented | metadata.json SHA256 musi zgadzać się z receipt przed parsowaniem tych samych bajtów; tamper i brak hash failclosed, istniejący CSVhash zachowany. |
| [4204074530](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204074530) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | valid_unfixed | Per-field selection map istnieje, writer bierze wspólny field_mode_ids; field walidowany jedynie niepusty. |
| [4204614962](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204614962) / #97 | `apps/control-room/src/shared/analysis-charts/chartRenderer.ts` | implemented | Po przerwie dataIndex jest przesunięty względem source points i może wskazać niewłaściwy eigenmode. |
| [4204614972](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204614972) / #97 | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | implemented | Renderer dostaje stage_overrides i używa stage_override dla innych pól Eigenmodes, lecz solver rtol/max outer/max linear emituje wyłącznie z study.solver_policy. Zmiana draft override może więc zostać zapisana w UI i nie pojawić się w kanonicznym skrypcie. |
| [4204614978](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204614978) / #97 | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | valid_unfixed | Źródła potwierdzają O(mode_count*DOF) dublowany transport; nie podawać zmyślonego progu pamięci/crash. To wymaga spójnej zmiany ABI i Rust consumers, nie usunięcia pól formattera. |
| [4204614988](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204614988) / #97 | `crates/fullmag-runner/src/fem/eigen_k_pool.rs` | implemented_pending_ci | Odpowiedzi processpool są konsumowane; po wszystkich walidacjach i loadartifacts wektorfinalmag przenoszony, bez clone i zachowania całego zestawu processedresponses. Report zachowany. |
| [4204614998](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204614998) / #97 | `scripts/validate_serial_adaptive_probe.py` | implemented | Wholedeclaredrequiredartifactcatalog+5corefiles weryfikowane securestreaming size/SHA/canonical/noSymlink/fstat przedinterpretacją i po walidacji; reportthin count+catalogdigest. Optionalreportmissing zachowujeNOTVERIFIED. |
| [4204615004](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204615004) / #97 | `apps/control-room/src/kernel/resources/useSimulationPreparation.ts` | implemented | Wspólny loader zachowuje 404 jako błąd cache, a tylko widok opcjonalnego konsumenta mapuje dokładny początkowy unavailable404 na ready/null. Required consumer zachowuje błąd i powiadomienie niezależnie od kolejności inicjującego odbiorcy. |
| [4204615009](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204615009) / #97 | `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` | implemented | Loader nie dopuszcza obcego runu do ready cache i wykorzystuje bounded shared retry. |
| [4204615016](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204615016) / #97 | `crates/fullmag-runner/src/fem/eigen_k_pool.rs` | valid_unfixed | process_root/bootstrap stały, different bytes rejected. |
| [4204615025](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204615025) / #97 | `crates/fullmag-runner/src/fem/single_k_checkpoint.rs` | valid_unfixed | Pliki sync_all, hard-link marker i katalogi bez synchronizacji entries. Brak dowodu awarii zasilania; ograniczenie durability źródłowe. |
| [4204615031](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204615031) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | implemented | Analysis łączy nieśledzone próbki linią i sugeruje fałszywą ciągłość gałęzi. |
| [4204615036](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204615036) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | duplicate | Powtórzenie 4060116262. Historyczny brak callbacku jest już poprawiony w źródłach: adapter i EPS stopping test; aktualna weryfikacja provider pozostaje pending przy uwadze głównej. |
| [4204792243](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204792243) / #97 | `.github/workflows/bootstrap.yml` | not_actionable | Cargo unit tests pozostają w GHA, ale jawna decyzja użytkownika zezwala na testy tylko w GitHub Actions. Ta uwaga nie jest podstawą do usuwania CI. Lokalnie nie uruchomiono testów. Commit f0594581 dodaje również g++ regression test do GHA, co mieści się w tej zgodzie. |
| [4204792253](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204792253) / #97 | `crates/fullmag-api/src/session.rs` | valid_unfixed | Modal detection przez publiczne object_id fem_eigen_progress. |
| [4204792263](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204792263) / #97 | `scripts/diagnose_managed_fem_startup.py` | valid_unfixed | Diagnostic allow-list obejmuje runtime-v1 i runtime-v2, producer nadal emituje schema v1 dla v1, ale _load_job bezwarunkowo wymaga schema v2 przed uruchomieniem sond. |
| [4204792272](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4204792272) / #97 | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | valid_unfixed | Warunek box_layered_geo_direct wybiera route dla pojedynczego Boxa z thin_film_tetrahedral niezależnie od bocznego paddingu. Generator exact-cell wywołuje _coincident_ring_airbox_bounds i rzuca ValueError, gdy lateral bounds nie są zgodne; route przez OCC nie zostaje w tym przypadku użyty. |
| [4205039831](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205039831) / #97 | `scripts/local_runner/runtime_references.py` | valid_unfixed | Rozwiązanie artifact_root dopisuje wpis references, ale nie wywołuje protect; refs_for_job służy tylko fingerprintowi. Package trafia do raw candidates, a runtime_retention przekazuje te candidates dalej. |
| [4205039846](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205039846) / #97 | `scripts/run_de_frozen_v2_probe.py` | valid_unfixed | successful_process ustawia completed_unqualified niezależnie od artifact_error. Później artifact_validation/native_validation dostają failed i CLI zwraca 1, lecz result.status zostaje completed_unqualified. |
| [4205039857](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205039857) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | implemented | Akceptuje wyłącznie sample_0000, writer dostaje actual sample_index. |
| [4205039869](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205039869) / #97 | `apps/control-room/src/shared/domain/analysis/eigenResidualSummary.ts` | unsupported_recommendation | Komentarz miesza endpoint raw /analysis/eigen/modes z używanym przez Inspector /analysis/frequency-domain/eigen/modes, którego kontraktem jest koperta status/payload. |
| [5440044234](https://github.com/MateuszZelent/fullmag/pull/97#pullrequestreview-5440044234) / #97 | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | implemented | Zasadna uwaga: non-shared Bloch/Floquet oblicza Cancelled z interrupted, lecz completion nadal dostaje literal Completed. Dokładny duplikat uwagi inline 4061684290, zachowany dla kompletności review body. Powtórzenie 4061684290. |
| [4205406966](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205406966) / #97 | `scripts/validate_comsol_dispersion_scientific_gate.py` | duplicate | Powtarza #4106577136 (merged disposition: implemented). Na bieżącym HEAD końcowy predicate używa dla airbox tego samego warunkowego progu co obliczona zmienna tolerance, więc opisany false-fail dla różnicy 1e-3 nie występuje. Powtórzenie 4106577136. |
| [4205406974](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205406974) / #97 | `packages/fullmag-py/src/fullmag/runtime/scene_document.py` | implemented | Guard odrzuca nonzero rotated DMI z exchange_enabled=false niezależnie od PBC, mimo że builder i SceneDocument przenoszą PBC dalej. Planner dopuszcza w pełni periodyczny przypadek bez otwartej granicy; guard blokuje legalny round-trip przed planowaniem. |
| [4205406982](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205406982) / #97 | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | valid_unfixed | Adaptive validation sprawdza lane FEM CPU i limity, ale global draft nie przenosi etapów/workflow. commitGlobalDraft zapisuje wartość, którą runtime odrzuca m.in. dla FrequencyResponse, bias-field continuation i FEM bez eigen k-path. |
| [4205406986](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205406986) / #97 | `scripts/local_runner/source_compaction.py` | implemented | Po os.replace pliku źródłowego nie ma fsync jego katalogu. Receipt jest fsyncowany w innym katalogu, więc checkpoint lub completed może przetrwać awarię, podczas gdy zmieniony wpis katalogowy kapsuły nie. |
| [4205406991](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205406991) / #97 | `crates/fullmag-runner/src/fem/eigen_native_window.rs` | implemented | native_modal_artifacts dobiera dense_operator_payload po shift_invert bez rozróżnienia Floquet sparse Schur adaptera. Faktyczny adapter ma natywne sparse blocks; dense limitation fałszuje provenance. Nie wykazano rzeczywistego downstream rejection. |
| [4205406998](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205406998) / #97 | `crates/fullmag-ir/src/waveguide_mesh_bindings.rs` | valid_unfixed | Air binding odrzuca tylko magnetization modules, ignoruje material assignment i tworzy material_assignment=None. Ogólna walidacja sprawdza referencję i istnienie materiału, nie zabrania assignment do Air. |
| [4205652646](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205652646) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | duplicate | To samo dopuszczenie free_modes/fmr_modal dla modal-spectrum co #4106577202 (implemented_pending_ci_browser). Bieżący predykat już akceptuje obie wartości. Powtórzenie 4106577202. |
| [4205652663](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205652663) / #97 | `scripts/local_runner/container_main.py` | duplicate | Ta sama luka async polling UI co #4204074481 (valid_unfixed). Preview zwraca planning, apply wymaga preview, a klient robi POST raz i nie pobiera planu po ID. Powtórzenie 4204074481. |
| [4205652672](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205652672) / #97 | `scripts/local_runner/build_executor.py` | not_actionable | Modal-v1 rzeczywiście buduje i uruchamia CTest, ale ten profil nie jest wybierany automatycznie: domyślna allow-lista go pomija, enable_slepc_modal jest jawnym opt-in, enable_slepc_runtime_v2 dodaje wyłącznie runtime-v2, a submit wymaga dokładnego profilu z allow-listy. Jawny lokalny zakaz ogranicza działania agenta, nie systemowy kontrakt ani istniejące profile operatora; usuwanie modal-v1 byłoby sprzeczne z decyzją o zachowaniu profili. |
| [4205652678](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205652678) / #97 | `crates/fullmag-authoring/src/adapters.rs` | implemented | SceneStudy.pbc Option default scala brak pola i null; Rust adapter zawsze emituje pbc:null. Python renderer obecny override interpretuje jako reset, więc legacy scene sync usuwa istniejącą periodyczność. |
| [4205652689](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205652689) / #97 | `crates/fullmag-ir/src/study_v04.rs` | duplicate | Dokładny duplikat wcześniejszego braku pełnej semantycznej walidacji StudyIRV04. Aktualny walidator nadal kończy na representation/BC/k_sampling. Powtórzenie 4204074492. |
| [4205652698](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205652698) / #97 | `scripts/local_runner/archive_receipt.py` | valid_unfixed | Runtime retention usuwa outputs/.fullmag/local i zapisuje tombstone removed; execution-TTL cleanup nadal waliduje pierwotny build receipt wymagając istnienia/hash każdego artefaktu. Validator archiwum nie obsługuje tombstone, więc usunięty pakiet blokuje późniejsze usunięcie execution tree. |
| [4205652706](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205652706) / #97 | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | duplicate | Ta sama niepoprawiona przyczyna co 4060687822 oraz jego duplikaty 4082209264/4082209310: shared-domain Floquet przekazuje nullptr zamiast consistent sparse FEM mass metric do overlap-deduplikacji. Aktualny kod nadal zawiera jawny identity fallback. Mocny dowód to możliwość scalenia masowo ortogonalnych bliskich modów; nie trzeba opierać werdyktu na dodatkowej tezie o niescalonych powtórzeniach, której nie odtworzono. Powtórzenie 4060687822. |
| [4205652714](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205652714) / #97 | `apps/runner-console/src/views/QueueView.js` | implemented | Kolejne strony są pobierane po OFFSET na dynamicznym filtrze queue. Jeśli kolejka zmieni się między requestami, rekordy przesuną się względem OFFSET; pages jest przeliczane, a is_truncated pozostaje false, więc klient może pokazać niepełny snapshot jako kompletny. |
| [4205833370](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205833370) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | implemented | Parser spectrum.v2 modes[] nie odtwarza resource key z mode_field_id; przy available=true i brakującym jawnym key wylicza dostępność false, a konsument wymaga ID i key. To nie jest duplikat #4204074499: fallback jest obecny w parserach dispersion points/CSV, ale nie w gałęzi spectrum.v2. |
| [4205833375](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205833375) / #97 | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | implemented | Duplikat utraty trzech solver overrides etapu Eigenmodes opisanej w #4204614972 (valid_unfixed). Renderer używa stage_override dla pozostałych pól, ale politykę solvera emituje z study.solver_policy. Powtórzenie 4204614972. |
| [4205833381](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205833381) / #97 | `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.ts` | valid_unfixed | Resource store zachowuje dotychczasowe data ze statusem stale podczas refresh, ale Study Inspector odrzuca każdy status poza ready przed sprawdzeniem session/run identity. Last-good stage snapshot w obrębie tej samej sesji i runu jest przez to tracony. |
| [4205833384](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205833384) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | duplicate | Duplikat nieprzeskalowanych wolumenowych quality metrics w swept/ring, już sklasyfikowanych jako valid_unfixed pod #4060116295. Powtórzenie 4060116295. |
| [4205833390](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205833390) / #97 | `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` | duplicate | Duplikat wcześniej potwierdzonego pominięcia EigenDiagnostics w requested outputs manifestu. Aktualny builder nadal rozpoznaje spectrum/branches/dispersion/mode_fields. Powtórzenie 4106577220. |
| [4205833396](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4205833396) / #97 | `crates/fullmag-ir/src/validation.rs` | implemented | Migrator mapuje legacy object names na obj_name i remapuje inne owner refs, lecz w ogóle nie przepisuje object_regions. Nowa V04 walidacja wymaga owner_object istniejącego object_id. Python add_region bez explicit object_id emituje legacy name. |
| [4206379803](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206379803) / #97 | `apps/runner-console/src/views/StorageView.js` | duplicate | Ten sam nadal obecny timeout pełnej inwentaryzacji: GET resources ma7s i jedną próbę; error usuwa last-good. Single-flight serwera nie wydłuża oczekiwania klienta. Powtórzenie 4061898648. |
| [4206379813](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206379813) / #97 | `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenBranchInspectorPanel.tsx` | implemented_pending_ci | Nowy problem: branch model wzbogaca punkty z dispersion wyłącznie po sample/rawmode bez potwierdzenia wspólnego run/source identity. Retained dane hooków mogą pochodzić z różnych runów i dostarczyć błędny k/path do nowego modu. |
| [4206379822](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206379822) / #97 | `crates/fullmag-session/src/reachability.rs` | duplicate | Ta sama niebezpieczna akceptacja opaque project documents w visualization import. Nowa uwaga rozszerza trigger o starszy snapshot/asset_index z ukrytym CAS ref; istniejący typowany scanner nie pokrywa tych wariantów. Powtórzenie 4061684299. |
| [4206379830](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206379830) / #97 | `.github/workflows/dispersion-artifact-consumers.yml` | already_fixed | Filtry workflow obejmują scripts/**/*.py i packages/fullmag-py/** w pull_request/push. Przekazany przez root dowód CI: dispersion-artifact-consumers run37626140024 SUCCESS dla f0b044b5369a2edc245a64ac6359b0291b6c2d32. Naprawa ma aktualny source i CI proof; nie jest pending. |
| [4206565154](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206565154) / #97 | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | duplicate | Powtórzenie 4060116262. Historyczny brak callbacku jest już poprawiony w źródłach: adapter i EPS stopping test; aktualna weryfikacja provider pozostaje pending przy uwadze głównej. |
| [4206565163](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206565163) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | duplicate | Diagnostics-only nadal filtrowane przez spectrum∪field IDs, bez tracking IDs; statystyki overlap stają się null. Powtórzenie 4060687842. |
| [4206565173](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206565173) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | duplicate | Single-k result.status nadal nie sprawdzony przed przyjęciem magnetyzacji/parsing; zewnętrzny path publikuje Completed. Naprawa completion w native window nie naprawia tej warstwy. Powtórzenie 4061684283. |
| [4206565184](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206565184) / #97 | `crates/fullmag-api/src/router_v2/handlers/data/scalars.rs` | duplicate | Ten sam discriminator fem_eigen_progress koliduje z legalnym object ID/name w per_object_scalars; filtr usuwa fizyczne wiersze. Powtórzenie 4204792253. |
| [4206565198](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206565198) / #97 | `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` | duplicate | Native production bez dispersion_validation nadal emituje with_analytic_comparison przy reference_model null. Powtórzenie 4061061326. |
| [4206565211](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206565211) / #97 | `backends/fem/include/frequency_domain/mode_kinematics.hpp` | implemented | Nowy problem odrębny od progu Gamma-k4082209289: default zero-frequency tolerance=1e5rad/s klasyfikuje dodatnie miękkie mody poniżej~15.9kHz jako zero, a exclude-zero filtr je usuwa. Publiczny nearest/window nie ogranicza się do GHz; brak wykonania konkretnego miękkiego benchmarku. |
| [4206565223](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206565223) / #97 | `crates/fullmag-runner/src/eigen/tracking.rs` | duplicate | Confidence pozostaje edge.score mieszanym; verifier dla modal_overlap_weighted_score wymaga equality z overlap. Powtórzenie 4060116342. |
| [4206565233](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206565233) / #97 | `crates/fullmag-runner/src/eigen/tracking_subspace.rs` | duplicate | Kod nadal1e-4, kanoniczne równanie degeneracji1e-9. To ten sam nierozstrzygnięty kontrakt progu. Powtórzenie 4060116349. |
| [4206911469](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206911469) / #97 | `crates/fullmag-runner/src/fem/eigen_k_pool.rs` | valid_unfixed | Nowy, odrębny lifecycle bug puli procesów: pool zwraca tekstowy Err przy cancel, a adapter przekłada go na RunError zamiast terminalnego Cancelled. Nie jest duplikatem braku anulowania in-process EPS ani ignorowania returned Cancelled w serial path. |
| [4206911477](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206911477) / #97 | `scripts/local_runner/ui_dist/src/api.js` | duplicate | Async retencja jest nadal tylko w ui_dist; canonical src API nie zawiera getRetentionPlan i canonical StorageView nie polluje. Build usuwa generated katalog i kopiuje source. Powtórzenie 4204074481. |
| [4206911487](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206911487) / #97 | `crates/fullmag-runner/src/fem/single_k_checkpoint.rs` | duplicate | Ten sam brak directory fsync checkpointu po hard-link markerze; pliki sync_all nie dowodzą trwałości names. Źródłowy gap, bez przeprowadzonego power-loss proof. Powtórzenie 4204615025. |
| [4206911491](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206911491) / #97 | `crates/fullmag-runner/src/fem/eigen_k_pool.rs` | duplicate | Bootstrap nadal stały process_root/bootstrap, conflict different bytes przy kolejnej próbie. Osobne raw-checkpoint attempts nie zmieniają tego namespace. Powtórzenie 4204615016. |
| [4206911494](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206911494) / #97 | `crates/fullmag-runner/src/native_fem/frequency_domain.rs` | valid_unfixed | Nowy provenance gap: helper bierze pierwszą znalezioną diagnostykę native i manifest używa jej dla całej ścieżki. Mieszane adaptery Gamma/Floquet wymagają per-sample lub aggregate execution. Obecny odrębny classifier/mixed-model bug może blokować taki run wcześniej; nie przedstawiam ukończonego błędnego bundle jako runtime proof. |
| [4206911501](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4206911501) / #97 | `scripts/local_runner/retention_service.py` | valid_unfixed | Nowy persistence-contract bug: _save zapisuje pełny rekord bez limitu, zaś _read_json odrzuca>4MiB. Duży retained/raw_engine_plan może stworzyć natychmiast nieodczytywalny plan/operation. Popping raw_engine_plan dla HTTP następuje dopiero po read, nie naprawia pliku. |
| [4207002965](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207002965) / #97 | `scripts/local_runner/source_store.py` | valid_unfixed | Nowy recovery bug: O_CREAT/O_EXCL lock bez OS-release/stale owner recovery pozostaje po przerwaniu procesu przed publikacją obiektu. Kolejne próby niepublished digest kończą się po30s. Już ukończony obiekt może ominąć lock, więc nie twierdzę że każdy completed digest jest blokowany. |
| [4207002986](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207002986) / #97 | `scripts/local_runner/runtime_references.py` | duplicate | Rozwiązany artifact_root dopisuje refs bez protect(target); fingerprint references nie są retention protection. Ten sam ryzyko usunięcia referenced package. Powtórzenie 4205039831. |
| [4207002995](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207002995) / #97 | `crates/fullmag-runner/src/fem/single_k_checkpoint.rs` | duplicate | Duplikat checkpoint directory durability, tak samo jak4206911487. Powtórzenie 4204615025. |
| [4207003016](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207003016) / #97 | `scripts/local_runner/retention_executor.py` | valid_unfixed | Nowy deterministyczny limit-contract bug: executor pobiera pełne Docker logs przez adapter z16MiB cap. Większy log rzuca zanim zostanie archived; retention zatrzymuje się bez drogi strumieniowej. |
| [4207003028](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207003028) / #97 | `packages/fullmag-py/src/fullmag/world.py` | duplicate | Spectrum scope wciąż Python-emitted, ale aktywny OutputIR ma tylko quantity. Global semantyka pozostaje nierozstrzygnięta; nie została cicho uznana za naprawioną. Powtórzenie 4060116242. |
| [4207003038](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207003038) / #97 | `scripts/managed_runtime_artifact_root.py` | valid_unfixed | Nowy producer-binding gap: terminal manifest wiąże metadata tylko path/kind i identity source/run; resolver hashuje aktualne bajty. Zmiana payloadu zachowująca identity przechodzi i otrzymuje nowy binding. Nie jest tym samym co brak weryfikacji już producer-recorded hashes w comparatorze. |
| [4207003048](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207003048) / #97 | `crates/fullmag-plan/src/validate.rs` | duplicate | Branch selectors poza Path nadal admitted, single-k requested indices nie obsługuje branches. Ten sam utracony output contract. Powtórzenie 4060116309. |
| [4207003056](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207003056) / #97 | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | duplicate | Naprawione źródłowo: declared Floquet vector jest sprawdzany dokładnie3finite przed tiny/production dispatch, a predicate korzysta z walidującego helpera. Pełna raw/fixed matrix dodana; native CI rerun po brakującym cstdio pending. Powtórzenie 4060116253. |
| [4207003063](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207003063) / #97 | `crates/fullmag-ir/src/plan.rs` | implemented | Nowy validation/provenance bug: FemEigenSolverPolicyIR nie ma deny_unknown_fields, więc typo daje allNone policy; planner przyjmuje ją, runner raportuje resolved_fem_eigen_plan/delegates=false mimo zlecenia native defaults. Unknown keys odrzucić; pusty policy jawnie normalizować do None albo odrzucać po udokumentowaniu, nie zakładać automatycznie zakazu {}. |
| [4207587005](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587005) / #97 | `crates/fullmag-runner/src/eigen/output_selection.rs` | duplicate | Ten sam brak obsługi flag EigenDiagnostics. crates/fullmag-runner/src/eigen/output_selection.rs:345–349 odczytuje tylko include_tracking; writer diagnostyki nie otrzymuje pozostałych flag. Powtórzenie 4061061294. |
| [4207587018](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587018) / #97 | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | valid_unfixed | Nowy błąd wiązania polityk per-object. asset_pipeline.py:1218–1224 przekazuje cały mesh_workflow przy geometries=[geometry], a _size_field_plan.py:1586–1591 odrzuca właściciela innego obiektu zamiast ograniczyć polityki standalone do bieżącego właściciela. Shared-domain walidacja wszystkich ownerów musi pozostać. |
| [4207587028](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587028) / #97 | `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` | duplicate | Ten sam guard retained identity w studyRuntimeResources.ts:837: każdy status poza ready usuwa identity mimo zachowanych data. Nowy trigger stale odświeżenia rozszerza wcześniejszy trigger error, lecz przyczyna i poprawka są wspólne. Powtórzenie 4204074508. |
| [4207587037](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587037) / #97 | `crates/fullmag-api/src/quantities.rs` | implemented | Nowa sprzeczność katalogu i historii. quantities.rs:55–57 zwraca scalar_available=false dla latest_step modalnego przed sprawdzeniem zachowanej fizycznej historii lub run_value (:59–70). tables.rs zachowuje fizyczne wiersze, więc dostępne dane zostają ukryte w katalogu. |
| [4207587048](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587048) / #97 | `crates/fullmag-api/src/router_v2/handlers/analysis/results.rs` | implemented | Nowa luka typed availability. frequency_domain.rs:326/518 definiuje oba mode payload bez jawnego mode_field_available; results.rs:1557 czyta extras przez as_bool i akceptuje wszystko inne niż bool false. String false może ominąć wyłączenie, jeśli field_status/ID/mesh są gotowe. Dodać typed Option<bool> i strict decode, zachowując uzasadnioną legacy semantykę. |
| [4207587059](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587059) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | valid_unfixed | Nowa niespójność gradingu z. _gmsh_swept.py:2003–2009 przy braku airbox hmin/hmax ustala h_inner=h_outer=hmax; _box_airbox_layer_levels:1923 clampuje growth do h_outer, więc warstwy nie grubieją. Pole lateral grading w :2243–2250 używa innego domyślnego outer=inner*ratio^4. Wymaga spójnego targetu, bez arbitralnego zwiększania jawnego hmax. |
| [4207587066](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587066) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | implemented | Nowa utrata przerw po decymacji. frequencyDomainChartModels.ts:1102/1124 oznacza breakBefore, lecz modules/analysis-plots/frequencyDomainSeriesAdapter.ts:22–66 wybiera jedynie endpoints/extrema/fill i może usunąć punkt graniczny. finiteFrequencySeries zachowuje marker w punktach; renderer dostaje serię bez przerwy. |
| [4207587076](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587076) / #97 | `crates/fullmag-ir/src/validation.rs` | duplicate | Ten sam niepełny publiczny validator V04. study_v04.rs:330 kończy po representation/BC/k_sampling, bez count/target/dynamics/sampling; validation.rs wywołuje właśnie tę metodę. Nie naprawiono przez migrację regionów. Powtórzenie 4204074492. |
| [4207587086](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207587086) / #97 | `crates/fullmag-plan/src/fem.rs` | valid_unfixed | Nowy silent-ignore dla solver policy na reference CPU. Planner fem.rs:5210 przyjmuje policy; eigen_capability.rs:38–63 nie wybiera native window dla zwykłego lowest, a eigen_execution.rs:1536ff realizuje reference_effective_field_generalized bez odczytu plan.solver_policy. Odczyty policy w :1083 są w GPU entrypoint, nie tej trasie. Trzeba honorować albo odrzucać nieobsługiwane kontrolki. |
| [4207786265](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786265) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | valid_unfixed | Nowy mixed-topology blocker. eigen_path.rs:879 tworzy MeshTopology::from_ir przed solve, a fullmag-engine/src/fem.rs:1019 wymaga tet4 oraz dalej tri3. Legalne P1 prism6/quad4 obsługiwane przez native provider nie przechodzą tego legacy adaptera; analogiczny tracking w puli wymaga spójnej naprawy. |
| [4207786279](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786279) / #97 | `crates/fullmag-plan/src/fem.rs` | implemented | Nowy guard nieaktywnej anizotropii. fem.rs:1664–1683 first_unsupported_floquet_airbox_local_interaction sprawdza Option::is_some dla współczynników i osi. Ku/Kc=0 z zachowaną osią jest odrzucane mimo nieaktywnej interakcji; zastosować istniejące predykaty aktywności, nie poszerzać obsługi niezerowych modułów. |
| [4207786284](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786284) / #97 | `scripts/local_runner/runtime_retention.py` | duplicate | Ten sam konflikt retencji runtime/execution. runtime_retention.py:164–179 usuwa payload i publikuje tombstone removed, natomiast archiwalna walidacja build receipt nadal wymaga pierwotnych artefaktów. Tombstone nie jest uwzględniony jako dowód usunięcia pakietu. Powtórzenie 4205652698. |
| [4207786295](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786295) / #97 | `scripts/local_runner/runtime_use.py` | valid_unfixed | Nowy błąd lifetime registry. runtime_use.py:111–147 dopuszcza nieistniejący leaf i trwale rejestruje output root; runtime_retention.py:30–37 rozwiązuje każdy zapisany root przez _checked_child, a retention.py:123 zgłasza missing_run_path. Brak recovery/unregister przy przerwaniu publikacji lub usunięciu starego wyniku blokuje preview. |
| [4207786303](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786303) / #97 | `.github/workflows/bootstrap.yml` | duplicate | Powtórzenie nieaktywnej rekomendacji usunięcia cargo test z GHA. Jawna decyzja użytkownika pozwala na testy wyłącznie w GitHub Actions; zakaz lokalnej kompilacji nie unieważnia bootstrap CI. .github/workflows/bootstrap.yml pozostaje dozwoloną trasą; nic lokalnie nie uruchamiano. Powtórzenie 4204792243. |
| [4207786315](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786315) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | implemented_pending_ci | Nowy P1 default-sentinel bug. floquet_modal_solver.cpp:3551–3554 rozwiązuje residual_tolerance=0 do eigen_tolerance=1e-10, lecz :4124–4126 przekazuje certifierowi min(raw sentinel,1e-8)=0. Certyfikat wymaga dodatniej tolerancji, więc default full-descriptor solve zostaje odrzucony. Użyć rozwiązanej eigen_tolerance; regresja sentinel vs jawny równoważny default. |
| [4207786330](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786330) / #97 | `crates/fullmag-api/src/router_v2/handlers/data/tables.rs` | valid_unfixed | Nowy błąd kursora fizycznej tabeli. data/tables.rs:420 odfiltrowuje modalny rekord przed wyznaczeniem publicznych indices; cursor_end:356–359 przy pustej stronie wraca do cursor_floor. Końcowy ukryty rekord pozostawia cursor niższy od raw total/revision, więc delta consumer stale odczytuje tę samą pustą stronę. |
| [4207786345](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786345) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | duplicate | Powtórzenie 4060116262. Historyczny brak callbacku jest już poprawiony w źródłach: adapter i EPS stopping test; aktualna weryfikacja provider pozostaje pending przy uwadze głównej. |
| [4207786360](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786360) / #97 | `scripts/local_runner/build_executor.py` | valid_unfixed | Nowa niepełna atestacja mountów. build_executor.py:187–207 odrzuca tylko device/dev/docker.sock, a is_attested_managed_browser_container:296 akceptuje pozostałe Mounts. Poprawnie etykietowany kontener z dodatkowym RW bind do builds/cache/execution omija globalny blocker. Wymagana dokładna allow-lista mountów managed launchera. |
| [4207786370](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786370) / #97 | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | duplicate | Dokładnie wcześniej wykazany legacy real-split mismatch. modal_eigen_solver.cpp:2247 zachowuje oryginalny pointer N*N, lecz zapisuje count dynamicznego wyniku (2N)^2. Starszy ledger już dokumentuje ten pointer/count oraz konieczność realifikacji własnego bufora; nowy opis podkreśla możliwe OOB certifiera. Nie wykonano runtime/ASan. Powtórzenie 4061343721. |
| [4207786385](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786385) / #97 | `scripts/local_runner/build_executor.py` | valid_unfixed | Nowa luka kompletności modalnego pakietu. build_executor.py:702–725 dla contract profile wymaga scenario result + FEM lib + source identity, zamiast BASE_REQUIRED_OUTPUTS. build_entrypoint.py:266–271/1031 wymaga fullmag-bin/API/core/launcher/web. Receipt pomijający plik i wpis może przejść executor i zakończyć niekompletny build sukcesem. |
| [4207979046](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207979046) / #97 | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | duplicate | Ten sam błędny metric fallback deduplikacji. production_cpu_modal_eigen.cpp:3080 ustawia metric tylko poza floquet_shared_domain_operator, pozostawiając nullptr i Euclidean fallback. Wcześniejszy algebraiczny kontrprzykład masowo ortogonalnych modów pozostaje aktualny; nie potrzeba nowej deklaracji runtime proof. Powtórzenie 4060687822. |
| [4207979056](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207979056) / #97 | `packages/fullmag-py/src/fullmag/model/study.py` | implemented | Nowy błąd typu publicznej solver tolerance. fullmag/model/study.py:186 zamienia residual_tolerance=True przez float na 1.0, podczas gdy _positive_int:215 jawnie odrzuca bool dla iteration limits. FemEigenSolverPolicyIR dopuszcza dodatnie 1.0, więc literal bool staje się rzeczywistą tolerancją. Odrzucić bool przed konwersją. |
| [4207979065](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207979065) / #97 | `backends/fem/include/frequency_domain/mode_kinematics.hpp` | duplicate | Ta sama soft-mode uwaga; źródło już poprawione. mode_kinematics.hpp:13 ma default=0.0, a mode_kinematics_test.cpp testuje ±1rad/s/±1kHz i both phasors. Publiczne dodatnie mody nie są usuwane przez 1e5rad/s. Provider/scientific qualification nie wynika z source fix. Powtórzenie 4206565211. |
| [4207979074](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207979074) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | implemented | Warstwowa trasa Box odrzuca reserved interface marker10 jako outer boundary na wejściu, przed czyszczeniem proofów i importem Gmsh. Regresja zachowuje proofy oraz marker99 jako poprawny dispatcher control. |
| [4207979082](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207979082) / #97 | `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenModeInspectorPanel.tsx` | implemented_pending_ci | Canonical relative/absolute L2 pozostają rozdzielone w parserze i Inspectorze; legacy norm jest jawnie type unspecified, zero valid, canonical negative/nonfinite odrzucone. |
| [4207979094](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207979094) / #97 | `scripts/local_runner/ui_dist/src/views/StorageView.js` | duplicate | Ten sam wcześniejszy drift source/ui_dist retencji; obecny source naprawiony w WIP. apps/runner-console/src/views/StorageView.js:25 ma scopes, :82/148 getRetentionPlan, :143 async accepted/running; canonical builder zachował shipped features. Sam drift nie jest już valid_unfixed, integracja źródeł wymaga rozliczenia przez root. Powtórzenie 4204074481. |
| [4207979104](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207979104) / #97 | `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` | valid_unfixed | Nowy backend PATCH tri-state bug, odrębny od frontend null draft #4204074511. schemas/authoring.rs:110 używa Option<ParallelExecutionResource>, a handlers/model/authoring.rs:3020 mutuje tylko Some, więc missing i explicit null zlewają się. Nullable requested_cpu_threads:109 ma osobny patch carrier; parallel_execution potrzebuje analogicznego rozróżnienia. |
| [4207979111](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207979111) / #97 | `crates/fullmag-ir/src/study_v04.rs` | valid_unfixed | Nowa strict-wire luka V04, odrębna od semantycznego count validation. study_v04.rs:135 używa legacy SamplingIR, a prevalidation:449 sprawdza tylko study keys i nie sprawdza sampling. Nieznane study.sampling pola znikają podczas deserializacji/roundtrip. Dodać strict V04 adapter lub nested prevalidation bez zmiany legacy V03. |
| [4208794529](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794529) / #97 | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | duplicate | Ten sam padded Box route-selection bug. asset_pipeline.py:2651–2656 wybiera exact-cell Box bez sprawdzenia lateral coincidence; _gmsh_swept.py:1971 wymaga coincident bounds i odrzuca padding, a bezpośrednia gałąź nie ma OCC retry. Nadal niepoprawione. Powtórzenie 4204792272. |
| [4208794541](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794541) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | duplicate | Ta sama utrata SI w swept quality. _gmsh_swept.py:2420–2435 dzieli nodes przez SCALE i kopiuje quality/per_domain_quality bez cubic conversion; analogicznie ring. Volume metrics pozostają w µm^3 przy nodes w m; poprawka musi obejmować wszystkie volume-bearing pola. Powtórzenie 4060116295. |
| [4208794550](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794550) / #97 | `crates/fullmag-ir/src/study_v04.rs` | duplicate | Ten sam pełny semantic validation V04 gap. study_v04.rs:330 zwraca po BC/k_sampling; count/target/dynamics/outputs nie dzielą reguł V03. Powtórzenie także nowego4207587076. Powtórzenie 4204074492. |
| [4208794557](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794557) / #97 | `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` | duplicate | Ten sam retained identity guard studyRuntimeResources.ts:837; data o niezmienionym session/epoch/run jest odrzucane w stale. Powtórzenie4207587028 i istniejącego error-refresh defect. Powtórzenie 4204074508. |
| [4208794569](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794569) / #97 | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | implemented | Direct Floquet stosuje tę samą regułę raw/fixed k co helper modalny; wybrany malformed raw nadal odrzucony, fallback i finite/nonzero zachowane. |
| [4208794575](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794575) / #97 | `scripts/local_runner/retention_service.py` | duplicate | Duplikat async source/ui_dist drift. Bieżący source StorageView.js:143–148 obserwuje planning/accepted/running przez getRetentionPlan, API ma singular method, więc rekomendacja dotyczy starszego snapshotu; source fix jest obecny, jego delivery rozlicza root. Powtórzenie 4204074481. |
| [4208794592](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794592) / #97 | `scripts/run_nonzero_k_validation_controller.py` | implemented | Wymuszono LF kontrolera bez osłabienia exact-byte attestation; dodano checkout/blob/capsule regression. |
| [4208794606](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794606) / #97 | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | duplicate | Ten sam per-stage output renderer bug. script_builder.py:612 wybiera pierwszy stage z outputs i emituje save globalnie przed _render_stages; późniejsze outputs nie są emitowane lokalnie. Wcześniejszy ledger obejmuje retroaktywną aktywację i utratę późniejszych outputs. Powtórzenie 4061684295. |
| [4208794615](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794615) / #97 | `packages/fullmag-py/src/fullmag/world.py` | duplicate | Ten sam unresolved spectrum_scope kontrakt. Python world.py:8822 emituje scope, lecz crates/fullmag-ir/src/study.rs:1720 EigenSpectrum ma tylko quantity. Global/per_sample decyzja pozostaje otwarta; nie usuwać scope ani uznawać tej uwagi za naprawioną. Powtórzenie 4060116242. |
| [4208794629](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794629) / #97 | `crates/fullmag-runner/src/eigen/output_selection.rs` | duplicate | Te same ignorowane flagi EigenDiagnostics co4207587005. output_selection.rs:345–349 przenosi tylko include_tracking; overlap/residual/leakage/orthogonality intent nie trafia do writerów. Nadal source gap. Powtórzenie 4061061294. |
| [4208794637](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794637) / #97 | `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | unsupported_recommendation | Rekomendacja frontendowej inferencji available z samego ID nie jest poparta dowodem istnienia payloadu i odwraca jawnie uzgodniony kontrakt4205833370. frequencyDomainChartModels.ts parser v2 odtwarza transport przy explicit true; eigen_path_mode_publication_json zachowuje durable ID także dla nieopublikowanego pola i publikuje false. Legacy compatibility powinna potwierdzić istniejący artifact po stronie adaptera i wydać availability, nie traktować ID jako dowodu payloadu. |
| [4208794649](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794649) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | valid_unfixed | Nowy zwykły k-path equilibrium reuse regression. eigen_path.rs:854 tworzy każdy single-k plan z reuse_relaxed_equilibrium=false i handoff=None; previous_accepted_magnetization jest używane do przygotowania następnego punktu tylko w bias-field branch (:869). Bez source_relax_handoff standalone RelaxedInitialState ponownie relaksuje każdy k i może zmienić linearization state. Wymagany wspólny zaakceptowany equilibrium handoff; bias sweep continuation zachować osobno. |
| [4208794663](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794663) / #97 | `crates/fullmag-ir/src/waveguide_mesh_bindings.rs` | duplicate | Ten sam authored Air material/provenance loss. waveguide_mesh_bindings.rs:355–373 odrzuca magnetization modules, następnie emituje material/material_assignment=None bez kontroli authored assignment. Generic reference validation nie zabrania tego przypisania. Powtórzenie 4205406998. |
| [4208794672](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794672) / #97 | `crates/fullmag-plan/src/fem.rs` | duplicate | Powtórzenie nowego guardu nieaktywnej anizotropii. fem.rs:1664–1683 używa is_some dla zerowych współczynników i osi. Pełny rekord pierwotny w tym ledgerze4207786279. Powtórzenie 4207786279. |
| [4208794677](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794677) / #97 | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | duplicate | Ten sam stale periodic certificate po SI conversion. _gmsh_swept.py:2420–2434 skaluje nodes/periodic translations, ale kopiuje raw_mesh.periodic_mesh_certificate. Hash dokładnych nodes opisuje wcześniejszą reprezentację; również ring wymaga rebindingu. Powtórzenie 4061343703. |
| [4208794683](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794683) / #97 | `crates/fullmag-runner/src/fem/eigen_path.rs` | duplicate | Ten sam serial returned-Cancelled loss. eigen_path.rs:1012 po native return checkpointuje i parsuje bez sprawdzenia executed.result.status; końcowy path może Completed lub RunError. Native completion fix nie naprawił path adaptera. Powtórzenie 4061684283. |
| [4208794690](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794690) / #97 | `scripts/local_runner/retention_service.py` | duplicate | Ten sam retained-plan size-contract mismatch. retention_service.py:48 zapisuje cały raw plan, podczas gdy get->_read_json wymaga <=4MiB; usunięcie raw fields po odczycie nie naprawia przepełnionego pliku. Powtórzenie 4206911501. |
| [4208794702](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794702) / #97 | `scripts/local_runner/source_store.py` | duplicate | Ten sam osierocony CAS publication lock. source_store.py:172 O_CREAT/O_EXCL bez OS release/lease recovery może pozostać po crash przed opublikowaniem obiektu. Completed digest może ominąć lock; brak nowego runtime crash proof. Powtórzenie 4207002965. |
| [4208794710](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794710) / #97 | `scripts/diagnose_managed_fem_startup.py` | duplicate | Ten sam profiler/schema mismatch. diagnose_managed_fem_startup.py:42 dopuszcza runtime-v1 i v2, lecz :273 wymaga zawsze slepc_runtime_contract.v2. Producer v1 pozostaje schema v1, więc preflight blokuje dozwolony failed job. Powtórzenie 4204792263. |
| [4208794719](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4208794719) / #97 | `crates/fullmag-api/src/session.rs` | duplicate | Ten sam public object_id discriminator. session.rs:2465/2482 traktuje per_object_scalars key fem_eigen_progress jako modalny marker; legalny object o tym ID traci fizyczną historię i dostępność. Wymaga jawnego typu diagnostyki lub zwalidowanej zarezerwowanej namespace. Powtórzenie 4204792253. |
| [4224318111](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4224318111) / #97 | `crates/fullmag-runner/src/fem/eigen_k_pool.rs` | valid_unfixed | Aktualny eigen_k_pool.rs sprowadza Pause/Stop do AtomicBool i mapuje przerwanie na RunError; potrzebne oddzielne statusy i wznowienie. |
| [4224318143](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4224318143) / #97 | `packages/fullmag-py/src/fullmag/runtime/scene_document.py` | implemented | SceneDocument odrzuca bool/float/fractional/nonpositive limity iteracji przed eksportem i IR; zachowuje dodatnie int oraz tekstowe pola authoring i unset defaults. |
| [4224318154](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4224318154) / #97 | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` | implemented_pending_ci | Native sparse Floquet certified_count nie zwraca sukcesu bez count certificate; error/cancellation mają pierwszeństwo. BestEffort pozostaje niecertyfikowane. Rozszerzony algebraiczny owner izoluje certificate gate od underfill/refill. |
| [4224318169](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4224318169) / #97 | `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp` | valid_unfixed | Formatter modalny nadal mapuje exp_i_omega_t niezależnie od request.phase_convention; potrzebna spójna konwencja serializacji i parsera. |
| [4224318179](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4224318179) / #97 | `scripts/local_runner/retention_executor.py` | implemented | Zatwierdzone execution przenoszone atomowo do prywatnej kwarantanny; przed rmtree sprawdzane containment, tożsamość rodziców i pełne tree identity. Mismatch zachowuje drzewo, restart utrwala interrupted_unknown bez ponowienia. |

## Przygotowane przyrosty

1. `5d3a721e56318e8d989dc8efa7871b0d53d98b2b`: osiem uwag powtórzonych w trzech grupach — zgodność progu airbox/statusu i blokada QUALIFIED przy failed check, pełny zestaw przypadków niezależny od kolejności, hash-bound pliki wewnątrz zadeklarowanego rootu runu. Dodano pokrywające regresje oraz wykonanie całego scientific gate suite w GitHub Actions. Review/AST/YAML PASS; bootstrap 37603838851 success; ponownie pokryte zielonym bootstrap 37606427947.
2. Uwagi4061898643 i4105055209: wszystkie pivoty RHS przed forward/back substitution; checked arithmetic dla jednoczesnych wewnętrznych payloadów Poisson/LU/pivots/RHS/solution/Schur. Caller-owned inputs/output poza tym budżetem. Regresje late/multiple pivot, real/complex RHS, original-system residual, budżet minimum i minimum-minus-one, duże wymiary/overflow bez wielkich alokacji. Review PASS; bounded dense-algebra contract PASS w bootstrap 37606427947, wyłącznie w CI, z aktywnymi assert. Nie jest to kwalifikacja managed FEM2D ani fizyki waveguide.

## Ograniczenia dowodów

Każdy ID oceniany wobec aktualnego kodu i konsumentów, również historyczne uwagi. Szczegółowe ledgery w lokalnym `pr-review-20261007` zawierają symbole, linie, scenariusze błędów oraz bramki regresji. Analiza źródeł, parser i test algebraiczny nie zastępują wykonania managed runtime, GUI ani walidacji naukowej. Zamknięcie #97 wymaga dokończenia rozpatrzenia pozostałych uwag i uzasadnionych poprawek.

## Poprawka completion przy anulowaniu — 2026-10-07

Uwagi 4061684290 i 5440044234: wspólny konstruktor native modal wiąże completion z rzeczywistym RunStatus, również dla nie-współdzielonej ścieżki Bloch/Floquet. Regresja sprawdza cancelled, brak converged i UserCancelled oraz przypadek completed. CI jawnie wybiera ten test w fullmag-runner. Review źródeł przeszło; test kompilowany wyłącznie w GitHub Actions, wynik tej poprawki oczekuje CI.

Poprzedni commit f0594581b17e107446343c7a851016f193ee5009: bootstrap 37606427947 zakończony success (8 jobów); obejmuje regresję LU i budżetu workspace. To dowód kontraktów źródeł, nie kwalifikacji produkcyjnego FEM.

## Selektory NumPy — 2026-10-07

Uwagi 4060116283 i 4080865455: study.save(mode) odróżnia None od przekazanej sekwencji zamiast wywoływać bool tablic NumPy. Dotyczy indices, branches, sample_indices i sample_labels. SaveMode zachowuje dotychczasową walidację pustych i błędnych selektorów. Dodano testy tablic wieloelementowych i singleton [0], tuple/range/list oraz błędów walidacji. AST/diff PASS; istniejący krok Run Python API tests w bootstrap pokrywa regresje, wynik oczekuje CI.

## Wykresy i kompletność rejestru — 2026-10-07

W checkpointcie d8e54be14 rozpatrzono pierwotne 160 wpisów, w tym treść review i duplikaty; późniejsze 20 uwag dopisano po ponownym pobraniu GitHub. Sześć uwag frontendowych obejmuje trzy przyczyny: zgodne rodziny tras modal/response, mapowanie kliknięcia po przerwie przez źródłowy rowIndex oraz zachowanie scatter w render modelu. Poprawka nie zmienia transportu, manifestu ani provenance. Testy pokrywa istniejąca bramka control-room-typecheck-lint-test uruchamiająca pełny vitest. Diff i review źródeł PASS; CI i celowany browser proof jeszcze wymagane. PR #97 pozostaje otwarty ze względu na zasadne nienaprawione uwagi.

## Ponowne pobranie GitHub — 2026-10-07

API zwróciło 182 komentarze liniowe ogółem; doszło 20 wpisów Codex. Rejestr obejmuje teraz 179 komentarzy liniowych Codex i jedną uwagę w treści review. Nowe rekordy oceniane są wobec aktualnego kodu; pending nie jest uznawane za zakończone. Brak miejsca na lokalny pełny build nie blokuje źródłowych poprawek ani zatwierdzonego GitHub Actions. Centralizacja ownership PETSc/SLEPc wymaga również reentrancy, lifetime zachowanych kontekstów, external initialization i polityki MPI; samo scalenie dwóch mutexów nie usuwa problemu.

## Remapowanie kolejnych próbek i wynik API — 2026-10-07

Uwaga 4205039857: remapper obsługuje kanoniczne legacy sample_0000 albo bieżący sample_index, odrzuca inne próbki i zachowuje selekcję modów oraz sidecary. Regresja metadata/vector obejmuje próbki 1, 7 i 10000 oraz odrzucenie obcych indeksów. Review znalazło i usunięto niepoprawne oczekiwanie unsigned JSON referencji. CI jawnie wykonuje cały output_publication_tests, wraz z istniejącymi regresjami pełnego potencjału. Diff/review PASS; kompilowana regresja i managed wielopunktowy run oczekują weryfikacji.

Selektory NumPy: suite API w job112755091647 przebiegło poprawnie (312 testów, 1 skipped), w tym oba nowe testy. Cały job Python pozostaje czerwony przez odrębny test gęstości siatki regionalnej: median1.9657793147842166e-08 >12e-9 dla thin_film_tetrahedral. Ten failure wymaga diagnozy kontraktu mesh/fixture; nie obniżamy progu dla uzyskania zielonego CI.

## Brak pola PBC a jawny reset — 2026-10-07

Uwaga4205652678: SceneStudyState i serde zachowują brak/null/wartość. Adapter eksportu nie emituje pbc override dla brakującego pola legacy, ale utrzymuje jawny reset null oraz zadaną periodyczność. Dostosowano wszystkich konsumentów Rust; kształt JSON wartości pozostaje bez zmian. Rozszerzono round-trip regresję missing/value/null i istniejącą walidację polityki demag. Niezależny source review bez blockerów, diff PASS, parser rustfmt bez błędu składni (pełny format check ma istniejące różnice). GHA jawnie wybiera fullmag-authoring scene_pbc. Wynik tej nowej regresji i pełny cross-language API sync pozostają NOT VERIFIED.

Oryginalna regresja completion anulowania zakończyła się SUCCESS w kroku Run native modal cancellation completion contract job112755091707; to dowód statusu completion, nie wykonania anulowania każdej ścieżki solvera. Nowe20 uwag zostało ocenionych źródłowo; rejestr nie zawiera już pending z tego pobrania, lecz zasadne niezaimplementowane pozostają otwarte.

## Regresja rzeczywistego eksportu PBC — 2026-10-07

Test scene_pbc_overrides_roundtrip_via_python_helper korzysta z istniejących helperów API: Python export-scene → Rust scene_document_overrides → Python rewrite-script do kopii → ponowny export-scene. Przypadki missing/null/value sprawdzają pełne osie, demag i image_counts oraz niezmienione bajty oryginału. Bez skipu przy braku środowiska; jawny filtr GHA fullmag-api binary ma setup Python i editable fullmag-py. Niezależne review źródeł bez blockerów; wykonanie testu w CI oczekiwane. Nie jest to test HTTP ani solvera.

## Regresja wewnętrznych kandydatów trackingu — 2026-10-07

Pełny output_publication_tests ujawnił przestarzałe oczekiwanie indeksów 0..count w teście internal_tracking_requests_all_modes_without_public_path_selectors. Produkcyjny helper już emituje all_modes, a selector używa rzeczywistych ID wyników. Zmieniono wyłącznie test: zachowano kontrolę usunięcia publicznych selektorów i dodano rzeczywisty select_eigen_outputs dla dwóch próbek oraz nieciągłych raw IDs4/9/11. Stary kontrakt i przeciek publicznych selektorów muszą ten test odrzucić. Niezależne source review bez blockerów, diff PASS; ponowne wykonanie całego modułu w GHA wymagane.

## Migracja właścicieli regionów V03 — 2026-10-07

Uwaga4205833396: migrator przepisuje object_regions.owner_object przez tę samą mapę aliasów nazw oraz jawnych object_id co pozostałe referencje. Regresje obejmują nazwę film→obj_film, explicit ID i już kanoniczny ID, a także unresolved owner z pointer-specific błędem i atomowym zachowaniem całego wejścia mimo wcześniejszej poprawnej referencji. Pozytywne przypadki sprawdzają pełną walidację ProblemIRV04. Niezależny source review, rustfmt/parser i diff PASS; istniejące pełne fullmag-ir GHA pokrywa wszystkie trzy testy. Wykonanie CI pozostaje wymagane.

Ponowna ocena4205652672: not_actionable. Nie ma auto/default/fallback do modal-v1; jest to jawnie aktywowany profil historyczny. Zakaz lokalnej kompilacji dotyczy działań agentów i nie wymaga usunięcia profili operatora, których zachowanie użytkownik zatwierdził wraz z runtime-v2. Profilów nie zmieniano i nie uruchamiano lokalnych testów.

## Rotated DMI i PBC w authoringu Python — 2026-10-07

Uwaga4205406974: oba guard call sites otrzymują PBC; Exchange jest nadal wymagane przy niezerowym rotated DMI i jakiejkolwiek otwartej osi. Jawnie w pełni periodyczny model3D nie ma tej otwartej granicy i nie jest już błędnie odrzucany podczas round-trip. Test pozytywny używa legalnego truncated_images z image_counts1/1/1 (nie periodic_airbox_k0, które wymaga openz), a negatywne obejmują brak PBC i częściowe PBC. Reguła odtwarza istniejący kontrakt plannera; walidacji airbox ani fizyki nie poluzowano. AST/diff/source review PASS; istniejący suite test_scene_document_problem_ir.py w GHA pokrywa regresje. Wykonanie CI jeszcze wymagane.

## Jawna weryfikacja GitHub Actions — 2026-10-07

Dla SHAe54c81a18 API actions/runs zwróciło total_count0, mimo aktywnego bootstrap i enabled Actions. Przyczyny braku automatycznego eventu nie potwierdzono. Dodano workflow_dispatch do istniejącego bootstrap, zachowując push/pull_request; umożliwia to zwykłe jawne zlecenie zaakceptowanych przez użytkownika testów w GHA na branchu zadania. Nie wprowadzono lokalnej kompilacji ani obejścia runnera FEM. Wymagane są run ID, faktyczny head_sha i wyniki pokrywających kroków; push sam w sobie nie jest dowodem uruchomienia CI.

## Eksport nadpisanej polityki solvera — 2026-10-07

Uwagi4204614972 i4205833375: renderer etapów uwzględnia eigen_solver_rtol, eigen_solver_max_outer_iterations i eigen_solver_max_linear_iterations z jawnych stage overrides. Brak klucza zachowuje bazową wartość, None/pusty tekst ją czyści. Regresja obejmuje fallback per-field, zastąpienie wszystkich wartości, pełny/częściowy reset oraz wejście bez policy. Publiczne nazwy i fizyczne parametry solvera pozostają dotychczasowe; naprawiono utratę żądania w eksporcie. AST/diff/source review PASS; test w istniejącym Run Python API tests oczekuje GHA. Odrębna uwaga4105055173 o materializacji pipeline Rust pozostaje otwarta.

## Pole modu z produkcyjnego spectrum.v2 — 2026-10-07

Uwaga4205833370: parser odtwarza kanoniczny phase-rotated vector resource key z trwałego mode_field_id wyłącznie przy jawnie potwierdzonym mode_field_available. Nie tworzy dostępności z samego ID i zachowuje false/brak metadanych jako brak handoffu. Użyto istniejącego fieldQueryIdentity buildera, bez nowego endpointu ani transportu komponentu. Regresja odtwarza eigen_spectrum.v2 producenta i sprawdza selection ref; przypadki negatywne sprawdzają dwie zachowane pozycje i brak fikcyjnego zasobu. Niezależny source review/diff PASS; pełny frontend CI oraz celowany browser/resource smoke wymagane. Nie jest to dowód solvera ani WebGL.

## Rzeczywisty payload sparse/dense — 2026-10-07

Uwaga4205406991: dla shift-invert dense_operator_payload zależy od mfem_operator_payload rzeczywiście opublikowanego przez ABI, a nie od solver_adapter ani samej nazwy transformacji. Ten sam adapter Floqueta obsługuje sparse oraz bounded dense compatibility. Regresja używa realnego native_modal_artifacts i obejmuje sparse Floquet, sparse CSR, ten sam adapter z dense payload oraz unknown marker, który zachowuje diagnostykę i pending certification. Niezależny source review/parser/diff PASS; GHA jawnie wybiera nowy test. Nie nadano unknown kwalifikacji ani nie zmieniono solvera. Fallback bez shift-invert pozostaje dotychczasowym ograniczeniem do osobnej oceny.

Jawny bootstrap37615859685 wystartował dla f11df2a9fc9b7ce4f9b6c5a966b572e1f05c4812. Scene/PBC suite przebiegło poprawnie; Python API suite zatrzymał przykład FMR z degenerowanym tetra i wtórnym brakiem owner binding fallbacku. Nowa poprawka klasyfikacji payload nie była w tym SHA i wymaga kolejnego runu. Nie przypisujemy wcześniejszemu runowi dowodu nowych źródeł.

## Policy materializacji pipeline oraz terminalny CI — 2026-10-07

Uwaga4105055173: materializer Eigenstage odczytuje te same jawne klucze co producer Python, buduje typed FemEigenSolverPolicyIR i zapisuje metadata konsumowane przez planner. Nieobecne klucze zachowują legacy; obecne null/blank czyszczą pole, wszystkie wyczyszczone usuwają policy. Sprawdza dodatnie finite rtol i poprawne signed limity iteracji bez clamp. Cztery regresje obejmują TimeEvolutionbase, brak keys, partial/all clear i błędne wartości (także NaN/inf, ułamek, i32overflow). Base pozostaje niezmienione. Niezależne source review/parser/diff PASS; pełne fullmag-application CI musi wykonać nowy kod.

Bootstrap37615859685 dla f11df2a9f zakończył się failure: siedem jobów success, jeden Python failure na dokładnym FMR mesh smoke. Potwierdzone success obejmuje Rust-Python PBC, scene_pbc, fullmag-ir migration i cały output_publication_tests oraz frontend type/lint/test. W logu API nowy test solver override jest ok mimo odrębnego mesherror. Te dowody dotyczą f11, nie późniejszego nativepayload ani nowej materializacji pipeline.

## Właściciel komponentu w fallbacku STL — 2026-10-07

Caller fix znalazł się w commit2a7e7d0ef0f1ecd5b465621952eb0aeeff045424 podczas równoległej pracy: dokładna geometry_name jest przekazywana tylko dla jednego pierwotnego komponentu; dla wielu nie zgaduje wspólnego ownera. Oddzielny test wymusza OCC i component-aware failure, dochodzi do prawdziwej gałęzi fallbacku i sprawdza binding, pola lower/upper oraz osobne ustawienia airboxu. Nie zmienia tolerancji jakości ani polityki naprawy siatki. Source review/AST/diff PASS; nowy plik jawnie dodano do GHA. Nie dowodzi to naprawienia pierwotnego slivera, jakości nowej siatki ani certyfikacji periodycznej — dokładny FMR smoke musi przejść w kolejnym runie.


## Potwierdzenie CI — run 37619970247

Źródła e4b6329c6afd8214a969df4e9cc3294d3d0e6b9b. Rust job 112787460051 zakończony SUCCESS: jawny test provenance operatora natywnego i pełny fullmag-application obejmują odpowiednio uwagi 4205406991 i 4105055173. Te dwie poprawki są implemented. Python API: 313 testów PASS, w tym wcześniejszy FMR smoke i nowe kontrole przypisania ownera fallbacku. Cały workflow FAILURE: meshing oczekuje dwóch warstw, a realizacja zwraca 41 poziomów z; problem pozostaje otwarty. Zielone testy kontraktów nie kwalifikują fizyki ani produkcyjnego runtime.

## Walidacja wektora Floqueta — uwaga 4060116253

Przygotowana poprawka sprawdza jawny wektor przed tiny dispatch: dokładnie 3 skończone składowe. Zachowuje niejawne Gamma i dotychczasowe pierwszeństwo raw/fixed ABI. Niezależny source review PASS; kompilacja i wykonanie jeszcze NOT VERIFIED. Dodano odrębny job GitHub Actions dla rzeczywistego fem_modal_eigen_contract bez MFEM/SLEPc/CUDA, z powiązaniem SHA źródeł, flag, logów i terminalnego receipt. Job nie zastępuje kwalifikacji produkcyjnego FEM.


## Pierwsze wykonanie nowego kontraktu ABI

Run 37625114591 dla 6ac65fd0710537a7e537867bccdfc69decae21dd wykrył błąd kompilacji no-provider: steady_transport_c_api.cpp używa std::snprintf także bez MFEM, lecz cstdio było pod warunkiem MFEM. Przeniesiono include poza warunek, zachowując kod obu realizacji. Python workflow contract wykrył starszą wersję nowego upload-artifact; dostosowano ją do wymaganej v7. Nie omijano żadnego testu ani nie wyłączono transportu. Ponowne wykonanie ABI nadal wymagane; wynik pierwotny FAILURE zachowany z receipt.


## Filtry zależności konsumentów — uwaga 4206379830

Ponowne pobranie GitHub wykazało kolejne 27 uwag, które są oceniane względem źródeł. Workflow konsumentów rzeczywiście pomijał zmiany importowanych validators, receipts i oracle. Filtry push oraz PR obejmują teraz cały Python w scripts i pakiet fullmag-py, więc także zależności przechodnie. Zachowano dotychczasowy zestaw testów i jawne GHA-only wykonanie. Source diff PASS; run workflow pozostaje wymagany.


## Trwałość źródeł CAS — uwaga 4205406986

Na POSIX fsync katalogu kapsuły następuje po atomic replace i odtworzeniu trybu, zanim plik może wejść do trwałego checkpointu. Przy wznowieniu istniejący CAS-link jest synchronizowany przed zaliczeniem go jako skipped. Błąd sync blokuje completed, pozostawia partial_failure i zweryfikowane bajty umożliwiające wznowienie. Windows zachowuje dotychczasową obsługę bez nieobsługiwanego directory fsync. Regresje sprawdzają kolejność checkpoint/completed, fault injection i wznowienie oraz Windows no-op. AST/source review/diff PASS; cały plik testów jawnie podłączono do GHA, wykonanie nadal pending. Nie wykonano kompaktowania rzeczywistych danych.


## Ponowny pełny przegląd komentarzy — 207 wpisów

Nowe 27 wpisów: 17 duplikatów, 9 nowych zasadnych problemów i 1 naprawiony z potwierdzonym CI. Pełne rozstrzygnięcia są w tabeli powyżej. Nadal otwarte są m.in. cross-run enrichment branches/dispersion, absolute cutoff miękkich modów, anulowanie puli, provenance wszystkich próbek, limity receipt/logów, odzyskiwanie CAS locków, producentowy digest metadata i nieznane/puste pola modal policy. Nie zamknięto PR97 ani nie uznano nowych zasadnych problemów za zakończone.

W run 37626455538 dla e58b4e70c7ed04ebb6de373ed6019d73e2acc572 krok retention contracts SUCCESS obejmuje pełny test_local_runner_source_compaction.py; poprawka 4205406986 ma dowód testowy. Nowy ABI job zakończył się FAILURE w kompilacji GPU Poisson no-provider: pięć funkcji odwoływało się do ctx.poisson_demag, który istnieje tylko z MFEM. Dostępy są teraz objęte istniejącym warunkiem MFEM; aktywna ścieżka MFEM zachowana, a brak providerów pozostaje unsupported. Ponowny ABI build wymagany.


## Stabilna paginacja kolejki — uwaga 4205652714

Dla SQLite queue/oldest pierwszy odczyt utrwala owner high-water w tej samej transakcji co strona. Następne strony używają sequence > after oraz <= high_water, limit+1 i kursora związanego z ownerem, filtrami, sortem oraz limitem. History zachowuje OFFSET. API publikuje as_of_sequence; UI wymaga next_cursor i spójnego watermarku, nie przyjmuje starej odpowiedzi jako kompletnej. Zadania nadal aktywne nie są pomijane po zakończeniu wcześniejszych rekordów; nowe zadania po high-water pojawiają się przy odświeżeniu. Nie jest to snapshot wszystkich statusów.

Regresja real SQLite obejmuje 1105 zadań, skurczenie pierwszej strony, nowe zgłoszenie, kompletność i błędne kursory; Node obejmuje 205 wierszy, repeated cursor, duplicate ID oraz legacy response. Browser fixture serwuje ui_dist i sprawdza 205 unikalnych FIFO ID na dwóch stronach. Nie łączy się z rzeczywistym koordynatorem ani nie usuwa danych. Niezależny source review, AST/syntax oraz diff PASS. GHA ma jawne Python/Node/browser kroki; wykonanie nadal pending.

Pakowanie wykryło wcześniejszy rozjazd appsource/ui_dist w retencji. Zachowano wdrożone scope, getRetentionPlan, observePlan oraz polityki; chronione hunki przeniosły je do kanonicznych źródeł bez utraty lokalnej poprawki kursora. Kanoniczny build.mjs odtworzył pakiet. Wszystkie source/assets są byte-equal, a Storage/Policies odpowiadają wcześniej wdrożonemu HEAD; runtime diff obejmuje wyłącznie API cursor i QueueView. Test fixture retencji dostosowano do zachowanych kontraktów.


Scalenie appsource StorageView.js oraz PoliciesView.js z wcześniej wdrożonym ui_dist jest przygotowane lokalnie i zweryfikowane byte-equal. Automatyczna kontrola dwukrotnie odmówiła stagingu tych dwóch plików jako zakresu niezwiązanego z kursorem, mimo sprawdzenia czystego preimage i guarded hunks. Zgoda na konkretny commit tych dwóch kopii źródłowych jest oczekiwana; pozostają poza commitem kolejki. Pakiet runtime zachowuje wcześniejsze funkcje retencji i dostaje wyłącznie zmiany kursora. Nie uznaje się jeszcze za zamkniętą pełnej synchronizacji source/package na remote.


## Polityka modalna — uwaga 4207003063

Serde odrzuca nieznane pola przed rozwiązywaniem planu. Znana pusta polityka lub wszystkie pola null normalizują się do None, co wybiera native defaults i poprawne provenance z delegowaniem. Częściowe wartości są zachowane wraz z istniejącą walidacją finite/positive/signed bounds. Nie wdrożono sugestii odrzucania pustego obiektu: publiczny FemEigenSolverPolicy() od początku oznacza brak overrides, więc normalizacja naprawia provenance bez zmiany tego zachowania. Cały metadata null pozostaje błędnym typem.

Regresje serde i rzeczywistego planera obejmują typo alone/alongside valid, absent/empty/all-null i partial roundtrip. Niezależny source review oraz diff PASS; pełne IR i nowy jawny filtr planner test są w GHA. Wykonanie pending. Kontrakt: [walidacja polityki](../../specs/fem-eigen-solver-policy-validation.md).


## Dalsze naprawy konfiguracji bez providerów

Run 37630198767 wykrył analogiczne niezabezpieczone odwołania do MFEM-owned state w stage_compute.cpp oraz fem_bem.cpp. Osłonięto dispatch i dostęp do workspace, zachowując gałęzie MFEM=ON i strict unavailable dla aktywnego demag bez providerów. Przejrzano pozostałe odwołania w obu plikach; nie wyłączono źródeł ani nie zastąpiono realizacji CPU/GPU. Niezależny source review i diff PASS; świeży ABI compile/run nadal wymagany.


## Fixture odtwarzania planu retencji

W run 37630198767 wszystkie testy Node Runner Console przeszły, a browser zatrzymał się później na reconnect. Fixture używała plan-browser-smoke-preview, podczas gdy rzeczywisty klient odzyskuje tylko plan- + 8–32 znaków hex. Nadano fixture prawidłowy ID plan-b0123456789abcdef; zachowano guard aplikacji i rzeczywiste API/scope assertions. Pełny browser smoke nadal wymaga ponownego wykonania; nie zgłoszono całego joba jako SUCCESS.


## Selektory gałęzi a Single/None — uwaga 4060116309 i duplikat 4207003048

Planner przekazuje rzeczywiste k_sampling do walidacji outputów. Niepuste branches wymagają Path; Single/None odrzucają także wybór mieszany zamiast cicho pomijać branche. Raw indices pozostają obsługiwane poza Path; dla Path zachowano branch-only i mixed selectors. Legalność nie zależy od liczby próbek ani hardcoded k. Regresje używają rzeczywistego planera, dodatniej ścieżki Floqueta oraz istniejących kontroli outputów. Niezależny source review/diff PASS; GHA jawnie wybiera nowe testy i wcześniejsze eigen_output_validation_tests. Wykonanie pending.


## Aktualizacja dowodów i assembly no-MFEM

Run 37632606743 dla 202c3e82453beab5fa46905adc1b2aa5e24ebc31: SQLite queue suite oraz cały packaged Runner Console Node/browser step SUCCESS; 205 wierszy FIFO i reconnect planu potwierdzone. Run 37630198767 Rust job SUCCESS obejmuje full IR i nowe policy planner tests. Paginacja i policy są implemented, bez deklaracji całego workflow green.

No-provider CABI dotarł następnie do MFEM-owned assembly types w modal_eigen_solver.cpp. Osłonięto wyłącznie provider declarations/helper/body/probe; żądany k0 shared-domain z payloadem dostaje unavailable z powodem shared_domain_requires_mfem_stack, zachowanym targetem i transformem. Brak payloadu nadal jest validation_error. Pozostałe tiny/dense/legacy CSR/nonzero-k admission nie zostały wyłączone. Assembly DTO zawiera mfem-owned matrices, więc nie wyniesiono go poza guard ani nie dodano fałszywego stubu fizyki. Nowy test trafia w tę gałąź; niezależny source review i diff PASS, GHA compile/run nadal wymagany.


## Kolejny blad kompilacji CABI - api.cpp

Run 37641245535 dla 947161f010666cd9e1b2f611d60e8fbb2bd6f8a0 wskazal odczyty MFEM-owned gpu_demag_mode i fresh_initial_guess_required bez MFEM. Oslonieto te odczyty, zachowujac H_EFF przy wylaczonym demag, walidacje argumentow tangent i istniejacy blad unavailable bez providera. MFEM=ON zachowuje warunki wykonania. Niezalezny source review i diff PASS; compile/run CABI nadal NOT VERIFIED do swiezego wykonania GHA. Lokalnie nie kompilowano testow.


## Przygotowany kontrakt ownership - uwaga 4206379813

JSON i CSV otrzymuja additive artifact_set_id oraz session/run/stage/mesh identity, content_digest i revision. artifact_set_id identyfikuje kanoniczny katalog artefaktow (opaque SHA-256), nie jest hashem pliku. Rozne digesty CSV i JSON sa oczekiwane: wzbogacanie punktow wymaga ready, zgodnych niepustych session_id/run_id/artifact_set_id i zgodnych opcjonalnych stage_id/mesh_generation_id. Brak obu opcjonalnych pol jest legalny dla samodzielnego zestawu; brak wymaganej tozsamosci blokuje wzbogacanie. Nie porownuje sie digestow roznych plikow. Rewizje zasobow uwzgledniaja tozsamosc takze przy identycznych bajtach.

Backend odczytuje pliki i path metadata z jednej przechwyconej lokalizacji; przed odpowiedzia ponownie sprawdza sesje, run, stage, mesh i canonical root. Zmiana zwraca 409 frequency_domain_artifact_set_stale. Missing zasoby nie otrzymuja ownership gotowego wyniku. Biezacy kontrakt zaklada niezmiennosc opublikowanych artefaktow; ta poprawka nie zapewnia transakcji wielu plikow przy zapisie do tego samego katalogu.

Zarzadzany non-test OpenAPI codegen PASS: receipt d5a5d8e8fc46466a95c5c4b02419ad20, scoped source SHA256 42cb156e04e27ec628eb3df055ff1daf230fc93d8772ee712c86bbfa593110b0. Typed-client generation PASS: receipt 48b02eee02744e80abe3e735aff21676. Regresje API, modeli, rewizji oraz delayed A/B browser fixture przygotowane; ich wykonanie nadal NOT VERIFIED. Przeglad i kontrola production-source trwaja.

Push commita 9b9db8d7df01d788a0639cd4746f4b71e09ffb34 dwukrotnie odrzucony przez GitHub Internal Server Error (HTTP 500); remote nadal947161f010666cd9e1b2f611d60e8fbb2bd6f8a0. Nie zglasza sie nowego CI dla lokalnego commita.


## Nowe ustalenia z rzeczywistego handoff 3D (poza 207 komentarzami)

- FD-LOCAL-001: branch Plot 3D nie przekazywal point frequency/representation oraz pelnej tozsamosci run/stage/sample/mode. Poprawka panelu przygotowywana z kanonicznym manifest context i fail-closed; source/browser proof nadal wymagany.
- FD-LOCAL-002: canonical field IDs analysis:eigen:sample-...:mode-... przekraczaja 16 bajtow quantityId w FMVP header. Codec nie nadpisuje ID z HTTP, a ModeFieldOverlayIntent wymaga zgodnosci pelnego ID. To wymaga sprawdzenia i naprawy kontraktu transportu po stronie producenta/odbiorcy; krotki sztuczny ID w fixture nie jest dowodem poprawnosci standardowej sciezki. Nie oslabiono binary gate.
- FD-LOCAL-003: mock Inspector nie zapewnial kanonicznych complex metadata/binary v3 i zgodnego hash topology. Wymagane sa 12 wezlow, nComp6, valueCount72, complexPairs36 i zgodna domain/hash/revision. Positive browser handoff pozostaje NOT VERIFIED; obecnego v2 real payload nie traktuje sie jako dowodu modow zespolonych.

Nowy run37642732008 (9b9db8d7df01d788a0639cd4746f4b71e09ffb34) skompilowal backend no-MFEM, po czym wykryl dwie asercje testu przekazujace std::string do contains(const char*, const char*). Dwuliniowa poprawka .c_str() zapisana w7343a21f996f03dc52bfcfff2d1261dd7a9ee1ec; push PASS. Nowe wykonanie CABI nadal wymagane.


## Soft modes - uwaga 4206565211

Usunieto domyslny fizyczny floor 1e5 rad/s (~15.9 kHz). Mapper domyslnie rozpoznaje dokladne zero; jawny absolute ModeKinematicsPolicy pozostaje zachowany. Testy obejmuja signed 1 rad/s i 1 kHz dla obu konwencji fazowych, explicit boundaries, exact zero oraz dense/tiny soft mode1rad/s. Pasma i residual admission pozostaja bez zmian. Nota0831/source-map oddzielaja exact zero od certyfikacji nullspace/Goldstone. Niezalezny source review, AST/diff/JSON PASS; nowy GHA compile/run trzech targetow nadal wymagany.

Run37644130848 dla7343a21f996f03dc52bfcfff2d1261dd7a9ee1ec: kompilacja CABI PASS, test zatrzymal sie na v17 sentinel assembly expectation. BezMFEM poprawny boundary to unavailable/shared_domain_requires_mfem_stack; fixture rozroznia teraz MFEM ON/OFF zachowujac wszystkie walidacje krotkich ogonow i descriptorow. Nie uznaje sie calego testu za zielony.


## Checkpoint ownership po naprawie bledow typow

Managed production-source PASS, terminal receipt874177f6478a4f1c936abb1452667ea9, HEAD0eafe7851b242f7f34d048bf55ed26c28454563f dirty-source snapshot. Test targets zostaly wykluczone. Naprawiono wlasne TypeScript diagnostics array, nieobslugiwany normalization w selection context i literal representation. Niezalezny source review API/model/hooks oraz panel PASS. Context panelu korzysta z rzeczywistego owner result_manifest, nadpisujac producer placeholders current/eigenmodes; wymaga zgodnego session/artifact-set/run/stage. Testy maja admitted baseline i pojedyncze mutacje, nie odrzucaja wszystkich przypadkow przez niezalezny brak k.

Przygotowany etap source/contract nie zamyka browser gate: smoke A/B jest nadal lokalnym WIP do naprawy canonical metadata/binary i pelnego field ID. Nie publikuje sie niezgodnego fixture jako pozytywnego dowodu. API/unit tests maja jawny krok GHA frequency_domain_; ich wykonanie pending. Run37645015791 sprawdza remote0eafe7851 soft modes, a nie nowsze lokalne ownership zmiany.


## Potwierdzone wykonanie regresji soft modes

Run37645015791, source0eafe7851b242f7f34d048bf55ed26c28454563f, native job112873419760: fem_mode_kinematics_contract PASS i fem_floquet_modal_solver_contract PASS. Dowod obejmuje nowy exact-zero mapper, signedsoft frequencies oraz dense/tiny1rad/s. fem_modal_eigen_contract skompilowany, lecz FAIL: JSON key must be present; caly job/workflow nie sa zielone. Production MFEM/SLEPc i fizyczna certyfikacja nullspace pozostaja NOT VERIFIED.

Etap ownership zapisany i wypchniety w8ba0ca4c48691efdbbd0a1ed98495cb0c100f2b6. Jawny CI37645481251 uruchomiony dla tego commita; testy API/unit/browser nadal pending. Niecommitowany smokeA/B, dwa runner-console sourcefiles oczekujace osobnej zgody oraz obca0833 sa zachowane. PR97 pozostaje OPEN; PR102 wczesniej CLOSED. Caly cel nie jest ukonczony.


## Checkpoint 2026-10-08 — nowe uwagi i transport FMVP v5

Rozpatrzono wszystkie 48 nowych komentarzy: 26 duplikatów, 21 nowych błędów
oraz jedną rekomendację niezgodną z kontraktem. Rejestr obejmuje teraz 255
wpisów. Pozostają 102 zasadne nienaprawione uwagi i trzy poprawki oczekujące
CI. PR #102 jest CLOSED; PR #97 pozostaje OPEN. Nie wykonano merge ani
wdrożenia. Cudzy plik 0833 i dwa pliki Runner Console oczekujące zgody są
zachowane poza commitami tych poprawek.

GHA 37645481251 potwierdziło Rust oraz krok ownership artefaktów. Poprawka
93631f89539dc4ee1b1e3cc52e41645a48332f7b usuwa wykazane błędy typu i higieny
API testów. Następny run 37746579551 wykazał utratę kontekstu w mapperze
SelectionRef: commit 8b8c78cd7844620b9a412b5d8dff5325af42e04c zachowuje
artifactRevision, equilibrium, kontekst k, normalizację, źródło oraz
częstotliwość klikniętego punktu. Dokładne asercje pozostają wymagane.

Job 113209380449 wskazał brak shift_omega_rad_s w wyniku tiny-validation.
Commit 676489532d3dae0c4af96a2dbcc1d3a22683968a publikuje je w diagnostics
oraz result przez kanoniczne omega=2*pi*f. Nowe wykonanie CABI jest wymagane.

Uwaga 4207786315: commit 52b065abbc03b9015fd815e7950b45f71719c764 używa
rozwiązanego eigen_tolerance zamiast surowego sentinela 0. Regresja obejmuje
jawne 1e-10 i 0 na rzeczywistej trasie sparse shared-domain MatShell, bez
legacy dense pointers. Przygotowany skrypt providerów obejmuje teraz target
CABI, regex i JUnit, lecz nie potwierdzono aktywnej trasy GHA z MFEM/SLEPc.
Test bez providerów tej gałęzi nie wykonuje: NOT VERIFIED.

FMVP v5/FMMI v4 obejmuje encoder, decoder, overlay i API: pełne ID UTF-8,
porównanie bajtowego prefiksu, opcjonalną kwalifikację źródła, jawny sentinel
braku topologii, odmowę mapowania 409 i ETag zależny od rzeczywistych bajtów.
Starsze wersje 2/3/4 pozostają obsługiwane. Review źródeł i poprawek przeszło.
Rewizja siatki 0 pozostaje legalna; tylko LegacyCountOnly wymaga dokładnego
sentinela i zwraca null dla topologii. Regresja browser A/B używa długiego ID,
complex XYZ dla 12 węzłów i rzeczywistych wywołań uniformu WebGL. Poprawiono
niezgodność sample_id z eksportem CSV. Hash fixture jest zgodnym identyfikatorem
64-hex, a nie dowodem fingerprintu obliczonego przez backend.

| Kontrola | Dowód | Stan |
|---|---|---|
| OpenAPI, bez kompilacji testów | receipt 7b8c7f14f4f94ab3880f5792f62c4bbb | PASS |
| Typowany klient | receipt 27b153f71d704e5e99dd514bc9c60bde | PASS |
| Produkcyjne źródła TypeScript | receipt 2208d2102e774757aefe530602b865d3 | PASS |
| Higiena API | receipt 837a6c817f0f473ca0f72702665803e9 | PASS |
| React Doctor | zarządzana trasa nie znalazła zależności; niczego nie instalowano | NOT VERIFIED |
| Nowe testy jednostkowe/API/browser | przygotowane w GHA | pending |
| Provider MFEM/SLEPc i nauka | brak wymaganego wykonania | NOT VERIFIED |

Kontrole źródeł wykonano sekwencyjnie po odmowie współdzielonej blokady.
Lokalny zakaz kompilacji testów pozostaje zachowany. Zielone źródła nie
zastępują runtime, browser/WebGL ani kwalifikacji naukowej. Cel jest aktywny.

## Checkpoint CI 37756983914 — wymagane dalsze naprawy

Run dla 9a7c61635c00adf44e0b9672834659425cf05bef zakończył się FAILURE.
Control Room contracts, API hygiene, generated API determinism, FDM relaxation
oraz Windows volatile storage przeszły. Nie oznacza to przejścia całej bramki.

Rust job 113243853060 zatrzymał się podczas kompilacji testów: brak importu
FieldVectorIndexing w module tests pliku fields.rs. Commit
d27420c07c0baa2ad46b0b442b4c35b0e4901547 dodaje wyłącznie ten import i ograniczoną
diagnostykę C ABI. Native job 113243853149 przechodzi mode-kinematics i Floquet
modal solver, lecz CABI odrzuca raw_vector_wins. Nowa diagnostyka wypisze status,
błąd i ograniczony JSON przed niezmienioną asercją. Przyczyna produkcyjna nadal
nie została potwierdzona; nie zmieniono solvera na podstawie przypuszczenia.

Browser job 113243853066: timeout przy Plot sample 1 mode 2 in 3D. Przegląd
potwierdził wybór aggregate branches zamiast child branch-0. Korekta fixture
wybiera pojedynczą gałąź i wymaga jej ownera, powierzchni oraz nagłówka. Kontrole
odrzucania obcego run, liczby żądań i rzeczywistego uniformu WebGL pozostają.
Wykonanie poprawionej bramki jest nadal wymagane. Python nadal wykazuje znany
błąd dokładnych warstw siatki; nie pominięto tej regresji.

Hook React Doctor dla 9a7c616 zgłosił 19 ostrzeżeń, score 64/100, przy skanowaniu
bez rozpoznania frameworka. Pełny React Doctor nie jest potwierdzony. Przejrzano
wszystkie wskazane miejsca: kontrolowane URL celowo odrzucają wadliwą konfigurację,
pętle API odczytują zakresy/chunki, a sekwencje fixture sprawdzają zależne kroki UI.
Kilka odczytów pól i diagnostyki błędu mogłoby działać równolegle, lecz są to
sugestie wydajności testu, bez dowodu błędu produktu. Nie dodano suppressions ani
instalacji nowego narzędzia. Testy wykonywane są wyłącznie w GitHub Actions.

PR #97 pozostaje OPEN; nie wykonano merge. Cel nadal aktywny, z niezamkniętymi
uwagami i bramkami runtime/provider/nauki opisanymi wyżej.
### Uwaga 4207786279 — zerowa anizotropia, przygotowana korekta polityki

Zakres to warunek legalności istniejącej trasy FEM CPU, double, strict,
FloquetAirboxCpuSchurSlepc opisanej w 0828-fem-frequency-domain-floquet-demag.md;
nie dodajemy nowej realizacji fizyki. Osie przy dokładnie zerowych Ku1, Ku2,
Kc1, Kc2, Kc3 oraz ich polach nie aktywują energii anizotropii. Planner zachowuje
wszystkie wejściowe dane i provenance; nie zmienia ich na None ani nie uruchamia
fallbacku. Każdy niezerowy współczynnik nadal powoduje istniejący błąd unsupported
local interaction. Celowo nie użyto wspólnego progu 1e-30 predykatów aktywności:
próg przy bramce capability przepuszczałby nieobsługiwaną niezerową interakcję.

Źródła: crates/fullmag-plan/src/fem.rs +
first_unsupported_floquet_airbox_local_interaction; tests.rs +
fem_eigen_floquet_dynamic_demag_requires_explicit_airbox_cpu_path.
Regresja sprawdza zera ze wszystkimi osiami, zachowanie rozwiązanego CPU engine
bez fallbacku oraz odmowę scalar i pojedynczego nodal coefficient 1e-40.
Pokrywający krok dodano do istniejącego bootstrap GHA. Nie zmieniono Python,
IR, OpenAPI ani UI vocabulary. FDM CPU/GPU i FEM GPU pozostają bez zmian.
Source review i wykonanie nowej regresji są jeszcze wymagane; nie podniesiono
statusu walidacji produkcyjnej.
Review wykryło analogiczny guard is_some w runnerze. Poprawiono także
crates/fullmag-runner/src/fem/eigen_shared_domain.rs + validate_shared_domain_modal_scope.
Regresja eigen_tests.rs + shared_domain_modal_scope_rejects_uncertified_local_tangent_terms
obejmuje zera z osiami, scalar oraz nodal 1e-40; krok GHA sprawdza oba poziomy.
Pozostałe A/DMI/surface guards zachowane. Test runtime scope nie zastępuje
wykonania produkcyjnego MFEM/SLEPc.

### Uwaga 4207587066 — poprawka źródeł, runtime nadal wymagany

Commit e74a1e576f8d55198c144fdfaebbfcf5cad6732e zachowuje breakBefore po
odrzuceniu punktu granicznego przez decymację. Dobór ekstremów, endpoints i limit
5000 punktów pozostają; znaczniki przenoszone są na pierwszy zachowany punkt za
luką. Regresje obejmują 10000 punktów/2500 przerw oraz 25000 punktów/6250 przerw,
w tym rzeczywiste odrzucenie pierwszego znacznika i wszystkie zachowane interwały.
Managed production-source receipt dc88351a18fa4c85801c00b1bacd5802: PASS,
unit_tests=not_compiled_not_run. Testy i browser/UI dowód wymagają GHA.

Diagnostyka CABI w 846f253b6eae925810f903755710078a609ec85d, job113257677764,
pokazała cztery przypadkowe wartości około 6.95e-310 i determinant 0 zamiast
zadanych 0,-1,1,0. Przyczyna przekazania bufora pozostaje w diagnozie; nie
zmieniono progu ani macierzy w celu wymuszenia sukcesu.

Run37760001789: API frequency_domain 53 PASS, 2 FAIL (409 mapping fixture i
stary offset body[48..] przy phase view). Inspector przeszedł do wyboru child,
lecz ten węzeł nie jest odnajdywany; aktualny routing fixture nadal wymaga naprawy.
Zerowa anizotropia ma jeszcze blockers w equilibrium identity/descriptor;
przygotowanego planner/scope diffu nie przedstawia się jako pełnej poprawki.
## Checkpoint 2026-10-08 — naprawy kolejnych błędów CI

Przebieg 37761924863 na 3bfff74df potwierdził cały job control-room-contracts
113260177928, w tym regresje zachowania przerw po decymacji. Dowód browser dla
przekroczenia budżetu punktów nadal wymagany. PR97 jest OPEN; PR102 CLOSED,
closedAt=2026-10-07T09:51:33Z. Nie scalono tych PR do master.

Commit e956338dc972ac209816e0127502432584114584 koryguje wcześniej nieprawidłowy
wybór child w fixture: rzeczywisty Explorer ma tylko zbiorczy leaf branches.
Użyto istniejącego przycisku tabeli dyspersji do prawdziwej selekcji branch-0,
z kontrolą owner/surface/h3. Asercje stale ownership są zachowane. Source review
PASS; nie uznaje się tej poprawki za potwierdzoną w przeglądarce bez wyniku CI.

Commit e231d17b3c238686b3e6f1e1c41cb723b3c4cacd poprawia offset wartości FMVP v5
w fixture response oraz usuwa powiązanie pojedynczego globalnego sample z obcą
czterowęzłową siatką. Oczekiwane wartości fazy/statusy pozostają niezmienione.
Native boundary diagnostics zapisano w 843b5e7447079e34355572da920463470cb6f9d5:
wartości macierzy odczytywane są dopiero po rzeczywistym błędzie singular mass,
żeby nie dereferencjonować nieużywanego bufora przed walidacją. Run37762594311
sprawdza wspólnie te źródła; wynik pozostaje pending.

Ponownie pobrano wszystkie 257 inline comments PR97. Trzy wpisy spoza dotychczasowego
rejestru Codex pochodzą od Copilot/React Doctor, zapisane osobno w dodatkowym rejestrze:
4060016735 (zasadny, sanitizer stringów JSON nadal wymaga poprawki), 4206086548
(przygotowano guardy find w skrypcie envelope), 4206086557 (sugestia dev/HMR bez
potwierdzonego błędu produkcyjnego, odłożona). Dodatkowych rekomendacji nie przedstawia
się jako nowych uwag Codex ani jako ukończonej walidacji.

Poprawka 4207786279 pozostaje WIP: identity i descriptor rozróżniają dokładne zero,
ale regresje rzeczywistego payload buildera i cloud execution są nadal wymagane.
Historyczne uniform-Ms Ku=0 preimages pozostają V2; nie przeprowadzono cichej migracji
podpisów istniejących artefaktów. Niezerowy K0 Ku zachowuje wcześniejsze wymagania.
Run37762594311 zatrzymał kompilację CABI na błędnej nazwie bufora dodanej do
probe fixture. Commit185ce9be37b67e1d8a031bdd75869077287e3df4 koryguje sześć odwołań
do istniejącego gyrotropic_mass_row_major. Run37763186739 sprawdza zmienione źródło.
Brak wykonania diagnostyki w pierwszym runie nie jest dowodem niepoprawnego ABI.

### Domknięcie źródeł 4207786279 — oczekuje CI

Source review pełnych sześciu plików PASS. Spójny guard dokładnego nonzero
obowiązuje w plannerze i runtime scope. Identity przyjmuje nowo legalne zera z
nodalnym Ms lub zerową osią, zachowując historyczne legalne uniform-Ms V2 preimages.
Payload filtruje Ku=0, więc nie tworzy tablic, digestu ani bitu aktywnego członu.
Regresja korzysta ze standardowego verifiera exact-artifact handoff oraz rzeczywistych
builderów linearization i native payload. Siatka testu ma 16 węzłów, osiem magnetycznych.
Wszystkie nowe testy podpięto do GHA, w tym zachowanie historycznego podpisu.
Certyfikat jest syntetycznym wejściem kontraktu testowego; nie dowodzi produkcyjnego
recompute, MFEM/SLEPc ani kwalifikacji naukowej. Lokalne testy pozostają zakazane.

4207587037: commit eb15c06a84afc49fb3079b59fc40cea15b82ea72 przywraca dostępność
zachowanej fizycznej historii skalarnej i wartości run manifest mimo modal latest step.
Modal-only negative pozostaje unavailable. Trzy regresje używają build_quantities;
nowy filtr quantities::tests podpięto do dotychczasowej bramki cloud.

CABI run37763186739: masa fixture 0,-1,1,0, lecz request pointer różni się od
adresu fixture, a adapter kopiuje ten sam błędny pointer. Dodano strict pre-call
pointer assertions, żeby następne wykonanie rozdzieliło konstrukcję requestu od
nadpisania w C ABI. Nie zmieniono physics/threshold w odpowiedzi na uszkodzone dane.
## Checkpoint 2026-10-08 — rtol i typowana dostępność modu

4207979056: commit 06d850befca9606ed860ee4b3857b44cd122186a odrzuca booleany
jako residual_tolerance przed konwersją float. Regresja sprawdza True/False,
dodatnią wartość, obydwa limity, serialization i puste defaults. AST i source
review PASS; wykonanie należy do existing Python API GHA, nie uruchamiano go lokalnie.

4207587048: commit 842f09b9b6475afeed84f35a396e0f2fa5c32639 dodaje Option<bool>
do spectrum-v3 i field-sweep. String false jest odrzucany, jawne false blokuje field_ref;
absent/null zachowuje stary adapter fallback bez nowego wymogu mesh dla v3.
Dopisano jawne filtry czterech nowych/zmienionych testów. Test OpenAPI sprawdza
rzeczywisty typ boolean|null, a nie błędne type.as_str(); pole pozostaje optional.

| Kontrola źródeł bez testów | Terminal receipt | Wynik |
|---|---|---|
| OpenAPI | 53d03dc4be304a35bb635b9334890852 | PASS |
| Wygenerowany klient | 91a65f682d9c44d88a6426493e8d41dd | PASS |
| Produkcyjny TypeScript | 53267239763f44789e04be6f0533dc7d | PASS |

Pierwsza próba codegen odmówiła z powodu aktywnego lease storage; niczego nie
odblokowywano ani nie przenoszono. Powtórzono ją po rzeczywistym released state
w ramach tej samej managed route i istniejącego target/cache. Brak testów i nauki
w powyższych receipts; nie przypisuje się source gate zakresu runtime.

GHA37764235204: planner i runtime-scope testy 4207786279 przeszły; identity suite
6 PASS/2 FAIL. Naprawiono fixture Ms=0 przez dodatnie 800000 A/m. Producer golden
9b1829… dotyczy niezmienionej gałęzi normalizacji/serializacji historycznego Ku=0.
Odrębny replay golden 5aff2c… zachowano dla jego dokładnych zapisanych bajtów,
które nie są ponowną normalizacją osi producenta. Nie zmieniono produkcyjnych
reguł ani hashingu w odpowiedzi na błędne oczekiwania testów.

CABI pre-call asercja wykazała błędny pointer jeszcze przed raw_vector_wins solve,
lecz po wcześniejszych invalid cases. Przygotowany checker mierzy factory przed
pierwszym wywołaniem, input mutation, solve i destroy; nie dereferencjonuje pointerów.
Przyczyna produkcyjna/kompilatorowa pozostaje NOT PROVEN.

Browser negative ownership próbował wybrać mode-view mimo braku active overlay,
gdy taki child zgodnie z builderem nie istnieje. Wybiera teraz istniejący object
Visualization; zachowano stale Plot disabled, zdrowy canvas, brak obcego uniformu
oraz brak requestu candidate field. Dodatnia ścieżka run B z prawdziwym overlay
pozostaje. Wymagane świeże GHA po korektach fixture.
Run37767620729 zatrzymał CABI już w phase=construction pierwszego requestu, przed
jakimkolwiek C ABI call w tej funkcji. Jawne pointer init-captures factory/checkera
zastępują implicit captures tablic. Bufory pozostają zewnętrzne i żywe przez
cały test; wszystkie niezależne asercje bezpośredniego bindingu oraz solve/destroy
zachowano. Source review PASS; przyczyna kompilatorowa NOT PROVEN, skuteczność
naprawy wymaga świeżego GHA. Macierze i physics nie zostały zmienione.

## Checkpoint — potwierdzone source contracts i sanitizer GPU

Run37768262448, SHA436b75a565115dfdeda56b3be8198a9bf14524dd:
4207786279 ma pokrycie planera, runtime scope, identity (8 PASS) i rzeczywistego
shared-domain payload buildera (PASS), job113281142319. Nie jest to produkcyjny
recompute ani dowód MFEM/GPU fizyki. 4207979056: Python API314 PASS, 1 skipped,
w tym dokładny bool-rtol test, job113281142692. Te dwie uwagi mają teraz status
implemented dla ich kontraktowego zakresu; całe workflow nadal FAILURE.

Jawny binding fixture przeszedł raw-wavevector validation. Kolejne zatrzymanie
CABI: gated-operator diagnostics oczekuje production_cpu_modal_gated_operator_terms_present.
Nie osłabiono warunku. Bounded print ujawni status, include_demag, periodic count
oraz oba JSON-y; źródło nie uzasadnia zmiany oczekiwania bez rzeczywistego powodu.
API frequency_domain_ ma 54 PASS i jeden błąd missing-metadata response text.
Dodano body do tej samej asercji, pozostawiając oczekiwany status i powód.

Dodatkowa uwaga4060016735: pure nonfinite_json_sanitizer.hpp zachowuje quoted
string/key bytes i escapes, zastępując wyłącznie kompletne niecytowane nan/inf
oraz ich ujemne warianty przez null. Preflight sprawdza terminator, quote closure
oraz łączny growth przed mutacją. Przy braku capacity nie zapisuje pozornego zera.
Obydwa GPU callsites przechodzą do artifact_error, complete:false i jawnego reason;
returned status nie jest nadpisywany. Fallback ma dotychczasowy schema GPU.
Helper normalizuje tokeny; nie jest pełnym walidatorem składni JSON.

Source review helpera, obu callerów i scoped testów PASS. Kontrakt pure helpera
wykonuje się pierwszy w CABI main, przed niezależnym failing Floquet testem, ze
znacznikiem PASS. Pokrywa quoted/escaped text, token boundaries, exact/spare
capacity, missing terminator, malformed quote i null pointer. Unit GHA oraz
kompilacja/provider GPU nadal wymagane; nie wykonano lokalnych testów/buildów.
Do dokumentu nie przypisuje się nieistniejącej naukowej kwalifikacji.
### FD-LOCAL004 — błędny dowód materializacji dynamic_demag

Run37770932283, SHAeb2693f7a2270dc9251501e2f6f5c319dd222775, native job113290040434:
pure bounded JSON sanitizer contract PASS, a następnie CABI gated-operator FAIL.
Rzeczywisty diagnostic: include_demag=0, brak dense demag payloadu, label dynamic_demag;
nie wykonano oczekiwanego term gate, tylko przejście do slepc_not_available.

Źródło production_cpu_modal_eigen.cpp + dynamic_demag_k_payload_is_consistent zwraca
true przy nieobecnym opcjonalnym payloadzie — to poprawna semantyka walidacji
opcjonalności, lecz nie dowód materializacji. modal_request_gated_operator_term
sprawdza teraz deklarację i spójność oddzielnie. Zachowano owned shared-domain
Floquet operator, który nie korzysta z dense demag matrix. Nie zmieniono globalnego
validatora, fizycznych macierzy, tolerancji ani gated-term assertions.

Source review PASS. Istniejący negative CABI pokrywa label bez materializacji;
MFEM/SLEPc shared-domain positive/provider pozostaje NOT VERIFIED i wymaga
rzeczywistego operatora, nie fikcyjnego pointera. Poprawka jest policy-only dla
istniejącej realizacji opisanej w 0828-fem-frequency-domain-floquet-demag.md.

Sanitizer ma rzeczywisty dowód pure-helper compile/run. Oba callsites GPU mają
source review status propagation; kompilacja z providerem GPU i kwalifikacja
fizyczna nadal NOT VERIFIED. Nie utożsamia się znaczników PASS z zielonym całym CI.
### Checkpoint 08.10 — CI 37771858494 i akcja CPU

CI dla 1b8a08bf72f665ef147a54fb909e56195f520540 zakończone FAILURE.
Native job 113293130327 przeszedł naprawiony gated-operator test; zatrzymanie
nastąpiło w teście bezpośredniej akcji Poisson-airbox shift-invert CPU.
Źródło src/frequency_domain/modal_eigen_solver.cpp wywołuje referencyjną akcję
CPU bez bramki SLEPc. Poprawiono tylko nieaktualną asercję OFF; status OK oraz
zawartość artefaktu pozostają wymagane. Commit:
fe7852d9838821cbd1f6d0132be0df2e7cc5a6d7, wypchnięty na branch PR97.
Weryfikacja wykonania: oczekuje na GitHub Actions 37774134308.
Nie wykonano lokalnych testów ani kompilacji.

Rust job 113293130194 zatrzymał się wcześniej niż frequency_domain_:
openapi_mode_field_availability_is_optional_boolean nie znalazł właściwości
w wybranym schemacie. Nie oznacza to braku bool w wygenerowanym OpenAPI;
trwa sprawdzenie nawigacji po rzeczywistym schemacie. Nie zaliczono quantity
ani pozostałych filtrów na podstawie tego runu.
Browser job 113293130343: timeout oczekiwanej odpowiedzi vector dla matched
run B, smoke-inspector.mjs:1601. Diagnostyka w toku; bramka WebGL i ownership
pozostaje NOT VERIFIED. PR97 pozostaje OPEN, pełny cel nieukończony.

Dalszy review schematu: snapshot OpenAPI obu modeli zawiera pole w inline
properties elementu allOf. Poprawiony test przegląda root i elementy allOf,
zachowując dokładny typ boolean/null i brak required. Produkcji nie zmieniono.

### Review4060687869 — powiązanie metadanych z przypadkiem

Certyfikat modalny sprawdza teraz containment jawnie przekazanego metadata_path
przed odczytem i hashowaniem, a następnie używa istniejącej kontroli względnej
ścieżki i reparse points. Zewnętrzny plik oraz traversal nie mogą certyfikować
lokalnego wyniku. Parametry fizyczne, tolerancje i konwencja Floqueta bez zmian.
Regresje obejmują plik zewnętrzny, ../ oraz poprawny jawny plik w case_dir.
Suite dodano do workflow dispersion-artifact-consumers. Diff/source review PASS;
wykonanie wyłącznie GHA pozostaje wymagane. Nie oznaczono kwalifikacji naukowej.

Dowód bieżący: bootstrap37774275871 / 9c276141208e11f70ec713fefcaf1740077b6270,
job113301125883 native-modal-cabi-contract SUCCESS. Zakres: dependency-free
native CABI, nie MFEM/SLEPc/GPU execution ani kwalifikacja fizyki.
Certyfikat: a2f2fd5e666abefc8517e04067a126acccb62d43 na remote;
workflow37774715764 dispersion-artifact-consumers rozpoczęty, wynik oczekiwany.

Certyfikat: workflow37774715764 / job113302569874 SUCCESS. Log potwierdza
wykonanie test_comsol_modal_field_certificate.py razem z trzema suite consumers:
54 passed, 22 subtests passed. Review4060687869: implemented w tym zakresie.

### Review4060687829 — walidacja dry-run benchmarku

Tryb podglądu korzysta z tego samego _new_output_dir co wykonanie, z persist=False.
Waliduje canonical storage, containment, reparse oraz nieistnienie celu; nie tworzy
rodziców ani runtime-reference root. Plan nie akceptuje już obcego/existing celu,
więc _compose_command nie zapisuje override do wskazanego istniejącego folderu.
Dodano regresje braku zapisów/rejestracji, foreign/existing rejection i odmowy
przed compose plan. Suite włączono do dispersion-artifact-consumers GHA.
Source/diff review PASS; wykonanie CI oczekiwane. Nie wykonano lokalnych testów.

### Review4060116361 — CUDA driver selection

Usunięto stubs hint z source-facade contracts. Wspólny selektor sprawdza
istniejący bezwzględny plik oraz segment stubs w supplied path i REALPATH,
także dla cache. Real compat/system driver i import libraries poza stubs
pozostają legalne. Configure fixture wywołuje rzeczywisty moduł produkcyjny;
sprawdza odmowy, cached/symlink stubs i wybrany INTERFACE_LINK_LIBRARIES.
CMake minimum3.18, jawny generator/build-tool path, brak narzędzi jest błędem.
Source review i AST/diff PASS. GHA configure, real driver link/load i managed
runtime nie są jeszcze potwierdzone. Nie wykonano lokalnych testów/buildów.

Bootstrap37774275871: typed field availability i trzy regresje retained scalar
PASS w job113301126219. Job dalej FAILURE przez stale catalog count53 vs56;
poprawka cdb018997 porównuje pełne canonical IDs i unikalność zamiast stałej.
Dry-run suite37775759392: 77PASS37subtests, jeden starszy lifecycle fixtureFAIL
przed scientific gate przez brak modelu/runtime binding. Fixture uzupełniono
w053e5e869; production gates nie zmieniono, mock nie stanowi physics proof.

CUDA proof: run37777057359 / SHA69104903e / native job113310469941 SUCCESS.
Log: dziewięć configure regresji, OK, bez skips; późniejszy CABI również SUCCESS.
Review4060116361 implemented w zakresie selekcji ścieżek. Pliki fixture nie
stanowią rzeczywistych bibliotek drivera; managed link/loader nadal NOT VERIFIED.

### Review4060116330 — deadline inspekcji obrazu

Docker image inspect używa teraz istniejącego 30s lifecycle deadline.
TimeoutExpired staje się jawnym BenchmarkError, który wywołujący obsługuje po
zwolnieniu kontekstów lock/use. Nie zmieniono immutable digest/volume checks.
Regresja sprawdza argument timeout i kontrolowany failure przy jego przekroczeniu.
Source/diff review PASS; wykonanie w artifact-consumers GHA oczekiwane.

Doprecyzowanie browser37775325905: trace wyklucza tylko wektor o oczekiwanym ID,
nie wszystkie field requests. Wewnętrzny timeout60s może dotyczyć wyboru Inspector
node przed wait30s na uniform. Metadata fixture spełnia aktualny predicate;
resource race nie jest udowodniony. Dalsza diagnostyka zachowa stack i phase marker.

### Review4060116295 — SI jakości dwóch ring routes

Konwersja volume_min/max/mean/std i element_volume przez S^-3 jest wspólna
(global/per-domain), kopiuje raport i nie zmienia znaków, SICN/gamma, markerów
ani kolejności. Cylinder liczy już jakość na nodes SI i nie jest skalowany.
Source review PASS. Nowe testy porównują rzeczywiste obie ring routes z
abs(det)/6 na końcowych nodes SI, z atol=0, oraz cylinder przeciw podwójnemu
skalowaniu; helper ma kontrolę niemutowania wejścia. Gmsh execution w GHA
pozostaje oczekiwane. Exact-layer scoped bug jest odrębny i nie jest naprawiony.

Deadline Docker: artifact-consumers37777723528 job113312698784 SUCCESS na
eab985d7a. To regresja kontraktu subprocess timeout, nie test zawieszonego demona.

SI execution proof: GHA37778512534 job113315395758 na a0999b68c SUCCESS,
84PASS37subtests, suite zawiera test_gmsh_quality_units.py bez skips. Rzeczywiste
coincident/general ring i cylinder kontrolny zgadzają objętości z nodes SI.
Review4060116295 implemented. To dowód jednostek mesher metadata, nie obliczeń
dyspersji/solver provider ani naukowej kwalifikacji zbieżności.

### Review4061061326 — prawdziwa provenance porównania

Obaj producerzy rozróżniają numeric_modal_solver (native bez comparison) oraz
numeric_modal_solver_with_analytic_comparison (z validation). Reference bez
comparison zachowuje null. Model referencyjny wymagany tylko dla comparison,
a dla numeric-only musi być null. Reader zachowuje starsze analytic-reference
artefakty; zgodność odczytu nie stanowi kwalifikacji naukowej. COMSOL scientific
gate nie został osłabiony. Nie zmieniono wersji schematu ani ścieżki solvera.
Source review PASS po przywróceniu compatibility. GHA obejmuje obu producerów,
pięć specific verifier regresji i evidence writer. Wykonanie oczekiwane.

Nowy browser trace37778366459 wskazał expandInspectorNode: selected parent
model:object:film:visualization. Potwierdzony source defect: pointerdown SVG
nie przechodził HTMLElement guard, a click handler był tylko na Chevron SVG,
nie całym branch hitbox. Poprawka event routing jest przygotowywana; pozytywny
matched-B overlay/vector/WebGL nadal NOT VERIFIED.

### Lokalna poprawka GUI — hitbox gałęzi i SVG

ExplorerTreeView pointerdown rozpoznaje Element, więc również SVGElement.
Click handler na całym non-leaf branch hitbox zatrzymuje propagację i rozwija
węzeł; leaf selection i obsługa klawiatury pozostają bez zmian. Test DOM renderuje
rzeczywisty komponent, rozróżnia SVG od HTMLElement, klika ikonę i pusty hitbox,
sprawdza widoczność dziecka oraz brak selekcji rodzica. Source/diff review PASS.
Vitest node discovery i pełny frontend gate obejmują nowy test; lokalnych testów
ani browsera nie wykonano. Matched-B overlay/vector/WebGL wymagają nowego GHA.
Nie uznaje się source fix za dowód zamknięcia błędu przeglądarkowego.

Provenance consumers37779797737 job113319716629 SUCCESS na64bced443:
5 targeted verifier testsPASS, 85artifact/mesher tests37subtestsPASS. Actual Rust
producer regresje w bootstrap37779798714 nadal oczekują wykonania.

### Fundament deduplikacji — ścisła akcja masy

Dodano wewnętrzne API z callbackiem geometrycznej masy i jawnymi statusami błędu.
Porównanie używa normowanych kopii, publikowany kandydat zachowuje oryginalną
amplitudę/residual/source index. Brak lub zła metryka nie daje identity fallback.
Self norm jest positive/finite, Hermitian roundoff względny bez progu jednostek SI.
Review usunęło odtwarzanie surowej normy (overflow/underflow); regresje obejmują
phase copies, prawdziwą degenerację masowo ortogonalną, CSR/dense i skale1e±300.
Source review PASS; cloud C++ contract wykonanie oczekiwane. Legacy API pozostaje
bez zmian. To nie zamyka review4060116218/4061061308/4060687822: jeszcze trzeba
podłączyć owned mass, finalizer przed cap, target selection i bounded refill.

Provenance producer proof: bootstrap37779798714 Rust job113319727666 SUCCESS.
Log potwierdza actual_path_manifest_distinguishes_numeric_solve_from_comparison
oraz native_modal_manifest_distinguishes_numeric_solve_from_comparison PASS.
Review4061061326 implemented (producer+consumer contracts), nie physics qualification.
GUI f614 trace potwierdza wybrany mode-visualization, a timeout przeszedł z expand
na wait-wavevector-uniform. SVG event fix rozwiązał tę część; admission viewportu
przed binary nadal wymaga diagnozy. Pełny browser gate pozostaje NOT VERIFIED.

### Fundament owned Floquet mass — źródła, nie wykonanie provider

Assembly składa pełną geometryczną consistent P1 mass i redukuje C^HMC.
Macierz nie jest blokiem Bqq, bez Ms/gamma; obejmuje physical slave nodes
oraz intercomponent frame dot products. DTO pożycza reducedCSR z tego samego
owned lifetime. Pełna macierz może mieć zerowe air/inactive rows; dodatniość
dotyczy aktywnej reduced magnetic space, nie całego padded full space.
Source review PASS. Independent tet4/prism6 phase/frame oracle dodany pod
FULLMAG_HAS_MFEM_STACK. No-provider CI nie jest dowodem jego wykonania.
GitHub repo runners=[]: istniejący self-hosted fem-managed route niedostępny.
Trwa ustalenie GitHub-hosted MFEM proof; zakaz lokalnej kompilacji testów zachowany.
Fixture air/inactive/pinned reduction nadal potrzebna przed pełną admission claim.
Solver/finalizer jeszcze nie konsumuje nowej metryki; trzy uwagi mode selection
pozostają otwarte do integracji, cap ordering/refill oraz real-pencil regresji.

### Browser root cause — brak strong ETag w topology fixture

Trace37785083142: ownership compatible, enabled/intent/session true, topologyCurrent
true, ale hasTopology=false/identity incomplete. Produkcyjny requestTopologyChunked
odrzuca header FMMT bez strong ETag przed decode. Fixture fulfilTopology wysyłał206
z Content-Range bez ETag. Dodano ETag z istniejących generation/revision/fingerprint
manifestu do200 i każdego206. Production identity/admission nie zostały osłabione.
Source/node/diff review PASS; positive overlay/vector/uniform proof oczekiwany GHA.

### Checkpoint 08.10 — weryfikacja provider MFEM i ponowienie browser CI

PR97 nadal OPEN; odświeżona lista zawiera 257 komentarzy inline. Brak nowych
review Codex po ostatnio sklasyfikowanych wpisach. PR102 pozostaje zamknięty.
Bootstrap37789659042 na7ec5ae9de: Rust, Control Room, native C ABI i determinism
przeszły. Browser job113353350442 zakończył się błędem parsera TLS Node/Undici
przed wykonaniem smoke; ponowiono wyłącznie ten job po terminalnym stanie runa.
Nowy handle browser113361219462 jest aktywny. Strong ETag fixture i pełny
matched-B overlay/vector/uniform/WebGL pozostają NOT VERIFIED do jego wyniku.

Python job113361281190 ujawnił realny błąd exact-layer realization:
`test_direct_layered_box_region_floor_beats_eligible_upper_actual_density`
żąda2warstw filmu, lecz scoped branch generuje41przedziałów z. Diagnoza dotyczy
swobodnego meshingu 3D po GEO partition, bez ograniczenia węzłów do zadanych
płaszczyzn. Nie zmieniono oczekiwań testu ani nie pominięto regresji.

Nowa trasa GHA buduje tylko CPU MFEM assembly contract z dwoma zadaniami
kompilacji, canonical storage resolverem i lease. Wymaga rzeczywistego macro
MFEM, dokładnie jednego passing CTest oraz znacznika po oracle. Receipt wiąże
SHA, obraz i biblioteki. Review wymagało porównania HEAD z GITHUB_SHA, ponownej
kontroli źródeł oraz overall failed po błędzie finalizacji ownera. Wykonanie tej
trasy i kwalifikacja fizyki pozostają NOT VERIFIED; nie jest to SLEPc/runtime proof.

### Wynik browser replay i poprawka transportu sesji

Browser113361219462: główny smoke i negative control PASS, ale Inspector modal
handoff FAIL. Trace ma już hasTopology=true i identityComplete=true, ownership
compatible; actual controller error: Headers Invalid value. Potwierdzona przyczyna:
modeFieldOverlayResources używał sessionResourceIdentityKey z separatorami NUL
jako x-fullmag-session-scope. Zastosowano istniejący sessionRequestScopeKey,
który zachowuje sessionId/epoch/request_scope_epoch w formacie transportowym.
Nie zmieniono bramek ownership ani metadanych; existing Inspector browser gate
jest regresją tego rzeczywistego błędu. Pozytywny modal handoff nadal NOT VERIFIED.

Trasa MFEM source contract zapisana i wysłana jako
0f6da649a40cc863600e78825bc6c472053e7269. Wykonanie oracle oczekiwane w GHA.

GitHub odrzucił bezpośredni dispatch nowego workflow MFEM (404: brak na default
branch); PR97 ma mergeStateStatus=DIRTY, więc push nie uruchamia workflow PR.
Dodano selektywny dispatch istniejącego bootstrap: domyślny bootstrap zachowuje
wszystkie kontrole; positive-mass uruchamia wyłącznie reusable MFEM contract;
browser uruchamia tylko browser smoke dla nowej poprawki transportowej.
Nie scala to PR, nie zmienia mastera i nie wymaga lokalnej kompilacji testów.
Poprawka transportu opublikowana jako32ba085b491a1fd01f0f6a71f57edb61009b3013.

Selektywny routing opublikowany jako56934a2cbb1ff8c6466ff402ec91aed11507e54a.
Potwierdzone aktywne handles: MFEM run37793696182/job113367486128;
GUI run37793702278/job113367511792. Wymagany jest ich terminalny wynik i odczyt
rzeczywistych oracle/overlay dowodów, nie sam status started.

### Checkpoint następnego wykonania — transport naprawiony, render nadal otwarty

GUI run37793702278/job113367511792 zakończony FAILURE w Inspector gate.
Main smoke, negative control i viewport audits PASS. Modal field metadata GET200,
field vector GET200 oraz resource controller ready potwierdzają naprawę nagłówka
sesji. Topology complete i owner compatible. Brak wavevectorUniform oznacza
kolejny problem w render handoff; pozytywny modal overlay nadal NOT VERIFIED.
Nie ponowiono tego samego nieudanego joba bez nowej diagnozy/zmiany.
MFEM run37793696182/job113367486128 nadal IN_PROGRESS w dependency build/test.

Review finalizera Floquet potwierdziło source_index i fizyczną kolejność selekcji,
ale wskazało niedeterministyczną fixture SLEPc: requested2/NEV4 może wyczerpać
budżet na kopiach pierwszych modów. Regresja jest poprawiana przez deterministyczne
wywołanie tego samego finalizera; nie zastępuje to brakującego bounded NEV refill.

### Dowód wykonania finalizera — 08.10

Commit082295567367c31d81b26e1904a8a627dc1d24cf opublikowany na branchu zadania.
GHA run37795426460/job113373527111 SUCCESS: rzeczywiste CMake build i CTest
wykonały fem_floquet_modal_solver_contract oraz modal_eigen i mode_kinematics;
3/3 PASS. Nowa deterministyczna regresja jest bezwarunkowo zarejestrowana w main,
poza guardem SLEPc. Jest dowód wykonania strict CSR mass finalizera i preserved
q/phi/certificates; nie dowód wykonania EPS ani full-window merge/refill.
Uwagi4060116218/4061061308/4060687822 nadal otwarte w całym swoim zakresie.

Kolejny render defect: globalny modal buffer ma complex/k, lecz per-target surface
wybiera part buffer bez tego attachment, potencjalnie zachowując starsze scoped
pole time-domain. Poprawka obejmuje actual target surface routing i regresję ze
scoped buffers; nie zmienia widoczności ani nie wymusza globalnie shaderów.
CPU-SLEPc cloud route jest przygotowywana ze wspólną orkiestracją i istniejącymi
pinami providerów; nie zastępuje ani nie restartuje aktywnego MFEM runa.

### Provider MFEM — oracle PASS, starsza fixture count FAIL

Run37793696182/job113367486128 zakończony FAILURE. Artefakt logu pokazuje
PASS: floquet_positive_tangent_mass_matches_independent_phase_reduction,
a później FAIL starszej asercji quadrature element_count. Producent liczy wszystkie
aktywne elementy; fixture Cartesian tetrahedral cube ma maskę wszystkich mesh.GetNE(),
ale test szukał hardcoded1. Poprawiono tylko test: expected=liczba jedynek maski,
dokładny global count i dokładny count w tet4 entry (bez dopasowania prefiksu).
Mixed fixture z jednym aktywnym prism pozostaje zachowana. Source review PASS;
cały provider target wymaga ponownego wykonania na nowym SHA.

### Native frequency-window merge — poprawka źródeł, provider pending

Agregator production_cpu_modal_eigen.cpp przekazuje całą pulę certyfikowanych
kandydatów do owned CSR mass finalizera z lokalnym limitem równym puli, a potem
zachowuje dotychczasowe ascending-frequency/window cap. Strict failure staje się
hard failure bez utraty wcześniejszego subwindow reason. Native branch nie ma
dense mass ani identity fallback; diagnostyka wskazuje positive tangent mass
oraz provided_complex_csr. Generic adapter i bounded NEV refill pozostają otwarte.
Dopisano guarded MFEM+SLEPc regresję publicznego ABI window entry na istniejącym
shared-domain fixture: metric provenance, exact cap, descriptor certificate i
window_complete:false. Source review PASS; wykonanie provider nadal oczekiwane.

Review GUI zatrzymało commit na dwóch realnych błędach nowego patcha:
nieistniejącym snapshot.binaryResourceKey oraz raw nodal complex arrays użytych
dla face-expanded/averaged projections. Poprawka zachowa canonical resource key
i projekcje surface_faces/thickness_average_z wraz z matching Re/Im mapping.
Nie opublikowano patcha GUI z tymi blockerami.

Native merge opublikowany jakoe0baa35bafe94813d8cc9d5db5aeb84ee1bf5594.
GHA run37798318950 SUCCESS na tym SHA potwierdza kompilację gałęzi i istniejące
no-provider kontrakty. Guarded MFEM+SLEPc window ABI regression nie wykonał się
w tym profilu; dlatego nie jest to dowód integracji SLEPc ani zamknięcia finding.
Nowy positive-mass run37797035215/job113379085747 nadal IN_PROGRESS na poprawionej
fixture count. PR97 OPEN, mergeState DIRTY; inline inventory nadal257 wpisów.

### MFEM provider gate zakończony — przygotowana trasa SLEPc

Run37797035215/job113379085747 SUCCESS na e570d4c957674724be7cb7990ca0de25aee1c156.
Receipt passed, source fencing before/after=true, MFEM compile macro observed,
assertion marker observed, CTest1/1PASS, owner completed. Jest dowód assembly i
niezależnej redukcji phase/frame mass. Nie jest to EPS/window/runtime proof.

Zreviewowany opt-in profil CPU-SLEPc używa istniejących pełnych pinów PETSc3.24.6
/SLEPc3.24.3, real double i CPU HYPRE prefix; CUDA/FEM GPU OFF. Wspólna orkiestracja
zachowuje storage/fencing/lease/terminal receipt, wybiera dokładnie dwa targety
modal_eigen i floquet_modal_solver z wymaganymi markerami/macros. Domyślna trasa
positive-mass pozostaje bez SLEPc; browser scope obejmuje teraz także pełny gate
Control Room dla nowych źródeł GUI. Nowy profil wymaga rzeczywistego GHA przed
jakimkolwiek twierdzeniem o build/link/solver/provider qualification.

### Modal per-target rendering — poprawka po drugim review

Zreviewowany patch wylicza canonical resource key z validated metadata/query,
nie z nieistniejącego pola snapshotu. Per-target complex Re/Im mają to samo
mapowanie world-Z columns/face averaging i kolejność face-expanded vertices co
scalar projection dla surface_faces oraz thickness_average_z. Active intent
blokuje starsze scoped time fields i chunked overrides także przed binary ready.
Regresje używają rzeczywistego target surface resolvera, sprawdzają długości,
średnie, phase/k/owner identity oraz zachowanie non-modal baseline. Source review
PASS, parser Node PASS; types/Vitest/browser/WebGL wymagają świeżego GHA.
CPU-SLEPc run37800314609/job113390449283 potwierdzony IN_PROGRESS; nie ponowiono.

GUI57bf6f566 run37800829433 zakończony FAILURE przed browser runtime: dwa TS
błędy nullable phase w per-target attachment. Dodano phase!==null guard zgodny
z globalnym attachComplexShaderValuesByMode; nie wybrano arbitralnej fazy0.
Source review PASS. Types/Vitest/browser wymagają nowego GHA na poprawionym SHA.
Hook React Doctor79/100 zgłosił dwa await-in-loop; sourceHEAD~1 potwierdza, że są
to istniejące yieldToMain pętle chunking/cancellation, bez nowego await w patchu.
Nie usuwano yieldów ani nie tłumiono diagnostyki.
CPU-SLEPc run37800314609/job113390449283 nadal IN_PROGRESS; nie restartowano go.

GUI69c2e0cd2 run37801898690: production typecheck PASS; lint FAIL z powodu
jednego zduplikowanego analysisFieldIntent dependency. Browser przechodzi
matched-B modal metadata/vector/shader-uniform handoff, a potem zatrzymuje się
na nieobsłużonym fixture GET eigen/modes/1/2 przed resetem kolejnego przypadku.
Usunięto wyłącznie duplicate dep (pozostaje wcześniejszy wpis). Dodano canonical
mode-detail route z danych istniejącej branches fixture, tym samym ownerem i
rzeczywistym artifact path/schema. Nieobecny punkt daje missing, nie zawsze-ready.
Browser error assertion pozostaje bez osłabienia. Source review/Node parse PASS;
świeży pełny browser/types/Vitest gate wymagany.

CPU-SLEPc run37800314609 zakończony FAILURE podczas budowania obrazu, przed
CMake/CTest. PETSc skonfigurowany i zbudowany; SLEPc configure wskazuje komendę
make bez PETSC_ARCH, lecz obraz wymusza pusty PETSC_ARCH, co prowadzi do braku
slepc/conf/slepcrules. Pinned-source diagnoza i korekta build-arch handling trwają.
Nie jest to dowód błędu eigen solvera ani wykonania jego nowych regresji.
GUI2f2236bcb rerun37803740912 obejmuje nowe mode-detail fixture i lint fix.
Scope4060116242 jest potwierdzonym Python->Rust IR drop; docs nie definiują
runtime różnicy global/per_sample. Zadano pytanie o publiczny kontrakt artefaktów;
nie wdrażamy arbitralnie odmowy global ani nowego layoutu bez tej decyzji.

ControlRoom37803740912/job113402451173: types i lint PASS, Vitest FAIL wyłącznie
w dwóch nowych expectation: fixture ma Re_y=2 we wszystkich węzłach, lecz test
oczekiwał średniej Im_x=4/5 jako Re_y. Korekta niezależnej arytmetyki: real
[3,2,3] dla face i [4,2,3] dla thickness; imaginary nadal[4,0,0]/[5,0,0].
Source review potwierdziło interleaved layout i world-Z column nodes0/3.
Nie zmieniono algorytmu ani nie osłabiono sprawdzania projekcji.

Pinned-source arch correction reviewed: PETSC_ARCH jest unset w configure/make,
generated installed-arch oraz reguły są sprawdzane; runner zapisuje observed arch
bez runtime empty override. To korekta route, nowy build wciąż wymagany.
Browser37803740912/job113402451478 SUCCESS dowodzi matched modal handoff/canvas,
ale review coverage nie znalazło specyficznych browser prób dla ośmiu chart findings.
Ich jawne Vitest regresje PASS w tym samym runie; pozostają pending_browser,
nie promowano ich wyłącznie na podstawie ogólnego green smoke.
Dodatkowy source P1: modal thickness_average_z sumuje globalnodes zamiast target
membership, więc drugi body/air o tym samymXY może zaniżać/zmieniać średnią.
Spec26 wymaga complete target nodes. Trwa wspólna korekta scalar+Re/Im projection
z osobnym membership filter i negativefixture2targets+air, bez zmiany fieldindexmap.

### Zielony pełny GUI gate — granica dowodu

GHA 37804977808 na 87f5b0e2d1cf006ae0a81ed42d3220f61cdc2cd5 SUCCESS:
ControlRoom113406787415 oraz browser113406787679 SUCCESS. Types/lint/Vitest oraz
Inspector modal handoff i browser/WebGL wykonane. Osiem chart findings nadal
pending_browser: specyficzne alias/gap/scatter/spectrum-key/decimation przypadki
mają jawne Vitest PASS, ale obecny smoke nie odtwarza tych wszystkich przypadków.
Dodatkowy P1 world-Z target membership jest w naprawie niezależnie od green gate.

Poprawka architektury buildu opublikowana jako c51e55fab8d64aecf1bb18858baf906b3dda1be0.
Nowy CPU-SLEPc run 37806509470 / job 113412099816 potwierdzony IN_PROGRESS.
NEV refill draft nie jest commitowany: stałe initial NCV/MPD, bounded total EPS
budget, cancellation i explicit partial / certified last pool wymagają review/GHA.
Kontrakt zakresu output (uwaga 4060116242) pozostaje do decyzji użytkownika; kolejne
niezależne części planu nie są przez to zatrzymane.

### Izolacja projekcji world-Z według targetu — source checkpoint

Commit d4a8c9d300cea5e4cdb590e6a0b1f7a605eb010c opublikowany na branchu zadania.
Membership targetu jest oddzielny od mapowania indeksów payloadu. Scalar oraz
Re/Im thickness_average_z filtrują bounds i akumulację przez pełny wybór węzłów
obiektu, również wewnętrznych. Cache uwzględnia membership. Regresje obejmują
permutowane indeksy globalne i dwa ciała plus airbox ze wspólnymi kolumnami XY.
Review czterech plików i scoped diff check PASS. Types/Vitest/browser nowego
SHA: NOT VERIFIED; uruchomiono GHA 37809144683. Poprzedni green GUI nie zastępuje
tej bramki. Hook React Doctor zgłosił tylko istniejące dwa await-in-loop w
chunking/yieldToMain; nie usuwano mechanizmu responsywności i cancellation.
CPU-SLEPc run 37806509470 / job 113412099816 potwierdzony IN_PROGRESS; pozostaje
na c51e55fab i nie dowodzi jeszcze niecommitowanego NEV refill.

### NEV refill i rzeczywista bramka PETSc/SLEPc — kolejny checkpoint

Commit 6650b04c6da9b6b5c8410be025aa7223c9b05392 opublikowano po ponownym review
dokładnie ośmiu plików źródeł, regresji i noty naukowej.
Cleanup blokuje retry przy nieudanym teardown; cancellation jest sticky.
Pula modów jest deduplikowana przed cap, retry zachowuje początkowe NCV/MPD
oraz kumulowany budżet EPS. Publiczne regresje nearest/window wymagają
niepustych certyfikowanych modów i jawnego statusu niekompletności.
Provider execution nowych regresji: NOT VERIFIED.

GUI 37809144683: types/lint PASS, Vitest 7625 PASS i 1 FAIL w nowym fixture,
który odczytywał nodeIndices zamiast zachowanego DTO node_indices. Korekta
wyłącznie dwóch asercji jest w 39586339b; nowy GUI run 37810228086 na 6650b04c6.
Browser 37809144683 / job 113421163150 SUCCESS; zakres nie obejmuje jeszcze wszystkich ośmiu chart findings.

CPU-SLEPc 37806509470 zakończył się FAILURE po poprawnym zbudowaniu image:
MFEM 4.10, PETSc 3.24.6 i SLEPc 3.24.3 mają manifesty i obserwowane hashe.
Native compile zatrzymało się na KSPConvergedDefaultDestroy/KSPSetConvergenceTest:
PetscCtxDestroyFn wymaga void**, helper używa void*. Regresji nie wykonano.
Artefakt: ci-37806509470-slepc-artifact/receipt.json i native-build-and-ctest.log.
Nowy run 37810232766 na 6650b04c6 potwierdzono jako żywy z tym samym helperem,
a następnie zażądano anulowania, żeby nie powtarzać znanej awarii kompilacji.
Trwa korekta zgodności API i własności kontekstu; ponowienie wymaga nowego SHA.

Uwaga 4208794592: commit 39031966898336419f4753ac97f654c9451b0508 wymusza LF
kontrolera przez .gitattributes i dodaje exact-byte regression do istniejącego
python-contracts. Nie normalizowano hashy i nie osłabiono kapsuły. Zastosowano LF
również do istniejącego checkoutu: hash-object --no-filters oraz HEAD blob mają
identyczny hash 6f3b9ee6aaf35dd994e3a077282c6c35ebbc164d; git diff kontrolera pusty.
GHA 37810672320 / Python job 113426385921 potwierdzony IN_PROGRESS; wynik regresji
jest NOT VERIFIED do odczytu terminalnego logu. Run 37810232766 ma już terminalny
status cancelled, zgodnie z żądaniem po potwierdzeniu wspólnego compile defect.

GUI 37810228086 / jobs 113424868456 i 113424868811 zakończone SUCCESS na
6650b04c6. Nowa regresja target membership przeszła razem z typecheck/lint
oraz rzeczywistym browser smoke. Ten dowód nie rozszerza coverage o osiem
jeszcze niewykonanych szczegółowych przypadków chart aliases/gaps/scatter.

Poprawka PETSc ABI: bde903d77df77a6208fe00b07373a31e9415b1d8 opublikowana po
review dwóch plików. Wersje przed 3.24 używają void*, od 3.24 void**; wrapper
czyści slot callbacku bez usunięcia zewnętrznego ownera. Próg potwierdzono w
oficjalnych nagłówkach PETSc 3.23 i 3.24. Uruchomiono provider 37811157641 oraz
automatyczny Shifted KSP test 37811150333. Wyniki pozostają NOT VERIFIED.

Python job 113426385921 w 37810672320 zakończył się FAILURE przed nowym
controller regression: audit_fem_cpu_only_runtime.py odrzuca samo --with-cuda,
więc jawne PETSc --with-cuda=0 daje fałszywy alarm accelerator-enabled.
Trwa korekta parsera z pozytywnym disabled i negatywnymi enabled przypadkami;
nie zmieniamy konfiguracji CPU i nie usuwamy bramki zakazu CUDA.

Shifted KSP 37811150333 / job 113428012006 SUCCESS na bde903d77: kompilacja
regresji z systemowym real PETSc oraz wykonanie PASS: shifted KSP
true-convergence regression. Pełny pinned PETSc 3.24/SLEPc provider nadal jest
oddzielnym dowodem oczekującym. CPU audit false-positive naprawiono w
89b9ca3c3 (exact --with-cuda=0 dopuszczone; bare/1/yes wciąż odrzucone).

Odświeżony pełny inventory PR97 nadal ma 257 inline comments, ostatni
4208794719 z 2026-10-07T15:34:45Z; nie znaleziono nowego feedbacku do dopisania.
PR97 OPEN, PR102 CLOSED. Chart browser draft po review nie ma jeszcze dowodu
raw scatter/cap/null gap: jego pierwotne counter minima i screenshot były
niewystarczające. Nie zmieniono statusów ośmiu pending_browser na podstawie
tego draftu. Doprecyzowanie rzeczywistych asercji i fidelity schemas trwa.

### Opublikowane poprawki i nowe bramki po ponownym review

- f1645a398bb2c65761ca18975152c69c4bf5febf: exact GEO layer extrusion zachowane
  także ze scoped size fields; istniejący actual density/planes test i jego
  progi pozostawione. Nota0104/source map validator exit0; runtime pending.
- 11940532f: confidence=scalar overlap, assignment score i fallback/subspace
  bez zmiany. Rzeczywisty tracker→JSON/CSV regression. Naprawiono też wszystkie
  12 błędów mapy źródeł0831; validator exit0. Log skopiowano do kanonicznego
  preview-state-checkpoint/pr-review-20261007/scientific-docs-0831-check.log.
- 160be3dee12bdd42f519a456f378e1419cccf4c9: bezpośrednia zależność MFEM testu
  modal ABI, w istniejącym provider guardzie, bez globalnych includes.
- 5101b31af38d1ad17636712c264c109579ef646a: opt-in actual ECharts option/click
  proof, owner-safe reader/listener cleanup, real mouse via convertToPixel,
  cap5000/null sentinel/connectNulls=false/raw scatter/alias/key assertions.
  Produkcyjna line zachowuje showSymbol=false, lecz circle umożliwia emphasis
  hit target; test utrwala ten kontrakt. Wszystkie osiem browser findings nadal
  pending_browser, nie zaliczono ich samym source review.

Provider37811157641 FAILURE: libfullmag_fem.so zbudowano z PETSc3.24.6/SLEPc3.24.3,
lecz modal ABI test nie dostał mfem.hpp. CTest nie wykonano. Artefakt zapisany
jako ci-37811157641-slepc-artifact. Świeży provider37814613673/job113439924161
na160be3dee jest IN_PROGRESS i obejmuje naprawioną zależność MFEM.
Pełny bootstrap37815314214 na5101b31af: Rust113442341515, Python113442341646,
ControlRoom113442341472 i browser113442341615 potwierdzone IN_PROGRESS.
Ten run ma faktycznie podpięte smoke:analysis-plots, nie tylko ogólny viewport.

Hook React Doctor69/100 pozostawia 6 ostrzeżeń w smoke: trzy pre-existing
sekwencyjne czynności browser UI, dwa read-only odczyty diagnostyki cold failure
path i includes dla dwóch stałych nazw legend. Nie tłumiono reguł ani nie
przedstawiono wyniku jako clean. Produkcyjna ścieżka nie dostała tych pętli.
Trwa następna niezależna poprawka4207979082: canonical relative-L2 w spectrum
nie jest dziś propagowany do Inspector fallback; wymaga jawnego zachowania
semantyki norm zamiast przepisywania legacy norm na relative L2.

### Checkpoint po wykonaniu nowych bramek i kolejnych korektach

ControlRoom37815314214/job113442341472 SUCCESS: nowy diagnostics/renderer/types
oraz Vitest wykonane. Browser113442341615 FAILURE przed chart cases z powodu
legacy locator(main) trafiającego w dwa elementy. Poprawka2c0a794e538ed1486771735c06b58e84ac05bb7f
wybiera jednoznaczny main.fm-workspace-shell. Rerun37816649176: ControlRoom PASS,
browser113446890379 FAILURE na Checking sessions przed otwarciem Analysis.
Trwa aktualizacja bootstrap fixture do rzeczywistego kontraktu katalogu sesji;
nie pomijamy base smoke ani nie osłabiamy admission/selection assertions.

Python37815314214/job113442341646 FAILURE: exact-count już przeszedł, ale
centroidowy selector nie znalazł region edge samples. Marker1 jest magnetic,
air0 — source review wyklucza pomyłkę markerów. Commit
c63ecba5b850aac96a8aca113db6e77e0f70346d mierzy thin-film samples przez midpointy
przy pełnej długości każdej krawędzi, zachowuje mediany4–12nm i bulk>=10nm,
fail na pustej próbce, oraz ma negatywną40nm geometrię/air duplicate guard.
Nota0104 validator exit0; actualGmsh density nadal wymaga świeżego CI.

Provider37814613673 FAILURE: fem_modal_eigen_contract zbudowany, następny
fem_floquet_modal_solver_contract compile FAIL na result.modes, którego DTO
nie ma. CTest nie wykonano. Naprawa471628198e29842eb0f29afb9d62d089e851621a
używa accepted_modes i zachowuje fail-closed assertion. Artefakt
ci-37814613673-slepc-artifact zapisany. Nowy provider37819089840/job113455190008
potwierdzony IN_PROGRESS na471628198; tania bramka raw/fixed37819435932 również
zlecona, wynik nie jest jeszcze rozliczony.

Raw/fixed3d2070e7db73e048a53849d089c5677211883db4 oraz typed residual
fda11e674883b59f5942859ff2107310e915c9e8 są opublikowane po source review;
nie uznano ich za runtime/science qualified. Przy residual hook78/100 wskazuje
dwie istniejące struktury JSX/key w peak browser, poza zmienionymi hunkami;
nie tłumiono diagnostyki ani nie deklarowano clean wyniku.

### Korekta zakresu dowodów — jawne logi zamiast ogólnego statusu

GHA37819435932/job113456368268 na471628198e29842eb0f29afb9d62d089e851621a
SUCCESS: CTest3/3 (mode kinematics/modal ABI/Floquet modal), nowy raw/fixed test
jest zarejestrowany w main bez provider guardu. Uwaga4208794569 ma implemented
na poziomie kontraktu wejściowego; brak naukowej kwalifikacji solvera pozostaje.
GHA37820851179/job113461212012: ControllerTests12/12PASS, exact-byte test wlog1054
wykonano PRZED meshingiem. Wcześniejszy wniosek, że błąd meshing blokował ten
test, był błędny — sprawdzono rzeczywistą kolejność i wyniki. Uwaga4208794592
ma implemented/source-contract proof. Meshing nadal FAIL: midpoint sample
w actualGmsh również pusty; nie zakwalifikowano density realization.

Rust37815314214/job113442341515 SUCCESS nie uruchomił nowych confidence tests:
komendy miały inne filtry. Nie promowano4060116342. Dodano jawny krok
tracking tests + real writer regression do istniejącego joba; krok jest obecnie
w source WIP razem z receipt-bound comparison tests i wymaga commit/GHA.

Startup/residual fixture a78f906462d5546a348098ef99f201e1f8db964e opublikowana:
GET/v2/sessions ma prawidłowy current identity/epochs, usunięto smoke bypass.
Nowy browser37820851179/job113461211850 dotarł do frequency chart, lecz FAIL
przed actualclick: tooltip nie pokazał oczekiwanego source row1. Diagnostyka
meaningful tooltip/pixel/applied option trwa; nie dopisujemy row-ID do produktu
wyłącznie dla testu. ControlRoom113461211846 FAIL tylko na expected5.000e-5 vs
legalnym formatterze0.00005000; rozdzielone etykiety/normy były wyrenderowane.

Provider37819089840 skompilował oba targets i wykonał CTest2, obaFAIL. Błąd1:
provenance fixture nie doszła do native Floquet; błąd2: configured KSP snapshot
wyzerowany przed EPS. Artefakt ci-37819089840-slepc-artifact zachowany; nowe
regresje NEV/cancellation nadal nie są uznane za wykonane. Trwa naprawa przyczyn,
bez wyłączania mass/residual gates ani usuwania assertions.

### Checkpoint 2026-10-08 — poprawka tooltipa i dalsza kwalifikacja

Commit `3e7f02ae38e1f0e42629d27d6f525d9b34d54d04` jest na remote.
Smoke oczekuje rzeczywistego, widocznego tooltipa z treścią użytkową przez
jawny `fm-chart-tooltip`. Zachowano odczyt actual option, real mouse click,
event tuple, request szczegółów modu i tożsamość Inspectora. Asercja legacy
residual odpowiada istniejącemu formatowaniu `0.00005000`; fizyki nie zmieniono.
Source review oraz Node syntax/diff PASS. Hook React Doctor: 68/100,
7 ostrzeżeń; trzy ordered UI loops i wcześniejsze odczyty diagnostyczne pozostają,
nowa sekwencja wait tooltip -> odczyt widocznej treści jest zależna, nie niezależna.
Nie tłumiono reguł ani nie uznano wyniku za clean.

GHA `37826316640` na tym SHA ma potwierdzone dwa aktywne joby:
browser `113479993143` i Control Room `113479993673`.
Wynik browser i nowe jednostkowe regresje pozostają NOT VERIFIED do zakończenia.

Review naprawy native window dopuszcza source wyjątek wyłącznie dla
best_effort, niepustej certyfikowanej puli i internal NEV dimension-limit.
Pozostałe partial, budget, cancellation, hard failure i nearest pozostają
fail-closed. Reviewer wykrył jeszcze strict policy w dodatnim provenance fixture;
trwa korekta obu pozytywnych requestów, bez zmiany negatywnego contour case.
Receipt-bound DE comparison jest rozszerzany, aby scientific validator i parser
czytały te same zweryfikowane bajty CSV, bez ponownego otwierania pliku.

PR97 nadal OPEN; PR102 CLOSED. Nie zakończono pełnego audytu ani celu.

### Opublikowane poprawki i aktywne bramki 2026-10-08

`1582a394f` wiąże dispersion.csv z receipt i przekazuje dokładnie te same bajty
validatorowi i parserowi. Source review sześciu skryptów PASS; AST/diff/YAML PASS.
Nowa uwaga4061684269 ma implemented_pending_ci, nie kwalifikację numeryczną.
Workflow jawnie uruchamia trzy suite receipt/comparator/validate_rows oraz
tracking tests i real writer confidence regression, wcześniej pomijane filtrami.

`fd275de8a185a5d48d5534a5b08613c41f86747a` zawiera source-approved poprawkę
KSP snapshot oraz ograniczone dimension-limit recovery best_effort window.
Oba pozytywne provenance requests mają policy0; strict policy i negative contour
pozostają osobnymi fail-closed regresjami. Bramka dokumentacji naukowej PASS.

GHA37826981190/bootstrap i GHA37826986842/provider zlecono na tym samym SHA.
Provider job113482264242 został potwierdzony IN_PROGRESS. Wcześniejszy celowany
browser37826316640 pozostaje obserwowany; kolejne runy go nie anulują.
Brak wyniku tych bramek oznacza NOT VERIFIED; nie promowano uwag dotyczących
masy, refillu ani przeglądarki na podstawie samego source approval.

Trwa osobna source diagnosis pustej próbki density w rzeczywistym layered Gmsh;
nie zmieniono geometrii, progów4–12nm, bulk>=10nm ani kwalifikacji layer planes.

Celowany browser37826316640 jest już terminalny: ControlRoom113479993673 SUCCESS,
browser113479993143 FAIL. Pierwszy frequency-case ma fm-chart-tooltip widoczny,
lecz bez tekstu; applied tuple [1,2.25,1], host top830/height326 i pointer y919.
Zachowano log ci-37826316640-browser.log oraz screenshot w artefakcie GHA.
To konkretny nowy dowód dla diagnozy tooltip/scroll/formatter; nie usunięto
asercji i nie uznano ośmiu browser uwag za zamknięte. Worker analizuje artefakt.

### Checkpoint 2026-10-08 — diagnosis browser/density i brakujące pokrycie

GHA37826981190/job113482245789: receipt tests7/7 PASS, comparator13/13 PASS
oraz validate_rows61/61 PASS. Rendering/report test był skipped (brak Matplotlib),
więc uwaga4061684269 pozostaje pending do uzupełnienia tego pokrycia.
Workflow otrzymał instalację i jawny import Matplotlib; zmiana source WIP.
Ten sam job meshing FAIL na region_lengths=[]; dowód z wcześniejszego SHA jest
aktualny dla niezmienionego kodu, bez kwalifikacji density realization.

Artefakt browser11571014585 pokazuje charthost top830 i pointer919 nad dolnym
Telemetry dock. Poprawka `bdd18e2372546cff26c346d37afa26e2201e7870` jest na remote:
exact chart scrollIntoView przed convertToPixel, bez zmiany tooltip/click/source/
Inspector/residual assertions. Source review i Node syntax/diff PASS, hook68/100
z tymi samymi siedmioma ostrzeżeniami. GHA37828142497 joby113486219556/113486219973
potwierdzone live; browser proof pozostaje NOT VERIFIED.

Density source trace potwierdził scoped layer partition, exact1element extrusion,
body volume tags oraz 3D Min(upper)/Max(lower) composition. Nie potwierdził przyczyny
pustej próbki na rzeczywistej siatce. Trwa empty-safe failure capture w testach;
workflow będzie zachowywał mesh/edge/field diagnostics po failure. Geometria,
ROI i progi nie są rozluźniane.

Uwaga4061684283 nadal valid_unfixed: serial i adaptive Relax→Eigen bootstrap
checkpointują raw artifacts, lecz nie blokują promotion/parsing non-Completed.
Zwykłe process workers posiadają taki gate. Projekt poprawki musi zachować typed
Cancelled/Paused, nie mapować ich na generic RunError przez parsowanie tekstu.
Nie uznano samego fail-closed generic guard za pełną naprawę terminal semantics.

### Checkpoint 2026-10-08 — rzeczywiste regresje i dalsze błędy

GHA37826981190/job113482245797 SUCCESS: jawnie wykonano
weighted_tracking_confidence_publishes_pair_overlap_not_assignment_score oraz
tracked_pair_overlap_is_published_as_confidence_in_json_and_csv. Uwaga4060116342
ma implemented na poziomie kontraktu; logci-37826981190-rust.log zachowany.

Artefakt11571579884 z GHA37828957946 zachował rzeczywistą siatkę density failure:
108tetra/45nodes/15nodes na każdej z−10,0,+10nm; 16 midpoint instances spełnia
promień15nm, 144 spełnia |z|<=4nm, przecięcie jest puste. Najbliższy midpoint
ma r3.777nm,z5nm, długość10nm. Offline geometria crossing edges również ujawnia
coarse edges (mediana39.695nm), więc sama zmiana selector nie naprawia gęstości.
Capture nie jest kwalifikacją siatki. Root cause sizing nadal nie rozstrzygnięty.

Browser37828142497 przeszedł do screenshot/notification gate, gdzie trzy brakujące
GET fixtures204 dawały undefined revisions. `49c0ddb6f` dostarcza jawne truthful
visualization state/composition/universe; notification assertions zachowano.
Hook68/100 z tymi samymi7warnings, Node/diff/source review PASS.
`f14bc4496` poprawia source guards na canonical apiPaths, po nowym hygiene failure
113494275580; bramki nie wyłączono. `2808167f9` naprawia terminal qualification
materializatora: odrzucony benchmark => summary/receiptfailed, exit1; artefakty
oraz niezależny materialization_statuspassed zachowane. GHA37830494397 na2808167f9
zlecono; uwaga4060116354 pozostaje pending do konkretnych regression evidence.

Provider37826986842/job113482264242 terminalFAIL, oba targets compiled i CTest2run,
0/2PASS. Artifactci-37826986842-slepc-artifact zachowany. ABI fixture odrzucony:
Aqq descriptor incomplete dimensions or terms. Zidentyfikowano term_presence_mask0
przy niezerowym h_eff0, trwa minimalna FIELD/digest fixture correction.
Floquet refill fail po PETSc3.24.6 GMRES recurrence residual1.01898e-79 vs computed
7.82914e-15 (start3.02639e-15); trwa source diagnosis bez obniżania tolerancji.
Nie ponowiono provider po samym observation timeout ani nie zamknięto mass gates.

Typed terminal multi-k patch zachowuje raw checkpoint przed admission, blokuje
Cancelled/Paused/Failed przed promotion/parsing i następną próbką. Review wykryło
utratę diagnostics przy legalnym checkpoint_rootNone; trwa bezpieczne zachowanie
raw closure w nieakceptowanym namespace z istniejącą walidacją portable paths.
Nie uznano WIP za naprawiony kontrakt ani nie publikujemy cancelled spectrum jako
zaakceptowanego wyniku. PR97 nadal OPEN, całość celu niezakończona.

GHA `37830494397`, job `113494275851`, potwierdza: porównanie CSV 14/14
(test wykresu i raportu nie został pominięty), walidator 61/61 oraz oba warianty
terminalnego statusu materializatora 2/2 PASS. Regresja zapisu pustego ROI także
przeszła. Późniejszy, niezależny błąd rzeczywistej siatki Gmsh nie unieważnia tych
dowodów kontraktowych. Uwagi 4061684269 i 4060116354 mają status `implemented`;
nie oznacza to kwalifikacji numerycznej solvera.

Commit `1b6edf6d0` jest na remote. Naprawia statusy ścieżki wielopunktowej
oraz bootstrapu Relax→Eigen, zachowując surową diagnostykę również bez katalogu
checkpointów i bez ukończonego widma. Błąd zapisu nie jest maskowany anulowaniem.
Review trzech plików i kontrole rustfmt/diff przeszły. Cztery jawne regresje
podpięto do GHA `37831903599` na SHA `175662faabcb893eaadf219920c4a0596fd5d520`.
Uwaga 4061684283 oczekuje CI; działanie runtime nie jest jeszcze potwierdzone.
Commit `175662faa` poprawia tylko maskę FIELD i digest w fixture provenance.
Ta poprawka przeszła review źródłowe; provider nie został jeszcze ponowiony.

Reviewer zatwierdził rozdzielenie centrum widma i przesunięcia w teście refillu:
przesunięcie BASE−10 kHz zachowuje bliski cluster, metrykę masy, kolejność modów,
pasmo BASE±1 Hz oraz wszystkie bramki residual/KSP. Izoluje test deduplikacji
i rozszerzania puli. Nie naprawia ani nie kwalifikuje ścieżki produkcyjnej
z przesunięciem 1 mHz od wartości własnej: błąd GMRES pozostaje jawnie otwarty.
PR #97 pozostaje OPEN; pełny cel i zamknięcie PR nie są zakończone.

### Ponowienie po konkretnych błędach — 2026-10-08

GHA37831903599/job113499112355 ujawnił trzy unikalne błędy kompilacji:
stary tuple return w eigen_k_pool377 i dwa odczyty pola handoff jako metody.
Commit `84dece49c` poprawia je; sprawdzono wszystkie udane return branches funkcji.
Nie uznano wcześniejszego source approval za dowód kompilacji ani regresji.
Commit `dd2aa4f10` izoluje test refill/dedup od near-pole KSP; problem produkcyjny
pozostaje otwarty. Commit `1dfce5dfc` dostarcza brakujący readiness GET z
ready_to_run=false; source guard korzysta z canonical apiPaths, notification
assertions pozostają aktywne. Source review, Node/diff i ograniczony rustfmt PASS;
React Doctor nadal68/100 z tymi samymi siedmioma ostrzeżeniami, bez suppressions.

GHA `37832748542` (bootstrap) i `37832753999` (provider) zlecono na pełnym SHA
`1dfce5dfc2854cf11aa96bdf27fa9dd5dc1c6190`. Oczekują named regression evidence.
Nie zaliczono jeszcze typedterminal runtime ani native refill/provider gates.

### Checkpoint 2026-10-08 — korekta historycznych opisów i nowe źródła

Aktualny owner Floqueta odczytuje callback anulowania, adapter przekazuje go,
a EPS stopping test jest faktycznie zainstalowany. Uwaga 4060116262 i jej duplikaty
nie mogą nadal twierdzić, że całe źródło nie zawiera callbacku. Poprawka źródłowa
oczekuje wykonania właściwych regresji w providerze; nie jest uznana za ukończoną.
Uwaga 4061061288 jest `already_fixed`: aktualny IR akceptuje diagnostics-only,
a istniejący test przeszedł w GHA37826981190. Commit `3ec16da01` zmienia tylko
nieaktualny komunikat błędu oraz rozszerza sprawdzenie mixed/illegal outputs.
Nie dodano pozornego refaktoru poprawnego predykatu.

Commit `626761fe8` ujednolica równanie grupowania w nocie0600 z kodem i0831:
1e−6Hz plus1e−4 względnie. Przy10GHz jest to około1MHz; usunięto twierdzenie,
że próg zawsze leży poniżej odstępu fizycznych pasm. Nowa regresja obejmuje
kotwicę klastra oraz zespoloną odległość i addytywność progów. Kwalifikacja
naukowa heurystyki pozostaje NOT VERIFIED. Source-map validator i reviewPASS;
uwaga4060116349 oczekuje GHA dla nowej regresji, nie zmianę solvera.

Browser37832748542 zakończył się na nieobsługiwanym platformowym GET
/v2/platform/development-backend, który wychodził poza fixture do realnego
serwera. Commit `728fb860947b1a01a69985995edb5994f174a23b` dostarcza exact GET
ze stanemdisabled, CORS/OPTIONS i405 dla innych metod. Hook i notification
assertions zachowano. Source review, Node/diffPASS; React Doctor68/100 z tymi
samymi7warnings, bez suppressions. GHA37835049604 jest zlecone na tym SHA.

GHA37832748542 ma wykonany ze statusemsuccess krok czterech terminal path
regresji; jobRust113501991197 nadal pracuje. Nie promowano4061684283 bez
odczytu konkretnych testów w logu. Provider37832753999/job113502008377 jest live.

Trwa bounded scalar observability dla near-pole KSP harderror. PETSc restart
wykrył rzeczywisty residual-gap, a dostępne dane nie rozstrzygają tiny RHS vs
kondycjonowanie. Powstaje oddzielny failure probe z wewnętrznymi normami,
rzeczywistymi wymiarami/indeksem próby i cache callbacku, bez żadnych zapytań
PETSc po harderror. Kryteria residual/KSP, mass i akceptacji pozostają niezmienione.
To zbieranie dowodów, nie naprawa ani kwalifikacja near-pole solvera.

### Checkpoint 2026-10-08 — dowody CI i izolacja kliknięcia

GHA37832748542 / Rust113501991197 zakończyło się sukcesem; cztery nazwane regresje terminalnego statusu eigen path rzeczywiście wykonano. Uwaga4061684283 jest implemented. GHA37835049604 / Rust113509840919 również SUCCESS; `frequency_clusters_use_anchored_complex_distance_and_additive_tolerance` wykonano PASS. Uwaga4060116349 jest implemented w zakresie zgodności opisu i regresji heurystyki, nie uniwersalnej kwalifikacji naukowej progu.

Commit `20516409dab22659a965d4d4c82b1afe64002d24` utrwala skalarny failure probe przed harderror EPS, bez odpytywania uszkodzonego grafu. GHA37837871230 ujawniło wadliwe założenie fixture’u: PETSc3.19.6 może zakończyć dokładnie zerowy RHS przed callbackiem. Commit `fcab12270d87862274c919b5a7bd5177861d1895` akceptuje wyłącznie ten sprawdzony fast path i zachowuje kontrolę rzeczywistego residualu; dodaje także bounded wydruk failure probe i liczników refill. Tolerancje i progi akceptacji solvera nie zmieniły się. Provider37832753999 nadal nie przeszedł: pierwszy fixture ma harderror KSP, drugi zatrzymuje się na telemetry assertion. Późniejsze asercje nie wykonały się; przyczyna licznika pozostaje nierozstrzygnięta. Nowe GHA37841016654 (KSP) i37841037546 (provider) uruchomiono na fcab12270.

Browser37835049604 dotarł do dense dispersion fixture, lecz kursor trafił w sąsiedni raw mode zamiast tracked line. Commit `205c2a59fa95f78c73aacbbd7a98b5ec67f49458` stosuje bounded rzeczywiste Ctrl-wheel, odczytuje zastosowany zakres i aktualny source row/dataIndex po każdym kroku oraz zachowuje tooltip/click/Inspector assertions. Source review i Node/diff PASS; skuteczność w przeglądarce NOT VERIFIED. GHA37841333004 jest celowanym browser gate. Częściowy dowód każdego udanego fixture jest teraz zachowywany, bez pozornego complete=true po awarii późniejszego przypadku. React Doctor68/100,7warnings; brak suppressions ani deklaracji czystego wyniku.

Plan właściciela PETSc jest osobną propozycją wymagającą decyzji użytkownika o wątku/procesie. Uwzględnia wszystkie sześć entrypointów, MPI affinity, borrowed Rust callbacki, zachowane konteksty i celową kwarantannę poisoned grafów blokującą finalize do końca procesu. Nie jest dowodem implementacji. Naprawa generic physical-mass dedup przed cap oraz bounded refill trwa osobno; nie promowano jej do implemented.

Aktualizacja dowodu: GHA37841016654 / job113530085049 zakończyło się SUCCESS. Kroki Build PETSc regression i Run PETSc regression wykonały się; log zawiera PASS: shifted KSP true-convergence regression. Potwierdza zakres helpera KSP i poprawionego fixture’u zero-RHS; nie zastępuje providerowego modal solve ani kwalifikacji dyspersji.

### Checkpoint 2026-10-08 — certyfikat SI i przenośny smoke

Commit882f6564b usuwa prywatne ścieżki Playwright/Chromium/Windows Temp z runner-console browser smoke, zachowując istniejące override i oficjalne provisioning CI. Commit096fa6a311c816b9b134caa4538898d67cad4721 ponownie certyfikuje finalny mesh SI obu tras ring, zamiast kopiować certyfikat współrzędnych µm. Helper przed walidacją usuwa stary certyfikat; błędna translacja nie pozostawia pozornie accepted evidence. Regresja syntetyczna obejmuje niezależne przeliczenie, zmianę fingerprintu, zachowanie wejścia i odrzucenie mismatch. Source review, syntax/AST/source-map/diff PASS; lokalnych testów ani Gmsh nie wykonywano. Uwagi4061061301 i4061343703 są implemented_pending_ci. GHA37842390414 zlecono na096fa6a31 z poprawnym contract_scope=bootstrap; poprzedni dispatch all odrzucono422, nie utworzył zadania.

GHA37841333004 terminal: Control Room contracts SUCCESS; browser smoke FAILURE na rzeczywistym kliknięciu dense dispersion row10010, bez oczekiwanego pobrania eigen/modes/5105/1. Zapisany częściowy artifact complete=false potwierdza sparse modal click oraz Inspector/residual, nie dense dispersion. Nie promowano ośmiu browser uwag. Trwa failure-only telemetry dla dense click; brak dowodów przyczyny nie uprawnia do osłabienia assertion. GHA37841037546 provider pozostaje aktywny przy ostatnim odczycie.

Uwagi4060116277 trace potwierdza dodatkowo runtime lib przed private build w LD_LIBRARY_PATH CTest. Wymagane wiązanie hash i actual loader resolution, sprawdzone przed/po testach, bez nadpisywania runtime. Ta poprawka pozostaje valid_unfixed; sam wybór katalogu CTest nie dowodzi testowania właściwej biblioteki.
### Checkpoint 2026-10-08 — wiązanie biblioteki i błąd immutable mesh

Commit442ee706d wiąże exact CMake TARGET_FILE z biblioteką runtime: SHA256 i rozmiar obu plików muszą zgadzać się przed testami i po nich. LD_LIBRARY_PATH stawia private build pierwszy, każdy CTest wymaga rzeczywistej zależności FEM, a fullmag-bin bez linkowanej FEM jest jawnym przypadkiem dlopen, dodatkowo atestowanym przez istniejący explicit ctypes loader. Dowody ldd zachowano; porównanie pomija wyłącznie niestabilne adresy ASLR. Missing/mismatch/ambiguity/change blokują pass, bez nadpisywania runtime. Atestacja library_identity trafia do result.json; resolution wymaga jej pass. Source review, AST/diff PASS; osiem regresji czeka na GHA. Uwaga4060116277 implemented_pending_ci, nie ukończona kwalifikacja.

GHA37842390414 ujawniło FrozenInstanceError w helperze certyfikatu SI: MeshData jest frozen dataclass. Commitd8bbe5226 używa immutable replace, zwraca nowy obiekt, oba callsites przypisują wynik; nie omija frozen kontraktu przez object.__setattr__. Test zachowuje oryginalny certyfikat wejścia i niezależnie weryfikuje SI. Review, AST/source-map PASS; wykonanie po korekcie NOT VERIFIED. Nie promowano4061343703 na podstawie nieudanej regresji.

Commit7a5c2e58f dodaje failure-only JSON/screenshot dla dense click: applied tuple/dataIndex/pixel, poprzedni i aktualny click event, zoom oraz widziane mode requests/responses. Assertion wyboru nie zmieniło się. Source review wychwyciło undefined shorthand targetCoordinate; poprawiono jawne mapowanie coordinateTarget przed commitem. Node/diff PASS; React Doctor68/100,7warnings, bez suppressions. GHA37843450520 zlecono na7a5c2e58f; provider37841037546 pozostaje active przy ostatnim odczycie. Pełny cel i PR97 pozostają otwarte.
### Checkpoint 2026-10-08 — potwierdzone kontrakty SI i portable browser

GHA37843450520 Python113538347501 wykonało wszystkie8 LibraryIdentityTests PASS i nazwaną regresję SI periodic certificate PASS. Suite kończy się później na znanym braku midpointów ROI w actualdensity; nie mylić tego z FrozenInstanceError, który już nie występuje.4061343703 implemented w zakresie poprawnego SI certificate, nie kwalifikacji naukowej całej siatki.4060116277 pozostaje pending dla integracji actual loader/managed biblioteki mimo8zielonych helper tests.

Browser113538347409 wykonał packaged queue checks i portable runner-console smoke:8/8views,51requests,pageerrors0, Chromium z provisioningGHA.4061061301 implemented;13consoleerrors należą do istniejących kontrolowanych auth/errorcases, nie deklaracji całej konsoli bez błędów. Późniejszy analysis clickFAIL nadal blokuje osiem uwagbrowser. Nowy artifact rozstrzyga outcome: expectedtarget/dataIndex poprawne, requestSeen=false,responseSeen=false,lastRenderedClick=null,failedResponses=[]; nie jest to błędnie pobrany mod. Screenshot i źródło rendereru wskazują potrzebę analizy hit target ukrytego symbolu line (showSymbol:false), szczególnie pierwszego punktu po gap. Nie zmieniono produktu bez potwierdzenia mechanizmu.

Commit3244ac2e5f7d0e8ff732e3638699bb8ea762898e naprawia4105055299 i4204074522: pusty optional residual=>None przy unchanged frequency_only_unqualified; niepusty invalid/nonfinite/negativefail; metadata bytes hash-bound przed parsowaniem. Regresje tamper/missingmetadata+CSV i6wariantów residual są jawnie podpięte do workflow po matplotlib. Review/AST/diffPASS; GHA37844070818 zlecono, wykonanie nowych regresjiNOTVERIFIED. Generic mass/refill nadalWIP, bez przedwczesnego stagingu.
### Checkpoint 2026-10-08 — actual provider failure i retained telemetry

Commitb432d346d naprawia4204074508: stale/error sessionstatus ze snapshotem nie zrywa sameidentity stage subscription. Dane nadal wymagają exactsession_id/session_epoch/run_id, loading oraz inny run nie ujawniają starego payloadu. Dodano actualhook/deferred regresję run-a statusrefresherror→run-b transition→newtelemetry; nie jest to osobna regresja stageexecution refresherror. Review/diffPASS; GHA37844797398 oczekuje.

Provider37841037546 terminalFAIL, oba fixture’y rzeczywiście wykonano. Nowe failureprobe odrzuca hipotezę tinyRHS dla tego przypadku: rhsL2=0.33333333333333337,trueResidualL2=0.33333333333333337,recursiveResidual=0,threshold=3.3333333333333341e−14,ratio≈1e13,31successfultrueprobes,zero measurementfailures. To normy wewnętrznego układu shift, nie originaldescriptor. Tolerancja pozostaje niezmieniona; trwa source/PETSc callbackmeasurement audit, brak jeszcze przyczyny i naprawy.

Refill fixture ma actualattempts=1,solved=1,finalized=1,initial/current/finalizedNEV=4,NCV16,MPD16,uniquecertified2. Dwa mody są accepted, lecz fixture nie wymusił refill; nie wolno na tej podstawie udowadniać retry ani twierdzić, że NEV wzrósł. Poprzednia asercja growth nie wykonała się po fail. Potrzebny fixture faktycznie underfilled po dedup, z osobnym zapisem outcome; produkcyjną zmianę rozstrzyga nowe źródłowe review.

Dense click telemetry oraz pinned ApacheECharts6.1 source wskazują usunięcie symbolDraw przy showSymbol:false; sam linepolyline domyślnie nie emituje pointindex click. Projektuje się bounded real hit target z zachowaniem ukrytych markerów, źródłowego dataIndex, nullgaps i pointbudget; nie używa się syntheticdispatchAction ani polylineevent bez indeksu. Product fix jeszczeNOTVERIFIED i niezatwierdzony sourcecompletion.
### Checkpoint 2026-10-08 — comparator proof i produktowy chart hit target

W bootstrap37844070818 nowe testy komparatora nie wykonały się: wcześniej testAPI przykładu holeFMR z Gmsh odrzucono przez degenerate tet i facet bez volumeadjacency. Commitae4566c56 dodał lekką celowaną kontrolę bez modyfikacji błędu całego suite. GHA37845234250/job113544340387 naae4566c56 wykonało12nazwanych regresji komparatora PASS, w tym6residual wariantów, plotPNG oraz receiptmetadata/CSVtamper.4105055299 i4204074522 implemented; nadalfrequency_only_unqualified, nie physicsqualification.

Commitec0c2fb7147d6de39e11f8133b9b80c813d56c68 w sharedchartRenderer zachowuje realcircle hit targets≤5000realpoints przez showSymboltrue i transparentnormalfill, z emphasiscolor i osobnym lineStyle. ZRenderopacity0 cull nie jest stosowany. Nullsentinels, source tuple/dataIndex, scatterstyle i decimation są zachowane; ponadbudżetowe lineinputs nie tworzą nieograniczonej liczby symboli. Review/diffPASS, granica5000/5001 w regresji; GHA37845431758 wymaga rzeczywistego browserclick/Inspector/request proof. Nie promowano ośmiubrowser uwag.

GHA37844797398/control-room113542882194 terminalFAIL:7654testsPASS, jeden nowy deferred provider fixtureFAIL (initialload expected1,actual2). To nie dowód regresji produktu ani dowód jego poprawności; trwa diagnoza sekwencji subscribe/load przed zmianą fixture’u.4204074508 nadalpendingCI, żadnego osłabienia identityfencing. KSPmeasurement review nie wykazało źródłowego błędu użycia KSPBuildSolution; log nie dowodzi x=0/Ax=0. Następny pomiar normxbuilt/Axbuilt oraz powtórzeniaMatMult ma być przypisany temu samemu callbackowi przedharderror, bez zmiany tolerancji.
### Checkpoint 2026-10-08 — manifest diagnostics i shared consumer load

Commitdb72e0cb9 dodaje missing4106577220 diagnostics w requested_execution.outputs z rzeczywistego OutputIR. Pełny signedsidecar fixture sprawdza empty oraz diagnostics-only manifest; przedcommitem poprawiono kluczrequested_execution, nie nieistniejącyrequested. Review/diffPASS, GHA37846414757 zlecono na90f10e803. Wybór individual diagnosticsflags w writerze nadal osobnąuwagą, nie uznany za naprawiony przez label.

Browser37845431758 terminalFAIL przedrealclick: renderer ma właściwe nowe linehit targets, lecz stary smoke wymagał showSymbolfalse. Commit90f10e803 wymaga teraz real transparent2px line i visible4px scatter, zachowując5000points/nullgaps/actualclickidentity. Node/review/diffPASS;browserproof nadalNOTVERIFIED. ReactDoctor68/100,7warnings bezsuppressions.

Commitbb5718a41 usunął duplicatefirstload w singleconsumer przez pauseLoad. Dalszy sourceaudit wykazał ryzyko sharedkey: pauseLoad globalnie abortuje request, a wymuszony refetch omija inflightdedupe. Ten etap nie jest ukończoną naprawą4204074508. Trwa wariant używający zwykłego nonforcedload oraz spójnej sharedrevision dla zmianyrun, bez perinstancepause, z nową two-consumer/noabort regresją. Nie rozluźniono mocków/liczników staregotestu i niepromowano statusu.

Genericmass/refill nadalwip: sourcecomplete freeze ma obejmować raw poolphysicalmassdedup przednearest/lowestselection/cap, fixedNCV/MPD retrybudget i explicitpartialpropagation z fixture’ami. Nie stageowano fragmentów solvera przedreview. Source KSPBuildSolution pomiaru pozostaje poprawne według dotychczasowego trace; dodatkowe cachednormx/Ax/projekcja mogą rozstrzygnąć rzeczywistą awarię, bez odpytywania PETSc poharderror i bezzmiany tolerance. Publicstatus/ABI nie rozszerzono.
### Checkpoint 2026-10-08 — rzeczywisty dense click PASS i shared consumers

GHA37846414757 browser113548304767 SUCCESS na90f10e803. Artifact analysis-frequency-domain-fixture-proof.json ma complete=true i3udane przypadki: modal spectrum alias/derived field key, responsealias, dense dispersion gap/scatter. Dense click rzeczywiście wyemitował data[5105000000,1.5105,10010],dataIndex2503,series0,previousIsNullSentinel=true,sourcegaprowabsent. Expectedrequest /eigen/modes/5105/1 i Inspector/residual assertionsPASS. Obie serie zawierają5000realpoints;linegap zachowany, rawmodes scatter. Osiem wskazanych browseruwag implemented, z jawnym powiązaniem IDs w ledger. To fixtureUI dowód, nie kwalifikacja solvera/FEM ani dowód wykonania pola w3D.

Commit54f5e5cfe naprawia4204614988 poprzez transfer owned worker finalmag po status/digest/threadbudget/artifact walidacji; responses nie są już zatrzymywane i klonowane do końca. Rust borrow/partialmove reviewPASS, compilationpending. Nie podano zmyślonego memory/crashthreshold ani speedup.

Commit8f1a476b4 zastępuje pośredni perinstancepauseLoad: initialunsettled request zwykłym loaderem, mismatchedsettledcache/runtransition invaliduje sharedkey stałym identitytoken. Controller deduplikuje token; nonforcedloader współdzieli inflight zamiast abortować inneconsumer. Nowa regresja dwóchconsumer sprawdza1initialload,unabortedsignal,1runchange,clearoldrun i przyjęcienewtelemetry; stara strictsame-run regression niezmieniona. Review/diffPASS; GHA37847504651 zlecono naa4d93372c.4204074508 nadalpendingCI.

Commita4d93372c koryguje błędne scientific zapewnienie o ownerfield realization w meshedextrusion. Geometrysourcecap naairboxzmin jest kopiowany przez zadaneprzedziały; nie ma mechanizmu niezależnego interiorROIrefinement. ActualdensityFAILED zachowuje ROI i próg12nm. Wymagana pełna naprawa independentsection triangulation+conforminglayerconnection, bez nowychZplanes; unsupported refusal samo nie zamyka pierwotnego celu. Nie zmieniono algorytmu ani admission w tym commicie. Focused scientificvalidator/reviewPASS, mesh/science niekwalifikowane. Genericmass/refill nadaloczekuje freeze/review.
### Checkpoint 2026-10-08 — pair admission i review numeryczny

Commit8c57e4e275896d8b674b742ddf3675eb46d2b275 naprawia4105055188: exactnonemptyrequested/node/boundarypairIDsets. Regresja pełnegoproviderpredicate sprawdza dotychczasowy single-IDfallback, empty/duplicate/unknown oraz legalny8magneticnodeXYmesh; pełnepairIDsaccepted,reverseorderaccepted,subsetXrejected bez mutacji geometrii. Review/diff/scientificvalidatorPASS, GHA37849144953 Rustproof pending, żadnego managedphysicsclaim.

Genericmass/refill review znalazło3compileblockery: missingcapture request w diagnosticslambda, duplicate native_floquet_sparse declaration i contourhunk czytający window_complete z innego scope. Worker je poprawił, usunął deadhelper; testmassorthogonal przeniesiono do wspólnego klastra tak, by Euclideanmetric rzeczywiście nie przechodziła. Pozostałe blockery: unsafePETScdestroy po harderror oraz symmetry/positiveDiagonal admission wpuszczająca indefiniteM[[1,2],[2,1]]. Powstaje explicitquarantine/terminalcleanupstatus i HermitianPSDcheck candidateGram allowingphasecopies, bez densifyinggeometricCSR. Checkedpositivity dotyczy wyłącznie certifiedcandidate span; globalSPD/finalizerowner nadalNOTVERIFIED. Fragment niecommitted i niekwalifikowany.

Root przygotował generic-modal-slepc CMake/CIprofile z dwomaexactCTest i postassertionmarkers; jestWIP zależnym od domknięcia solverfragmentu, jeszcze niewysłany. Dedicatedargvtest zapewni osiągalność nowychregresji bez wcześniejszego Floquetharderror; pełnysuite nadalzachowany.

GHA37847504651 ControlRoomfail dokładnie dotyczy statusLoad drugiegowywołania w oczekiwaniu wewnątrzact, nie etapu stageExecutionruntransition. Commitbf4ff9f3c flushuje refetchact przedwaitFor, rozwiązuje deferredresponse w osobnymact; callcounts/identity/noabort unchanged. Renderercolor test sprawdza transparentnormalfill oraz greenline/emphasis zgodnie z nowymproduktem. Source review/diffPASS; GHA37849313561 ponowiono. Nie uznano4204074508 za implemented na podstawie korektyfixture. Browserrealclick proof pozostaje wcześniejpotwierdzony.
### Checkpoint 2026-10-09 — serial reset, provider PASS i paritycatalog

GHA37849313561 ControlRoom113557997014 SUCCESS onbf4ff9f3c. Pełny providerfile7testsPASS obejmuje bothsame-runrefresherror/crossrun i two-consumer/noabort/coalescedloads bezskipów;7657testówPASS.4204074508 implemented. GHA37850553227 ControlRoom113562124601 SUCCESS on042a6f861;StudyGlobalAuthoringModel44testsPASS, wtym explicitnullcanonicalization/nondefaultserialroundtrip/invalidserialcontrols.4204074511 implemented. Zapis serial jest canonicalfullobject jakIR, nie nowy publicresetmarker;obiebramkibrowserSUCCESS.

Skorygowano ID ledger: memorymove54f5e5cfe dotyczy4204614988/eigen_k_pool.rs, a sąsiednie4204614998 dotyczy parityhashes/validate_serial_adaptive_probe.py. Historyczny opis checkpointu poprawiono; countsametodykwalifikacji niezawyżone przez błędnąpodmianę.

Commit9bfc052e3 wiąże całykatalogrequiredartifacts oraz5core numericfiles przedsemanticvalidation i po niej. Secure reader używa≤1MiBchunk,hash-onlyAPI niegromadzipayload;existingbyteAPI zachowanesafePath/size/SHA/fstat. Reportzawieraartifactcount+deterministiccatalogdigest, nie powielonądużąmapę. Nie jest to nowy jointimmutable snapshot ani scientificqualification. Testy semanticfault honestrebind zachowują wcześniejszephysical/phase/identitygates, osobnetamperbothcases testsreject. GHA37851077182:95pass,60subtestsPASS;jedensubcase metadatafailsregex, bo wcześniejszyruntime_output_binding jużodrzuca metadata. f8eba1a88 wymaga dokładnie tejwcześniejszejbramki dlmetadata i hashgate dlpozostałych4plików, bezacceptancetamper.4204614998 pendingrepeatCI.

Genericmass/refill z GramPSD i quarantine pozostaje frozenreviewWIP razem z przygotowanymgeneric-modal-slepcprofile. Niecommitted przedsourceapproval ani providerCI, niezmieniono publicABI/tolerancji. PR97 pozostajeOPEN,PR102CLOSED;pozostałycałyuzgodnionycel aktywny.
## Checkpoint 09.10 — potwierdzona integralność całego katalogu artefaktów

Uwaga `4204614998` ma status `implemented`: GitHub Actions `37851505913`, job `113565248408`, zakończył się sukcesem na źródłach `f8eba1a88`. Wykonano 5 testów provenance oraz 95 testów i 61 podtestów konsumentów artefaktów. Bramka obejmuje wymagany katalog, kontrolę manipulacji pięcioma plikami podstawowymi, brak katalogu jako `NOT VERIFIED` oraz strumieniowe hashowanie z ograniczonym rozmiarem odczytu. Potwierdza spójność przed i po interpretacji; nie dowodzi wspólnego niezmiennego snapshotu ani zgodności fizyki solvera.

Review zmian natywnego finalizatora pozostaje otwarte. W jego trakcie znaleziono i poprawiono dodatkowe wywołania PETSc po błędzie odczytu lub przywracania widoku wektora oraz po błędzie zapisu macierzy. Źródła wymagają jeszcze bramki GitHub Actions z włączonym SLEPc; lokalnej kompilacji ani testów nie wykonano.

## Checkpoint 09.10 — generic SLEPc: metryka, refill i błędy obiektów

Zakończono review źródłowe spójnego przyrostu generic dense/CSR: geometryczna metryka masowa bez fallbacku identity i bez densyfikacji CSR; certyfikacja Gram na przestrzeni kandydatów; deduplikacja przed cap; bounded refill z pierwszym NCV/MPD i wspólnym budżetem iteracji; incomplete best-effort window oraz fail-closed nearest/strict/budget/error. Poprawki review obejmują brakujące kwalifikacje `fd::` w testach i źródło finalizatora w lekkim linkowaniu CI. Testy callbackowe dowodzą sekwencjonowania helpera, nie awarii rzeczywistego PETSc. Globalny właściciel PETSc i bezpieczeństwo finalizacji pozostają `NOT VERIFIED`.

Dodano oddzielny profil GitHub Actions `generic-modal-slepc`: wymaga włączonych MFEM/SLEPc, dwóch rzeczywiście wykonanych kontraktów oraz ich markerów sukcesu. Zachowano pełny wcześniejszy modal suite i jego odrębny problem Floquet/KSP. Walidator noty 0831, parser Python i kontrola diff przeszły; kompilacja i wykonanie są jeszcze niepotwierdzone. Lokalnych testów ani buildów nie wykonano.

## Checkpoint 09.10 — stare dane runu i nowe uwagi GitHub

Uwaga `4204615009`: odpowiedź stage execution jest sprawdzana względem tożsamości session/run przed uznaniem cache za settled. Obcy run powoduje `not_ready` i istniejący bounded retry współdzielony przez odbiorców; dane poprzedniego runu nie trafiają do widoku. Regresja dwóch odbiorców wprowadza starą odpowiedź po zmianie runu, oczekuje jednego wspólnego retry i odzyskania nowych danych. Review wykrył wyścig domyślnego timeoutu testu z opóźnieniem retry 1000 ms; poprawiono wyłącznie timeout obserwacji. Wykonanie GHA pozostaje niepotwierdzone.

Ponownie pobrano komentarze PR #97. Pięć nowych wpisów `4224318111`, `4224318143`, `4224318154`, `4224318169`, `4224318179` oceniono w aktualnych źródłach jako zasadne i dołączono do pełnego rejestru. Obejmują rozróżnienie Pause/Stop, ścisłe limity solvera SceneDocument, certified-count sparse Floquet window, spójność phase convention i tożsamość katalogu przy retention. Nie pominięto ich w kryteriach zakończenia. Generic SLEPc CI `37853083613` / `113570688520` pozostaje aktywne; nie jest dowodem sukcesu ani powodem ponownego uruchomienia.


## Checkpoint 09.10 — weryfikacja obu poprawek UI

Commit 904321bf5 naprawia stare dane runu; ca904497d naprawia wspólny loader optional/required przygotowania symulacji. Ten drugi zachowuje błąd w cache i mapuje opcjonalną nieobecność dopiero w widoku odbiorcy; regresja obejmuje obie kolejności startu oraz jedno współdzielone żądanie. GitHub Actions 37853788374 obejmuje pełne kontrakty Control Room i fixtures przeglądarkowe na ca904497d. Wyniki obu poprawek są jeszcze NOT VERIFIED. Generic SLEPc 37853083613 nadal jest osobną aktywną bramką.

## Checkpoint 09.10 — wyniki CI i konkretne naprawy regresji

`4204615009` ma potwierdzone wykonanie: job 113572992459 w GHA 37853788374 wykonał 7 testów studyRuntimeResources.provider, wszystkie przeszły, w tym retry obcego runu z dwoma odbiorcami. Cały job zakończył się błędem w osobnym teście preparation, więc nie oznacza zielonego całego frontendu.

`4224318143` poprawiono w 1718cf0fa. GHA 37854287363 / Python 113574630308 wykonało pełny moduł roundtrip: 54 testy przeszły, dwa niezależne starsze oczekiwania nie przeszły. Nowe przypadki obu limitów oraz poprawny eksport/defaulty przeszły. Starszy test nazywał obsługiwane frequency_response etapem nieobsługiwanym, a malformed k-path oczekiwał dawnego tekstu komunikatu; 55734f6ff zachowuje rzeczywiste odrzucanie nieznanego stage kind i niepoprawnej ścieżki.

Preparation optional-first przeszło, required-first miało dwa API calls. Source review wskazał race timera: widoczne loading nie dowodzi dołączenia drugiego ensureLoad przed odrzuceniem requestu. 55734f6ff dodaje call-through spy/barierę obu joinów i stałe keyed slots, pozostawiając ścisłe jedno żądanie i rozdzielne stany/powiadomienia. Dowód wymaga kolejnego GHA. Ten sam commit uzupełnia brakujące publiczne/native include roots w lekkiej kompilacji. Nowy pełny run 37854824442 uruchomiono po tych konkretnych korektach. Generic SLEPc 37853083613 nadal aktywne i nie zostało zrestartowane.

## Checkpoint 09.10 — kwarantanna execution i błąd kompilacji

`4224318179` przygotowano w 4b71b2b7b: atomic rename do prywatnej kwarantanny pod run root, ponowna kontrola containment/device/inode i całego drzewa przed rmtree, zachowanie mismatched tree i durable interrupted_unknown po restarcie. Review źródłowe oraz AST/diff przeszły. Regresje obejmują podstawienie katalogu w czasie rename, mutację po przeniesieniu, restart i partial deletion. Żadnych rzeczywistych danych nie usunięto. Wykonanie cleanup Windows/reparse oraz odporność wobec niekooperującego procesu o równych uprawnieniach po ostatniej kontroli pozostają poza kwalifikacją.

Generic SLEPc 37853083613 zakończyło się błędem kompilacji, nie błędem numerycznym: production_cpu_modal_eigen.cpp używał native_floquet_sparse poza deklaracją. Mały artefakt z receiptem i logiem zachowano. 3212cb4cc dodaje wyłącznie lokalną deklarację w window function; niedokończony większy WIP count-policy pozostał poza commitem. Nowy generic run 37856133644 jest uzasadnionym ponowieniem po konkretnej zmianie źródeł. Bootstrap 37856135463 ma wykonać również nowe regresje retention.

Pełny authoring roundtrip w poprzednim GHA 37854824442 / Python 113576378060: 56 testów przeszło po korekcie dwóch starych fixture’ów. Cały Python job pozostał failed w osobnym meshing. Frontend nie uruchomił ponownie preparation regresji: zatrzymał się na importach kernel→module internals w nowych modułach analizy. Brak rg w obrazie również wymaga jawnej zależności CI; przygotowano ją w źródłach workflow.

Count-policy 4224318154 pozostaje nienaprawione w rejestrze: produkcyjna poprawka przeszła review, ale mały fixture nie dowodzi zbieżności wszystkich internal shifts. Powstaje większy legalny owner i izolowana bramka floquet-count-slepc. Nie przedstawiono braku certyfikatu jako zaimplementowanego producenta count_certificate.

## Checkpoint 09.10 — preparation potwierdzone i granica konwencji fazowej

GHA 37856135463 / Control Room 113580646996 wykonało useSimulationPreparation.test.tsx: 12/12 PASS; studyRuntimeResources.provider.test.tsx: 7/7 PASS. Obie kolejności optional/required zachowują jedno współdzielone żądanie po rzeczywistym joinie, z odpowiednimi stanami i powiadomieniami. 4204615004 jest implemented. Cały frontend job FAIL w niezależnym ribbonStructure „Mode” label; nie uznaje się całego CI za zielone. Log konkretnych regresji zachowano. Krok runner retention preview cancellation w Rust job 113580647105 ma SUCCESS, ale cały job nadal działa; oczekujemy pełnego logu nowych przypadków.

4224318169: diagnoza rozdziela czasową exp(±iωt) od przestrzennej Floquet exp(±ik·r). Generic native formatter używa stale plus mimo dopuszczonego minus i wymaga jawnego przekazania request.phase_convention przez helper kinematyki, oba formattery modes i wszystkie result callsites. Raw lambda, amplitudy i residuale pozostają podpisane; abs(Im(lambda)) nie jest poprawką. Tiny validation już mapuje z requestu; trzeba sprawdzić jej etykietę phasor_convention. Contour odrzuca minus jawnie. Rust runner ustawia czasowe ExpIOmegaT w eigen_native_window.rs, więc jego plus-only parser odpowiada faktycznemu żądaniu; nie rozszerzamy go bez expected convention z requestu. Obsługa minus przez generic C ABI pozostaje do poprawy i regresji dense/CSR nearest/window dla obu konwencji.

Architektoniczny import kernel→module został już poprawiony w równoległym commicie 30777cdf6 przez istniejące public.ts; nie cofano nowej funkcji. Count fixture 4224318154 jest rozszerzany o nieparowane węzły wewnętrzne, pozytywne Tet4 i consistent P1 mass, z asercjami dokładnie jednego subwindow oraz raw status=ok/stop_reason=converged przed strict certificate rejection. Zmiany te nadal wymagają review i GHA; nie są gotową certyfikacją liczby modów.


## Checkpoint 09.10 — reserved interface marker w warstwowym Box

4207979074: direct layered Box odrzuca marker10 dla outer boundary przed mutacją proofów/Gmsh, zgodnie z istniejącymi ring/mixed guards. Dwie regresje w GHA-covered test_meshing.py obejmują invalid marker bez importu i utraty proofów oraz poprawny marker99 docierający do generatora. Review źródeł, AST i diff przeszły. Testy i kwalifikacja meshing pozostają niepotwierdzone; fizyczna geometria, grading i zbieżność nie wynikają z dispatcher control.

## Checkpoint 09.10 — count-policy: rozszerzona regresja zaakceptowana źródłowo

4224318154 przygotowano do GHA: strict sparse Floquet bez count certificate zwraca solve_error, best_effort zachowuje jawnie niecertyfikowany wynik. Zbieżność shiftów nie jest zastępowana certyfikatem liczby modów. Rust nie publikuje diagnostycznych modów z native error jako wyników.

Reviewer zaakceptował większy fixture algebraiczny: 5 wewnętrznych węzłów magnetycznych, dodatnio zorientowane Tet4 ze starymi outer/seam faces, compact magnetic prefix i singleton canonical classes, stiffness z consistent P1 mass i dodatniego skalowania. Focused CLI wymaga jednego subwindow status=ok/stop_reason=converged i co najmniej 4 unikalnych modów przed capem dla obu polityk; strict zawodzi dopiero na bramce certyfikatu. Stary default suite zachowano. To source contract fixture, nie materiałowy benchmark ani implementacja count-certificate producer.

Dodano izolowany CTest/profile floquet-count-slepc z bramkami MFEM/SLEPc, dokładnie 1/1 testu i markerem PASS. Dodano też szybki standalone retention dispatch i jawną instalację rg w bramce Control Room. Walidator noty 0831, AST i diff przeszły. Kompilacja/wykonanie i nauka pozostają NOT VERIFIED; source approval nie zastępuje wyniku GHA.

## Checkpoint 09.10 — retention i reserved marker potwierdzone w CI

4224318179: standalone retention GHA 37858403201 / 113588040080 na 25d1fe130 SUCCESS, 57 testów PASS. Log zawiera pozytywne wyniki rename-time replacement, postmove identity mismatch, interrupted restart i partial deletion. To dowód testów na temp fixtures w GHA Linux; nie wykonano hostowego cleanup, a Windows/reparse i równouprawniony niekooperujący proces po final check nie są kwalifikowane.

4207979074: scoped mesh GHA 37857536564 / 113585218463 na 1a9418249 wykonało obie nowe regresje markera: PASS. Cały moduł: 313 testów, 1 failure gęstości direct layered Box i 1 skip. Status implemented dotyczy guardu i dispatcher control, nie poprawności całej geometrii/gęstości. Problem realizacji scoped 3D pól nadal pozostaje do naprawy.

25d1fe130 zapisuje source-reviewed count-policy i większy algebraiczny fixture. Targeted MFEM/SLEPc GHA 37858401532 / 113588036063 jest aktywne; nie jest dowodem zbieżności ani sukcesu. Naprawę temporal phase 4224318169 rozpoczął bounded worker: obowiązkowy request.phase_convention w całym native formatter chain, signed lambda zachowane, Rust plus-only parser pozostaje zgodny z faktycznym requestem. Brak wykonanych regresji minus nie jest oznaczony jako poprawka ukończona.
