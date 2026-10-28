# Wdrożenie audytu Results UX — 2026-10-28

Wdrożono aplikacyjne zmiany R1–R5 z [audytu](2026-10-28-eigensolve-results-ux-audit.md). Testy automatyczne i rzeczywista przeglądarka potwierdzają opisany poniżej zakres. R6 pozostaje otwarte dla ręcznego odbioru użyteczności; nie utożsamiamy go z samym Playwrightem.

Worktree: `/home/kkingstoun/git/fullmag/worktrees/eigensolve-integration-ui-20261026`. Branch: `codex/eigensolve-integration-ui-20261026`. UI: http://localhost:3217/session/eigen-mode-ui-de-signed15. [PR 262](https://github.com/MateuszZelent/fullmag/pull/262) pozostaje draftem szerszej integracji; ten raport kwalifikuje wyłącznie zmiany UX.

## Stan planu

| Etap | Stan | Wdrożenie i dowody |
| --- | --- | --- |
| R1 | Implementacja, CI i browser PASS | Overview / Data / Provenance / Diagnostics mają różne treści. Undamped nie udaje braku lifetime; temporal phasor pochodzi z właściwego kontraktu. Opcjonalne residualy nie tworzą pustych wierszy. Wymagany brak metadanych blokuje akcję i pokazuje powód. |
| R2 | Implementacja, CI i browser PASS | Kolekcja pokazuje liczbę badań; podstawowy panel modu pokazuje f, fizyczne k i akcję bez przewijania przy 1600×1100 oraz 1440×900. Szczegóły i wygląd są zwinięte. Wynik nie pokazuje stopki edycji modelu. |
| R3 | Implementacja, CI i browser PASS | Explorer, wybór próbki i selekcja z wykresu używają Γ / podpisanego k / GHz. Surowe identyfikatory pozostają w danych. Zachowano run/stage/revision/sample/mode oraz węzły nawigacji; Back to chart wraca do istniejącego wykresu. |
| R4 | Implementacja, CI i browser PASS | Jedno Color by; solid, scalar range i vectors mają warunkowe controls. Wygląd i Stop są dostępne tylko dla tej samej tożsamości aktywnego pola. Po wyborze innego k pojawia się jawna informacja o poprzednim aktywnym modzie. |
| R5 | Implementacja, CI i browser PASS w podanym zakresie | Elastyczna wysokość wykresu, Show / hide lower panel, szczegóły telemetryki na żądanie. Status pozostaje widoczny. Sprawdzono trzy rozmiary okna oraz przywrócenie wysokości po hide/show; nie zmieniono właściciela paneli, cache zasobów ani cyklu życia obliczeń. |
| R6 | Automatyczna macierz PASS; ręczny odbiór OTWARTY | 1267 testów, typecheck, architektura, React Doctor; realne dane, WebGL, brakujące pole i klawiatura. Badanie z nową osobą oraz pełna ręczna sesja dock/float podczas aktywnego solvera: NOT VERIFIED. |

## Co potwierdzono

- 15 opublikowanych punktów FEM w zakresie −25…+25 rad/µm i dwie referencje; częstotliwości wykresu sprawdzane względem źródłowych wierszy.
- Rzeczywiste pola dla −25, Γ, +25: po 5127 wartości zespolonych, widoczna powierzchnia, nieutracony WebGL context i niezerowy drawing buffer.
- Kliknięcie referencji nie udostępnia akcji pola FEM; sprawdzono kᵧ oraz współrzędną ścieżki s.
- Wykres mieści się w układach 1600×1100, 1440×900 i 1100×900. Ukrycie dolnego panelu powiększa wykres, a ponowne pokazanie przywraca jego wysokość.
- Kolekcja nie ma fikcyjnych `Unavailable` / `Not applicable`; główny panel poprawnego modu również nie ma takich wartości. W zakładkach Data/Diagnostics nadal można zobaczyć rzeczywiste braki wymaganych danych.
- Sterowanie solid/manual/auto działa w przeglądarce. Wybór Γ nie pozwala edytować poprzednio aktywnego pola. Test klawiatury potwierdził przejście Data → Provenance i zmianę treści.
- Wstrzyknięta wyłącznie w osobnym kontekście przeglądarki odpowiedź HTTP 503 dla metadanych pola daje końcowy komunikat `metadata unavailable` i wyłączoną akcję. Nie zmodyfikowano backendu ani archiwum.
- Harnessy dopuszczają ACK wizualizacji oraz odnotowany zapis preferencji przez `PATCH /v2/sessions/current/visualization/state`; pozostałe mutacje blokują. Nie wykonano Solve, Compute Fields ani nowych obliczeń. Końcowa kontrola po odtworzeniu odnotowała jeden zapis preferencji, zero niedozwolonych mutacji, zero błędów HTTP i JavaScript.

