# DE signed15: ukończone obliczenia i odbiór UI — 27.10.2026

## Aktualny wynik

Run `run-live-f6e511007567b55c1e3fad2a56f9c85e914ddce3d5fb6d5565c0df3a40e65a88`, backend `fe06a6573bc03afdbe94ca9949066d1aab778dbc`, API `1bef67b6-e535-40ef-8aa8-4adccba6208e`, UI http://localhost:3217/workspace.

Relaksacja i eigensolve ukończone. API publikuje 15 próbek ky = −25, −20, −15, −10, −7, −5, −2, 0, 2, 5, 7, 10, 15, 20, 25 rad/µm. Generacja `94a4698432bb417fd3e0758c39300ef98661c84a7d3b7e6638e74b10b9ca7f4f` ma status `member_verified_owner_bound`. Pełny dowód: [API](2026-10-27-eigensolve-signed15-current-api.evidence.json). Skrypt: `examples/fem_eigen_mode_ui_de_signed15.py`, SHA-256 `8d48ad08356352d69713b29465a70e2c0ea4135f66069f3d82c2ce853dacfa2f`.

Film 40×40×10 nm, M ∥ x, k ∥ y, B = 0,1 T, Ms = 800 kA/m, Aex = 13 pJ/m. Dynamiczny demag Full2x2, periodyczne x/y, airbox Dirichleta z powietrzem 2 µm po każdej stronie filmu. FEM CPU double, 7134 tetraedry. Gamma = 9,299249697 GHz. Maksymalny pełny residual 2,7173e−11 przy wymaganym 1e−8.

[Wykres PNG](../raports/assets/de-signed15-current-20261027/de-native-completed-dispersion.png), [PDF](../raports/assets/de-signed15-current-20261027/de-native-completed-dispersion.pdf), [CSV](../raports/assets/de-signed15-current-20261027/samples.csv), [provenance](../raports/assets/de-signed15-current-20261027/provenance.json).

Gamma zgadza się z analityką dla skończonego airboxu praktycznie do precyzji numerycznej. Maksymalna różnica 0,82715% względem przybliżenia n=0 i 0,59363% względem zachowanej tabeli otwartej referencji 1D basis16. To różne przybliżenia/warunki brzegowe; nie są dowodem zbieżności ani porównaniem COMSOL A1.

## Odbiór i otwarte błędy

