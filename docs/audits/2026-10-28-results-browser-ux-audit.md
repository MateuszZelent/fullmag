# Audyt UX przeglądarki wyników, Inspectora i przejścia live ↔ preview

Data: 2026-10-28, aktualizacja 2026-10-29. Status: **REQUEST CHANGES dla całej funkcji — końcowy audyt nawigacji, snapshotów m, tabel i powrotu do Live przeszedł; pozostałe formaty i bramki kwalifikacji pozostają otwarte**.

## Aktualny stan audytu

Poniższa tabela jest bieżącym podsumowaniem. Szczegółowe ustalenia UX-01–16 poniżej opisują także stan sprzed napraw; ich historyczne brzmienie nie oznacza, że każde pozostaje otwartym defektem.

| Obszar | Aktualny wynik i zakres | Pozostała praca |
|---|---|---|
| Model Builder / Object / Airbox | Browser: Cancel zachowuje draft, Saved odmawia zmiany kontekstu, Discard przywraca zapis; powrót ze snapshotu zachowuje draft modelu | Dalsze przypadki formularzy poza Name/hmax |
| Inspector snapshotu | Próbki czasu, własne ustawienia, powrót do ostatniej próbki po wyborze pliku; stabilne montowanie | Pełny widok szeregu tabelarycznego i pozostałe formaty analiz |
| Live ↔ preview | Rzeczywisty FEM m: zgodność payloadu, brak mutacji sesji w badanym przepływie, opóźniona odpowiedź nie przywraca historii | Bezsesyjny przepływ przeszedł z fixture discovery i realnymi danymi; kontrolowany błąd odczytu wymaga dalszego QA |
| Kamera i panele | Fit/Reset, zachowanie kamery, hide/restore/float/dock; szerokości 768–1920 przeszły | Pozostałe komendy kamery, powiększenie 200% |
| Results / nawigacja | Wspólny filtr/collapse/focus, widoczny zakres wyszukiwania, klawiatura, wejście Saved | Kolejność folderów i Source details mają dowód browser; duże katalogi/strony i długi run pozostają otwarte |
| Tabele i metadane | Nazwy sześciu kolumn, odczyt pierwszej/ostatniej próbki, tekstowe preview | Pełne możliwości analiz dla tabel/modów/eigensolve |
| FDM/FEM i wszystkie quantity | Katalog odczytuje faktyczne wpisy; FEM m ma kwalifikowane 3D | H_eff FEM wymaga per-quantity geometry binding; nowa regresja FDM/YIG i wiele etapów |
| Monitoring | Revision-pinned reader i polling widocznego panelu | Managed run publikuje current output dopiero na końcu; aktywny autosave nie jest zakwalifikowany |
| Dostępność i czytelność | Klawiatura drzewa, osiągalne kontrolki po scrollu, motywy, brak poziomego overflow w badanym zakresie | Wspólne tokeny dark/light przeszły check:design; brak pełnej kwalifikacji czytnika ekranu i wszystkich rzeczywistych zestawień kolorów |
| Integracja | Commity i draft [PR #332](https://github.com/MateuszZelent/fullmag/pull/332), grupa 3298 zachowana | CI, końcowe review i merge; React Doctor hook nie ukończył analizy parsera |

## Zakres i tożsamość

- Checkout: `/home/kkingstoun/git/fullmag/worktrees/results-snapshot-inspector-20261028`.
- Branch: `codex/results-snapshot-inspector-20261028`.
- Początkowy HEAD audytu: `6a28c950204fbc7c7566a5b6545e8aba092bec6a`. Końcowa próba ma bazowy HEAD `3b441b13048df28e0dd0da2f4396da327329ef35` i zmiany funkcji; dokładny snapshot oraz hash harnessu podano w końcowym checkpointcie.
- Badane: Explorer/Model Builder i Results, folder workspace, routing Inspectora, ustawienia snapshotów, suwak czasu, wspólny slot 3D, kamera, przejście do live, błędy/monitoring, dostępność, hierarchia informacji i zakres istniejących testów.
- Nie jest to ponowny pełny audyt bezpieczeństwa wszystkich linii backendu ani kwalifikacja fizyki FEM/FDM. Backend sprawdzono tu w zakresie kontraktu rewizji i jego wpływu na UX.
- W początkowej części audytu nie zmieniano kodu produktu ani istniejących staged zmian. Nie uruchamiano solvera, nie wysyłano wiadomości do innych czatów, nie zmieniano lease’ów.

### Historyczny checkpoint runtime — 28.10.2026

`docker ps -a --filter name=results-snapshot` oraz `docker inspect` potwierdziły, że backend `a9a0c8d9a569` i frontend `ad3f54838e69` są zatrzymane (`exited`, exit 255; backend FinishedAt `2026-10-28T18:57:48.769017355Z`, Pid 0). Połączenie do `127.0.0.1:3298` zostało odrzucone. Sam adres otwarty w przeglądarce nie dowodzi działającego UI.

Wcześniejszy checkpoint opisuje konflikt aktywacji CoFeB; nie traktujemy go jako dowodu aktualnie działającego procesu. Odczyt bieżącego czatu „Uruchom Fullmaga z CoFeB ring” wskazuje już pracę w innym worktree. Nadal nie wykonano kwalifikowanego odzyskania starej grupy ani sprawdzenia jej trwałych receiptów po zatrzymaniu. Przed wznowieniem konieczny jest właściwy preflight/recovery; nie wolno wnioskować z samego wyjścia kontenera, że przyjęte zadanie można powtórzyć.

## Werdykt

Podstawy są sensowne: faktyczny katalog outputu, jawne załadowanie pola, osobne ustawienia snapshotów, kontrola geometrii i przełączanie źródła bez Solve. Obecna integracja **nie jest jeszcze spójną i dopracowaną przeglądarką naukową**. Najważniejsze problemy dotyczą stabilności wyboru i rewizji, klawiatury oraz niespójnych komend viewportu. Osobno istnieją wyraźne problemy hierarchii informacji. Stan pierwotnego audytu nie potwierdzał wyglądu ani powrotu do live. Aktualny dowód podstawowego scenariusza desktopowego opisano w kontynuacji 29.10; responsywność i pozostałe ustalenia nie są przez niego automatycznie kwalifikowane.

## Ustalenia wymagające zmian

### UX-01 · P1 · Klawiatura może wybrać rodzica zamiast wskazanego wyniku

Źródło: `apps/control-room/src/modules/results-navigator/ResultsOutputTree.tsx:218`.

Każdy zagnieżdżony `li[role=treeitem]` ma handler Enter/Space wybierający swój wpis. Handler nie odcina propagacji i nie odróżnia zdarzenia własnego od zdarzenia potomka. Enter na wierszu potomnym przechodzi przez jego przodków; późniejsze wywołanie `onSelect` może zastąpić wybór rodzicem. Podobny problem dotyczy strzałek zwijania/rozwijania. Dodatkowo każdy `li` i jego przyciski są osobnymi przystankami Tab, a ArrowUp/Down/Home/End nie mają obsługi drzewa.

Reprodukcja do testu: katalog `stage/fields/m`, fokus na `m`, Enter. Inspector ma otrzymać wyłącznie `m`, nie `fields` ani `stage`. ArrowLeft ma działać na właściwym węźle.

Naprawa: jeden właściciel interakcji wiersza, roving tabindex i ten sam model klawiatury co istniejący ExplorerTreeView; brak propagacji aktywacji do przodków. Test z co najmniej trzema poziomami i rzeczywistymi zdarzeniami klawiatury.

### UX-02 · P1 · Monitoring resetuje stan pracy w drzewie

Źródła: `ResultsOutputExplorer.tsx:122` oraz `ResultsOutputTree.tsx:166` (ścieżki względem `apps/control-room/src/modules/results-navigator/`).

Pager ma key złożony ze źródła i rewizji katalogu. Każda nowa rewizja remountuje również drzewo, które lokalnie przechowuje zapytanie i zwinięte węzły. W trwającym runie nowy autosave może więc skasować filtr, rozwinąć gałęzie, usunąć fokus i załadowane kolejne strony. Reset paginacji przy zmianie rewizji jest potrzebny, reset interakcji użytkownika nie jest.

Naprawa: trwały stan UI przypisany do źródła, osobno revision-pinned dane stron. Uzgadniać zachowane identyfikatory węzłów, nie remountować całego panelu. Test: wpisany filtr, zwinięta gałąź, fokus i scroll przetrwają co najmniej trzy publikacje.

### UX-03 · P1 · Nowa rewizja katalogu nie aktualizuje wyboru Inspectora

Źródło: `ResultsOutputExplorer.tsx:167` zapisuje rewizję wyłącznie w `selectEntry`; `ResultsOutputInspectorContainer.tsx:98` odczytuje zapisany `resultRef.revision`. Backend `crates/fullmag-workspace-inspect/src/results.rs:429` i `:448` sprawdza tę rewizję przy metadanych i próbce.

Po aktualizacji folderu drzewo może pokazywać nowy katalog, ale wybrany wpis pozostaje przypięty do starej rewizji. Następne przewinięcie do niepobranej próbki otrzyma stale revision. Sam Refresh katalogu nie przestawia selection. Nie należy usuwać ochrony backendu; UI musi świadomie uzgodnić źródło i zakomunikować aktualizację.

Naprawa: dla bieżącego monitoringu przyjąć nową rewizję istniejącego datasetu, zachować współrzędną/indeks, zweryfikować dostępność próbki, pokazać stan aktualizacji. Dla celowo przypiętego preview jawna akcja „Update to latest” i czytelne oznaczenie rewizji. Odrębnie obsłużyć usunięty wpis i zmianę runu.

### UX-04 · P1 · Inspector i viewport mogą pokazywać inny snapshot

Źródło: `apps/control-room/src/modules/inspector/ResultsOutputInspectorContainer.tsx:84`, `:109`.

Body remountuje się po zmianie wybranego wpisu i zaczyna od `useState(0)`. Aktywny snapshot pozostaje w kontrolerze. Przebieg: załaduj próbkę 80, wybierz plik tekstowy, wróć do tej samej tablicy. Inspector pokazuje próbkę 0 i jej ustawienia, viewport nadal próbkę 80. Edycja koloru może dotyczyć niewidocznej próbki. Brakuje wyraźnego statusu „selected” versus „displayed”.

Naprawa: zachowywać wybraną próbkę per dataset; przy ponownym wyborze aktywnej serii przywracać jej aktywny indeks. Jeżeli użytkownik świadomie wybiera inną próbkę bez załadowania, oba stany muszą być czytelnie nazwane. Test integracyjny tablica → plik/Model → tablica, również przy innym aktywnym datasecie.

### UX-05 · P1 · Fit/Reset i sterowanie kamerą nie obsługują preview

Źródła: `modules/viewport-3d/manifest.ts:261`, `:272`; `SavedResultsPlaybackViewport.tsx:85`; `Viewport3DModule.tsx:1486`.

Komendy Fit i Reset zmieniają `viewport3dStore`/cameraRegistry. Kamera saved-field korzysta z lokalnego dopasowania i OrbitControls; nie subskrybuje tych zmian. Komendy mogą zwracać completed bez widocznego efektu. Ochrona `isSavedMaterializedDatasetSelection` rozpoznaje starszy typ materialized-dataset, nie nowe result-output. Ten sam slot 3D nie oznacza jeszcze wspólnego kontraktu komend.

Naprawa: kanoniczne sterowanie aktywną kamerą z rozróżnieniem źródła, bez modyfikacji ukrytego live. Fit, Reset i sterowanie z Inspectora muszą działać na widocznej scenie. Test ręcznie oddalonej/przesuniętej kamery, także po zmianie próbki.

### UX-06 · P2 · Powrót do live nie przywraca pełnego kontekstu UI

Źródło: `kernel/visualization/returnResultsToLive.ts:5`; `modules/inspector/InspectorModule.tsx:89`; `ResultsOutputInspectorContainer.tsx:198`.

Helper poprawnie odłącza historyczne źródła i nie wywołuje API, ale nie usuwa ani nie przywraca selection. Wybrany `result-output` nadal kieruje do Inspectora historycznego. Dla źródła workspace `canReturnToLive` nadal jest true także po zamknięciu folderu. Użytkownik może oglądać live obok Inspectora starego folderu z kolejnym „Return to live”. Przy braku sesji label obiecuje tryb live, choć shell przejdzie do Home/projektu.

Naprawa: ustalić i przywrócić poprzedni kontekst live (selection/tab/focus), albo jawnie pozostawić Inspector „Saved result — not displayed”. Przycisk powrotu zależny od rzeczywiście aktywnego preview; bez sesji „Close results”/powrót do Home. Kryterium: stan całego UI oraz dane live, nie tylko zniknięcie historycznego elementu DOM.

### UX-07 · P2 · Dwa niezależne drzewa Results i dwa modele nawigacji

Źródła: `ExplorerModule.tsx:1146–1162`; `ResultsNavigatorModule.tsx:790–825`; `WorkspaceDockLayout.tsx:69`.

Nowy katalog dopięto pod istniejącym drzewem semantycznym. Ma własny filtr, własne rozwijanie, osobną obsługę klawiatury i odświeżania. Górny filtr oraz Expand/Collapse All Explorera nie kontrolują tego katalogu. Folder workspace dodatkowo zastępuje lewy panel osobnym „Saved folder”. Ten sam wynik może być reprezentowany w dwóch miejscach z innymi akcjami. Tabela/mod w folderze nie otrzymuje automatycznie tych samych możliwości analizy co odpowiednik w starym katalogu semantycznym.

Naprawa: jeden Results navigator z wyborem źródła i spójnymi sekcjami Fields / Tables / Modes & analysis / Files. Zachować rzeczywiste ścieżki w szczegółach i jawne capability; semantyczne akcje powiązać z wpisem katalogu, bez udawania obsługi nieznanych plików. Nie tworzyć dodatkowego shellu aplikacji.

### UX-08 · P2 · Filtr udaje wyszukiwanie całego outputu, ale zna tylko pobrane strony

Źródła: `ResultsOutputTree.tsx:59`, `:327`; `ResultsOutputExplorer.tsx:43`.

Filtr działa na aktualnie zgromadzonych wpisach, a komunikat „No outputs match this filter” nie informuje, że poszukiwany wpis może być na kolejnej stronie. Search jest więc mylący przy większych runach. Drzewo jest rekursywne, wszystkie gałęzie domyślnie otwarte, a kolejne strony powiększają DOM bez wirtualizacji (istniejący ExplorerTreeView ma próg 200 wierszy).

Naprawa: filtrowanie serwerowe lub wyraźnie nazwane wyszukiwanie załadowanych wpisów z działającym przejściem do pełnych wyników. Ograniczona lista widocznych wierszy. Test >200 wpisów, trafienie dopiero na stronie 2/3, głęboka ścieżka.

### UX-09 · P2 · Najważniejsze sterowanie jest schowane pod danymi technicznymi

Źródło: `modules/inspector/panels/ResultsOutputInspector.tsx:352`, `:379`, `:406`, `:408`.

Kolejność: rozbudowane Output metadata → Samples → do 24 surowych wartości → Visualization. Sekcje nie są zwijane (`InspectorGroup` ma domyślnie collapsible=false). Wąski Inspector wymaga długiego scrollu do palety i skali. Tablice bez capability 3D także otrzymują Visualization oraz nieaktywny Load into 3D. Tabele są podglądem listy wartości, nie pełną przeglądarką tabel.

Naprawa: nagłówek z quantity/jednostką/źródłem, Samples i Visualization na początku; szczegóły storage i raw values domyślnie zwinięte. Dla tabel dedykowana tabela z kolumnami/jednostkami i capability analizy; dla plików preview; dla grup podsumowanie zawartości. Sterowanie 3D pokazywać tylko tam, gdzie ma znaczenie.

### UX-10 · P2 · Błędne i nieprecyzyjne komunikaty ustawień

Źródło: `ResultsOutputInspector.tsx:201`, `:287`.

Dla skalaru kontrolki zakresu są aktywne, ale tekst mówi, że są niedostępne. Opis „changes do not load data into the viewport” nie wyjaśnia, że zmiana ustawień aktywnego snapshotu natychmiast zmienia obraz. Brakuje wyraźnego oznaczenia aktywnego snapshotu, co zwiększa skutki UX-04.

Naprawa: usunąć sprzeczny tekst, jasno opisać działanie na aktywny/nieaktywny snapshot; jednostkę umieścić również przy limitach. Testy muszą sprawdzać zgodność komunikatów z dostępnością, nie tylko obecność kontrolek.

### UX-11 · P2 · Podczas przewijania obraz jest celowo ukrywany

Źródła: `ResultsSnapshotViewport.tsx:332`, `SavedResultsPlaybackViewport.tsx:54`, `:82`.

Gdy nowa próbka nie jest gotowa, `canvasColors=null`, a warstwa ma `visible=false`. Zachowanie canvasa chroni kontekst, ale nie zapobiega znikaniu geometrii między próbkami. Przy wolniejszym odczycie będzie to widoczne jako miganie/pusty viewport. Rzeczywiste opóźnienie i intensywność wymagają pomiaru w przeglądarce.

Naprawa: utrzymać ostatnią poprawną klatkę tej samej serii podczas pobierania, z oddzielnym „Displayed time” i „Requested time”; podmiana atomowa. Przy błędzie jasno oznaczyć stare dane, nigdy nie podpisywać ich nowym czasem. Test opóźnionych i odwróconych odpowiedzi, błędu i szybkiego scrubowania.

### UX-12 · P2 · Obecny test przeglądarkowy nie dowodzi całego deklarowanego przepływu

Źródło: `apps/control-room/scripts/check-saved-playback-browser.mjs:155–214`.

Nowa ścieżka sprawdza indeks w DOM, zatrzymany canvas, jedną składową i WebGL. Hash pól oraz zmienność obrazu pochodzą z wcześniejszego legacy playback, nie z nowej ścieżki snapshotów. `live_return_verified=true` jest ustawiane po samym zniknięciu elementu snapshotu. Potem test przechodzi do `/home`, zamiast potwierdzić żywy obraz i zgodny Inspector. Nie obejmuje current-run Results, monitoringu, rewizji, buildera, klawiatury, szerokości paneli, kontrastu ani braku przepełnień.

Naprawa: osobne dowody dla nowej ścieżki: odpowiedź próbki → aktualny obraz → czas/quantity/legenda. Powrót do live musi potwierdzić aktywną sesję, widoczny canvas z poprawnym buforem i właściwym źródłem, zachowaną kontrolę modelu oraz brak mutacji solvera. Osobne testy current run i folder workspace, także bez sesji.

## Ocena estetyki i ergonomii

To ocena struktury źródeł, **nie ocena screenshotu działającej aplikacji**.

- Plus: używane są tokeny projektu i współdzielone Button/Input/Select/Switch; historyczny viewport ma jawny podpis oraz jednostkę. Nie wprowadzono nowej biblioteki stylów.
- Problem: każdy zagnieżdżony wiersz powtarza pełną ścieżkę (`entry.path`), a obok zajmują miejsce badge typu, statusu i rozmiar. Wąski panel ma mało miejsca na nazwę quantity. Zalecenie: krótka nazwa + ikona typu, ścieżka w tooltipie/breadcrumbzie, szczegóły w Inspectorze.
- Problem: rewizja SHA jest pokazywana dwukrotnie w podstawowym widoku, a run może mieć techniczny identyfikator. Zalecenie: nazwa runu/stage, liczba próbek, zakres czasu; pełne identyfikatory w szczegółach z kopiowaniem.
- Problem: znaki tekstowe ▸/▾/↻ zamiast spójnych ikon używanych w głównym Explorerze. To polish, niższy priorytet niż poprawność wyboru.
- Problem: historyczny nagłówek i legenda 3D są pojedynczymi liniami z paskiem stałej szerokości 180 px; trzeba sprawdzić wrap/overflow na małym viewporcie i przy długich nazwach. Nie twierdzimy bez renderu, że overflow już występuje.
- Problem: stały identyfikator wyszukiwania `fm-results-output-search`; jeśli layout pokaże równocześnie dwie instancje przeglądarki, etykiety będą niejednoznaczne. Sprawdzić dostępne układy, użyć unikalnego ID instancji.
- Sugestia: wybór dokładnego czasu/indeksu przez pole liczbowe; sam slider i Next/Previous są uciążliwe przy setkach próbek. Autoplay jest rozszerzeniem, nie warunkiem dotychczasowego żądania przewijania.
- Sugestia: wspólne ustawienia serii z jawnymi override’ami snapshotów, jeżeli użytkownik chce porównywać amplitudy przy stałej skali. Obecne per-snapshot auto jest zgodne z żądaniem niezależności, ale może utrudniać porównania.

## Model Builder i przejścia między kontekstami

Otwarcie folderu sprawdza dirty object edit i korzysta z pendingForms. To właściwa ochrona niezapisanych zmian; trzeba ją sprawdzić w scenariuszu Object i Airbox.

Podgląd snapshotu bieżącego runu przełącza tylko render branch `Viewport3DModule`. Model Builder i Inspector innych obiektów pozostają dostępne. Sam wybór obiektu nie wyłącza snapshotu. Użytkownik może więc edytować model, patrząc na historyczny obraz, który nie reaguje na te zmiany. To nie jest dowód zmiany zapisanych wyników, lecz ryzyko dezorientacji. Potrzebna jawna, stała informacja o źródle na poziomie workspace oraz spójna akcja powrotu do widoku modelu; komendy dotyczące widocznej geometrii muszą działać na właściwe źródło.

W folderze workspace lewe drzewo modelu jest zastąpione panelem Saved folder, a shell nie pokazuje zwykłego kontekstu wstążki. Otwieranie legacy folderu od razu wybiera starszy playback, folder bez descriptor wymaga Load into 3D. Dwie ścieżki są funkcjonalnie możliwe, ale powinny prowadzić do jednego przewidywalnego wzorca obsługi.

## Macierz odbioru — pełny cel pozostaje otwarty

| Obszar | Potwierdzone obecnie | Dowód potrzebny do zamknięcia |
|---|---|---|
| Katalog wszystkich logicznych outputów | Drzewo uwzględnia grupy/tablice/pliki; chunki jako próbki | Rzeczywisty completed run, zgodność z folderem, unknown/binary/partial |
| Current run monitoring | Polling metadanych, revision-pinned API | 3 kolejne autosave bez utraty UI, prawidłowe nowe próbki |
| Klawiatura i fokus | Wykryto UX-01/02 | Tab/Enter/Space/strzałki/Home/End, stabilny fokus |
| Model Builder → Results → Model | Routing istnieje, ryzyko mylenia źródła | Object/Airbox dirty form, selection, widoczna scena, brak przypadkowej mutacji |
| Snapshot i Inspector | Oddzielne identity/appearance | Powrót do wpisu z zgodnym czasem, niezależne ustawienia dwóch snapshotów |
| 3D FDM/FEM | Adaptery i jawna kontrola mapowania | Faktyczne dane obu backendów, zmienne hashe obrazu, maski, jednostki |
| Kamera i przyciski viewportu | Brak integracji Fit/Reset | Obie komendy na aktywnym preview, stabilna kamera przy scrubowaniu |
| Return to live | Helper nie wywołuje solvera | Live canvas + dane + właściwy Inspector; osobno brak sesji |
| Tabele/mody/eigensolve | Pliki widoczne, stare widoki zachowane | Spójny dostęp do funkcji analizy dla wyniku wybranego z folderu |
| Responsywność/estetyka | Tokeny i wspólne kontrolki w kodzie | Light/dark, szerokości 1440/1180/1024/768, panel 280/360 px, zoom 200% |
| Panele | Wspólny layout | Float/resize/hide/restore, scroll, brak drugiego canvasa i zerwania monitoringu |
| Błędy/ładowanie | Jawne stany, brak fallbacku do live | 409, niedostępny plik, opóźniona próbka, ponowienie bez utraty wyboru |
| Typy/API | Nowe domenowe typy odwołują się do generowanych schematów | Managed codegen; obecne generated types nie zawierają WorkspaceResultsCatalog/Array |
| Wydajność | Ograniczone odczyty, demand-render; runtime store usuwa nieobserwowane dane | Duży katalog, szybki scrub, request/render counts, brak narastania RAM |

## Kolejność prac po audycie źródeł

1. Naprawić UX-01–06 i dodać testy integracyjne komponentów/kontrolerów; zachować backendowe granice rewizji.
2. Ujednolicić Results i hierarchię Inspectora (UX-07–10), a przy scrubowaniu utrzymywać poprawnie podpisaną ostatnią klatkę (UX-11).
3. Dokończyć managed codegen/typecheck i wymagane testy backendu z istniejącego planu implementacji; nie omijać ich ręcznymi typami.
4. Bezpiecznie wznowić właściwą grupę i przygotować rzeczywisty krótki completed FEM run. Nie odtwarzać niepewnej aktywacji CoFeB ani cudzej symulacji.
5. Wykonać pełną macierz wizualną oraz nową ścieżkę current-run i folder, z dowodami pól/canvasa/stanu UI. Screenshot z mockupu lub legacy playback nie zastępuje tego odbioru.
6. Dopiero po poprawkach i dowodach można ponownie ocenić gotowość integracji. Ten raport nie zatwierdza merge ani nie deklaruje celu jako ukończonego.

## Uzupełnienie: panele, dostęp do zapisanych danych i aktualna blokada runtime

Stan ponownie sprawdzony w kolejnej turze audytu. SHA-256 `git diff --cached --binary`: `7d4c75fb0e0abe7b9ad8bb3bd30e2341cf1c5533326991ddbb67c5a910fdd53e`. Raport jest osobnym untracked plikiem i nie wchodzi do tego odcisku.

### UX-13 · P2 · Tryb saved-folder omija normalną obsługę widoczności paneli

Źródło: `apps/control-room/src/kernel/layout/WorkspaceDockLayout.tsx:162–215`; `shellCommands.ts:139`; `InspectorModule.tsx:120`.

Przy `playbackOnly` widoczność panelu prawego jest wymuszona na true, niezależnie od `panelVisible.right`. Tymczasem menu View i przycisk Inspectora nadal wykonują `panels:inspector:toggle`, modyfikujący ten stan. Komenda może zgłosić completed i zmienić zaznaczenie w menu, ale panel pozostaje widoczny. W tym samym trybie znika dolny pasek Restore, choć lewy panel zachowuje możliwość Hide i wcześniejszy stan widoczności. Po ukryciu Explorera pozostaje droga przez menu View, ale znika zwykły, bezpośredni sposób przywrócenia panelu. Na małej szerokości wymuszony Inspector może stale zajmować drawer.

Naprawa: zachować jeden kontrakt Hide/Restore i zgodność komendy z faktycznym stanem. Jeżeli Inspector ma być obligatoryjny, jego komendy ukrywania muszą być jawnie niedostępne z uzasadnieniem; zalecane jest jednak zachowanie normalnego sterowania panelami. Test: ukryty Explorer przed otwarciem folderu, Hide/Restore po otwarciu, toggle Inspectora, oba drawery poniżej 760 px.

### UX-14 · P2 · Sam wybór tablicy pobiera całą próbkę do krótkiego podglądu

Źródło: `ResultsOutputInspectorContainer.tsx:114`; `kernel/resources/resultsBrowserResources.ts:45`; `ResultsOutputInspector.tsx:27`.

Wybranie czytelnej tablicy uruchamia odczyt pełnej próbki f64 przed Load into 3D. Inspector pokazuje najwyżej 24 wartości, ale dla dużego pola transfer i dekodowanie dotyczą całego bufora (limit dekodera do 64 MiB). Ograniczenie backendu chroni przed bezgranicznym odczytem, nie czyni takiego podglądu tanim. To potwierdzona ścieżka wykonania; opóźnień i zużycia pamięci nie zmierzono.

Naprawa: pobieranie wartości dopiero na jawne żądanie podglądu lub Load into 3D, ewentualnie osobny ograniczony podgląd danych. Wspólny resource store już usuwa nieobserwowane próbki (`ResourceRuntimeStore.ts:799`) i może deduplikować te same aktywne klucze — nie zgłaszamy tu niepotwierdzonego wycieku całej serii ani podwójnego transferu każdego requestu.

### UX-15 · P2 · Zakładka Saved nie prowadzi do folderów zapisanych wyników

Źródło: `modules/results-navigator/ResultsNavigatorModule.tsx:831`; `SavedResultsBrowser.tsx:44`.

Zakładka Results → Saved używa `SavedResultsBrowser`, który wymaga otwartego projektu i przegląda durable SolutionSet revisions. Nowy folder Zarr otwiera się inną komendą workspace i osobnym panelem. Gdy użytkownik bez otwartego projektu szuka ukończonej symulacji w Saved, widzi „Open a project before browsing durable SolutionSet revisions”, mimo że produkt potrafi otworzyć folder niezależnie od projektu.

Naprawa: Saved powinno oferować otwarcie/zarejestrowanie folderu i ostatnie foldery obok wyników projektu, z jasnymi nazwami źródeł. Żądany przepływ „wchodzę w Results i znajduję output symulacji” nie powinien wymagać znajomości różnicy między SolutionSet i workspace item.

### Co sprawdzono i wykluczono

- Ukrywanie lewego panelu korzysta z `PanelFrame`/React Activity (`shared/ui/PanelFrame.tsx:176`), więc jego efekty są zawieszane. Sam brak parametru widoczności w hooku nie jest wystarczającym dowodem, że ukryty Explorer nadal odpytuje API. Wcześniejsza hipoteza o stałym pollingu ukrytego panelu nie została zgłoszona jako błąd.
- Menu View zawiera przełącznik Explorera (`kernel/layout/appMenuModel.tsx:111`). UX-13 nie oznacza całkowitej niemożności odzyskania lewego panelu; oznacza niespójność i utratę bezpośredniego Restore.
- ResourceRuntimeStore zwalnia dane i anulowuje request po zniknięciu ostatniego obserwatora; nie ma podstaw do deklarowania nieograniczonego cache wszystkich odwiedzonych buforów na podstawie samego użycia hooka.

### Właściwy stan runtime po ponownym odczycie receiptów

Zarządzany `BuildControl.read` potwierdził:

- `active` nie istnieje — poprzedni lease aktywacji nie blokuje już grupy;
- `activation/attempts/39d89f614b43494381b490f373d12b7b/terminal.json` ma `state=succeeded`;
- receipt skryptu `backend/script-activation-321e73383cbd05b5bf675c6a674a055b70d57f49917149381af5d44cabca2312/activation.json` ma `state=activated`;
- `runtime-control/runtime-service/process-tree.json` ma `failed_outcome_retained` z błędem obserwacji ownera;
- katalog pierwszego runu CoFeB `run-live-228d0fde8546f51b4ace1bddffc7462d877bb88165d157509c8f73bf5fcaf7f2` wskazuje zadanie `failed`;
- istnieje **drugie zadanie CoFeB** `run-live-92fe49229c57ea43f2730d0053ee6e8a35d2bec4db73ceb51eda1711fe19913d`, task `task-75bb19319b6e4ae5fe3f5a2115b73223e0034a405b8af1d1a40efaaa6ab7212b`, lifecycle `accepted`, readiness `accepted_task_awaiting_preparation`;
- jego trwały intent ma `reason=user_requested_cofeb_strayfield_demo`, command `solve`, requested FEM GPU. Nie jest to fixture audytu ani krótkie zadanie YIG/FEM przygotowane w tym czacie.

Nie uruchomiono zwykłego resume/recreate, ponieważ jego ocena wymaga zachowania przyjętego cudzego zadania i bezpiecznego uzgodnienia ownership. Nie anulowano tego zadania i nie zmieniono jego katalogu. Wysłano użytkownikowi pytanie o zgodę na skontaktowanie się z właścicielem w czacie „Uruchom Fullmaga z CoFeB ring”; odpowiedź pozostaje potrzebna. Aktualną blokadą nie jest stary lease, lecz nierozstrzygnięte przyjęte zadanie w retained namespace.

Następny krok runtime: po zgodzie ustalić z właścicielem oczekiwany los tego dokładnego zadania, zastosować właściwą zarządzaną trasę dla potwierdzonego stanu i dopiero wtedy uruchomić audyt UI. Nie zastępować tej ścieżki ręcznym kasowaniem stanu, nowym namespace ani startem na cudzej grupie.

### Koordynacja właściciela — zgoda użytkownika otrzymana

Użytkownik odpowiedział „Tak, uzgodnij zwolnienie grupy”. Wysłano wiadomość przez `send_message_to_thread` do czatu `01a18238-cee8-7a52-a6d9-6d856134fe77`, z dokładnym run/task, kontenerami, stanem receiptów i wymaganiem zachowania danych. Dostarczenie zostało potwierdzone. Prośba dotyczy uzgodnienia ownership; nie jest równoznaczna z autoryzacją anulowania runu lub kasowania wyników.

Dwa sprawdzenia `wait_threads` potwierdziły aktywną pracę tego czatu, lecz jeszcze nie dały odpowiedzi o zwolnieniu 3298. Czat obecnie testuje wizualizację Airboxa w innym środowisku. Z wcześniejszej zakończonej wiadomości właściciela wynika, że próba 3298 była nieudana, a demo zostało uruchomione na 3246; nie zastępuje to uzgodnienia losu zachowanego accepted task. Do czasu odpowiedzi nie uruchomiono recovery, anulowania ani ponownego Solve.


## Kontynuacja 29.10.2026 — ownership i runtime

Właściciel czatu CoFeB jawnie zwolnił grupę 3298 oraz uznał run `run-live-92fe…` / task `task-75bb…` za zbędny. Blokada ownership opisana powyżej jest nieaktualna. Próba `cancel-unclaimed-volume` odmówiła przed mutacją: zachowany process receipt miał `failed_outcome_retained`, a ta trasa wymaga `shutdown_unknown`. Nie zmieniano receiptów ręcznie.

Kanoniczne `recreate-volume --fresh-state` zakończyło archiwizację sukcesem (`725f1d35c7a74732990fc1e671414b40`). Zachowano stary state root, runtime-control w `runtime-archives/725f1d35c7a74732990fc1e671414b40` i poprzedni wolumen group-ledger. Nowa próba DEV: `cecc28bb5ce44fb8868583f24b6bb0b6`, config SHA `9385143719b94a714b71fb669e67ba8aabc70d5c0c2deaf02fed451614964395`.

Pierwszy build ujawnił brak importu `std::fs::Metadata` w results_fs.rs. Po poprawce resume `ebc563efa44a4bb5b17d0fc8d3ce1c9a` zakończyło się sukcesem. Snapshot backendu `0a5c3c6708100e97f57278b1797aa7cc54e5448ee4b1a470abd639ba3bc82fc1`. API i runtime gotowe na 3298. Zarządzany codegen opublikował cztery pliki API; receipt `f07d7fcdafd787b286e854d2322d1576f70d3f77de4a94ab23885ff45d27b40e`. Typecheck frontendu przeszedł.

Test `fullmag-workspace-inspect --lib` wykonany w backendzie: 67 passed / 21 failed. Dominująca przyczyna: skaner wymagał `.zarray` także w zwykłych katalogach. Poprawiono klasyfikację: nieobecny marker oznacza zwykły katalog, pozostałe błędy nadal są odrzucane. Osobno poprawiono sprzeczny test budżetu: odrzucona rezerwacja nie zużywa bajtów; test teraz sprawdza dokładnie jeden pozostały bajt, a następnie odmowę. Te poprawki wymagają nowego capture i powtórzenia testów.

Pierwsza aktywacja fixture FEM (`831600f7e67d453fb3f950d5bc01a3b9`) zakończyła się potwierdzonym odrzuceniem tworzenia siatki: PLC segment/facet intersection. Solver nie wystartował. Zwiększono domenę z 32×32×8 nm do 64×64×32 nm przy niezmienionej bryle 32×32×8 nm, aby rozdzielić granice bryły i domeny. Restart-idle odmówił walidacji failed-preparation; nie obchodzono tej bramki. Kolejna aktywacja zmienionego skryptu przechodzi zarządzaną archiwizację nieprzyjętej sesji.

Test przeglądarkowy rozszerzono o hashe payloadów nowych Results samples, pierwszą/środkową/ostatnią próbkę, stabilność Inspectora/canvasu oraz kontrolę `data-view-source=current` i widocznego, nieutraconego WebGL po Return to live. Składnia skryptu poprawna; wykonanie w przeglądarce nadal NOT VERIFIED.


### Zakończony FEM i pozytywny test przeglądarki — 29.10.2026

Grupa 3298 działa: backend `7637828e50bd`, frontend `01773a126bfc`. Snapshot backendu `fb0c02da994aad66cfc3ac5a77953621345ba33781f8212c5008324c461b9446`. Natywny run FEM `run-live-e5df1bcac11b0cb42e0ccfa720ae394f710b257b3fe652fa095a7a18fc232f2f` zakończył 101 kroków / 100 ps na CPU double. Siatka: 461 węzłów, 1694 komórki. Zapisano sześć snapshotów (0–100 ps co 20 ps), `m`, `H_eff` i tabelę. Workspace item: `1`, katalog logiczny: 32 wpisy.

Zarządzany browser QA `d5cc410be9d94bb5b2e929158fb5abfb` ma stan `succeeded`, runner `passed`, bez błędów. Weryfikacja obejmuje próbki 0, 2 i 5, zgodność hashy odpowiedzi API z pobranymi danymi, zmianę obrazu canvasu, zachowanie ustawień osobnych snapshotów oraz Return to live. Widoczny canvas live ma `data-view-source=current`, nieutracony kontekst WebGL i bufor 649×495. Dziennik komend i stan sesji nie zmieniły się podczas przeglądania. Dozwolone zapisy sieciowe to wyłącznie obecność klienta i potwierdzenia renderowania (`visualization/client-acks`). Browser używa SwiftShader; ten test nie dowodzi renderowania na fizycznym GPU ani poprawności fizyki FEM.

Zrzuty sprawdzono wizualnie. Potwierdzają także UX-06: po powrocie do live pozostawał Inspector historycznego wyniku. Poprawiono helper powrotu: usuwa historyczny wybór, zachowuje wybór modelu live oraz definicje/ustawienia snapshotów. Przycisk powrotu zależy od faktycznie otwartego podglądu. Testy kontrolera, powrotu i shellu: **22 passed**. Test przeglądarkowy rozszerzono o brak historycznego Inspectora/przycisku po powrocie; jego wynik po poprawce należy odnotować oddzielnie.

Ograniczenia nadal otwarte:
- API bieżącego runu wybierało nieistniejącą projekcję zamiast opublikowanego folderu. Osobna poprawka trwa; dotychczasowy pozytywny test korzystał z zarejestrowanego folderu workspace.
- `H_eff` ma zapisane wartości, ale nie ma kwalifikowanego powiązania z geometrią; 3D prawidłowo odmawia zamiast wnioskować po długości wektora.
- Natywny FEM autosave nie obsługuje `eden_total` w tej ścieżce. Usunięto tę quantity wyłącznie z fixture FEM; energia całkowita pozostaje w tabeli. Nie uznano obsługi dowolnych quantity za sprawdzoną.
- Inspector pokazuje indeksy próbek, lecz brak czasu fizycznego w tym widoku wymaga oddzielnego sprawdzenia mapowania współrzędnych.
- Przeglądarka pokazuje surowe wpisy plików/ścieżki; hierarchia i czytelność z wcześniejszego audytu nadal wymagają pracy.

Testy czytnika po poprawce klasyfikacji katalogów: **85 passed / 3 failed**. Trzy przyczyny poprawiono w źródłach: rewizja nie uwzględniała nadpisania istniejącego chunka; dwa testy błędnie zakładały geometrię/layout bez pozytywnej walidacji. Ochrona geometrii nie została osłabiona. Zmiany oczekują na capture i ponowne wykonanie testów.


### Weryfikacja poprawek — checkpoint końcowego capture 29.10.2026

- Po poprawce UX-06 browser QA `8ff45d608b154e7985da5988a568e798` przeszedł, w tym brak historycznego Inspectora i przycisku powrotu po Return to live. Hash skryptu: `bcaded2bc9e9006565a60790277ab56a88b4746cb25cdb6565ee81acdc12f36e`. Zrzut wizualnie potwierdza scenę live z pustym Inspectorem. Typecheck oraz ESLint zmienionych plików przeszły.
- Iteracja `11f9cbdcf75d49429748d89cacf1e1c8` zbudowała snapshot `e2a89fbb52b4cc1d25a8aaa927e895bfeebda83579f9b3c8fe1eed82d8ad7712`. Testy `fullmag-workspace-inspect --lib`: **88 passed / 0 failed**, łącznie z wykrywaniem nadpisania chunków i ścisłym wiązaniem geometrii.
- Poprawiono źródło czasu dla dokładnie powiązanej tablicy playback. Starszy continuous index numeruje różne pola wspólnie; dla ukończonej serii pierwszeństwo ma jawne `times_s` z deskryptora tej konkretnej tablicy, z kontrolą liczby próbek. Inne tablice nie dziedziczą tych czasów. Nie zmieniano istniejących plików wynikowych.
- Nowa aktywacja `736af63d0d3949c79d7afce60be74454`: run `run-live-cce1fd0396100cc1569bcd9d54afd47e089985d16de0f1484a61448621c0a94a`, zakończony FEM CPU double. Wyniki zarejestrowano jako workspace item `2`.
- `/v2/sessions/current/data/results` podczas runu zwracało jawne `409 current_results_not_published`, a po zakończeniu **200 / ready / 32 wpisy**. Wcześniejszy błąd nieistniejącej projekcji usunięto. Resolver korzysta z konfiguracji output storage i zgodnych receiptów opublikowanego folderu, zachowując kontrolę tożsamości sesji/runu.
- Metadane bieżącego `m`: sześć próbek, czasy 0, 20, 40, 60, 80, 100 ps, `can_visualize_3d=true`. Rozszerzony browser QA dodatkowo sprawdza Explorer → Results bieżącego runu, ponowne przewijanie i powrót do live.
- Test kompilacji czytnika ujawnił brak nowego pola czasu w jednym fixture; uzupełniono fixture przed końcowym zielonym wynikiem 88 testów. Testy API uruchamiane są dla binarnego targetu `fullmag-api` (pakiet nie ma targetu `--lib`).

Nadal **REQUEST CHANGES** dla całości funkcji: pozostałe ustalenia UX-01–05, UX-07 i kolejne nie zostały zamknięte tym checkpointem. W szczególności dokładne wiązanie geometrii `H_eff`, pola skalarne, duże katalogi, wiele etapów oraz kompletność obsługi modów/eigensolve nie mają pełnej kwalifikacji. Zmian nie scalono; nie jest to deklaracja gotowości całej przeglądarki wyników.


### Wynik końcowy tego audytu runtime

Browser QA `bd3effcee49e451cb1fca4864d9f8440`: **succeeded / passed**, hash skryptu `cdd4eb2bc808a3eed34cdfaddb5852e65e4336ec876507051794cac2ce978e16`. Sprawdzono oba wejścia na tym samym zakończonym runie: otwarcie folderu workspace item `2` oraz Explorer → Results bieżącej sesji. Próbki 0/2/5 w folderze oraz 0/5/0 w bieżącym runie mają zgodne hashe payloadów; obraz zmienia się, ustawienia snapshotów są zachowane, Return to live przywraca widoczny canvas i usuwa historyczny Inspector. `current_run_results_verified=true`, `live_return_verified=true`, bez nowych komend solvera ani sesji. Wizualnie potwierdzono fizyczny czas w Inspectorze.

Testy API: **5 passed / 0 failed**. W pierwszym wykonaniu dwie próby czytały bazę grupy, ponieważ odziedziczony `FULLMAG_WORKSPACE_STATE_DIR` miał pierwszeństwo przed fixture ustawiającym `FULLMAG_STATE_DIR`. Ponowne wykonanie z `env -u FULLMAG_WORKSPACE_STATE_DIR` ograniczonym do procesu testowego przeszło; nie zmieniano konfiguracji działającego API ani bazy wyników. Polecenie kwalifikujące: `FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source cargo test --locked --profile backend-dev -p fullmag-api --bin fullmag-api workspace_results` z powyższą izolacją środowiska. Pełna suita API i CI pozostają poza tym wynikiem.

Łączny zakres lokalnej weryfikacji: 88 testów czytnika, 5 testów API, 22 testy kontrolerów/shellu, typecheck i ESLint zmienionych plików oraz zarządzany scenariusz browser/WebGL. UX-06 i podstawowa luka pokrycia przewijania/powrotu są zamknięte w tym scenariuszu; nie zamyka to pozostałych pozycji audytu.

Dodatkowe obserwacje wizualne do dalszej pracy: bardzo małe wartości automatycznej skali legendy potrafią tworzyć zbyt długi zapis dziesiętny; Explorer jest nadal przeładowany pełnymi ścieżkami. Po powrocie widok rzeczywiście korzysta ze źródła current, lecz licznik ostatniej klatki/telemetrii live na zrzucie nie odpowiadał końcowemu czasowi manifestu. Ten test potwierdza przełączenie źródła i działający canvas, nie dowodzi, że pipeline live dostarczył końcową klatkę 100 ps. Końcowy czas i wartości zapisanych snapshotów zostały potwierdzone niezależnie.


## Checkpoint 2026-10-29 — Inspector, klawiatura, kamera i wąski panel

Stan całości: **REQUEST CHANGES**. Poniższy checkpoint aktualizuje wcześniejsze ustalenia; historyczne sekcje zachowano jako zapis diagnozy. Kod pozostaje WIP na `codex/results-snapshot-inspector-20261028`, HEAD bazowy `6a28c950204fbc7c7566a5b6545e8aba092bec6a`. Backend nadal korzysta ze snapshotu `e2a89fbb52b4cc1d25a8aaa927e895bfeebda83579f9b3c8fe1eed82d8ad7712`; poprawki tego checkpointu dotyczą frontendu podłączonego do grupy 3298.

### Wdrożone poprawki i zakres dowodu

| Ustalenie | Stan w tym checkpointcie | Dowód |
|---|---|---|
| UX-01 klawiatura/fokus | Naprawione | Roving tabindex, strzałki/Home/End, Enter/Space; focus z potomka nie wybiera rodzica. Test DOM i rzeczywisty click → Enter w browserze |
| UX-02 reset drzewa na rewizji | Naprawione w źródłach | Pager usuwa stare strony bez remountu drzewa; test zachowania filtra i rozwinięcia |
| UX-03 stary wybór | Jawnie obsłużony | Informacja o przypiętej rewizji i Update selected output; inny run nie jest dopasowywany po ścieżce, usunięty wpis ma odrębny stan |
| UX-04 różny snapshot w Inspectorze | Naprawione | Pamięć ostatniej próbki na serię i rewizję; aktywny snapshot ma pierwszeństwo. Browser: ostatnia próbka → JSON → to samo pole zachowuje indeks |
| UX-05 kamera | Fit/Reset naprawione | Zamontowana kamera saved przejmuje oba polecenia; tokenowy cleanup i testy braku mutacji ukrytej kamery live. Browser: zoom → Fit oraz zoom → Reset przez paletę poleceń |
| UX-08 zakres filtra | Wyjaśniony w UI | Przy stronicowaniu jawnie filtruje tylko załadowane wpisy; nie jest to implementacja wyszukiwarki całego folderu |
| UX-09 hierarchia | Poprawiona | Samples i Visualization przed zwiniętymi metadanymi i wartościami; slider i component widoczne przy wszystkich trzech rozmiarach testowych |
| UX-10 komunikaty | Poprawione | Usunięty sprzeczny opis zakresu skalaru; aktywne ustawienia wyjaśniają natychmiastowy efekt; odrzucona nieaktualna uwaga katalogu po uzyskaniu kwalifikowanej geometrii |
| UX-14 eager payload | Naprawione | Decoded values otwiera odczyt dopiero na żądanie; zamknięta sekcja nie wysyła requestu próbki — test komponentu i browser |
| Format legendy | Naprawiony | Zapis naukowy zamiast setek zer dla bardzo małych wartości; legenda zawija się w swoim panelu |
| Czytelność wąskiego drzewa | Naprawiona dla badanego zakresu | Jawna kolumna minmax(0,1fr), krótsze wcięcia i wtórne metadane ukrywane poniżej 320 px; nazwy pól zachowane |

Zmiany UX-02/03 mają testy komponentowe, ale nie dowodzą monitorowania autosave podczas aktywnego managed runu. Dodatkowe polecenia kamery, np. zmiana projekcji, nie zostały objęte nowym dowodem Fit/Reset.

### Dowód przeglądarkowy

Próba **`7b2dc16dbbf7480faa988383a5b02d68`**, wynik **succeeded / passed**, hash skryptu **`c9a69862d3d4013aea04cea10b8fffbda02f8bee740b40a9f4044b69645c5914`**. Dane: ten sam zakończony FEM run `run-live-cce1fd0396100cc1569bcd9d54afd47e089985d16de0f1484a61448621c0a94a-1`, workspace item `2`, sześć próbek, katalog 32 wpisów. JSON dowodowy: [2026-10-29-results-browser-ux-evidence.json](2026-10-29-results-browser-ux-evidence.json).

Sprawdzono oba wejścia: folder workspace oraz Explorer → Results zakończonej sesji. Hashe próbek 0/2/5 są zgodne z API i obrazy różnią się. Canvas i Inspector pozostają zamontowane przy scrubowaniu; kamera nie przeskakuje. Powrót do live przywraca źródło `current`, usuwa historyczny Inspector i nie wysyła nowych komend solvera ani nie tworzy sesji. Canvas jest widoczny, kontekst WebGL nieutracony, drawing buffer niezerowy. Chromium korzysta z **SwiftShader**; nie jest to kwalifikacja sprzętowego GPU ani walidacja fizyki.

Rozmiary okna: **1280×900, 1500×1000, 1920×1080**. Brak poziomego overflow strony i drzewa, `scrollLeft=0`, główne kontrolki widoczne. Przy 1280 px nazwy `m` i `H_eff` mają po 102 px dostępnej szerokości i nie są obcięte. Zrzuty jasnego i ciemnego motywu obejrzano wizualnie. 1024/768 px, zoom 200%, wszystkie konfiguracje floating/docking oraz długie nazwy innych datasetów nadal wymagają osobnej kwalifikacji.

Wcześniejsza próba `2c4f869539bc444b93a457484bab1c69` przeszła asercje funkcjonalne, ale oględziny PNG wykryły obcięte początki nazw. Próba diagnostyczna `0c15f979f9724def846bf533e04f3092` potwierdziła implicit grid track o szerokości 472 px w sekcji 228 px oraz ukryty `scrollLeft=145`. Poprawiono przyczynę i rozszerzono asercje o granice drzewa oraz faktyczną szerokość nazw, zamiast uznać pierwszy zielony test za dowód jakości wyglądu.

### Testy źródeł

Pełne `pnpm lint` oraz `pnpm typecheck` przeszły w kontenerze frontendowym `01773a126bfc`. Pełny przebieg Vitest: **8987 passed, 2 failed, 1 skipped**. Oba błędy dotyczyły kontraktów czytających niewłaściwy katalog źródeł w zarządzanym cieniu frontendu: `next.config.test.ts` oraz `scripts/resolve-pnpm-invocation.test.mjs`. Ponowienie wyłącznie tych plików z istniejącą obsługą `FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source`: **35/35 passed**. Nie zmieniano asercji ani nie wyłączano testów. Po końcowej poprawce Tree: **7/7 passed**, scoped ESLint i `git diff --check` czyste. Pełnej suity nie powtarzano bez potrzeby; pojedynczy skipped test pochodzi z istniejącej konfiguracji API hygiene. CI dla bieżącego WIP nie uruchomiono, zmian nie scalono.

### Nadal otwarte ustalenia

1. **UX-07**: Explorer → Results, Results Navigator oraz saved-folder mają osobne hosty przeglądarki i stan nawigacji. Wspólny komponent drzewa nie oznacza wspólnego stanu źródła/filtra/rozwinięcia.
2. **UX-13**: `WorkspaceDockLayout` w playback wymusza prawy panel, pomija jego onHide, ukrywa footer oraz pasek Restore, mimo że polecenia shellu zmieniają stan i zwracają completed. Potrzebny wspólny kontrakt paneli albo jawne wyłączenie nieobsługiwanych komend.
3. **UX-15**: Results → Saved pokazuje projektowe runs/SolutionSets, nie zarejestrowane foldery workspace. Foldery są dostępne z Home; luka dotyczy wejścia przez Results, nie braku możliwości otwierania folderów w aplikacji.
4. **UX-11**: podczas oczekiwania na następną próbkę renderowana warstwa jest ukrywana. Zachowanie ostatniej klatki wymaga wyraźnego rozróżnienia czasu wyświetlanego i żądanego, aby nie podpisywać starych wartości nowym czasem.
5. **Model Builder i dirty forms**: źródłowo saved-folder ma fence dla Object oraz pendingForms dla Object/Airbox. Current-result preview korzysta z komponentowego InspectorDirtySelectionGuard i pozostawia authoring dostępny przy historycznej scenie. To asymetria i ryzyko dezorientacji, nie udowodniona utrata danych. Browser regresji dirty Object/Airbox nadal brak.
6. **Kompletność wyników**: `H_eff` jest widoczne i czytelne, ale bez dokładnego powiązania geometrii nie jest kwalifikowane do 3D. Mapowanie innych quantity, scalar autosave FEM, mody/eigensolve i spójne wejścia do ich analiz nadal wymagają pracy. Katalog logiczny obejmuje również pliki metadanych; binarne chunki są obsługiwane jako próbki tablic.
7. **Live po zakończeniu**: API status potwierdza `solver_steps=101`, `solver_time=1e-10`, `completed`, podczas gdy Footer Telemetry na zrzucie pokazuje 5 kroków / 5 ps. Return to live jest potwierdzeniem zmiany źródła i działającego canvasu, nie dowodem aktualności końcowej telemetrii ani samego bufora pola.
8. **Pozostała kwalifikacja**: managed in-progress autosave nadal zwraca `current_results_not_published` do publikacji folderu; realny FDM w nowej przeglądarce, wiele etapów, duże katalogi, no-session return, opóźnienia/błędy oraz długotrwałe zużycie pamięci pozostają NOT VERIFIED w tym checkpointcie.

### Retencja dowodów

Zastosowano ocenę danych według `fullmag-build-stage-cleanup`. Resolver potwierdza storage `/home/kkingstoun/git/fullmag/storage`. Nie było nowego buildu backendu ani nowego runu naukowego w tym checkpointcie. Katalogi browser QA są dowodami audytu (około 2–3 MiB na próbę), logi lint/typecheck/testów pozostają w woluminie frontendu, aktywny pakiet i cache są nadal używane. Decyzja: zachować do integracji i ponownej kwalifikacji; brak planu usuwania i brak wykonanej retencji. Wolne miejsce hostowego storage przy kontroli: około 8,2 GiB. Ten pomiar nie opisuje wolnego miejsca named volumes Dockera.


### UX-16 · P1 · Bieżąca telemetria nie nadąża za zakończonym runem

Kontrola bezpośrednich GET po końcowym browser QA potwierdziła: `status.resources.scalars_revision=1`, status runu 101 kroków / 100 ps, a `GET /v2/sessions/current/data/scalars?tail=true&limit=1` zwraca również revision 1 i ostatnią próbkę 5 kroków / 5 ps. Request był przypięty do bieżącego scope sesji; `observation_frames[0].session_epoch` odpowiada tej samej sesji, a `source_step=5`, `source_time_seconds=5e-12`. Nie jest to wyłącznie stare lokalne pole React ani dowód odczytu innego runu.

`FooterTelemetry.tsx:363–395` daje próbce skalarnej pierwszeństwo przed `status.run`, a `studyRuntimeResources.ts:2467–2498` pobiera ten zasób przez centralny klient. Stopka pokazuje więc wartości rzeczywiście dostępne w scalar resource. Potwierdzono niespójność publikacji status-summary ↔ scalars; nie ustalono jeszcze, w którym miejscu producent/przekaźnik nie publikuje końcowej próbki. Samo wyczyszczenie cache po Return to live nie naprawiłoby tego GET-a.

Następny krok: prześledzić finalizację i publikację scalar observation wraz z terminalnym statusem; zachować tożsamość epoki, domeny i kroku. Nie zastępować czasu wiersza czasem statusu przy pozostawieniu dawnych energii/magnetyzacji bez oznaczenia różnicy. Aktualność końcowego pola 3D wymaga odrębnego sprawdzenia jego observation frame. Ten checkpoint nie modyfikuje backendu w celu naprawy UX-16.


## Checkpoint 2026-10-29 — panele i wejście Results → Saved

Stan całości nadal **REQUEST CHANGES**; poniższe dowody dotyczą UX-13/15 i ergonomii paneli, nie kończą pozostałych punktów audytu.

- **UX-13 naprawione w badanym przepływie**: Saved folder ma standardowe menu PanelChrome, Inspector respektuje ukrycie, pasek Restore jest dostępny. Stopka istniejącej sesji działa także podczas playback i jawnie pokazuje „Live session diagnostics”. Brak sesji nie tworzy sztucznej stopki. Test shellu sprawdza hide/restore oraz zachowanie wyboru snapshotu.
- **UX-15 naprawione**: Results → Saved zawiera zarejestrowane foldery workspace, również bez projektu. Otwarcie korzysta z istniejącej komendy i jej ochrony edytowanych formularzy. Projektowe SolutionSets pozostają oddzielnym zbiorem. DTO/parsery wydzielono do kernel/api, wspólny resource hook do kernel/resources; nie dodano prywatnego importu Results → Start.
- Minimalna szerokość lewego panelu wynosi 240 px. To usuwa wykryte obcięcie nazw przy 1024 px. Nie oznacza, że cały Inspector musi mieścić się bez pionowego przewijania.

Próba browser **1fe8413b9d384a2db6da33a2cd4af476**: succeeded / passed. [Dowód JSON](2026-10-29-results-panels-browser-evidence.json) zawiera hash harnessu i metryki. Badano ten sam zakończony run FEM i item 2: próbki 0/2/5, zgodność payloadów, stabilny canvas/kamera, niezależne ustawienia, hide/restore trzech paneli, Float/Dock Saved folder, wejście Results → Saved → Open folder oraz powrót do current bez komend solvera. WebGL aktywny, drawing buffer niezerowy, SwiftShader — bez twierdzenia o sprzętowym GPU.

Rozmiary 768×900, 1024×900, 1280×900, 1500×1000 i 1920×1080: brak poziomego overflow drzewa i strony, pełne nazwy m/H_eff/table. Rozszerzona asercja wykonuje przewinięcie Inspectora, próbę kliknięcia bez zmiany wartości oraz hit-test środka każdej głównej kontrolki. Jest to dowód dostępności po przewinięciu, nie jednoczesnej widoczności wszystkich kontrolek. Wcześniejsze metryki boundingBox przeceniały widoczność elementów zasłoniętych stopką Inspectora.

Próba 19879ca0d78a47d5ab407ad5514f0ea3 przeszła wcześniejszy zakres. Próba 17a03fa38ef34d1da0b5fc4e0d2c5cd6 przerwała się przed testem layoutu: Chromium zwrócił requestfailed/body-unavailable dla frame 0 mimo gotowego canvasu. Zachowano błąd i wymaganie zgodności payloadu; ponowienie po zakończeniu równoległych kontroli przeszło bez osłabienia asercji. Przyczyny pojedynczego błędu CDP nie zakwalifikowano jako błędu danych ani nie uznano za rozwiązany problem produktu.

Pełny frontend: **8998 passed, 0 failed, 1 existing skipped**, 880 plików passed. Uruchomiono z FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source. Pełny ESLint, typecheck i architecture hygiene passed. Logi pozostają w /state/development/results-ux-*-final.log woluminu frontendowego. Późniejsze zmiany UX-11/16 wymagają własnej weryfikacji i nie dziedziczą tego wyniku automatycznie.

Retencja przed planowanym buildem UX-16: Docker /build i /opt/fullmag/control mają około 137 GiB wolnego, hostowy /user-data 8,2 GiB. Zachowano wszystkie wyniki, logi i receipty oraz używany cache. Nie usuwano danych; katalogi QA są dowodami potrzebnymi do zakończenia audytu.


## Checkpoint 2026-10-29 — zachowanie klatki i końcowe dane Live

**UX-11 zamknięte dla badanego FEM**. Render przechowuje najwyżej jedną ostatnią poprawną klatkę poza stanem React, przypiętą do dokładnej tożsamości sesji/źródła/runu/etapu/tablicy/quantity/rewizji. Opóźniona próbka 1 nie usuwa obrazu próbki 0: nagłówek rozróżnia Displayed 0 (0 ns) i Requested 1 (0,02 ns), a legenda zachowuje składową i skalę faktycznie pokazanego obrazu. Po odczycie przełącza dane i legendę razem. Zmiana serii, rewizji lub widoczności nie przenosi obrazu. Testy komponentu/modelu: **11/11**, scoped ESLint i typecheck przeszły.

**UX-16 naprawione i sprawdzone w nowym runie**. Commit `3b441b13048df28e0dd0da2f4396da327329ef35` publikuje rzeczywiste końcowe StepStats z FDM/FEM, przez wersjonowany immutable receipt v2 i dotychczasowe fences sesji/sceny/publikacji. Odczyt sprawdza schema, zgodność tożsamości i skończoność metryk; błędny receipt v2 nie wraca po cichu do v1. Brak kroków pozostaje brakiem obserwacji. Nie rekonstruuje magnetyzacji/energii z licznika kroków ani nie uruchamia Solve podczas recovery. Testy backendu: **10/10** odczytu receiptów/statystyk i **15/15** projekcji live. Zakres jest węższy od pełnej suity API.

Zarządzany restart `40a73dc373b64e40bed5ad783af5c157` uruchomił backend ze snapshotu `98e2c48f404e7e0c0f8b7187801a329454170c610484f17c7a70703a87a37143`. Nowy FEM CPU double: run `run-live-517b15c17e310c8b22aa68c39294d8a6a7b9cc96069b34fad41a7cb297d94a7d`, workspace item **5**, sześć próbek m, 461 węzłów / 1694 komórki. Status, scalar resource, observation frame oraz rzeczywista stopka UI po Return to live zgadzają się: **101 kroków / 100 ps**, revision scalars 2. Weryfikacja nie jest kwalifikacją fizyki ani sprzętowego GPU.

Browser QA **`16eab9eeb4194289aa95290d9a4dc9c0` — passed**, hash skryptu `50b90e1d36b852d2a5155fe5618805e0ad5da66d030fe40f7b35770c560fd90a`. [Dowód JSON](2026-10-29-results-fem-snapshot-live-evidence.json). Test obejmuje Home → folder, Results → Saved → folder oraz Explorer → Results bieżącego zakończonego runu, hashe payloadów próbek 0/2/5, opóźnioną próbkę 1, powrót do ostatniego indeksu po obejrzeniu JSON, odrębne ustawienia snapshotów, stabilny canvas/Inspector/kamerę, Fit/Reset, hide/restore/float/dock, szerokości 768–1920 px i kontrolki osiągalne po pionowym przewinięciu. WebGL: widoczny canvas, nieutracony kontekst, niezerowy drawing buffer; Chromium SwiftShader. Zrzuty opóźnionej próbki i końcowego Live obejrzano wizualnie.

### Zapis kamery przy inicjalizacji

Próby `fcc52b3b76924ffd9a372ca16095972e` i `d8adda573aa243cfa6e75095ca308343` zakończyły się błędem nadmiernie szerokiej asercji wszystkich zapisów sesji, choć pozostałe sprawdzenia przeszły. Trace drugiej próby potwierdził PATCH zawierający wyłącznie kamerę, jeszcze przed pierwszym Return to live. Home jest nakładką nad zamontowanym workspace; pierwsze dopasowanie live camera zapisuje pozycję po idle interval 8 s. Nie był to zapis ustawień historycznego snapshotu.

Harness rozdziela teraz tę inicjalizację od playback: dla świeżej revision 0 oczekuje dokładnie jednego PATCH camera w fazie initial-home, sprawdza strukturę i skończoność pozycji, zachowuje osobny dowód, a dopiero potem ustala baseline. Podczas całego playback i powrotu Live wymaga **zerowych zapisów sesji** (poza observer lease/render acknowledgements), identycznego zasobu persisted visualization po scenariuszu, niezmienionego command ledger i zbioru sesji. W próbie 16e… wszystkie te asercje przeszły. Nie zmieniono produkcyjnej obsługi kamery ani nie dodano ogólnego wyjątku dla PATCH visualization.

Pełna frontendowa suita sprzed dodania retention: **8998 passed / 0 failed / 1 istniejący skipped**. Nowy retention ma wskazane testy skupione i typecheck. Przerwany kodem 137 typecheck zbiegł się z zarządzanym restartem frontendu, OOM=false; powtórzony po restarcie przeszedł. Nie przedstawiamy przerwanego procesu jako błędu TypeScript.

Nadal otwarte: UX-07 (w trakcie poprawy), exact geometry binding innych quantity FEM, obsługa semantyczna wszystkich modów/eigensolve, monitoring outputu podczas managed runu, regresje dirty Object/Airbox i pozostałe scenariusze kwalifikacyjne. CI i merge bieżącego WIP pozostają niewykonane. Status całości nadal **REQUEST CHANGES**, mimo zamknięcia UX-11 i UX-16.

Retencja: zachowano receipty prób, logi testów, aktywny pakiet/cache oraz wszystkie wyniki małych runów audytowych; nie usuwano danych. Ostatnia kontrola przed buildem: około 137 GiB wolnego w technicznych wolumenach Docker i 8,2 GiB w hostowym storage. Ponowna ocena zbędności dopiero przy integracji lub wycofaniu konsumentów.


### Otwarta luka FEM: zapisane pola poza magnetyzacją

Odczyt rzeczywistego outputu item 4 potwierdził, że `results_browser.autosave.json` zawiera `field_quantities: [H_eff, m]`, a obie tablice mają sześć próbek, 1383 wartości, dtype f64 i jawny `soa_component_major`. Jednak `playback.json` wiąże dokładną ścieżkę wyłącznie z `fields/m`, a `geometry.json` ma semantykę `FemP1MagnetizationFieldSemantics` z quantity `m`. Dlatego `H_eff` jest poprawnie czytelne, ale nie kwalifikuje się do 3D. To ograniczenie producenta metadanych i bindingu, nie problem pobierania wartości ani samo ograniczenie UI.

Źródła: `artifact_pipeline.rs` rejestruje playback tylko dla m; `artifacts.rs` publikuje m-specific descriptor; `playback.rs` waliduje v1 jako m-only; `results.rs::playback_fem_geometry` oraz `geometry_for_array` wymagają exact descriptor binding. Samo poluzowanie warunku quantity lub zgodność liczby węzłów byłoby błędem kontraktu.

Dalsza poprawka musi dodać producer-owned per-quantity binding: dokładna ścieżka tablicy, quantity/layout, próbki/czas, topologia i support oraz opis przestrzeni pola. V1 pozostaje kompatybilny i m-only; nowy format wymaga jawnej wersji i negatywnych testów podmiany ścieżki/quantity/layout/fingerprint. Obecny checkpoint nie nadaje H_eff nieistniejącej kwalifikacji. Zapisane scalar fields FEM oraz mody/eigensolve wymagają własnego zgodnego opisu, nie inferencji z samej nazwy pliku.


## Checkpoint 2026-10-29 — wspólny stan Results i nazwy kolumn

- **UX-07, zakres nawigacji**: folder outputu znajduje się przed analizami. Analizy mają osobne, domyślnie zwinięte sekcje `Modes & analysis` / `Analysis results`, oparte na wspólnym Accordion. Filtr i przyciski drzewa semantycznego jawnie dotyczą tylko analiz. Usunięto globalne „Results missing” pochodzące z braku indeksu analiz.
- Kernelowy store zachowuje filtr, collapse i focus między hostami dla dokładnego source/run/session; rewizja katalogu nie resetuje stanu. Limit: 32 klucze, bez katalogów i buforów pól. Ewikcja powiadamia aktywnych subskrybentów i nie odcina ich późniejszych aktualizacji. Starsze foldery bez tożsamości korzystają z prywatnego stanu bieżącego montowania; zmiana source/run/session tworzy nowy lokalny controller, również dla A→B→A. Testy zakresu UX-07: 63/63, dodatkowy edge lokalnego fallbacku 23/23. Nie jest to dowód pełnego semantycznego powiązania każdego pliku z analizą.
- **Nowo wykryty i naprawiony brak nazw tabeli**: czytnik znał `quantities`, lecz DTO nie publikował tej listy. API udostępnia teraz uporządkowane `quantity_ids`; starszy JSON bez tego pola nadal się deserializuje. Nie-stringowe/puste etykiety, błędny rank/kolejność osi i liczba nazw niezgodna z osią quantity są odrzucane bez przesuwania nazw. Inspector podpisuje pełne wiersze tabel; nazwa pojedynczego wektora nie staje się etykietą jego pierwszej liczby. Test Inspectora: 7/7. Testy modułu Results reader: **24/24** (pozostałe 65 testów crate poza filtrem).

Managed restart: **`da523edff65b403fa89f7ee6fbb6868b`**. Backend source snapshot **`1a5f454bd867e81adff78ab5d359d4b3b603011396f443032770fc1ad12520a4`**, HEAD bazowy `3b441b13048df28e0dd0da2f4396da327329ef35` + WIP. Codegen zakończony sukcesem; receipt `backend/codegen/openapi-v2/4b10fb8d356efbac8b7461d19c1972aad2c1879c2e2092bfc47f3720ef8e0cf8.json`. Generowane API nie było dopisywane ręcznie. GET zachowanego workspace item 5 potwierdził kolumny `t, step, mx, my, mz, e_total`.

Po tym restarcie DEV nie było aktywnej sesji (`sessions=[]`, status 404 `no active local live workspace`). Foldery wyników pozostały dostępne; nie przedstawiamy tego restartu jako dowodu odtworzenia kontekstu Live. Do kolejnej kontroli utworzono mały nowy run FEM, aktywacja **`9e93a5b717cd4f9d8b9fc8d7e7c16a20`**, run **`run-live-66d8ccfcf9cd1ae79e437817a7ad1400742a0acd6fb7a1ae9cc0a158f3148611`**, item **6**, completed 101 kroków / 100 ps. Przepływ UI odtwarza wyniki i wraca do Live w obrębie tego samego zakończonego runu.

Pełna suita frontendowa po zmianach: **9015 passed, 2 failed, 1 istniejący skipped**. Dwa niepowodzenia wynikały z brakującego nowego kontrolera w mocku kernela shellu oraz źródłowej asercji dawnej stałej etykiety przycisku Explorera. Po uzupełnieniu prawdziwego controllera fixture i zachowaniu testu obu nowych etykiet: **28/28 passed** w obu plikach. Pełny lint, typecheck i architecture hygiene przeszły. Nie przedstawiamy pierwszego pełnego przebiegu jako zielonego; CI nie zastępuje tego zapisu.

Próba browser QA `1dce377cfc0a4332ab7791027a7268e2` nie weszła w scenariusz — preflight loopback odpadł podczas cold compile `/workspace`. Po skompilowaniu strona odpowiadała. Próba `7080778061fb4d72a9886ab92efc603f` przerwała asercję hasha próbki 2: DevTools zgłosił `Network.getResponseBody: No data found`, mimo gotowego obrazu. Nie zaakceptowano braku hasha. Harness został zmieniony na obserwację faktycznie odczytywanych przez aplikację `arrayBuffer`/chunków streamu (bounded binary response), z limitem 64 MiB na odczyt i 128 kluczy. Oczekiwane hashe nadal pochodzą z niezależnych GET. Instrumentacja nie zmienia danych, produkcyjnych limitów ani anulowania. Niezależny review tego bloku nie znalazł Required findingu. Końcowy wynik nowej próby zostanie zapisany poniżej po wykonaniu.

Kontrola storage przed buildem: około **134 GiB** wolnego w technicznych woluminach Docker i **7,6 GiB** w hostowym user-data. Zachowano aktywny pakiet/cache, wyniki, receipty i logi. Nie wykonano usuwania ani globalnego sprzątania.


### Końcowy wynik tego checkpointu

Próba **`b44b61e4299740ce8253c140e36c18ba` — succeeded / passed**, hash harnessa **`052e6647f8dcc25bcae2306324ab1c91954818eb11d304b00bfebcb2ecfa8592`**. [Kompletny dowód JSON](2026-10-29-results-browser-final-evidence.json). Ten sam run FEM item 6 przeszedł cały scenariusz: próbki 0/2/5, retained frame przy opóźnieniu próbki 1, własne ustawienia snapshotów, table samples 0/5 i nazwy wszystkich sześciu kolumn, powrót do Live jeszcze przed dostarczeniem opóźnionego payloadu, wspólny filtr Explorer ↔ Results, ponowne otwarcie folderu z Saved i końcowa telemetria **101 kroków / 100 ps**. Hashowane są bajty faktycznie odczytywane przez aplikację, porównane z osobnym GET. Cały persisted visualization resource, command ledger i zbiór sesji pozostały niezmienione podczas scenariusza. Widoczny WebGL/canvas, stabilne kamera/Inspector i wszystkie wcześniejsze kontrole paneli/rozmiarów przeszły. SwiftShader, bez deklaracji sprzętowego GPU lub walidacji fizyki.

Poprzednia próba `78473560609f4119a9633b441d51d071` przeszła nowe asercje tabel i spóźnionego payloadu, lecz zatrzymała się na błędnym selektorze filtra w harnessie (`textbox` zamiast rzeczywistego `searchbox`, z właściwą nazwą `Search saved result outputs`). Poprawiono selektor na podstawie kodu/DOM; nie zmieniano produkcyjnego filtra, limitu czasu ani asercji zachowania.

Pozostają otwarte ograniczenia formatów i kwalifikacji wymienione wcześniej, przede wszystkim jawny per-quantity geometry binding FEM poza m. Bieżący audyt nawigacji/snapshotów/Return to live ma dowód runtime; nie jest to zatwierdzenie całego szerszego zakresu wszystkich quantity/modów. Integracja i CI bieżącej funkcji pozostają osobnym niedokończonym etapem.

Końcowe zrzuty `terminal_live_screenshot` i `pending_snapshot_screenshot` z próby b44… obejrzano wizualnie: po Return to live nie pozostaje Inspector historyczny, a podczas oczekiwania czas Displayed/Requested i legenda odpowiadają zachowanej klatce.


## Checkpoint 2026-10-29 — Model Builder, robocze formularze i kontekst podglądu

Próba **`03608b15552b4b7f9eaed0ea78fb820b` — passed**, hash harnessu `b89e697001eee0b55c5eb50cf6672349327dfb7f23508c821c232a04fe760a8c`. [Dowód JSON](2026-10-29-results-model-drafts-evidence.json). Test nadal korzysta z rzeczywistego zakończonego runu FEM item 6; nie wykonuje nowego Solve, Apply ani przebudowy siatki.

- **Object i Airbox**: lokalna zmiana pola → wybór outputu → Cancel zachowuje wpisaną wartość. Próba otwarcia Saved folder kończy się jawną odmową i zachowuje draft. Discard umożliwia zmianę wyboru; ponowne wejście do formularza pokazuje wartość zapisaną. Dotyczy pola Name oraz Airbox Maximum element size.
- **Kontekst historycznego viewportu**: otwarcie Inspectora bieżącego modelu przy aktywnym snapshotcie wcześniej nie wyjaśniało różnicy źródeł. Dodano neutralny komunikat i Return to live. Przejście zachowuje roboczą nazwę obiektu. Nie wprowadzono globalnego zakazu authoringu: ustawienia modelu nadal dotyczą bieżącego workspace, a zapisany snapshot zachowuje własne ustawienia.
- Cały scenariusz zachowuje command ledger, persisted visualization oraz zbiór sesji; nie wysłał mutacji sesji poza wcześniej dozwolonymi observer leases/render ACK. Ten wynik dotyczy sprawdzonych interakcji bez Apply; nie oznacza zakazu jawnej edycji modelu podczas current-result preview.
- Focused kontrole shellu, stylów Inspectora i Return to live: **27/27 passed**. Scoped ESLint i pełny typecheck przeszły. Niezależne review nowego notice i testów nie znalazło blokera.

Wcześniejsza próba `80d49f28895b47cea1ea456ac5208934` przeszła sam rozszerzony zakres Object. Późniejsza 036… obejmuje również Airbox i nowy kontekst Inspectora. Osobne kontrole braku aktywnej sesji i kolejności katalogu są w dalszej części pracy, nie są dowiedzione tym wynikiem.


## Checkpoint 2026-10-29 — spójne wyjście i czytelniejsza lista wyników

**`25ba83b20468499b9b95e89fcf632b35` — succeeded / passed**, harness `ae670f2da517cbb76bd917a5feb05a94790f1e1737b8a6ae9b2f7e8ebe008d65`. [Dowód JSON](2026-10-29-results-context-exit-evidence.json). Obejmuje wszystkie wcześniejsze asercje oraz:

- Cancel/Discard i odmowę Saved dla roboczych formularzy Object/Airbox; Return to live z modelowego Inspectora zachowuje wpisaną wartość i zaznaczony obiekt. Nowy komunikat kontekstu ma role=status.
- Etykietę **Return to live** wyłącznie przy potwierdzonej sesji; bez niej **Close results** w shellu, drzewie, Inspectorze i viewportach. Starszy Inspector playback używa wspólnego helpera usuwającego źródła historyczne.
- No-session: otwarcie realnego folderu, przewinięcie snapshotu do końca, zamknięcie do Home oraz ponowne zamknięcie starszego Inspectora i browser-only folderu. Discovery sesji zostało kontrolowanie zastąpione pustą kolekcją/404 w osobnym kontekście przeglądarki. Dane wyników nadal pochodzą z rzeczywistego backendu. To dowód UI bez sesji, **nie dowód backendowego restartu/recovery**. Nie zatrzymano istniejącej sesji i nie dopuszczono żadnej próby mutacji sesji w tym kontekście.
- Kontenery wyników i tablice są przed zwykłymi plikami; pełne identyfikatory Run/Revision pozostają w domyślnie zwiniętym **Source details**. Licznik katalogu nie powtarza pełnego hasha. Browser potwierdził zwinięcie i dostępność całej rewizji po rozwinięciu.

Próba `44f12568b6d4439b8f4b69f6c0bcb0a0` wykryła pominięty przycisk Return to live w drzewie przy braku sesji. Poprawiono przekazanie etykiety z istniejącej sessionIdentity; nie osłabiono asercji braku takiego przycisku. Wszystkie wcześniejsze asercje draftów w tej próbie przeszły, bez mutacji sesji.

Weryfikacja: exit labels/legacy cleanup **32/32**, tree/explorer **18/18**, końcowy tree po przeniesieniu Source details **9/9**. Jedna wcześniejsza asercja CSS wymagała aktualizacji z usuniętego truncate header na domyślnie zwinięte details i break-all; zachowano kontrolę pełnego 64-znakowego hasha. Scoped ESLint, typecheck i check:design przeszły w stałym frontendzie. Check:design kwalifikuje wspólne tokeny kolorów dark/light i focus ring, nie wszystkie możliwe renderowane kombinacje kolorów ani czytnik ekranu. Niezależne review zmienionych zachowań nie wykazało blokera.

Zrzuty modelowego Inspectora przy snapshotcie, no-session snapshotu i końcowego Live obejrzano wizualnie. Kontrolki mają spójne etykiety; źródło modelu jest jawne, a pełny hash nie wypycha listy. UI nadal wymaga dalszego audytu wskazanych otwartych obszarów. Grupa 3298, dane użytkownika, receipty, logi i cache pozostają zachowane.

### UX-17 · P2 · Ogólne zakładki Inspectora nie są połączone z panelem outputu

Nowa obserwacja z końcowego zrzutu, potwierdzona źródłowo: `inspectorDescriptor.ts::resolveFamily` nadaje `results.output.entry` ogólne zakładki Overview/Data/Provenance/Diagnostics. `InspectorShell` zmienia tylko `InspectorTabState`, natomiast `ResultsOutputInspectorContainer` i `ResultsOutputInspector` nie odczytują activeTab. Panel pokazuje te same sekcje niezależnie od wybranej zakładki. Nie oznacza to utraty danych, ale jest martwą nawigacją i pozostaje otwartym defektem ergonomii. Następny krok: nadać temu panelowi spójny kontrakt sekcji bez pustych zakładek albo powiązać je z rzeczywistą treścią; zachować Samples/Visualization, metadata, values i błędy oraz dowieść zachowania w UI.
