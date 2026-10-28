# Wdrożenie audytu Results UX — 2026-10-28

Wdrożono aplikacyjne zmiany R1–R5 z [audytu](2026-10-28-eigensolve-results-ux-audit.md). Testy automatyczne i rzeczywista przeglądarka potwierdzają opisany poniżej zakres. Techniczna próba R6 podczas aktywnego solvera jest zakończona PASS; otwarty pozostaje ręczny odbiór użyteczności z nową osobą. Nie utożsamiamy go z samym Playwrightem.

Worktree: `/home/kkingstoun/git/fullmag/worktrees/eigensolve-integration-ui-20261026`. Branch: `codex/eigensolve-integration-ui-20261026`. UI: http://localhost:3217/session/eigen-mode-ui-de-signed15. [PR 262](https://github.com/MateuszZelent/fullmag/pull/262) pozostaje draftem szerszej integracji; ten raport kwalifikuje wyłącznie zmiany UX.

## Stan planu

| Etap | Stan | Wdrożenie i dowody |
| --- | --- | --- |
| R1 | Implementacja, CI i browser PASS | Overview / Data / Provenance / Diagnostics mają różne treści. Undamped nie udaje braku lifetime; temporal phasor pochodzi z właściwego kontraktu. Opcjonalne residualy nie tworzą pustych wierszy. Wymagany brak metadanych blokuje akcję i pokazuje powód. |
| R2 | Implementacja, CI i browser PASS | Kolekcja pokazuje liczbę badań; podstawowy panel modu pokazuje f, fizyczne k i akcję bez przewijania przy 1600×1100 oraz 1440×900. Szczegóły i wygląd są zwinięte. Wynik nie pokazuje stopki edycji modelu. |
| R3 | Implementacja, CI i browser PASS | Explorer, wybór próbki i selekcja z wykresu używają Γ / podpisanego k / GHz. Surowe identyfikatory pozostają w danych. Zachowano run/stage/revision/sample/mode oraz węzły nawigacji; Back to chart wraca do istniejącego wykresu. |
| R4 | Implementacja, CI i browser PASS | Jedno Color by; solid, scalar range i vectors mają warunkowe controls. Wygląd i Stop są dostępne tylko dla tej samej tożsamości aktywnego pola. Po wyborze innego k pojawia się jawna informacja o poprzednim aktywnym modzie. |
| R5 | Implementacja, CI i browser PASS w podanym zakresie | Elastyczna wysokość wykresu, Show / hide lower panel, szczegóły telemetryki na żądanie. Status pozostaje widoczny. Sprawdzono trzy rozmiary okna oraz przywrócenie wysokości po hide/show; nie zmieniono właściciela paneli, cache zasobów ani cyklu życia obliczeń. |
| R6 | Techniczny lifecycle podczas solvera PASS; odbiór użyteczności otwarty | Naprawiono `live_retirement_busy`; rzeczywisty pilot FEM zakończony i widmo opublikowane. Wszystkie 10 operacji panelowych przy running przed i po, ten sam run ID, zero błędów/mutacji. Split Chart + mode zweryfikowany w przeglądarce. Badanie z nową osobą NOT VERIFIED. Szczegóły w raporcie R6 z tego samego dnia. |

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

## Kontynuacja R6 — poprawki kontrolek i przeglądarki modów

Zakres dodatkowego zlecenia: naprawa animacji/skali, wybór k/f dla dużych zbiorów,
sprawdzenie cyklu życia paneli podczas rzeczywistego obliczenia i aktualizacja dowodów.

### Usunięte przyczyny

1. **Animacja poprzedniego modu.** `set-3d-animation` wcześniej preferowało aktywny
   overlay mimo jawnego `fieldId` nowego zaznaczenia. Jawny cel otrzymuje teraz
   własną pełną tożsamość; brak ownera kończy się odmową, bez użycia starego pola.