| Sprawdzenie | Stan i dowód |
|---|---|
| 15 punktów, Gamma, rzeczywiste pola | PASS w bieżącym API, dokładny run/stage/generation |
| Gamma w 3D, Real/Imag/Abs/Phase | Wykonane; pole zespolone, WebGL2 bez utraty kontekstu i niezerowy buffer; sam film 40×40×10 nm, bez airboxu |
| Animacja Gamma | Zmiany 40004–40044 pikseli pomiędzy klatkami, zatrzymane klatki identyczne; osobny [dowód pikseli](2026-10-27-eigensolve-signed15-animation-pixels.evidence.json) |
| Pełny strict browser verifier | FAIL: GET `/v2/sessions/current/data/artifacts` zwraca proxy HTTP 500. Nie obniżono bramki ani nie usunięto błędu z raportu |
| ETag listy artefaktów | Potwierdzona przyczyna `HPE_HEADER_OVERFLOW`: nagłówek zawiera wszystkie ścieżki zamiast hasha. Poprawka źródłowa hashuje pełną odpowiedź; regresja 250 pozycji i unieważniania cache kierowana do CI. Runtime nadal poprzedza poprawkę |
| Punkt Gamma → mod | Kliknięcie rzeczywistego canvasu wybiera sample 7/raw mode 0 i 9,299249697 GHz. Przeglądarka wykryła zasłonięty przycisk akcji przez canvas; CSS poprawiony i hit-testing potwierdza BUTTON zamiast CANVAS; dodatkowo wykryto niezgodny reader KSamplingIR: manifest publikuje points/samples_per_segment, UI wymagało sample_count. Reader rozszerzony z walidacją wire contract i regresjami; PASS w zakresie rzeczywistego kliknięcia Gamma → pole zespolone 3D po obu poprawkach; [dowód](2026-10-27-eigensolve-dispersion-point-mode-ui.evidence.json). Zmiana ky → path zachowuje wybrany sample 7 i dokładne pole; zakres/pozycja punktu po zmianie osi i strict browser pozostają osobnymi bramkami |
| Zapis/ponowne otwarcie FMS | FAIL: accepted-v2 eksport zachowuje w live snapshot odnośniki do projekcji `runs/<run>/artifacts/...`, których nie pakuje. Skaner traktuje również złożony `accepted_state_ref` jako nieznany CAS ref. Nie omijać kontroli kompletności ani nie usuwać odnośników w celu uzyskania PASS |
| Retry projekcji | Poprawka `fe06a6573` przeszła CI [40564150611](https://github.com/MateuszZelent/fullmag/actions/runs/40564150611), w tym moduł `live_accepted_projection::tests` |
| Pełne widmo, tracking, serial/adaptive, zbieżność, COMSOL A1 ≤0,5% | NOT VERIFIED |
| PR/master | PR262 draft, konflikty; brak merge |

## Kolejne kroki

1. Dokończyć odbiór CSS: przycisk jest osiągalny prawdziwym kliknięciem i pokazuje dokładne pole wybranego punktu; zachować dowód po zmianie osi.
2. CI poprawki ograniczonego ETag; wdrożyć do backendu po przygotowaniu sprawdzonego zachowania/odtworzenia aktualnej sesji, ponowić strict browser verifier.
3. Naprawić accepted-v2 FMS: zachować pełną, zweryfikowaną projekcję artefaktów wyprowadzoną z accepted closure, dodać typed obsługę AcceptedStateRef bez traktowania jej jak CAS ani osłabienia unknown-ref guards. Regresja eksport → inspect → cold visualization import z prawdziwym mode bundle i tamper rejection. Same puste katalogi testowe są niewystarczające.
4. Kontynuować I0/I1/I5/I6/I7 w oryginalnym planie; powyższy wykres nie zamyka całego celu.

Zwykły restart-idle zachował SessionStore, lecz nie odtworzył aktywnej sesji UI. Poprzedni ukończony run `run-live-d09693e8f59dc1d41274c8b5510b57fd7a69f0c1847b7cd3a3d18172900e19bc` pozostaje nienaruszony; bieżące dane pochodzą z nowego, jawnie uruchomionego sweepa. Nie restartować ponownie wyłącznie w celu obserwacji i nie deklarować działającego FMS przed cold-import proof.


## CI i aktywne okno po poprawkach

Commit `8714a84d5222ce43a90cd0c06859120e8f90e44c` jest na remote. CI Rust [40569633928](https://github.com/MateuszZelent/fullmag/actions/runs/40569633928) i frontend/browser [40569637108](https://github.com/MateuszZelent/fullmag/actions/runs/40569637108) uruchomione; nie deklarujemy PASS przed wynikiem. Backend nadal `fe06a6573`; poprawki CSS/KSamplingIR załadowano przez frontend HMR. Ograniczony ETag wymaga późniejszego wdrożenia backendu. Widoczne okno Chromium jest otwierane z dokładnym polem Gamma; jego proces jest obserwowany osobno od trwałych usług Docker.


## Kontynuacja naprawy eksportu

Frontend/browser CI `40569637108` zakończone PASS; backend nie był ponownie restartowany. FMS1/FMS2 oraz pozostałe prace mają [osobny plan kontraktów i odbioru](../superpowers/plans/2026-10-27-eigensolve-fms-roundtrip-repair.md). W źródłach dodano typowanie AcceptedStateRef i jawnie ograniczone źródło CAS accepted closure dla grafu live snapshot. Nie zmieniono jeszcze zamkniętego namespace v2 i nie deklarujemy gotowego eksportu modów.


CI Rust `40569633928` zakończone PASS na `8714a84d5`, w tym test ograniczonego ETag i wszystkie kontrakty fullmag-session. Nowe zmiany FMS1/FMS2 powstały później i wymagają odrębnego CI; nie przenosimy na nie poprzedniego wyniku.
