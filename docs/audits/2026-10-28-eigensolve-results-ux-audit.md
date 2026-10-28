# Audyt UX przeglądania wyników eigensolve i plan uporządkowania UI

Data: 2026-10-28. Status: **audyt wykonany; przebudowa aplikacji jeszcze niewdrożona**.

## 1. Wniosek i granice

Obecny ekran prezentuje przede wszystkim strukturę zasobów i implementacji. Użytkownik szukający zależności f(k) i kształtu konkretnego modu musi przejść przez identyfikatory, statusy transportu, provenance, fizykę, diagnostykę oraz ustawienia wyglądu w jednym długim panelu. To problem hierarchii informacji, semantyki stanów i działania zakładek. Sama zmiana kolorów nie wystarczy.

Audyt obejmuje Results Explorer, inspektor kategorii dyspersji, inspektor pojedynczego modu, układ wykresu/viewportu i telemetrykę widoczną przy oglądaniu zapisanych wyników. Nie jest pełnym audytem wszystkich ekranów Fullmaga ani ponowną kwalifikacją solvera. Nowych obliczeń, importów ani zmian kodu aplikacji nie wykonano.

Źródła: dedykowany worktree `/home/kkingstoun/git/fullmag/worktrees/eigensolve-integration-ui-20261026`, branch `codex/eigensolve-integration-ui-20261026`, HEAD `09e14a42a33c6fc1d4ead93dfe5eafc182a0de30`. Działające UI: `http://localhost:3217/session/eigen-mode-ui-de-signed15`, runtime `0.1.0-dev.20261028.g7abc39f3ba46+9797`. Różnica HEAD/runtime dotyczy późniejszej dokumentacji. Dane fizyczne mają własną tożsamość źródła w artefakcie; nie należy zastępować jej SHA bieżącego frontendu.

Wykorzystano trzy obrazy użytkownika, odczyty API, rzeczywistą przeglądarkę w osobnym kontekście oraz źródła wymienione w §8. Towarzyszący [zapis dowodów](2026-10-28-eigensolve-results-ux-audit.evidence.json) zawiera hashe źródeł, pomiary i lokalizacje materiałów. Poprzedni [raport funkcjonalny UI](2026-10-28-eigensolve-docker-recovery-ui.md) pozostaje dowodem renderowania i zgodności danych; nie był badaniem intuicyjności interfejsu.

## 2. Co zostało odtworzone

| Obserwacja | Wynik w przeglądarce |
| --- | --- |
| Inspektor kategorii „Dispersion & k-resolved response” | 4 × `Unavailable`, 2 × `Not applicable` |
| Inspektor `Sample 5 · Mode 0` | 5 × `not available`; 31 elementów sterowania, licząc nagłówek/zakładki/stopkę |
| Zakładki Overview / Data / Provenance / Diagnostics | Zmienia się aktywna zakładka; tekst panelu pozostaje identyczny, 2893 znaki, ten sam SHA-256 |
| Wysokość treści inspektora modu | 2691 px przy 459 px widocznej wysokości: około 5,9 wysokości panelu |
| Wysokość treści kategorii | 858 px przy 459 px widocznej wysokości |
| Błędy JavaScript podczas inspekcji | 0 |
| Próby mutacji API poza ACK wizualizacji | 0; pozostałe metody zapisujące były blokowane przez harness |

Pomiar dotyczy konkretnego układu 1600 × 1100, nie każdej konfiguracji paneli. Harness jedynie wybrał węzły i zakładki; nie aktywował nowego pola w viewportcie. Widoczny w świeżym kontekście komunikat o niematerializowanym `m` nie stanowi w tym audycie dowodu awarii renderowania wybranego modu. Stan zaznaczenia i stan aktywnego pola trzeba wyraźnie rozdzielać.

Odczyt wybranego modu potwierdza: k = (0, −5·10⁶, 0) rad/m, f = 10,310201976016174 GHz, część urojona częstotliwości 0, `damping_policy=ignore`, `phasor_convention=exp_plus_i_omega_t`. Dostępny jest residual względny 7,494532641082661·10⁻¹² przy progu certyfikacji 10⁻⁸, z zakresem `full_projected_weak_form_and_periodic_seams` i certyfikatem producenta. To dowód dla tego artefaktu, nie kwalifikacja zbieżności ani kompletności całego widma.

## 3. Ustalenia

P1: błąd działania lub myląca interpretacja wyniku. P2: istotna przeszkoda w podstawowym zadaniu. P3: porządek i wykończenie. Priorytety nie oznaczają, że wszystkie problemy są błędami solvera.