Test układu nie uruchamiał nowego solvera ani nie dowodzi osobno zachowania aktywnego joba podczas wszystkich operacji float/dock. Zachowano istniejące mechanizmy paneli; hide/show nie emitowało komend do solvera. Ścieżka renderowania SwiftShader nie jest dowodem obliczeń na sprzętowym GPU.

## CI i review

Kod aplikacji: `59f5db5cf0eb2c1bfe87cd28716d42a93cd2d5e1`. [CI 40751815945](https://github.com/MateuszZelent/fullmag/actions/runs/40751815945): **PASS** — 55 plików / 1267 testów, pełny frontend typecheck i kontrola architektury. Testy kompilowano wyłącznie w GitHub Actions.

React Doctor: bramka PASS, 89/100, trzy nieblokujące uwagi istniejące przed tym zakresem: barrel import w `ModeFieldOverlayIntent.ts` oraz eksporty funkcji pomocniczych z `DispersionModeAction.tsx` i `EigenDispersionInspectorPanel.tsx`. Nie zmieniano ani nie wyciszano reguł. Lokalny hook wcześniejszego commita nie ukończył analizy z powodu `Unexpected discriminant 7 for TSTypeName`; nie zaliczono go jako PASS.

Pierwsze CI (`40739212435`) miało 1267 zielonych testów, lecz wykryło TS2367 w nadmiarowym porównaniu trybu `auto`. Poprawiono warunek, a pełną bramkę ponowiono. Pierwszy browser R4/R5 wykrył ucięcie przy 1440×900; poprawiono rozmiar wykresu i ponowiono macierz. Zachowano oba nieudane dowody; nie osłabiono asercji. Pierwsza kontrola Γ po odtworzeniu zatrzymała się na blokadzie legalnego zapisu preferencji wizualizacji w harnessie. Dopuszczono wyłącznie ten endpoint i odnotowano jego wywołania; komendy solvera pozostały zablokowane. Ponowiona kontrola `r6-restored-gamma-v2` przeszła wraz z WebGL, osiami, referencjami, trzema rozmiarami okna oraz hide/show panelu.

Commity aplikacji: R1 `52439e27ac3228ee091ec73a2d85baa65ce9ec0b`, R2/R3 `d8481507975d6b0b48bbe6375e7f5ad2e505c38b`, R4/R5 `00c6c6118de91b64c2ea35cd246f788d4315df73`, poprawka CI `59f5db5cf0eb2c1bfe87cd28716d42a93cd2d5e1`. Specs 13/32/33 uzgodniono z implementacją. Czternaście wcześniejszych plików WIP innych etapów zachowano bez zmian i poza commitami UX.

## Odtworzenie runtime w trakcie weryfikacji

Po przerwaniu obu kontenerów (exit 255) zwykłe resume `9cae7e8bbe7a4e6facb7211c35c8a86e` wykryło historycznego właściciela z innego buildu: `native service target/build mismatch`. Nie obchodzono kontroli właściciela. Użyto istniejącej procedury `stop-bootstrap-volume` (`1d7dea28cbe44e358e4506385a766832`) i zarządzanego odtworzenia `--fresh-state` (`4797e071f624457089f7b4969aa7398e`), zachowującego poprzedni namespace w archiwum.

Nowy start `e052efdd368e497abbddc99322b10b9e` przeszedł z cache-hit pakietu. Compose digest: `61f9cbdc62690e9d3cddf60603597d78c6363d4a73d1d0a35bce7de0c73d9274`. Usługi `359dcf0a0ffa` / `e55c52b53060` są zdrowe. W pustej sesji przywrócono przez rzeczywisty import UI plik `de-signed15-with-references-20261028.fms`; import HTTP 200. Zachowane run/generation oraz 15 próbek potwierdzono z API; Γ = 9,299249697073517 GHz. Import jest wizualizacyjny i nie odtwarza Solve. Nie migrowano wspólnego ledgera ani nie zmieniano innych grup.

## Artefakty i odtworzenie kontroli

Baza dowodów:
`/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/eigensolve-results-ux-implementation-20261028/`

- `r1-browser.json`, `r23-browser.json`: zakładki i hierarchia.
- `r45-browser/`: WebGL −25/Γ/+25, wykres, osie, layout i screeny.
- `r45-browser-first-failed.json`: zachowany błąd ucięcia przed poprawką.
- `r6-browser.json`, `r6-restored-session/browser-audit.json`: interakcje, aktywny owner i klawiatura po odtworzeniu.
- `r6-missing-field/browser-audit.json`: kontrolowany brak wymaganej metadanej.
- `evening-recovery/import.json`, `recovery-and-ci.json`: import, recovery i identyfikatory CI.
- `r6-restored-gamma/`: zachowana nieudana kontrola z blokadą zapisu preferencji przez harness.
- `r6-restored-gamma-v2/`: końcowe sprawdzenie wykresu i Γ po odtworzeniu runtime, PASS; screeny `modal-sample-7-3d.png` i `modal-workbench-focused.png`.

Harnessy w repo: `scripts/verify_eigensolve_results_ux.mjs` i `scripts/verify_eigensolve_modal_workbench_ui.mjs`. Pierwszy przyjmuje `FULLMAG_UI_URL`, `FULLMAG_UX_EVIDENCE`, `FULLMAG_PLAYWRIGHT_MODULE`, `FULLMAG_UX_SCREENSHOTS=0` oraz `FULLMAG_UX_MISSING_FIELD=1` dla testu braku metadanych. Drugi wymaga `--run` i obsługuje `--samples`, `--output`, `--screenshots`. Są to lane'y istniejącego benchmarku signed-DE, nie uniwersalny kwalifikator solvera.

Nie zmieniono progu COMSOL 0,5%, demagu, operatorów ani danych fizycznych. Zgodność renderowania i residual nie oznacza zbieżności siatki/airboxu, kompletności widma ani zakończenia kwalifikacji naukowej.

## Kontynuacja R6 — kontrolki i aktywny solver

Zakres 2026-10-28: (1) odtworzenie animacji i skali, (2) poprawki oraz selektor k/f, (3) rzeczywisty przebieg solvera podczas float/move/resize/hide/dock, (4) CI i raport. Stan: W TOKU.

Odtworzono: Animate uruchamia poprzednio aktywny mod mimo zaznaczenia Γ; po zmianie maksimum skali ręcznej zakres renderera i screenshot pozostają identyczne. Ustalono dwie przyczyny zakresu: brak atomowego zapisu obu końców oraz ograniczanie override do składowych globalnego pola zamiast składowej aktywnego modu. Dowód: `mode-controls-r6-20261028/baseline/probe.json` w katalogu wizualizacji wątku.

Wybór setek wyników: inspektor grupuje po próbce k, następnie pokazuje częstotliwości w tej próbce; filtrowanie i strony po 32 pozycje, odrębne ID dla degeneracji. Zmiana k wybiera najniższą zwróconą częstotliwość, nie obiecuje śledzenia gałęzi. Drzewo pokazuje najwyżej 32 pola, pełny zbiór pozostaje dostępny przez inspektor.