2. **Niedziałający zakres kolorów.** Przełączenie auto → manual nie zapisywało
   wyświetlanych końców −1/+1. Zapisywane są teraz oba końce wraz z trybem.
   Override zakresu aktywnego modu obejmuje jego składowe, niezależnie od wyboru
   składowej globalnego `m`. Dane ani normalizacja `unit_l2` nie są przeskalowywane.
3. **Sterowanie fazą.** Inspektor wykorzystuje istniejący kontroler i transport
   fazy: ustawienie fazy, play/pause, tempo, kierunek, pętla. Wybranie statycznego
   Real/Imag/Abs/Phase wyłącza animację. Tempo odtwarzania nie zmienia fizycznego f.
4. **Wybór wielu modów.** Inspektor udostępnia wybór wektora k, następnie
   częstotliwości w tej próbce. Większe zbiory mają wyszukiwanie i strony po 32
   pozycje; poza stroną może pozostać jedna przypięta wybrana pozycja. Degeneracje
   mają różne ID. Drzewo pokazuje najwyżej 32 pola i odsyła do pełnego selektora.
   Wybór innego k zaczyna od najniższej zwróconej częstotliwości; nie jest to
   automatyczne śledzenie gałęzi.
5. **Pełny kontekst ścieżki.** Browser znalazł brak `path_s` w nowym selektorze:
   etykieta +25 zmieniała się, lecz viewport odmawiał renderowania z komunikatem
   `Active analysis overlay k-path coordinate is missing`. Selektor przekazuje
   teraz opublikowane s, również zero. Nie osłabiono walidacji ownera ani nie
   wyliczono fikcyjnego s z indeksu lub normy k.

6. **Powrót do właściwego wykresu.** Selekcja modu ze ścieżki k zachowuje
   `calculationMode = dispersion_modal`. Domyślne `free_modes` otwierało widmo
   indeksowane modami przy „Back to chart”. Dodano regresję routingu; wyniki
   bez ścieżki k nadal prowadzą do widma.

### R6: historyczny checkpoint przed naprawą blokady

**Test paneli podczas aktywnego solvera: NOT VERIFIED.** Żaden nowy solver nie
wystartował w tej próbie. Wskazanie `completed` dotyczy odtworzonego archiwum.

Zarządzane uruchomienie `examples/fem_eigen_mode_ui_de_k10.py`, request
`eigensolve-r6-panel-k10-20261028-1`, operation
`359acb20e15f4b0990604c83caf519e7`, zakończyło się potwierdzoną odmową przed
mutacją (`live_retirement_busy`). Kod importu celowo ustawia
`runtime_status.code = imported_read_only`, a prywatna bramka retirement wymaga
zgodności tego kodu z efektywnym `completed`. Dowody w kodzie:
`session_persistence.rs::normalize_imported_read_only` oraz
`development_restart.rs::validate_runtime_status`. Dodatkowo retirement wymaga
własnego dowodu terminalnego run-store; samo dopuszczenie innego napisu statusu
nie jest kompletną, bezpieczną naprawą.

Sprawdzono też publiczną komendę `run-script-accepted --help` w tym samym
kontenerze. Trafia ona do parsera skryptu: `is_script_mode` nie zawiera tej
komendy w tabeli subkomend. Ta alternatywa również nie została użyta do Solve.
Nie zastąpiono sesji pustą sesją w celu ominięcia blokady i nie zmieniano ledgera.

Warunki zamknięcia tej części R6:

- osobna, testowana ścieżka przejścia z importowanego wyniku do nowego obliczenia,
  zachowująca archiwum i sprawdzająca aktywnego właściciela runtime;
- start dokładnie jednego runu i potwierdzenie rzeczywistego stanu `running`;
- float/move/resize/maximize/restore/hide/show/dock przy tym samym run ID;
- brak komend stop/cancel/solve z operacji panelowych, postęp i końcowy wynik
  tego samego solvera. Przy zatrzymaniu solvera choćby w trakcie jednej operacji
  observer nie zalicza testu.