| ID / priorytet | Potwierdzony problem i skutek | Przyczyna / kotwica | Naprawa i warunek odbioru |
| --- | --- | --- | --- |
| UX01 · P1 | Cztery zakładki inspektora modu pokazują tę samą treść. Użytkownik nie może oddzielić danych od diagnostyki. | `InspectorShell` zmienia `InspectorTabState`, lecz `ScientificFrameRoute` i `EigenModeInspectorPanel` renderują zawsze tę samą zawartość. S1–S4. | Właściciel panelu jawnie rozdziela zawartość zakładek albo usuwa puste zakładki. Każda pozostawiona zakładka ma inną, uzasadnioną treść; test przeglądarkowy klika wszystkie, nie tylko sprawdza aria-selected. |
| UX02 · P1 | Znany model bez tłumienia przedstawia Lifetime i Q jako brak danych. | `modalDampingObservables` rozpoznaje `undamped`, lecz dla nieskończonych/niefinitywnych wielkości zwraca null; renderer zamienia null na `not available`. S4–S5. | Pokazać „Tłumienie pominięte — brak zaniku w tym modelu”. Nie zamieniać każdego null na ∞: nieznana konwencja, brak częstotliwości, mod rosnący i zerowa częstotliwość to osobne przypadki. |
| UX03 · P1 | „Phase convention: not available”, mimo dostępnej konwencji czasowej. | `useEigenModeSummary` czyta `field_units.phase_convention` lub `metadata.phase_convention`; rzeczywisty artefakt publikuje top-level `phasor_convention`. Resolver tłumienia już go rozpoznaje. S4–S5. | Oddzielić „Konwencja czasowa” od przestrzennej fazy Floqueta. Dla czasowej użyć istniejącego typowanego resolvera. Nie podmieniać automatycznie znaczenia przestrzennej fazy na czasową. Brak wymaganej konwencji pozostaje jawną diagnozą. |
| UX04 · P2 | Kategoria zbiorcza wygląda jak uszkodzony pojedynczy wynik: brak Run, Stage, Equilibrium, revision. | `rootWithChildren` tworzy kategorię bez tożsamości pojedynczego artefaktu; `PhysicsFirstResultInspectorFrame` stosuje do niej szablon zasobu. S3, S6. | Osobny inspektor kolekcji: liczba badań/zbiorów, zakres k, dostępne wyniki i akcje. Kontekst runu pobierać od rzeczywistego właściciela; nie wymyślać jednego Stage lub equilibrium na podstawie pierwszego dziecka. |
| UX05 · P2 | Częstotliwość i akcje modu są pod statusami, URI i hashami. Pierwszy ekran inspektora nie odpowiada na pytanie „co oglądam?”. | `ScientificInspectorTemplate` domyślnie rozwija Status, Physical properties i Provenance przed właściwym panelem. Dodatkowy nagłówek powtarza tożsamość z `InspectorShell`. S1, S3, S7. | U góry: f, fizyczne k, wybrana gałąź/mod, dostępność pola i jedna główna akcja. Rozwinięte dane techniczne dopiero na żądanie. |
| UX06 · P2 | „Sample 5 · Mode 0” nie pozwala rozpoznać k = −5 rad/µm i częstotliwości bez dodatkowych kroków. | `modalFieldTargets` zna wavevector i frequency, lecz buduje etykietę z indeksów; `buildEigenModeIdentityViewModel` powiela indeksy. S4, S6. | Czytelna etykieta fizyczna, np. „kᵧ −5 rad/µm · 10,3102 GHz”. Γ wyróżnić. Indeksy/raw IDs zachować w provenance; nie zmieniać kluczy tożsamości ani utożsamiać gałęzi z raw mode. |
| UX07 · P2 | Residuale opcjonalne/legacy wyglądają jak brak podstawowej kontroli poprawności, choć raportowany residual względny jest dostępny. | `EigenModeResidualFields` stale renderuje Absolute L2 oraz „Spectrum residual (type unspecified)” z pustymi wartościami. S4, S8. | W „Jakości” pokazać właściwy residual, jego zakres, próg i status certyfikatu dla wybranego artefaktu. Opcjonalny niewyemitowany residual opisany tylko w szczegółach. Nie utożsamiać różnych norm i nie uzupełniać zerami. |
| UX08 · P2 | Zduplikowane wybory widoku/koloru i stale widoczne nieaktywne opcje wydłużają panel. `Mode component` używa δm, a część etykiet kolorowania ogólnego m. | `FrequencyDomainModeDisplayControls` renderuje solid color także przy innym color source; vector budget/scope/scale także bez wektorów. Min/max dla auto są widoczne, choć częściowo wyłączone. Dodatkowo `EigenMode3DActions` ponawia Real/Imag/Abs/Phase. S4, S9. | Jedna sekcja „Wygląd”: reprezentacja, składowa, powierzchnia/wektory. Ustawienia podrzędne warunkowo. W trybie modu etykiety odnoszą się do δm. Dokładnie jedna kontrolka danego ustawienia, synchronizowana z istniejącym stanem. |
| UX09 · P2 | Wykres konkuruje z szerokim inspektorem, ribbonem i wysoką telemetryką z czasowej dynamiki. | Poprzedni raport mierzył canvas 569 × 286 przy oknie 1440 × 1000. `FooterTelemetry` subskrybuje skalary sesji i renderuje siatkę metryk bez kontekstu wybranego wyniku. S10 i wcześniejszy raport. | Tryb oglądania wyników z dużym obszarem wykresu, kompaktową stopką, panelem szczegółów dostępnym na żądanie. Telemetrykę obliczeń zachować w rozwijanym panelu; nie przerywać obliczeń ani ich obserwacji. |
| UX10 · P2 | Zaznaczenie modu i prezentowany w 3D obiekt nie są wystarczająco czytelnie powiązane. Sam wybór w drzewie nie jest dowodem aktywacji pola. | Istnieje osobna komenda `analysis.eigen.plot-mode-3d`; stany wyboru/overlay mają różne cykle życia. S4 i harness. | Jedna widoczna akcja „Pokaż mod w 3D” oraz nagłówek aktywnego viewportu z k i f. Do czasu ukończenia zmiany pola wyraźny stan ładowania, a przy błędzie poprzedni mod opisany jako poprzedni. Test: etykieta, owner, generation i payload wskazują ten sam mod. |
| UX11 · P2 | `ready/completed/available` nie mówi, czy wynik jest naukowo zweryfikowany; aktualne capabilities backendu nie opisują automatycznie importowanego archiwum. | Statusy szablonu dotyczą transportu/wykonania/dostępności; manifest zawiera osobno capabilities i artefakty. S3, S7 i snapshot API. | Osobne, zwięzłe informacje: „wynik zapisany”, „pole dostępne”, „kwalifikacja zbieżności otwarta”. Zachować pełne stany techniczne w szczegółach. Nie używać zielonego statusu transportu jako certyfikatu fizyki ani niedostępnego nowego Solve jako dowodu braku archiwalnego pola. |
| UX12 · P3 | Treści o implementacji i planowanych funkcjach zaśmiecają normalną pracę: Shared style preset, Volume inspection roadmap, raw URI, token CSS koloru, No staged edits. | Stałe teksty w `EigenModeInspectorPanel`, surowy `settings.solidColor` i uniwersalny `InspectorFooter`. S4, S9, S11. | Usunąć roadmapę z operacyjnego inspektora; Help dla wyjaśnień, Provenance dla URI/ID, przyjazna nazwa koloru/wartość rozstrzygnięta, stopka edycji tylko tam, gdzie są edycje. Fit view przy viewportcie, nie jako uniwersalna akcja wyniku. |

