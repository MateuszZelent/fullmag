# Checkpoint

- Baza: e1865ce66c0291be2bfc03a77253b77972b62d4f.
- Poprzedni PR154 scalony, główny master fast-forward, stary czysty worktree i branch usunięte; dowody zachowane w storage.
- Nowy etap: simulation-mode-consistency-20261013, właściciel codex-thread-01a12cc7.
- Potwierdzono przekazanie backend=fem; wykryto sprzeczny status/domain API przed mesh i downstream utratę active_lane.
- Backend worker: status.rs/domain.rs i regresje tests.rs.
- Frontend worker: resolver i konsumenty z audit.md, poza status-bar i runOutcome.
- Root: status-bar (jawna metoda i engine not started), provenance runOutcome, audyt/review/integracja.
- Zakaz lokalnej kompilacji/testów pozostaje w mocy; CI uruchomi regresje.
- Pozostało: review całości, przegląd analysis/field-storage, source hygiene, commit etapów, PR/CI/browser, integracja i cleanup.
- Cały wcześniejszy goal R0/R1 D07 pozostaje aktywny: receipts/generation/runtime qualification nie są zamknięte przez ten etap.


## Etap backendu

Commit: `86ab736c1e26788d0ea0bab1145f727a76092048`.
Zakres: domain.rs, sessions/create.rs, sessions/status.rs, router_v2/tests.rs.
Źródłowy review i diff-check PASS; regresje zapisane, nieuruchomione lokalnie. Obejmują rzeczywiste POST create→GET status/domain dla empty FEM/FDM, built/empty FEM payload i explicit FDM z retained FEM mesh.
FEM bez siatki: `fem:unmaterialized`, domain generation revision/topology 0, counts null, brak structured grid, finite zero bounds. Scratch nie przypisuje fikcyjnej runtime family ani engine id.

Known limits zachowane z wcześniejszego kodu: classifier DomainMeta daje pierwszeństwo explicit execution plan/artifact layout; to klasyfikacja reprezentacji danych, nie resolved runtime lane. Built FEM mesh z generation_id=None nadal ma historyczny FDM fingerprint/revision fallback. Ten problem pełnej publication/generation qualification należy do aktywnego D07 i nie został ukryty przez nowy sentinel.

## Frontend / review

Root: kontrolka metody, osobny stan engine-before-run i run outcome provenance z regresjami. Independent review zgłosił P2 utraty ostatniej znanej metody przez chwilowe active_lane=null; poprawione i ponownie zamknięte źródłowo. Testy wykonania pozostają do CI.
Source architecture hygiene i API hygiene PASS dla pierwszego spójnego zakresu; końcowe sprawdzenie po zmianach konsumentów jeszcze wymagane. Node syntax-check smoke-inspector PASS. Przegląd adapterów i paneli trwa.

## Etap komend i analizy

Commit: `c4a4b0344470cfef8df407eebd4d406941d4a77b`.
Review źródłowy niezależnego agenta i scoped diff-check PASS. Regresje czekają na CI. Guard FDM commands opiera się na active execution, nie retained artifacts. Topological charge zachowuje FDM field topology mimo retained FEM mesh; istniejąca nota 0940 pozostaje kontraktem.

Root rozszerzył zakres o StudyInspectorPanelModel provenance i testy dla CPU preview vs GPU run. Nie zmienia requested device ani legacy/per-step stage legality.

## Końcowy review UI

Poprawiono: brak capabilities w adapterach, jawne unresolved Airbox, equality zachowujące lane i presence, stale explicit_topology flags, zależności callbacku wizualizacji obiektu, stale lane-specific errors viewportu. Independent review P2 wspólnego targetQuantity field poprawiony przez gating aktualnego demandu FDM/FEM; P2 metadata run poprawiony przez unavailable/not loaded zamiast domniemania not started w Inspectorze. Status bar nadal rozróżnia running + brak metadata od potwierdzonego stanu przed run.

Architecture hygiene, API hygiene, diff-check i smoke script syntax-check PASS; lokalne testy/typecheck/build/browser niewykonane. Końcowy CI będzie źródłem dowodu wykonania.

## CI pierwszego head

Head a20c9cf08d1f4d3b3fdba4f6aed72ee3669e64a7, PR #155. Control Room typecheck wykrył brak deklaracji readback metody w Viewport3DFrameProps oraz nullable status po gatingu lane. Naprawa zachowuje neutralny status idle i przekazuje metodę jako jawny prop frame, nie rozszerza kontraktu sceny Three.js. Pozostałe CI trwa; wynik końcowy jeszcze niepotwierdzony. React Doctor CI PASS; local commit hook zgłosił 13 warnings na niezmienionych liniach, nie traktować hook score jako wyniku CI dla diff.

## Triage React Doctor

CI advisory PASS zgłosiło dwa nowe non-component export warnings dla adaptera/equality MeshBuildDialog oraz complexity statusbara. Pure adaptery przenosimy do modułu .ts, comparator statusbara do modelu. Pięć await-in-loop ostrzeżeń dotyczy niezmienionych sekwencyjnych operacji browser smoke (dodanie proof przesunęło linie o16); kolejność służy synchronizacji mutacji/screenshotów i nie będzie równoleglona dla wyniku narzędzia. Te warningi nie dowodzą regresji ani wyniku 0 warnings.

## CI drugiego head

Head 5ea1b4b7256ccb68fa24d0b3f98f84f4564383d9. Browser fixture i Inspector actions PASS. Typecheck i lint PASS, unit suite 7774 PASS / 3 FAIL / 13 skipped: stare expectation explicit topology przy active FDM, domyślny FEM child przy unresolved Airbox oraz source regex FDM warning po nowym FEM error gate. Poprawiono te trzy oczekiwania bez osłabiania kontraktu, legacy manifest fallback nadal ma pozytywną regresję. Python meshing testy przeszły, dalsza repo consistency przerwana przez invalid UTF-8 w nowych notach; oba dokumenty naprawione i repo consistency źródłowo PASS.

Rust CI: 974 PASS / 1 FAIL / 3 ignored. Nowy test fallbacku FDM pozostawiał bazowy fixture w stanie running, więc istniejąca bramka remesh_admission prawidłowo zwracała 409 (Stop the running stage before rebuilding the mesh). Fixture ustawiono w awaiting_command, bez live_state/stage_execution, jak istniejący pozytywny test komendy. Bramka runtime pozostaje bez zmian. Wynik naprawy wymaga kolejnego CI.