Observer `scripts/verify_panels_during_solver_ui.mjs` wymaga
`FULLMAG_EXPECTED_RUN`. Nie uruchamia obliczeń i nie przyłącza się do obcego runu.
Dotychczasowa próba `live-panels/report.json` zakończyła się
`No live solver appeared`; nie jest dowodem ciągłości obliczeń.

### Dowody dodatkowej weryfikacji

Baza: `mode-controls-r6-20261028/` pod bazowym katalogiem wizualizacji tego wątku.

- `baseline/`: odtworzone błędy animowania starego modu i nieskutecznej skali.
- `controls-check/`: PASS zmiany rzeczywistego zakresu bufora i palety oraz
  Animate po przejściu z próbki 5 do Γ, bez mutacji solvera.
- `full-controls/`, `picker-diagnosis/`: zachowany błąd brakującego s przed naprawą;
  metadane HTTP 200 nie wystarczyły do dowodu renderowania.
- `live-panels/`: nieudana próba oczekiwania na realny solver.
- `scripts/verify_eigensolve_mode_controls_ui.mjs`: odtwarzalna kontrola danych
  signed-DE, obrazu animacji, zakresu/palety, wyboru k/f, fazy, pauzy i paneli.
  Operacje dotyczą prezentacji; nie zastępują testu aktywnego solvera.