## 4. Jak interpretować „brak danych”

Nie należy jedynie ukryć wszystkich pustych pól. Potrzebne jest rozróżnienie przyczyn w modelu prezentacji, zachowujące wymagane diagnostyki.

| Przypadek | Znaczenie | Prezentacja |
| --- | --- | --- |
| Kategoria wyników bez pojedynczego Stage/equilibrium | Wielkość nie jest własnością kolekcji | Nie tworzyć pustego wiersza. Pokazać podsumowanie kolekcji i przejście do konkretnego badania. |
| Znane `ignore`, Im(f)=0, rozpoznana konwencja | Brak zaniku w tym modelu | „Tłumienie pominięte”. Brak skończonego czasu zaniku; szczegóły Q/lifetime opcjonalnie, bez mylenia z błędem odczytu. |
| Konwencja opublikowana pod innym, obsługiwanym kluczem | Błąd mapowania UI | Poprawić adapter i jednoznaczną nazwę konwencji. |
| Niewyemitowany opcjonalny Absolute L2 | Tego konkretnego pomiaru nie zapisano | Nie wypiera dostępnego residualu względnego; szczegół „nie zapisano w tym artefakcie”. |
| Brak wymaganej tożsamości, payloadu lub poprawnej generacji | Rzeczywista przeszkoda w bezpiecznym użyciu wyniku | Widoczny powód, zablokowana zależna akcja, szczegóły diagnostyczne i sensowna możliwość odtworzenia odczytu. |
| Ładowanie | Stan przejściowy, jeszcze bez wyniku | Krótki stan ładowania; nie „brak danych”. |
| Brak kwalifikacji siatki/airboxu/kompletności | Otwarta weryfikacja naukowa | Jawne „niepotwierdzone”, niezależne od dostępności wykresu i poprawnego residualu. |
| Funkcja planowana lub nieobsługiwana | Nie istnieje aktywna ścieżka dla tej operacji | Nie prezentować jej jak bieżącego parametru. Przy potrzebnej akcji podać ograniczenie; reszta w Help/dokumentacji. |

Stan `missing_required` nie może zostać zamieniony w `not_applicable`, żeby panel wyglądał lepiej. To samo dotyczy konwencji, normalizacji i identyfikacji siatki. Proponowana warstwa prezentacji może rozróżniać te stany bez zmiany istniejących statusów zasobów i kontraktu solvera.

## 5. Docelowy model pracy

Podstawowy scenariusz: **wybierz zbiór wyników → zobacz f(k) → wskaż punkt → zobacz mod**.

1. **Explorer wybiera zbiór/badanie.** Krótkie, fizyczne etykiety; pełne rozwijane drzewo nadal dla dużych projektów. Run hash, revision i machine codes nie dominują. Nie usuwać na stałe innych rodzin wyników z globalnego Explorera tylko dlatego, że bieżący przykład jest modalny.
2. **Środek jest miejscem pracy.** Widoki „Dyspersja”, „Mod 3D”, „Dane”, opcjonalnie istniejący układ „Wykres + 3D”. Wykres z podpisanymi jednostkami, rozróżnioną numeryką i referencjami oraz wyborem podpisanej współrzędnej k. Nie dodawać drugiego konkurencyjnego canvasu 3D ani odrębnego workspace.
3. **Panel kontekstu odpowiada na bieżący wybór.** Dla kolekcji: zakres, liczba opublikowanych próbek, wyniki. Dla dyspersji: serie i porównanie. Dla modu: f, k, gałąź, dostępność pola, główna akcja. Nie wymuszać stałej liczby kafelków przez uzupełnianie `N/A`.
4. **Wygląd blisko widoku.** Reprezentacja zespolona, składowa, faza/animacja oraz dodatkowe opcje kolorowania/wektorów w jednym spójnym miejscu. Interfejs mówi wprost, że skala wizualizacji nie zmienia wyliczonego wektora własnego ani nie jest amplitudą fizycznego wzbudzenia.
5. **Jakość i pochodzenie dostępne po rozwinięciu.** Istotny błąd lub otwarta kwalifikacja pozostaje widoczna również po zwinięciu. Pełne hashe, URI, SI i precyzja dostępne do skopiowania/eksportu; zaokrąglenie na ekranie nie modyfikuje danych.
6. **Stopka jest kontekstowa.** Zapisany wynik, liczba próbek, postęp aktywnych obliczeń gdy istnieją. Szczegółowa telemetryka nadal dostępna, lecz nie konkuruje stale z wykresem.

Nie należy utożsamiać jednego k z dyspersją ani etykiety „1 zapisana gałąź” z kompletnością widma. Dla ogólnej ścieżki k zachowujemy wektor i współrzędną ścieżki; podpisane kᵧ jest właściwe dla tego konkretnego przykładu DE, nie wszystkich badań.

### Makieta poglądowa

Pliki znajdują się w katalogu artefaktów wskazanym w evidence JSON:

- `propozycja-results.html` — interaktywna, lokalna makieta; rzeczywiste 15 punktów FEM i zapisane referencje z poprzedniego raportu;
- `propozycja-dyspersja.png` — układ wykresu i krótkiego panelu modu;
- `propozycja-mod-gamma.png` — przykład widoku Γ;
- `prototype-check.json` — sprawdzenie makiety.

To **nie jest implementacja Fullmaga**. Makieta nie łączy się z API, nie uruchamia solvera ani WebGL. Podgląd Γ wykorzystuje niezmieniony zrzut z poprzedniej udanej weryfikacji; nie podstawia go jako modu innego k. Klikanie punktów, tabela, przełączanie widoków i referencji działają lokalnie. Makieta upraszcza zewnętrzny chrome aplikacji, żeby pokazać priorytety treści; jej wdrożenie nie upoważnia do usunięcia globalnych menu, narzędzi lub cyklu życia paneli.