CI `40759600486`: 58 plików / 1421 testów PASS, typecheck wykrył brak
`Selection.moduleSource`. Poprawka `c61c796df4206c3cd07b46c9ad7b5d26d36b54af`
przeszła pełne CI [40761152801](https://github.com/MateuszZelent/fullmag/actions/runs/40761152801).
Ponowny dispatch starego SHA `40760894305` nie jest dowodem poprawionej wersji.
Poprawka s: `8150a2701c8fb086aab7f42bcb52f3bc0d7bc67a`.
[CI 40762300718](https://github.com/MateuszZelent/fullmag/actions/runs/40762300718):
**PASS**, 58 plików / 1421 testów, pełny typecheck, architektura i bramka
React Doctor. Pozostały te same dwie kategorie uwag (trzy miejsca) sprzed zmian.

Lokalny hook React Doctor ponownie zgłosił błąd parsera oxlint
`Unexpected discriminant 7 for TSTypeName`; nie uznano go za zaliczony.
Testy jednostkowe kompilowano tylko w GitHub Actions.

W `full-controls-v2` przełączanie +25 → Γ, faza 0 → π/2 i nieruchomy obraz
po pauzie przeszły; dalszy test zatrzymał się na próbie użycia kontrolki we
zwiniętej sekcji Appearance. Harness otwiera tę sekcję jawnie. W
`final-controls` ręczny zakres był poprawnie przekazany, lecz porównanie obrazu
przy minimum −1 nasycało całe ujemne pole zarówno przed, jak i po zmianie
maksimum. Kontrola obrazu używa teraz zakresu −5·10¹¹…+5·10¹¹, obejmującego
rzeczywistą amplitudę tego konkretnego pola. Nie zmieniono rendererów ani
asercji wymuszającej różny obraz przy faktycznej zmianie odwzorowania kolorów.

W `final-controls-v2` potwierdzono zmianę koloru przy zakresie obejmującym obie
polaryzacje, paletę, selektor +25/Γ, zmianę fazy, zatrzymanie obrazu po pauzie,
wyłączenie animacji przez wybór statycznego Real oraz osiem operacji panelowych:
float, move, resize, maximize, restore, hide, show, dock. Canvas pozostał
widoczny, WebGL context nie był utracony (703×573). Nie zaliczono całego harnessu:
ostatni odczyt niezmienionego wpisu `mode-surface-binding` trafił na wyczyszczony
fragment ograniczonego bufora diagnostycznego. Próba oczekiwania na nowy wpis po zmianie składowej również wykazała ograniczenie
diagnostyki; końcowy test sprawdza odpowiedź rzeczywistego obrazu po dokowaniu,
zamiast zakładać nieograniczoną retencję logu. Wszystkie wcześniejsze próby zachowano.

Końcowy test paneli nie może polegać na trwałym wpisie w diagnostyce: strumień
może nie zachować wpisów po zmianach układu. Rozszerzona kontrola zachowuje
potwierdzone wiązanie pola przed operacjami, sprawdza WebGL oraz wybrany i
wyświetlany kontekst Γ po operacjach, a następnie wymaga zmiany rzeczywistego
obrazu powierzchni po zmianie palety. Nie traktuje samego HTTP 200 ani napisu
„Selected mode requested” jako dowodu obrazu.

### Wynik końcowej próby paneli

`panels-final-v2/probe.json`: **PASS** dla ośmiu operacji panelowych podczas
animacji opublikowanego modu Γ. Potwierdzono rzeczywisty bufor zespolony przed
operacjami, zachowanie kontekstu Γ po operacjach oraz zmianę obrazu powierzchni
po zmianie palety. Canvas: 703×573, widoczny, `contextLost=false`. Brak błędów JS
i prób niedozwolonych mutacji. Powrót przez „Back to chart” otwiera dyspersję
z 15 punktami i dwiema krzywymi referencyjnymi.

Screeny w tym katalogu: `gamma-mode-controls.png` i
`dispersion-after-mode-picker.png`. SwiftShader potwierdza rendering WebGL;
nie stanowi kwalifikacji sprzętowego GPU ani ponownego testu fizyki solvera.
W tym wcześniejszym checkpointcie aktywny solver był **NOT VERIFIED**; aktualne potwierdzenie opisano poniżej.

Ostateczne źródła UI: `223ba56533a5aed735c382b1b6279e33759b4474`.
[CI 40765299446](https://github.com/MateuszZelent/fullmag/actions/runs/40765299446):
**PASS**, 58 plików / **1422 testy**, pełny typecheck, architektura i React Doctor
(z trzema wcześniejszymi uwagami w trzech miejscach). Backend pozostaje na
`59f5db5cf0eb.dirty`; frontend odczytuje źródła worktree przez HMR.

Dowody maszynowe: [eigensolve-mode-controls-r6.evidence.json](2026-10-28-eigensolve-mode-controls-r6.evidence.json).
Zachowano 14 cudzych zmienionych lub nieśledzonych plików; porównanie SHA-256
z manifestem zachowania nie wykazało zmian. Nie scalono PR ani nie usunięto
archiwum wyników.

`combined-final/probe.json`: **PASS całego odtwarzalnego harnessu**
`verify_eigensolve_mode_controls_ui.mjs` na końcowych źródłach. W jednej sesji
sprawdzono ręczny zakres docierający do renderera i zmieniający obraz, paletę,
wybór +25 → Γ, fazę 0 → π/2, nieruchomy obraz po pauzie, zatrzymanie animacji
przez statyczny Real, osiem operacji panelowych podczas animacji, odpowiedź
powierzchni po dokowaniu i powrót do dyspersji. Brak błędów JS i niedozwolonych
mutacji; run ID pozostał niezmieniony. Zestaw nie wysyła Solve.

## Aktualizacja końcowa R6 (28.10, po rzeczywistym obliczeniu)

[Raport naprawy, runtime i split](2026-10-28-eigensolve-r6-runtime-and-split.md)
oraz [evidence](2026-10-28-eigensolve-r6-runtime-and-split.evidence.json)
zastępują wcześniejszy status blokady. CI Rust i UI: PASS. Aktywacja z importu,
rzeczywisty solver i publikacja: PASS. Float/move/resize/maximize/restore/hide/
show/dock podczas solvera: PASS. Podział widoku z zachowaniem modu podczas
Show/Animate: PASS. Ręczna próba z nową osobą pozostaje otwarta.