## 6. Plan wdrożenia — wszystkie etapy aplikacyjne pozostają do wykonania

| Etap | Zakres / właściciel zmian | Zależności | Kryterium odbioru | Stan |
| --- | --- | --- | --- | --- |
| R1 | Model stanów prezentacji + poprawne zakładki: inspektor kategorii, `PhysicsFirstResultInspectorFrame`, adapter konwencji/tłumienia/residualu, `InspectorTabState` i panel modu | Audyt | Cztery zakładki nie powtarzają tej samej treści; znany przypadek bez tłumienia nie wygląda jak brak danych; krytyczne braki nie są ukrywane. | TODO |
| R2 | Hierarchia inspektorów: oddzielny kontrakt kolekcji, dyspersji i modu; wspólny template bez podwójnej tożsamości | R1 | Dla modu f, k i główna akcja widoczne bez przewijania przy 1440 × 900; provenance nie poprzedza podstawowego wyniku. | TODO |
| R3 | Etykiety oraz nawigacja: builder Explorera, selekcja, jeden kanoniczny selected result, czytelny powrót do wykresu | R1–R2 | Γ i ±k rozpoznawalne bez indeksów; przejście od zaznaczonego punktu do jego pola w najwyżej dwóch świadomych akcjach; tożsamość run/stage/generation zachowana. | TODO |
| R4 | Kontekstowe controls wyglądu i status aktywnego pola; integracja istniejącego viewportu | R2–R3 | Jedno sterowanie reprezentacją/składową; ukryte nieistotne controls; po zmianie k etykieta i payload odpowiadają sobie, poprzednie pole nie udaje nowego. | TODO |
| R5 | Układ wyników, stopka, spacing/typografia zgodne z tokenami i zachowanym panelem dock/float | R2–R4 | Duży wykres, szczegóły na żądanie, brak poziomego overflow; brak utraty zaznaczenia, kamery, scrolla, ustawień i działającego obliczenia przy ukryciu/zmianie rozmiaru paneli. | TODO |
| R6 | Weryfikacja aplikacji na rzeczywistych artefaktach i nowych stanach pustych/błędnych; aktualizacja specs i screenów | R1–R5 | Macierz poniżej przechodzi; odrębny test z nowym użytkownikiem nie jest zastępowany samym Playwrightem. | TODO |

Pierwszy fragment implementacji powinien zamknąć UX01–UX04 bez przebudowy solvera. Potem można skracać panel i reorganizować workspace. Nie rozpoczynać od masowego przepisywania CSS ani globalnej wymiany wszystkich inspektorów.

Uzgodnić dokumentację z istniejącymi kontraktami: `13-inspector-and-property-editing.md` (jeden semantyczny owner i istniejące zasoby), `32-results-analysis-feature-modules.md` (proponowany, nie wdrożony stan docelowy), `33-ui-glossary.md` (spójne nazwy). W propozycji 32 trzeba zrewidować wymóg stałej liczby metryk, jeśli prowadzi do pustych kafelków. Zachować istniejący kernel/resource cache/selection/visualization state; bez bezpośrednich fetchy w komponentach i bez drugiego magazynu wyniku.

## 7. Macierz odbioru przyszłej implementacji

| Obszar | Wymagana kontrola |
| --- | --- |
| Rodzaj zaznaczenia | Kategoria, badanie, dyspersja, pojedynczy mod, brak zaznaczenia — każdy pokazuje właściwy zakres informacji. |
| Zakładki | Zmienia się zarówno aria-selected, jak i treść; focus i obsługa klawiatury poprawne. |
| Dane fizyczne | Γ oraz oba znaki k; indeksy nie podmieniają współrzędnych; częstotliwość pochodzi z właściwego artefaktu; domyślna oś nie zamienia podpisanego k w odległość bez wyjaśnienia. |
| Stan modalny | Undamped, decaying, growing, nieznana konwencja, brak części urojonej i zerowa częstotliwość — odrębne komunikaty, brak fałszywego ∞ lub 0. |
| Braki danych | Opcjonalny brak odróżniony od brakującego wymaganego payloadu, identity, generacji i certyfikatu. |
| Porównanie | FEM i analityka rozróżnione stylem; inne warunki brzegowe opisane; żadnego automatycznego „zweryfikowano solver” na podstawie jednego progu lub residualu. |
| 3D | Widoczny canvas, żywy WebGL context, niezerowy drawing buffer, właściwe complex values i surface binding; poprawna faza/animacja. SwiftShader nie jest dowodem obliczeń GPU. |
| Layout | 1600 × 1100, 1440 × 900, 1100 × 900; węższe okno jako osobny układ, nie ucięty desktop. Krytyczna informacja i akcja bez pionowego szukania; detale mogą się przewijać. |
| Cykl życia | Dock/float, resize, hide/show, zmiana wybranego k i powrót do wykresu zachowują stan; background job nie jest zależny od widoczności panelu. |
| Użyteczność | Nowa osoba wskazuje Γ, odczytuje f, przechodzi do modu i wyjaśnia status jakości bez znajomości machine IDs. Wynik takiego badania: NOT VERIFIED do rzeczywistej sesji. |

Zakaz lokalnej kompilacji testów pozostaje w mocy; wymagające jej bramki realizować zgodnie z wcześniej udzieloną zgodą w GitHub Actions. Odczytowy harness przeglądarki i walidacja lokalnej makiety nie kompilują testów aplikacji.

W tym etapie: odtworzono problem zakładek, sklasyfikowano brakujące wartości, przejrzano układ i przygotowano makietę. Wykonano kontrolę interakcji makiety, tabeli i pięciu szerokości 1600/1440/1100/820/390, bez błędów JavaScript i poziomego overflow. To dowód dla makiety, nie zamknięcie R1–R6. Nowe Solve, kwalifikacja COMSOL, mesh/airbox convergence i nowy performance benchmark: poza zakresem tego audytu.

## 8. Mapa źródeł

Numery linii odnoszą się do wskazanego HEAD; SHA-256 całych plików zapisano w evidence JSON. Ścieżka plus symbol pozostają kotwicą po przesunięciu linii.

| Ref | Plik, symbol i linia |
| --- | --- |
| S1 | `apps/control-room/src/modules/inspector/InspectorShell.tsx`: `InspectorShell`, okolice 67, 165–190; shell przełącza aktywną zakładkę, dzieci pochodzą od panelu. |
| S2 | `apps/control-room/src/modules/inspector/InspectorTabState.ts`: `configureInspectorTabs`, `setInspectorActiveTab`, 18–39. |
| S3 | `apps/control-room/src/modules/inspector/panels/physics-first/PhysicsFirstResultInspectors.tsx`: `ScientificFrameRoute` 29; `DispersionOverviewResultInspector` 221. `PhysicsFirstResultInspectorPanel.tsx`: `PhysicsFirstResultInspectorFrame`, 14–69. |
| S4 | `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenModeInspectorPanel.tsx`: `buildEigenModeIdentityViewModel` 57; `EigenModeInspectorPanel` 97–141; `EigenModeResidualFields` 149; `EigenModeDampingFields` 173; `useEigenModeSummary` 365, konwencja 424–437. |
| S5 | `apps/control-room/src/shared/domain/analysis/modalDampingObservables.ts`: `modalDampingObservables` 29–85; `resolveModalPhasorConvention` 97. |
| S6 | `apps/control-room/src/modules/explorer/builders/resultsExplorerNodes.ts`: `modalFieldTargets` 327–391; `rootWithChildren` 1198; `buildPhysicsFirstResultsTree` 1414, root runu 1436, k-resolved 1465. |
| S7 | `apps/control-room/src/modules/inspector/components/ScientificInspectorTemplate.tsx`: `ScientificInspectorContext` 76–117; `ScientificInspectorTemplate` 130–157. |
| S8 | `apps/control-room/src/shared/domain/analysis/eigenResidualSummary.ts`: `buildEigenResidualSummary`, 19–40. |
| S9 | `apps/control-room/src/modules/inspector/panels/FrequencyDomainModeDisplayControls.tsx`: `FrequencyDomainModeDisplayControls` 387–650; solid color 489, zakres 551, parametry wektorów 606. |
| S10 | `apps/control-room/src/modules/footer/FooterTelemetry.tsx`: `FooterTelemetry`, subskrypcje około 85–136, render 142–186. |
| S11 | `apps/control-room/src/modules/inspector/InspectorFooter.tsx`: `InspectorFooter`, komunikat 26–30, render 54–90. |
| S12 | `docs/specs/frontend-v2/13-inspector-and-property-editing.md`, `32-results-analysis-feature-modules.md`, `33-ui-glossary.md`; `src/design/styles/theme.css` i `tokens.css` w `apps/control-room`. |
