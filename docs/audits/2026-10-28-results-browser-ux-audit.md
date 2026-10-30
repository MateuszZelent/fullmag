# Audyt UX przeglądarki wyników, Inspectora i przejścia live ↔ preview

Data: 2026-10-28, aktualizacja 2026-10-30. Status: **REQUEST CHANGES dla całej funkcji — podstawowy scenariusz nawigacji, snapshotów m, tabel i powrotu do Live przeszedł; pozostałe formaty i bramki kwalifikacji pozostają otwarte**.

## Aktualny stan audytu

Poniższa tabela jest bieżącym podsumowaniem. Szczegółowe ustalenia UX-01–26 poniżej opisują także stan sprzed napraw; ich historyczne brzmienie nie oznacza, że każde pozostaje otwartym defektem.

| Obszar | Aktualny wynik i zakres | Pozostała praca |
|---|---|---|
| Model Builder / Object / Airbox | Browser: Cancel zachowuje draft, Saved odmawia zmiany kontekstu, Discard przywraca zapis; powrót ze snapshotu zachowuje draft modelu | Dalsze przypadki formularzy poza Name/hmax |
| Inspector snapshotu | Próbki czasu, własne ustawienia, powrót do ostatniej próbki po wyborze pliku; stabilne montowanie | Pełny widok szeregu tabelarycznego i pozostałe formaty analiz |
| Live ↔ preview | Rzeczywisty FEM m: zgodność payloadu, brak mutacji sesji w badanym przepływie, opóźniona odpowiedź nie przywraca historii | Bezsesyjny przepływ i kontrolowany błąd odczytu przeszły; długotrwałe błędy i pełna macierz awarii pozostają otwarte |
| Kamera i panele | Fit/Reset, zachowanie kamery, hide/restore/float/dock; szerokości 768–1920 przeszły | Pozostałe komendy kamery, powiększenie 200% |
| Results / nawigacja | Wspólny filtr/collapse/focus, widoczny zakres wyszukiwania, klawiatura, wejście Saved | Kolejność folderów i Source details mają dowód browser; duże katalogi/strony i długi run pozostają otwarte |
| Tabele i metadane | Nazwy sześciu kolumn, odczyt pierwszej/ostatniej próbki, tekstowe preview | Pełne możliwości analiz dla tabel/modów/eigensolve |
| FDM/FEM i wszystkie quantity | Pełny Rust CI20cf98 i regresja CAS przeszły; nowy FEM101kroków/100ps, sześć m/H_eff, obie geometrie3D poprawne. Rzeczywisty UI potwierdził oba pola i przewijanie | Dokończenie pełnego browser po poprawce skrótu palety, FDM/YIG i wiele etapów |
| Monitoring | Poprzedni runtime: watermarki 1–6 w plikach przed terminalizacją. Nowe źródła: Current API dopuszcza zatwierdzone prefiksy i kolekcję etapów/prób | Nowe testy Rust, monitoring Current UI, FDM i wiele etapów w rzeczywistym runie nadal bez kwalifikacji |
| Dostępność i czytelność | Klawiatura drzewa, osiągalne kontrolki po scrollu, motywy, brak poziomego overflow w badanym zakresie | Wspólne tokeny dark/light przeszły check:design; brak pełnej kwalifikacji czytnika ekranu i wszystkich rzeczywistych zestawień kolorów |
| Integracja | Draft [PR #332](https://github.com/MateuszZelent/fullmag/pull/332), grupa 3298 odzyskana. Pełny Rust, UI i browser fixture a3e341 oraz wcześniejszy pinned React Doctor przeszły | CI20cf98: Rust/UI/live i roundtripy przeszły; do migracji jedna stara asercja liczby węzłów. Poprawka skrótu palety i pełny browser wymagają nowego potwierdzenia przed merge |

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


## Kontynuacja 29.10 — ciągły Inspector wyników (UX-17)

Dla dokładnego rodzaju `results.output.entry` descriptor nie publikuje już ogólnych zakładek. Panel nadal zawiera Samples, Visualization, metadane, wartości i podgląd plików; nie zmieniono pozostałych rodzin Inspectorów. Test descriptoru sprawdza również zachowanie dotychczasowego kontraktu innego rodzaju Results. Review diffu tego fragmentu nie wykazało zmiany API, danych ani uprawnień edycji.

Zarządzany browser QA `47fbb05117c5422d8e7ba21660918ac6` przeszedł z harness SHA `e76b53993faf398d35adb4f7c635dc6805433722794970422497c75844105b41`. Potwierdza brak martwych zakładek, wszystkie poprzednie asercje przewijania i Return to live, drafty Object/Airbox oraz bezsesyjny przepływ Close results. Obejrzany screenshot no-session pokazuje Samples i Visualization bez pośredniej martwej nawigacji. Testy descriptoru **25/25**, powłoki **2/2**, scoped ESLint i typecheck przeszły w stałym frontendzie grupy 3298.

Poprzednia próba `5db288056f8c4f0eacad29cc94792b1c` przeszła przewijanie i Return to live, lecz ujawniła wyścig w samym teście Airbox: zapisywał początkową pustą wartość przed asynchronicznym odczytem polityki, a po Discard porównywał ją z zapisanym `8e-9`. Test czeka teraz na dodatni authored hmax wymagany przez tę konkretną fixture FEM; usunięto zastępcze `|| 8`. Zachowano asercje Cancel, blokady Saved folder i dokładnego przywrócenia przez Discard. Nie zmieniono modelu ani zapisanej polityki.

UX-17 zamknięto w powyższym zakresie. Nie jest to zamknięcie całej kwalifikacji przeglądarki; otwarte obszary pozostają w tabeli na początku audytu. Bieżący odczyt GitHub Actions dla HEAD `3ed19bbe7882d6d374720c6e16a602f9b9db2601` nie zwrócił workflow runs; nie stanowi to zielonego CI.


## Kontynuacja 29.10 — kontrolowany błąd odczytu snapshotu

Browser QA `06198ac2247842fcbd9dc1638e9c3931` przeszedł, harness SHA `dffacfde43ea336e932a238d7ea9774953e44818d5dbb10144fdb1f9ed2a1542`. Dowód: [results-read-error-evidence](2026-10-29-results-read-error-evidence.json). Nadal ten sam zakończony run FEM, backend snapshot i grupa 3298; nie wykonano nowej symulacji.

Intercept dotyczył wyłącznie jednego GET próbki o indeksie 4; zwracał kontrolowany HTTP 503. Browser sprawdził stan error dla żądanej próbki, zachowanie poprzedniej klatki indeks 5 i jej prawdziwej współrzędnej 0,10 ns, niezmienioną kamerę i legendę, zachowany canvas, widoczny alert i dostępny przycisk Return to live. Zrzut błędu obejrzano: Requested 0,08 ns jest wyraźnie oddzielone od Displayed 0,10 ns. Po usunięciu interceptu, wyborze poprzednio poprawnej klatki i ponownym wyborze indeksu 4 nastąpił poprawny odczyt; hash bajtów użytych przez UI jest zgodny z niezależnym GET zapisanych danych. Końcowy powrót do Live, kontrola braku mutacji sesji, drafty Object/Airbox i no-session Close results także przeszły.

To kwalifikacja krótkiego błędu odczytu i odzyskania przez ponowny wybór próbki; nie dowód wszystkich błędów, restartu backendu ani automatycznego retry. Return to live w samym stanie error sprawdzono jako dostępny; rzeczywiste kliknięcie powrotu wykonuje dalsza część scenariusza po odzyskaniu odczytu. Przeglądarka używa SwiftShader, bez deklaracji kwalifikacji sprzętowego GPU lub fizyki.


## Kontynuacja 29.10 — publikacja przyrostowa i stan oczekiwania (UX-18)

### UX-18 · P1 · Bieżący output nie jest źródłem autosave w czasie runu ani kompletną agregacją wielu etapów

Odczyt źródeł potwierdził dwie granice publikacji. `AcceptedProjectStorage::prepare` ustawia `data_root` na prywatne `temp_dir/data`; writer autosave zapisuje tam próbki. `finish` dopiero po sukcesie kopiuje output do zarezerwowanego leafu i zapisuje finalne receipty. Resolver `workspace_results.rs::resolve_current_results_root` wymaga completed manifest i succeeded output-storage receipt. Usunięcie tych kontroli nie zapewni streamingu: w docelowym folderze nie ma jeszcze próbek. Osobno `artifacts.rs::publish_fem_autosave_playback` publikuje opis geometrii dopiero przy Completed i korzysta z producer-owned danych dla `m`.

Dodatkowy kontrakt wielu etapów: resolver zwraca `current_results_publication_ambiguous`, jeżeli znajdzie więcej niż jeden pasujący opublikowany leaf. Nie należy naprawiać tego wyborem ostatniej nazwy lub katalogu. Użytkownik potrzebuje katalogu całego runu z jednoznaczną tożsamością etapów, attemptów i quantity.

Pełny [kontrakt i kolejność wdrożenia](../plans/active/results-incremental-publication.md) obejmuje publiczny commit próbki, współrzędne i watermark, per-quantity geometry binding, wiele etapów, terminalizację failed/cancelled i przejście live/history. To projekt implementacji oparty na wskazanych źródłach, **nie dowód wdrożonego streamingu**. Numeryki, lease'ów storage i backendowego resolvera w tym checkpointcie nie zmieniono.

Naprawiono natomiast mylący stan UI przed publikacją: tylko dla bieżącego źródła, pustego katalogu i dokładnego błędu HTTP 409 / `current_results_not_published` Explorer Results pokazuje status „Waiting for results publication”. Przy aktywnym watch opisuje odświeżanie widocznego panelu; bez watch wskazuje ręczny Refresh. Terminalny brak publikacji, inny kod/status, folder workspace i nieudane odświeżenie zachowanego katalogu nadal pokazują błąd. Dane nie są zastępowane pozornym pustym sukcesem.

Test red potwierdził dotychczasowy ogólny alert. Po poprawce: Explorer **15/15**, Tree **9/9**, scoped ESLint i typecheck passed w stałym frontendzie 3298. Testy obejmują pojawienie się prawdziwego katalogu po oczekiwaniu, rozróżnienie awarii oraz brak obietnicy pollingu bez watch. Dowód browser jest rejestrowany oddzielnie.

Próba QA `ef4e8ade113a48eabda1b3cb334a99b1` przekroczyła limit obserwacji. Najpierw potwierdzono terminalny exit 1 kontenera przeglądarki, następnie istniejący reconciler z pinami receipt/Compose/IDs zamknął ją jako failed-confirmed, output_lost, NOT VERIFIED. Nie uruchomiono drugiej próby na aktywnej blokadzie ani nie modyfikowano ręcznie receiptów. Odczyt kodu transportu wykazał błąd fixture: mock 409 nie zawierał nagłówków instancji i wersji API. Poprawka testu zachowuje nagłówki z oryginalnej odpowiedzi przez `route.fulfill({response, status, json})`, zgodnie z dokumentacją Playwright; kontrole tożsamości aplikacji pozostają aktywne.


Końcowy browser QA tego etapu: `40bedc0a008e409982ffd0c0768a837c`, **passed**, harness SHA `8f787e49319f3625b997949fa8c255f7899a8ca7811edbb38bfd2a040118a5be`, bazowy HEAD `d871a5e090c73ee98bce69ab7383f5732962dc43` plus zmiany checkpointu. [Dowód JSON](2026-10-29-results-publication-state-evidence.json). Oddzielny kontekst przeglądarki wykonał cztery odczyty: kontrolowane waiting, automatyczny kolejny odczyt, terminalną awarię oraz rzeczywisty opublikowany katalog. Alert nie jest używany do oczekiwania, pojawia się dla końcowego błędu i znika po odzyskaniu. Brak mutacji sesji. Zrzut panelu waiting obejrzano — komunikat i Refresh mieszczą się w lewym panelu. Pozostałe asercje pełnego scenariusza (snapshoty, błąd próbki, drafty, Live i no-session) też przeszły.

Zakres dowodu jest jawnie oznaczony jako `browser-availability-fixture-with-real-published-catalog`. Nie uruchamiano solvera w tym etapie i **nie zaliczono testu publikacji autosave przed terminalizacją**. UX-18 w części backendowej pozostaje otwarty; część mylącego komunikatu w UI została naprawiona.

## Kontynuacja 29.10 — zatwierdzanie próbek i świeży FEM

Wdrożono pierwszy element UX-18: writer i reader obsługują `fullmag.zarr.sample_publication.v1`. Liczba dostępnych próbek pochodzi z atomowo zastępowanego `.fullmag-samples.json`, po zapisie payloadu oraz lokalnej współrzędnej. `.zarray.shape` może wyprzedzać zatwierdzony zakres. Czytnik odrzuca niekompletne potwierdzenie, zachowuje stare foldery bez tej polityki i waliduje rewizję. Indeks czasu jest lokalny dla tablicy, także dla przeplatanych `m` i `H_eff` oraz layoutu separate. Pełny kontrakt i granice opisano w [planie publikacji](../plans/active/results-incremental-publication.md#pierwszy-etap-implementacji-commit-pojedynczej-tablicy).

Dowody w [JSON](2026-10-29-results-sample-publication-evidence.json):

- Testy writera **4/4**, cały `fullmag-workspace-inspect --lib` **91/91**, ESLint harnessu passed. Testy obejmują przerwany append, ukryty częściowy chunk, niezatwierdzony suffix czasu, niezgodny commit, stale revision, zachowanie u64 kroku powyżej 2^53 oraz stałą szerokość pola. Nie kompilowano na hoście.
- Końcowy managed capture `097da4a7cbdc4488a09616cd3e40b650`, snapshot `13dd771d83f7dda9d18fd9ec9d9e057a2f3281fef37a8514be214be5d68ecd1d`. Bajty obu zmienionych plików Rust porównano z `/build/workspace`; są identyczne. Wcześniejszy build ujawnił błąd typu kroku, a pierwsza kompilacja testu brak nowego pola w fixture; oba poprawiono przed zielonym wynikiem.
- Dwa nowe zakończone runy FEM CPU double: `run-live-56b1f8abca4b1224e47cd0c94ef95d609ca66df7482a74e0e3d73f5204530fa6` (item 7) i `run-live-4901d9094a83d35875013f679964a51ed3d30d9a7074a127be70dd7a3e1efac3` (item 8). Każdy: 101 kroków, 100 ps. Pierwszy output zawiera potwierdzenia sześciu próbek m, H_eff i tabeli. API czyta czasy osobno; pierwszy zapis tabeli jest w 1 ps, początkowe pola w 0 ps. Nie utożsamiono tych współrzędnych.
- Browser QA `fa4bb73be904456ea9d856f21d1c9138` passed. Następnie szerszy obserwator żądań i nowy run: `d45f2cc6a05e47869eca368fdaace792` passed, harness SHA `f04db44d7101eb18b56675c44f87783ebfb2e79902abc285239f4b39c96d8c64`. Potwierdzono payloady klatek 0/2/5, zmianę obrazu, stabilność kamery i Inspectora, ustawienia per snapshot, obsługę opóźnienia/błędu, Return to live, zachowanie modelowych draftów i niezmienione commands/sessions/visualization. Widoczny WebGL, nieutracony kontekst, SwiftShader.

### Obserwacja inicjalizacji kamery — nie uznawać za naprawioną regresję

Pierwsze QA `3c2b27757d764db1bc9d5559826e5afd` przeszło przewijanie i Return to live, ale końcowa kontrola odrzuciła zmianę globalnej kamery rev 1→2. Rejestr żądań tej strony nie odnotował mutacji po baseline. Nie ustalono pewnie autora tej zmiany. Powtórka bez zmiany kodu przeszła. W kolejnej świeżej sesji pozycja odpowiadająca rev 2 była już zapisana jako rev 1 **przed startem QA**; sam test nie był jedynym możliwym źródłem inicjalizacji.

Harness rejestruje teraz żądania wszystkich stron kontekstu i ograniczony ślad odpowiedzi z rewizją kamery, zgodnie z [BrowserContext.on(request)](https://playwright.dev/docs/api/class-browsercontext#browser-context-event-request). Nie osłabiono asercji niezmienności wizualizacji. Nowe QA zachowało rev 1 i przeszło. Pierwszy wynik pozostaje failed; przyczynę inicjalizacji współdzielonej kamery pozostawiono do osobnej kwalifikacji wielu klientów. Context7 odmówił z powodu miesięcznej kwoty; dokumentację sprawdzono u producenta.

**UX-18 pozostaje otwarty:** dane nadal są publikowane do publicznego leafu przy terminalizacji, resolver nie agreguje wielu etapów, a geometria H_eff nie jest opisana przez producer. Nowy marker jest kontraktem jednej tablicy, nie dowodem własności runu ani dostępności autosave przed końcem. Brak kwalifikacji długiej serii, pełnego FDM/YIG i całego UI. Nie scalono PR ani nie zadeklarowano zielonego CI.

Retencja: zachowano nowe wyniki, dowody QA, logi i aktywny cache/pakiet przypisanej grupy. Nie wykonano ręcznego usuwania danych ani cleanupu cudzych zasobów.


## Kontynuacja 29.10 — publiczny folder autosave, WIP i niedostępny Docker

Przygotowano drugi etap UX-18 opisany w [planie](../plans/active/results-incremental-publication.md#drugi-etap--implementacja-właściciela-publicznego-outputu-wip). Publiczne próbki Zarr zachowują się po cancelled/failed; końcowa publikacja nie kopiuje ich ponownie. Własność jest sprawdzana przed przekazaniem katalogu oraz finalizacją. Manifest runu zapisuje się przed zwolnieniem lease, a finalizator provenance nie modyfikuje dokumentów należących do storage ani commitów próbek. Pozostałe workflow zachowują staging.

Managed build `a9b8c97f2ed74e2fad184c42227bc62e` przeszedł. Test `separate_stage_autosave_root_is_recorded_for_final_provenance`: **1 passed / 0 failed**. Te dwa pliki nie zmieniły się po teście. Następnie doprecyzowano warunek autosave-only, dodano test starej ścieżki i sformatowano dwa pliki storage. Końcowy build nie został potwierdzony: `Docker observation exceeded its time/output budget during docker_capture (timeout=90s); daemon resources retained`. Odczyt `docker ps` również przekroczył 12 s, a porty 3298, 3198 i 3201 odmawiały połączeń. Nie ustalono przyczyny niedostępności wspólnego silnika; nie wykonano globalnego restartu, nie usunięto lease ani nie ponowiono nieznanej operacji.

[Dowód WIP i hashe](2026-10-29-results-public-root-wip-evidence.json). **Testy accepted storage, świeży run oraz audyt UI tej wersji: NOT VERIFIED.** Poprzedni pozytywny test snapshot → Live pozostaje dowodem wersji `5a15ea7`, nie nowego storage. API current nadal czeka na terminalizację; agregacja etapów i bieżące bindingi FEM pozostają otwarte. Zmian nie commitowano ani nie scalono przed wymaganymi testami. Zachowano wszystkie wyniki, logi, receipty i cache; cleanup wymaga ponownego odczytu konsumentów po powrocie Dockera.


## Kontynuacja 29.10 — ocena wizualna i odzyskanie środowiska

Ponownie obejrzano obrazy z QA `d45f2cc6a05e47869eca368fdaace792`, następnie prześledzono ich przyczyny w źródłach. To nowe ustalenia na zachowanym renderze, nie świeży test przeglądarki. [Dowód i hashe obrazów](2026-10-29-results-visual-finish-evidence.json). Kopie obrazów odzyskano z receipt QA po zniknięciu plików `/tmp`; są w `user-data` grupy, `audits/results-ui-20261029`.

### UX-19 · P2 · Cztery równoległe przyciski powrotu do Live

Na ekranie Saved widać identyczną akcję w globalnym nagłówku, nad drzewem, w podpisie viewportu i w Inspectorze. Powtórzenia konkurują z główną akcją „Load into 3D” i sugerują różne zakresy działania. Źródła w `apps/control-room/src`: `kernel/layout/WorkspaceShellClient.tsx:149`, `modules/results-navigator/ResultsOutputTree.tsx:434`, `modules/viewport-3d/ResultsSnapshotViewport.tsx:465`, `modules/inspector/panels/ResultsOutputInspector.tsx:378`.

Kierunek: jedno nadrzędne wyjście z historii w danym układzie; lokalne wyjście tylko tam, gdzie globalne nie jest dostępne. Kryteria: Saved, Current-history, no-session, ukryty Inspector/Explorer i odłączone panele; wyjście zawsze osiągalne klawiaturą, bez identycznych konkurujących akcji. Zachować odrzucanie późnej odpowiedzi po powrocie i ochronę draftów. **Otwarte; przycisków jeszcze nie zmieniono.**

### UX-20 · P2 · Nagłówek Saved zajmuje wysokość pełnego ribbonu

Obraz 1500×1000 pokazuje szeroki pas pustej przestrzeni nad panelami. `SavedResultsWorkspaceShell` wstawia krótki nagłówek jako drugi bezpośredni element `.fm-workspace-shell`, a `design/styles/layout.css:15` wymusza w tym wierszu `minmax(var(--fm-ribbon-height), max-content)`. Przyczyną jest nadrzędny grid, nie padding nagłówka.

Dodano regułę specyficzną dla bezpośredniego nagłówka Saved: drugi wiersz ma wysokość `auto`; tokeny tekstu, odstępów i kontrolek zachowano. **WIP: source review i diff check, bez renderu po poprawce.** Kryteria: nowy zrzut tego samego układu; większy obszar pracy bez ucięcia tytułu i wyjścia; długa nazwa folderu; 320/768/1024/1440/1920 px i 200% zoom; przywrócenie pełnego ribbonu w Live. Dotychczasowe testy szerokości nie dowodzą tej poprawki.

### UX-21 · P2 · Pliki pomocnicze Zarr przesłaniają quantity

Domyślnie rozwinięte drzewo (`kernel/results-browser/ResultsBrowserUiController.ts:29`, `modules/results-navigator/ResultsOutputTree.tsx:137`) pokazuje `.zattrs`, `.zgroup`, `index.jsonl` i commit próbki przed kolejnymi quantity. Na zachowanym ekranie m i tabela wypadają poniżej widocznego obszaru. To prawdziwe eksporty i muszą pozostać dostępne zgodnie z wymaganiem użytkownika.

Kierunek: etapy i quantity czytelne w pierwszej kolejności; pliki pomocnicze datasetu pod jawną, domyślnie zwiniętą sekcją. Nie usuwać ich z katalogu i nie udawać semantycznej obsługi nieznanych formatów. Kryteria: m, H_eff i tabela osiągalne bez przewijania przez pliki pomocnicze; wyszukanie `.zattrs` ujawnia wynik; fokus, collapse i wybór zachowane przy rewizjach oraz stronicowaniu. **Otwarte.**

### UX-22 · P2 · Etykiety mieszają indeks i numer próbki

Viewport pokazuje „index 0”, a Inspector „Sample index 1 / 6” (`ResultsSnapshotViewport.tsx:462`, `ResultsOutputInspector.tsx:396`). Mapowanie danych jest poprawne, lecz nazwy utrudniają ocenę, czy wybrana i wyświetlana klatka są zgodne. Kierunek: wspólna użytkowa numeracja „Sample 1 of 6” i czas; techniczny indeks w metadanych. Przy opóźnieniu nadal rozróżniać displayed/requested, nie zmieniając indeksowania API. Kryteria: pierwsza/środkowa/ostatnia próbka, accepted-step bez czasu, błąd i opóźniona odpowiedź. **Otwarte.**

Dodatkowa obserwacja: m ma „Unit not recorded”. Viewer uczciwie odzwierciedla brak w eksporcie; jednostkę należy zapisać u producenta zgodnie z kanonicznym katalogiem quantity (`crates/fullmag-quantities/src/catalog.rs:36`: dimensionless), nie zgadywać jej w UI.

Docker/WSL początkowo nadal był niedostępny, następnie CLI i serwer wróciły. Bieżący odczyt potwierdził oba stare kontenery 3298 w stanie exited 255, bez OOM i z Pid 0. `iteration/current.json` nadal wskazuje succeeded `a9b8c97f2ed74e2fad184c42227bc62e`, snapshot `7881f9924df5ebcb508cbe88abbe4bf40c3ca0279aaf34a8d43bea2ee7fdaa39`; aktywnego markera operacji brak. Nie uruchamiano ręcznie serwisów. Następny krok to managed resume przypięte do istniejącego development attempt, następnie testy WIP i nowy render. Cała funkcja nadal wymaga zmian.


## Checkpoint 29.10 — działający runtime, publiczny autosave i browser PASS

[Zbiorczy dowód](2026-10-29-results-public-root-baseline-evidence.json) rozdziela snapshoty, zakres testów, błędne próby i udaną kwalifikację. Nie jest dowodem nowszych, nieprzetestowanych zmian retry ani globalnego wyjścia.

- Końcowy capture po powrocie Dockera dał snapshot `e759e272ebf7553727abbcba294a87697fab16af266ddfcd72304896f0d5de99`; 7 testów accepted storage i 5 testów API Results przeszło. Runtime zatrzymał admission na historycznym native ownerze z innym buildem.
- Naprawiono brak możliwości użycia tożsamości kontenerów z poprawnej iteracji, gdy pierwotny failed DEV terminal nie miał tych identyfikatorów. Nowe `stop-bootstrap --iteration-attempt` korzysta z istniejącego walidatora linked continuation, przypina bieżący identyczny receipt i ponawia kontrolę pod lease oraz po stop. Bieżący czas startu nadal pochodzi z failed resume. 9 testów, w tym 24 przypadki błędnych powiązań, przeszło; niezależny reviewer nie znalazł blockerów. Realny stop `a836f77535f941089f56c02bf82ba12e` potwierdził niezmienione bajty ownera. Nie edytowano ręcznie lease ani receipt.
- Managed fresh recreation zachowała poprzedni runtime w archiwum. `/user-data` i katalog workspace pozostały. Nowy development `4ee5f6657f5d4ebd959f76a16d307be2`, config `0d54d28a8c2b5406059e885da3d2110fd932b1442642c66eccea8e954a9aa810`, snapshot `1ebb4e0bc60a1eac53608dc4e450e385d709201a1fa9bf3cbc4042f4d9897554`: succeeded, API i native service Ready.
- Rzeczywisty FEM `run-live-ac5c1552ae2cde97a70c427ba4763559115542be763a7e4508c49a104eb64764`, CPU/double/strict, zakończył się jako completed; storage succeeded i marker aktywny usunięty. Monitor widział po sześć rosnących commitów 1–6 dla m, H_eff i tabeli przy manifestach running oraz nieobecnym terminal receipt przed i po każdym odczycie. To dowód publikacji plików przed końcem, **nie** dowód odczytu tych watermarków przez Current API/UI. Folder dodano jako workspace item 9.
- Browser QA `6b16e7b9727f405ea8a6515cef7c46e9`: PASS. Rzeczywiste klatki 0/2/5, zgodne payloady, zmienny canvas, WebGL bez utraty kontekstu, stabilna kamera/Inspector, per-snapshot appearance, opóźniony odczyt i błąd/recovery, Return to live w trakcie odczytu, Model/Airbox draft guards, terminalne statystyki i brak mutacji naukowych w badanym przepływie. No-session i arrival/waiting używają jawnych fixtures przeglądarkowych z rzeczywistymi danymi wynikowymi. SwiftShader nie kwalifikuje sprzętowego GPU ani fizyki solvera.
- Pierwsza próba UI nie ruszyła przeglądarki przez 30 s cold-compile frontend. Druga zakończyła runner kodem 0, ale została odrzucona przez limit raportu. Zamiast podnosić 2 MiB lub usuwać asercje, pomocnicze obrazy przechwytywane są natywnie w JPEG80; dwa główne obrazy i pixel-hashe pozostają PNG. Zaakceptowany raport ma 1 565 902 B. Format każdego obrazu jest jawny; raport błędu zachowuje końcowy obraz i trace.

Obejrzany główny zrzut potwierdza poprawę wysokości nagłówka Saved z UX-20. Pełna macierz 320 px/200% nadal nie jest zaliczona. Na obrazie nadal widać cztery wyjścia, metadane wypychające quantity i różną numerację. Naprawy UX-19/22 są teraz w implementacji; UX-21 pozostaje otwarty.

Review storage wykrył rzeczywistą lukę: błąd terminalnego manifestu zwalniał lease i blokował retry. Wprowadzono WIP z zachowaniem markera niepewności, immutable outcome, idempotentnym cleanup i jednorazowym przygotowaniem danych/manifestu. Przygotowanie deskryptora ma terminalizować swój błąd. **Nowe przypadki błędów nie były jeszcze skompilowane/testowane na chwili tego checkpointu.** Kwalifikacja sukcesu powyżej nie zamyka tej bramki.

### UX-23 · P2 · Powtarzana identyfikacja folderu zajmuje miejsce wyników

Na zrzucie QA 6b16e7 globalny nagłówek i Explorer już podają nazwę folderu; wcześniejsza sekcja „Saved result folder / Name / Workspace item” zabiera kolejne wiersze nad rzeczywistym katalogiem. `WorkspaceDockLayout.tsx` przenosi te informacje do natywnego, domyślnie zamkniętego **Folder details** pod Explorerem, zachowując dane, aria-label i identyfikator sekcji. **WIP: wymaga testu/renderu po zmianie.** Kryteria: quantity ma pierwszeństwo, szczegóły pozostają dostępne myszą i klawiaturą, hide/restore i panele odpięte zachowują działanie.


## Checkpoint 29.10 — retry storage i scenariusz UI 3df588

[Dowód](2026-10-29-results-public-root-retry-evidence.json) zawiera dokładny snapshot, run, publikację, testy, hashe plików i natywne obrazy. Backend storage zapisano osobno jako `ba76afc3f`; naprawa bootstrap identity jako `f4ea712d9`. Nie scalono PR #332.

- Snapshot `33d0eaba`, iteration `cf232a8305a24e36b75e584edb2c8679`: runner storage 2/2, accepted storage 10/10, workspace results 5/5 PASS. Realny FEM `run-live-5e4873…` zakończył się poprawnie i opublikował sześć preterminalnych próbek każdego pola/tabeli. Nie jest to jeszcze dowód aktywnego Current API/UI.
- QA `3df588c9d44d4eb3887842352a1825ef`, item 10: PASS. Próbki pierwsza/środkowa/ostatnia zweryfikowane hashem payloadu; przewijanie, per-snapshot appearance, pending/error retention, tabele, dirty guards, no-session oraz powrót do Live działają w tym scenariuszu.
- UX-19: jedno nadrzędne wyjście potwierdzone w Saved i Current-history. Dodatkowo Current-history → Live działa po schowaniu obu paneli i przełączeniu na Live Charts; przy 320 px przycisk ma x=68, szerokość 118 i przechodzi hit-test. To nie jest kwalifikacja całego układu przy 320 px.
- UX-20: oglądnięty render potwierdza usunięcie pustego wysokiego ribbonu w Saved i przywrócenie go w Live. Pełne 320 px/200% zoom pozostaje otwarte.
- UX-21: tablice domyślnie zwinięte; wyszukanie metadanych rozwija ich przodków, a wyczyszczenie filtra zachowuje poprzednie rozwinięcie. Sterowanie jest ograniczone do 512 wpisów na źródło, najnowsza akcja usuwa najstarsze nadmiarowe ustawienie. Testy jednostkowe i browser potwierdzają kontrakt; oględziny obrazu ujawniły poniższy UX-24.
- UX-22: Inspector i viewport używają „Sample N of M”; indeks API pozostaje 0-based. Nowsze aria-valuetext na natywnym suwaku i Radix Thumb oraz opis latentnego wyboru 3D przeszły 20 testów w 4 plikach i typecheck, lecz ten receipt browser ich nie obejmuje.
- UX-23: Folder details jest zamknięte domyślnie, pod katalogiem; otwieranie klawiaturą i osiągalność po rozwinięciu tablic potwierdzone. Podsumowanie ma własny overflow scroll.

Cztery wcześniejsze próby nowego harnessu zakończyły się failed: zła rola searchbox, nieodseparowana poprawna ochrona dirty draft, automatyczne otwarcie Inspectora przez Live Charts i niejednoznaczny nagłówek. Zachowano receipty; poprawiono selektory/kolejność bez osłabiania asercji. Żaden failed nie został przeklasyfikowany na PASS.

### UX-24 · P2 · Zagnieżdżone quantity niewidoczne w zachowanym renderze Saved

Na principal/compact screenshot QA 3df588 widać początek rozwiniętej grupy Zarr, po czym pliki poziomu root. m/H_eff/table są wizualnie ucięte; Live screenshot pokazuje pełne zagnieżdżenie. Automatyczny PASS nie zamyka tej obserwacji. Trwa diagnoza layoutu; potrzebny jest test geometrii/hit-testu wierszy i nowy render. Nie uznajemy całego UI za ukończone.


### UX-24 — poprawka i końcowa kwalifikacja tego etapu

Próba `646d826a4008476daee4a7fab930d5e2` potwierdziła regresję: ostatni wiersz potomny Zarr kończył się na y=831,97 px, a kolejny root sibling zaczynał na y=379,31 px. `overflow-hidden` na treeitem zerował minimalną wysokość w gridzie, a `overflow-x-hidden` wrapperów tworzył także pionowy scroll context. Wrappery używają teraz `overflow-x-clip`; treeitem i grupy zachowują wysokość potomków. Truncation etykiet pozostało.

QA **`6ff37f3256bf45939ae570606758dc41` PASS**, raport 1 552 634 B, [dowód](2026-10-29-results-browser-ui-refinements-evidence.json). Wszystkie row boxes są monotoniczne; m, H_eff i tabela mają wysokość 28 px oraz poprawny pointer hit-test. Folder details pozostaje osiągalne przy scrollHeight 1437/clientHeight 628. Obejrzano principal i compact render: quantity są widoczne, zaznaczenie m jest czytelne. Dodatkowo rzeczywiste Radix/native slidery ogłaszają „Sample N of M”; cały wcześniejszy scenariusz scrubbing/Live/no-session przeszedł ponownie.

Frontend zapisano jako `c96d3bee5`; 32 pliki zachowały hashe od startu do końca QA. Po QA usunięto wyłącznie pustą linię na końcu testu, co jawnie zapisano w dowodzie. Focused tree suite: 26 niezmienionych testów PASS i 11/11 w poprawionym pliku po aktualizacji oczekiwania z hidden na clip; a11y 20/20; typecheck i check:design PASS. Wcześniejsze failed pozostały w receiptach. Zainstalowany, nieblokujący hook React Doctor zgłosił błąd parsera oxlint `Unexpected discriminant 7 for TSTypeName`; nie traktujemy tego jako zaliczonego review ani CI.

Pozostają: Current API podczas runu, kolekcja etapów/prób, wczesne bindingi FEM, świeży FDM/YIG, szersza kwalifikacja tabel/modes/eigensolve, pełne 320 px/200%, problem inicjalizacji kamery wielu klientów i integracja PR. Automatyczny PASS oraz poprawiony render tego etapu nie zamykają tych punktów.


### Integracja z masterem — receipty V3 i aktualna kwalifikacja

Baza lokalna `ef3cb578032d734404642cb58369c43b31262075`, merge w toku z `82a43e62041c1e7f2a1e6bf311aaae7449240931`. Nowy writer publikuje V3 w kanonicznym slocie, a czytnik rozróżnia historyczne V1, Stats V2 oraz terminal V2. Recovery porównuje pełne końcowe statystyki z CAS; początkowy stan zachowuje własny czas. Oba sloty zakończenia blokują ponowne wykonanie, a limit wielkości zapisu odpowiada limitowi odczytu. Niezależny review tej semantyki i późniejszych poprawek kompilatora nie zgłosił pozostałych regresji w sprawdzonym zakresie. Nie jest to review całej funkcji Results.

- Managed resume `c596263558174321b9b116cf81324086` zbudował i uruchomił backend na `eb7940ef81336e59320094fd88a4a4349e27df1c3f880731b1e4f425f08b8293`. Kompilacja testów wykryła dwa fixture bez trzech pól dodanych na masterze; uzupełniono puste wartości bez zmiany asercji.
- Następna kanoniczna iteracja `43bd4379171143e692b0b9a03589ba82` zakończyła się sukcesem; snapshot `a8b46a957897aeb3d4243a8c3329a998f72e957c7ee57f9af0ef70170d35fc91`. Capture i poprawione źródło projekcji mają identyczne bajty.
- Rust: **56 testów PASS**: 20 receiptów, 34 projekcji live, 1 fence odzyskiwania i 1 retencji. Logi: `/build/results-v3-verification/a8b46a957897/{completion,projection-local-unit,failure-fence-local-unit,retention}.log` w backendzie tej grupy. Użyto profilu `backend-dev` i `--locked`.
- Testy fixture ledgerów wymagały prywatnego TMPDIR oraz lokalnego profilu filesystem w procesie testowym. Produkcyjny profil kontenera prawidłowo odrzucał niepakietowane binaria testowe (`runtime provenance omits the current executable`). Nie zmieniono środowiska usług ani ich provenance; PASS tych unitów nie jest kwalifikacją runtime admission. Wcześniejsze nieudane przebiegi zachowano.
- Python: poprzednio wykonane **89 testów + 51 subtestów PASS** pozostają aktualne dla sześciu niezmienionych plików validatorów.
- Managed OpenAPI codegen zakończony sukcesem, receipt `cf282820340eb07266e20f61e514631122f0cb06736966f7f01647ce7e9aedb9`; nie wprowadził nowego diffu wygenerowanych plików.

**Świeże UI po merge nadal NOT VERIFIED.** QA `c9a103047f5f4f949a85b3911ba5f157` zakończyło się na sondzie hostowego loopbacku podczas pierwszej kompilacji strony; później ta sama strona odpowiedziała 200 w 0,24 s. QA `8fd6bed057c44e5fb772437a0d28e254` oraz `465f4f9a35fb4eaa92c0711788e94820` zakończyły się failed-confirmed w scenariuszu. Receipt zachował wyłącznie końcówkę stdout z obrazem, przez co właściwy błąd został utracony; kontenery mają logging driver `none`. Harness otrzymał ograniczony komunikat wyjątku na stderr, bez zmiany asercji.

Odświeżenie frontendu `53f4f2b78b974ac6afb98ed790dce459` ujawniło niezależny błąd integracji: grupa ma `group-ledger.json`, a helper wymagał dokumentów starego host-ledger. Błąd wystąpił przed zatrzymaniem usług; oba kontenery pozostały healthy. Nie edytowano żadnego lease ani receiptu. Trwa naprawa wyboru dokumentów z kontrolą obu profili i zmian pod lease. Stan całego audytu pozostaje REQUEST CHANGES; wcześniejszy PASS przeglądarki na poprzedniej wersji nie zastępuje nowego przebiegu.


Dalsza weryfikacja checkpointu: poprawka group-ledger przeszła niezależny review i **22 testy +35 subtestów** w Docker/Python3.11. Test fixture dostosowano do rzeczywistego stanu BuildControl i osobnych guardów anulowania/przygotowania; asercje własności, unknown outcome i zachowania lease pozostały. Helper sprawdza cały rekord oraz jego ponowny odczyt pod lease, a brak wymaganych dokumentów zatrzymuje się przed otwarciem nowej operacji. Zastosowanie w runtime nadal oczekuje na nowy capture. [Dowód integracji](2026-10-29-results-integration-v3-evidence.json).

Odczyt API potwierdził brak warunku wstępnego pełnego harnessu po restarcie: status, commands i visualization bieżącej sesji zwracają404 `no active local live workspace`, podczas gdy workspace item10 i jego playback zwracają200. Lista zapisanych sesji jest pusta. Następny przebieg wymaga nowego, autoryzowanego runu `examples/results_snapshot_browser_fem_smoke.py`; wyniki poprzedniego runu pozostają zachowane.


### Świeży run po integracji — 29.10.2026

Kanoniczna iteracja `4f9f28b7dc9849af8cae5cb832ce1ff0` na commicie `7025dfbf39f988e63b0dd0c9697ff7088c7717ac` i snapshotcie `662e2ed08306e6d5ab111ab4f14b3c43421c69e0ea909d4a2ab3d4ed595fabab` zakończyła się sukcesem. Poprawione odświeżenie frontendu `9249f5c7473e48d6a0e1347a154f5c57` również przeszło w rzeczywistym group-ledger runtime; backend pozostał zachowany. React Doctor w pre-commit ponownie zgłosił błąd parsera oxlint, więc lint pozostaje niezakwalifikowany. Ostrzeżenia whitespace w incoming master były identyczne z MERGE_HEAD i nie zostały zmienione.

Aktywacja `ca8a27f8920946d0898af546fd7c61d6` istniejącego fixture FEM zakończyła nowy run `run-live-c0aab773b27224d95392934223a4fd726e9dd06557e920e53dcb01534d362c1a`: CPU/double, 1687 komórek, 101 kroków, 100 ps. Folder zarejestrowano jako item11. Obie tablice `m` i `H_eff` mają po sześć czytelnych próbek. API kwalifikuje 3D tylko dla `m`; `H_eff` zgłasza brak jawnego powiązania geometrii. To nadal otwarty brak funkcji, wymagający osobnego, ścisłego kontraktu FEM per quantity i wczesnej publikacji. Kontrakt `owned_sample_field_geometry.v1` z mastera jest ograniczony do inspekcji anteny (V_electric/J_charge/H_ant) i nie może zostać użyty przez zmianę nazwy quantity albo rozluźnienie istniejących walidatorów.

[Dowód nowego runtime](2026-10-29-results-fem-runtime-evidence.json). Audyt przeglądarki `52a08fbb914149228a2fdbe849475c63` jest w tym checkpointcie w toku; nie jest jeszcze dowodem świeżego UI PASS.


Próba `52a08fbb914149228a2fdbe849475c63` zakończyła się **failed-confirmed** w kroku synchronizacji źródła i filtra między hostami Explorer/Results (harness:880). Screenshot pokazuje zakładkę Saved z listą folderów, podczas gdy Explorer wcześniej pokazywał Current z filtrem `fields/m`. Przed tym krokiem rzeczywiste odczyty próbek i zmiany canvas, ustawienia per snapshot, zachowanie starej klatki przy ładowaniu/błędzie, guardy Object/Airbox, powrót Live, wyjście podczas opóźnionej próbki i Current results przeszły. Nie odnotowano mutacji solvera. To częściowy dowód, nie pełny UI PASS. [Zachowany wynik z hashami obrazów](2026-10-29-results-fem-browser-failure.json).


### UX-25 · P2 · Źródło Results rozjeżdżało się przy zmianie hosta — naprawione

Po przejściu z Explorera pokazującego Current do zakładki Results pozostawał poprzedni wybór Saved. Explorer renderuje wyłącznie Current outputs; otwarty zapisany folder ma osobny host. Synchronizacja jest teraz akcją aktywacji hosta Explorera z jego kartą Results (mount lub zmiana wewnętrznej karty), a nie każdym rerenderem. Świadomy Saved pozostaje podczas zwykłych renderów Results; przejście do Explorera z widocznymi bieżącymi wynikami ustawia Current. Trzy testy source routing przeszły w frontendzie grupy, niezależny review nie znalazł blokera.

Pełny browser QA `d126043062cf4b808e71b5eea7e70313` przeszedł na tym samym runie i item11. Potwierdził także rzeczywiste podłączenie mount/tab efektu, wspólny filtr między hostami, Saved entry, zachowanie ustawień i guardów, stale-response exit, tabele oraz końcowe skalary **101 kroków /100 ps**. Widoczny canvas ma buffer **649×565**, kontekst nie jest zgubiony; errors i hook_errors są puste. Jest to SwiftShader. Przygotowane scenariusze braku sesji i oczekiwania na publikację nadal są testami kontrolowanymi w przeglądarce, nie dowodem działającego wieloetapowego monitoringu. [Pełny wynik i hashe frontendowej delty](2026-10-29-results-fem-browser-pass.json).

Obejrzano główny screenshot Saved, końcowy Live i kompaktowy. Quantity są widoczne, obiekt Saved mieści się w kadrze, suwak i ustawienia są czytelne, a powrót do Live przywraca właściwy viewport i końcową telemetrię. Ten ogląd nie rozszerza kwalifikacji na pełne 320 px/200% ani hardware GPU.

### UX-26 · P2 · Jednostka zapisanej tablicy nie jest publikowana

Na oglądniętym screenshotcie `m` nagłówek pokazuje `Unit not recorded`. Ogólny writer Zarr zapisuje quantity/layout, lecz nie jednostkę i per-array semantics. Dla istniejącego FEM m geometria wiąże już kanoniczny descriptor z jednostką1; nowy kontrakt publikacji powinien przenosić jawne jednostki bez zgadywania z nazwy. Dla H_eff kanoniczny katalog i live API definiują A/m, Node, FullDomain, a planner przelicza B Zeemana przez μ₀. Nie wolno skopiować maski/producer ID magnetyzacji ani zastąpić H_eff przez kontrakt inspekcji H_ant.

Końcowy `pnpm run typecheck` tej poprawki również przeszedł w frontendzie grupy3298 (exit0). Kod Rust i dane runu nie zmieniły się podczas poprawki UI.


### UX-26 — kontrakt zapisanych pól FEM; testy runtime wstrzymane

Dodano źródłowe kontrakty geometrii H1/P1 i osobnej semantyki quantity. Zarr deklaruje jednostkę oraz AoS/SoA przed pierwszą publikacją; binding tablicy wskazuje współdzielony obiekt siatki i osobny obiekt semantyki. M zachowuje support magnetyczny, H_eff support całej domeny. FrozenSpins i pola modalne nie otrzymują fałszywego kontraktu zwykłego pola. Limity metadanych prowadzą do zapisu bez geometrii podglądu, bez blokowania danych autosave. Przy kolejnym snapshocie nie jest hashowana ponownie cała siatka.

Review wykazało dwie usterki, poprawione w źródłach: rozdzielono walidację strukturalną producenta od `parse_payloads`, które weryfikuje referencje hash/size obu obiektów; Windows przypina katalog bez współdzielenia usuwania podczas otwierania pliku. Nowe regresje obejmują podmienioną poprawną maskę M, niezmienność plików, dowiązania Unix, zmianę layout/width oraz pierwszą publikację z geometrią. Formatowanie plików zadania i diff-check przeszły. Przypadkowe rekurencyjne formatowanie 104 innych plików cofnięto dopiero po bajtowym dowodzie `rustfmt(HEAD) == current`; w lib.rs zachowano jedynie deklarację modułu.

**Cargo, nowy runtime i nowy browser: NOT VERIFIED.** Iteracja `bb64d9f26dab4712bb96985fd08143b6` nie doszła do capture/build: zatrzymanie backendu zakończyło się kodem1 i receiptem `shutdown_unknown`, ponieważ API przekroczyło 10 s oczekiwania po terminate. Nie wykonano jeszcze authenticated service drain. Launcher zachował operację i odmówił restartu; backend jest zatrzymany, helper zachowany. Brak ręcznej zmiany lease/receiptów. Ostatni pełny browser PASS pozostaje dowodem poprzedniej wersji i nie dowodzi nowych kontraktów. Sam czytnik bindingu, podgląd H_eff, monitoring trwających publikacji, kolekcja etapów oraz pełna macierz UI nadal pozostają do ukończenia. [Checkpoint źródeł i blokady](2026-10-29-results-fem-nodal-source-checkpoint.json).

Kanoniczna recepta `docker-dev-offline-check` w tej samej zatrzymanej grupie wykonała **39 testów `test_docker_volume_reconcile` — PASS, exit0**, przy stabilnych źródłach. To dowód drogi testów launchera, nie nowych testów Rust. Niezależna analiza nie znalazła pasującej procedury wznowienia: nowy wariant failed-stop może domknąć jedynie operację kontrolną przez oryginalnego helpera/CAS, zachowując `verified` i wszystkie rekordy native. Nie daje to jeszcze prawa do startu: odzyskanie ukończonej sesji z zachowanym `OWNER=ready` i procesem `shutdown_unknown` wymaga osobnego kontraktu. Obecne failed-build, offline-reconcile i held-manual recovery mają inne warunki. Nie należy ich dopasowywać przez zmianę receiptów.


### Aktualizacja recovery grupy 3298 — rozliczony nieudany stop

Wcześniejszy wniosek o braku natywnej ścieżki jest zastąpiony dokładnym trace: istniejący request v3 obsługuje Ready ownera oraz pełny zestaw terminalnych runów, bez held-manual. W store są trzy runy, wszystkie task catalogs wskazują succeeded; ich intent/catalog/artifact-catalog mają przypięte hashe. Pełna natywna walidacja tych danych nadal pozostaje przed nami.

Dodano jawny failed-stop reconciler. Wymaga dokładnych preflightów ukończonego zadania, pustej kolejki, starej inkarnacji kontenerów, niezmienionego ownera i receiptów, oraz braku checkpointów świadczących o rozpoczętej innej fazie. Daemon sprawdza CAS ponownie przed publikacją; `verified` i native pozostają poza targetami zapisu. **19 testów nowego profilu + 39 kontrolera + 13 przygotowania v3 przeszło** w kanonicznym offline helperze grupy. Pełny test BEGIN/COMMIT potwierdza zachowanie oryginalnego flock/active, brak native write i odmowę całej publikacji po drift preflightu. Niezależne review nie znalazło blokera.

Podgląd rzeczywistego żądania `e2c0dce5c71cb76c4a8d394a1a3fe4ed3b787147ad1d6cf0758f729543f289d7` przeszedł. Kanoniczne zastosowanie zakończyło `bb64d9f26dab4712bb96985fd08143b6` jako failed-confirmed; oryginalny helper sam zwolnił operation lease. To rozliczenie nie potwierdza drainu ani działania API.

Odczytowy preflight istniejącego native recovery ujawnił kolejny błąd: caller aliasów WSL używał domyślnej grupy master, a kernel probe również ograniczał się do mastera. Rozszerzony test odtwarza odmowę dla prawidłowo przypiętego worktree. Naprawa ma zachować autentykację wybranego checkoutu, dokładne piny kontenerów oraz fizyczny test rozłączności; cudze kontenery i dane pozostają nietknięte. **Nowe testy Rust, nowy runtime i nowy browser pozostają NOT VERIFIED.**


### Kontynuacja: odczyt geometrii przypisanej do tablicy FEM

Naprawa failed-stop została zapisana w commicie `4f4eade947c21b3eed7578793013efb7f44c3230`.
Hashe helpera, testu i kontrolera są identyczne z wersją, która przeszła 19 testów nowej
ścieżki i 39 testów kontrolera w zarządzanej grupie. Commit nie oznacza wznowienia native.

Poprawki przekazania projektu worktree i obsługi pominiętego `HostConfig.Mounts` przeszły
odpowiednie testy zarządzane; aktualną blokadą jest tożsamość obcych mountów Windows
`/run/desktop/mnt/host/{c,e}/...`. Obie usługi naszej grupy pozostają `exited`/PID 0.
Nie poszerzono dowodu POSIX na aliasy Windows i nie zmodyfikowano obcych grup.

Adapter API łączy nowy `fem_nodal_binding` z istniejącymi odpowiedziami Results i
wspólnymi kodekami FMMT/FMSP. Geometry identity jest SHA256 serializowanego,
zwalidowanego bindingu i obejmuje referencje mesh/semantics oraz quantity/layout/unit.
Nie tworzymy dla H_eff starego kontraktu magnetyzacji. Niepoprawny istniejący binding
nie może przejść do legacy M/FDM; Inspector zachowuje metadane z wyłączonym 3D.
Nowy test routera obejmuje M/H_eff, wspólną topologię, różne maski, jednostki,
zgodność hashów/długości binariów, drugi snapshot, zmianę jednostki i stale revision.
Review adaptera: source-only PASS po poprawieniu oczekiwania HTTP 422 na kontraktowe
400. Testy Rust i odbiór nowego UI: **NOT RUN**. Nowe zależności testowe inspect
wymagają kanonicznej aktualizacji Cargo.lock przed bramką `--locked`.


Czytnik został zamrożony do integracji. Obecny binding (także `null` lub uszkodzony)
wyłącza legacy inferencję quantity/layout/times również w katalogu. Wewnętrzny
`.fullmag_geometry` nie zaśmieca Explorera, ale nadal jest objęty revision i
kontrolą ścieżek. Dodano regresje obu referencji hash/length, metadanych,
budżetu, symlinków i braku fallbacku; wykonanie testów nadal oczekuje na runtime.

Dodatkowa luka źródłowa: kanoniczne wielkości spoza małej legacy listy, np.
`DemagPhi`, miały `component_count=None` mimo poprawnego bindingu. API teraz
przenosi liczbę składowych i layout z pełnego, zwalidowanego kontraktu. Test
routera obejmuje również skalar `DemagPhi` z jednostką A i odpowiednią szerokością
snapshotu. Niezależny review tej delty: source-only PASS.

Usterka ergonomii pustej tablicy: Inspector wyłączał nawigację, ale przy
`sample_count=0` mógł pozostawić aktywne „Load into 3D”. Przycisk i obsługująca go
akcja wymagają teraz co najmniej jednego snapshotu; dostępne jest wyjaśnienie
„No snapshots have been published yet.”. Rozszerzono istniejący test pustego
stanu. Vitest/typecheck oraz odbiór tej zmiany w przeglądarce: **NOT RUN**.

Wysłano pytanie o zgodę na koordynację z pozostałymi czatami Fullmaga w sprawie
właścicieli obcych grup Windows. Brak odpowiedzi nie stanowi zgody; żadnej
wiadomości do tych czatów ani mutacji ich grup nie wykonano.

### 2026-10-30 — aktywne snapshoty i rzeczywista struktura Zarr (źródła)

Poprzedni komentarz resolvera był nieaktualny: producent Zarr ze stage autosave publikuje niezmienny `run.json` przed startem runnera, a granicę widoczności danych wyznacza `.fullmag-samples.json` każdej tablicy. API dopuszcza teraz taki pojedynczy aktywny leaf po sprawdzeniu runu, próby, epoki, fingerprintu i polityki próbek; starsze foldery zachowują wymóg zakończonej publikacji. Czytnik nie może użyć ścieżki legacy dla tablicy bez watermarka w zadeklarowanym folderze przyrostowym. Nowe testy obejmują 0/1/3 zatwierdzone próbki, stare rewizje i błędne deklaracje.

Przegląd realnego wcześniejszego screenshotu ujawnił dodatkową niezgodność fixture: wynik ma `results_browser.zarr/stages/...`, podczas gdy czytnik FEM zakładał `stages/...` bezpośrednio pod folderem Results. Czytnik ustala teraz dokładny store Zarr właściciela tablicy i otwiera jego obiekty geometrii przez przypięte katalogi. Nie korzysta z kopii obiektu w folderze nadrzędnym; osobny test obejmuje tę odmowę. Wewnętrzne obiekty są ukrywane w katalogu na każdej głębokości. Fixture routera otrzymał zagnieżdżony układ i rzeczywisty katalog receipt, ale pozostaje syntetyczny, nie jest dowodem przebiegu producent→API.

Niezależny review znalazł brak hashowania treści `run.json`; dodano hash do rewizji i regresję zmiany polityki przy tym samym rozmiarze oraz mtime. Kontrola składni rustfmt i `git diff --check` przeszły. **Nowe testy Rust, nowy build i nowy browser: NOT RUN.** Całkowite usunięcie deklaracji polityki z folderu Saved pozostaje nierozróżnialne od formatu legacy; nie deklarujemy odporności na taką utratę wszystkich markerów.

Odczyt Docker potwierdził własny backend zatrzymany oraz obcą grupę `live-quantity-refresh` nadal działającą (PID 7625); dwie pozostałe wskazane grupy pozostają zatrzymane. Nie zmieniano cudzych zasobów. Nadal wymagane są kwalifikowane odzyskanie runtime, testy i odbiór UI, obsługa kolekcji wielu etapów/prób, pozostała macierz oraz CI/integracja.

Końcowy review delty potwierdził usunięcie P2 w źródle oraz poprawę struktury fixture. Nie jest to dowód kompilacji ani rzeczywistego roundtripu producenta.


### 2026-10-30 — kolekcja etapów i granice rewizji (source review)

Current Results agreguje legalne leafy accepted runu, zamiast odrzucać drugi etap.
Każdy członek ma stabilny klucz wyprowadzony z niezmiennej tożsamości outputu,
runu i nazwy leafu. Globalna rewizja katalogu obejmuje członkostwo i rewizje leafów;
metadane tablicy zwracają osobny token rewizji wybranego leafa. Dodanie siblinga
unieważnia globalny cursor, lecz zachowuje ID i token istniejącego snapshotu.
Odczyty próbek i geometrii sprawdzają właściwy leaf przed i po odczycie;
nie używają geometrii sąsiedniej próby. Zatwierdzony prefiks deklarowanej
publikacji incremental pozostaje dostępny również po failed/cancelled.
Nie kwalifikuje to anulowanej próby jako zakończonej sukcesem.

Niezależny source review nie znalazł błędu routingu tożsamości lub fence rewizji.
Finding P2: trzy osobne receipty na każdy z maksymalnie 256 leafów mogły
spowodować parsowanie do 768 MiB JSON. Dodano wspólny budżet 16 MiB na jedno
rozwiązanie kolekcji, niezależnie od limitu 1 MiB pojedynczego dokumentu.
Ponowna kontrola po odczycie ma własny taki budżet. Bounded reader ogranicza
odczyt do pozostałej kwoty przed parsowaniem; wyczerpanie daje 413.

Nowe testy źródłowe obejmują drugi etap, stabilność pierwszego snapshotu,
odrzucenie obcego tokenu, prefix anulowanej próby, topology/support po dodaniu
siblinga i stale geometry po zmianie wybranego leafa. Osobny test przekracza
łączny budżet receiptów, zachowując limit każdego pliku. Fixture nodal FEM
zawiera teraz rzeczywisty kontrakt commit/coordinates dwóch próbek.
**Wykonanie tych testów: NOT RUN.** Parser Rust i git diff-check przeszły.

Istniejący job `bootstrap/rust-contracts` rozszerzono o filtry `workspace_results`,
`autosave_fem_geometry` i `autosave_zarr`. Zachowuje też Cargo.lock oraz manifesty
jako artefakt, aby odebrać kanoniczną zmianę dependency graph wygenerowaną przez
Cargo w autoryzowanym CI; lockfile nie jest edytowany ręcznie. Kontrola składni
YAML przeszła. Samo przygotowanie workflow nie jest dowodem kompilacji.

Bieżąca kontrola Dockera: grupa Results 3298 nadal nie działa; obca grupa
live-quantity-refresh nadal działa. Nie wykonano restartu ani mutacji obcych
zasobów. Odbiór nowego UI i pełna macierz audytu pozostają otwarte.


### 2026-10-30 — ustawienia snapshotu po dopisaniu danych

Kontroler zachowuje ostatnio wybraną próbkę serii i ostatnio edytowany wygląd
konkretnej próbki między rewizjami metadanych. Preferencje są ograniczone do
128 wpisów i rozdzielone według run/session, stage, source/dataset, quantity
oraz indeksu próbki. To osobna pamięć ustawień: dokładne definicje renderu nadal
zawierają rewizję i nie współdzielą buforów. Samo utworzenie definicji nowszej
rewizji nie zmienia aktywnego viewportu. Istniejąca definicja starszej rewizji
zachowuje swój wygląd; Return to live zachowuje preferencje, reset sesji je czyści.
Inspector nadal ogranicza odtworzony indeks do aktualnej liczby próbek.

Testy kontrolera rozszerzono o dziedziczenie preferencji, izolację tożsamości,
brak przełączenia viewportu, LRU oraz clear/Return to live. Primary source review:
PASS; **Vitest, typecheck i browser: NOT RUN**. Nie jest to dowód zachowania
kamer ani widocznego renderu bieżącego buildu.

Drugi review budżetu wykazał błędne mapowanie każdego błędu I/O przy małej
pozostałej kwocie na 413. Reader ma teraz typowany `MetadataByteBudgetExceeded`;
API używa go tylko dla rzeczywistego przekroczenia limitu. Brak pliku, zły typ,
symlink i inne błędy zachowują odrębny komunikat. Regresje dodano w readerze
oraz handlerze API. Niezależny ponowny source review: PASS, wykonanie: NOT RUN.


### Pierwsze CI nowego etapu — HEAD 1f2980429

Kod i testy opublikowano w `1f2980429f5c546f4ee2d0bca5d28efb74e80e3d`.
Rust run [41043411407](https://github.com/MateuszZelent/fullmag/actions/runs/41043411407)
zakończył job rust-contracts błędem kompilacji: brak importu
`FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT` w saved_fem_nodal i przesłonięcie helpera
`reference` lokalną zmienną w teście. Oba błędy poprawiono; potrzebne ponowienie CI.
Testy Results nie wykonały się w tej próbie. Artefakt 12971087642 zawiera Cargo.lock
wygenerowany przez Cargo; po sprawdzeniu SHA256 ZIP i identyczności manifestów
przeniesiono go bajtowo do repo. Zmiana to dwie wymagane zależności testowe oraz
kanoniczna kolejność istniejących wpisów CLI; bez ręcznej edycji lockfile.

UI run [41043505998](https://github.com/MateuszZelent/fullmag/actions/runs/41043505998)
przeszedł `inspector-actions-browser-smoke`; pozostałe joby były w toku podczas
odczytu. Obejrzano zrzuty Airbox narrow/live i Object wide/invalid z artefaktu
12970928459. Kontrolki mają czytelną hierarchię, akcje pozostają widoczne przy
przewijaniu, stan walidacji wyłącza Apply. Raport jawnie kwalifikuje test jako
fixture callbacków produkcyjnego Inspectora, bez API end-to-end, runtime ani
fizyki. Nie dowodzi to nowego przepływu Results. Zrzuty mają odznakę Next dev;
nie traktujemy tej fixture jako wyglądu pełnego produkcyjnego workspace.

Hook commita wykonał skan pięciu plików UI i zgłosił indeks jako klucz w liście
Decoded values. W tym read-only widoku indeks jest stabilną pozycją wartości
w tablicy; brak stanu wiersza i sortowania. Uznano ostrzeżenie za nieadekwatne
do tej listy; nie dodano suppression. Nie jest to pełny lint ani typecheck.

Job control-room-contracts potwierdził typecheck, a następnie zatrzymał się na
jednym ostrzeżeniu ESLint (`React` nieużywane w mocku
InspectorDirtySelectionGuard). Usunięto niepotrzebny import i async tego mocka.
Vitest i build nie zostały przez tę próbę wykonane; obowiązuje ponowienie CI.


### Drugi Rust CI i odświeżenie ścieżki recovery

Rust run [41044935114](https://github.com/MateuszZelent/fullmag/actions/runs/41044935114)
na HEAD `78ff376e462db4ebebb2c625ede8d45dd07e0e65` ujawnił kolejne błędy
kompilacji producenta: nieistniejący moduł fem::plan, przesłonięty helper plan
oraz niezgodny typ oczekiwanego bufora w teście limitu serializacji. Producent
korzysta teraz z `dispatch::normalized_runtime_element_markers`, tej samej
funkcji co runtime i istniejący writer artefaktów; nie kopiuje starszej wersji
z nieużywanego adaptera. Helper testowy to make_plan; oczekiwanie JSON sprawdza
pełne trzy bajty `"a"` jako slice. Potrzebne ponowienie CI, bez deklaracji PASS.

Szeroki browser smoke pierwszego UI runu zatrzymał się na nieobecnym legacy
węźle `results:run:inspector-run`. Fixture nie obsługuje GET current/data/results,
a bieżące drzewo ma odmienną hierarchię w Modes & analysis. Diagnostyka nadal
rozróżnia nieaktualne oczekiwania testu od rzeczywistego dostępu do wyników
zakończonego etapu. Limitu żądań nie podniesiono i nie ukryto strony przed pollingiem.

Odczyt mastera `aee17a54d4c283f2fdf5aa3d89acc5ecdb638e19` potwierdził nowy natywny
dowód Windows/DrvFs dla aliasów drive. To potencjalna droga usunięcia starej
blokady recovery. Nadal potrzebne: integracja helperów z lokalną tożsamością
worktree, świeża kontrola runtime i nowe piny. Poprzedni katalog pinów w /tmp
nie istnieje; nie odtworzono jego wartości z pamięci. Obcy main ma lokalną zmianę
browser QA, dlatego nie wykonujemy z niego mutującego recovery jako z czystego
przypiętego helpera. Nie zmieniono cudzych grup.

### 30 October: executable reader results and completed-run identity

Rust CI [41046759452](https://github.com/MateuszZelent/fullmag/actions/runs/41046759452), source `76e2c9d84`, passed compilation and reached the read-only playback step. Workspace inspection ran 103 tests: 102 passed; `eligible_attestation_read_failure_preserves_running_manifest_for_retry` failed with `WouldBlock` while reacquiring the publication lock. The later playback route and autosave commands in that step did not execute. This is not a green Rust qualification.

The broad browser fixture failure was traced to the closed **Analysis results** accordion and a missing current output catalog response, not obsolete tree IDs. The harness now expands that section and serves the complete empty catalog DTO; all IDs, routing assertions and the request budget of 8 remain unchanged. Syntax and primary diff review pass; the browser rerun is pending.

A separate completed-run issue in the legacy Results navigator is fixed in source: after active stage metadata clears, identity comes from a ready manifest that explicitly belongs to the current run/session and names an exact stage. Contradictory metadata is rejected; completion ordering is never used to choose a stage. Focused tests were added, but have not yet run.

The owned recovery changes were committed separately as `15fb39d23` before master integration. Python and justfile parsing passed. A global justfile formatting check reported existing formatting differences; none were applied. The fresh read-only control receipt still selects development attempt `9249f5c7473e48d6a0e1347a154f5c57`. Application recovery, current backend deployment, snapshot scrubbing and Return to Live remain **NOT VERIFIED**.


### 30 October: master integration, recovery preflight and second UI evidence

The semantic merge with master `aee17a54d4c283f2fdf5aa3d89acc5ecdb638e19` is in progress. Completion receipts keep explicit version dispatch and the dual-slot replay fence. New V3 writers use `terminal_stats`; readers also accept the deployed V3 `final_step_stats` spelling and reject a document containing both keys. Legacy V2 and legacy-spelling V3 retain their original optional/input-state-reference semantics, while canonical V3 validates the final reference, claim and bounded row. Recovery still verifies receipt identity and immutable output clocks/energy. Optional diagnostics omitted by the writer are also omitted from its returned execution, preventing a later receipt/execution mismatch from failing a valid Solve. The terminal projector uses only the pinned terminal scalar artifact; it does not fall back to a completion receipt or stale live sidecar. Migration, durable-energy tampering and full-row dedup regressions are added; Cargo verification is pending.

Managed offline recovery tests on the merged Python source passed **76/76**: bind overlap 25, preparation 13, abrupt-stop recovery 38. Receipts report stable source inputs. Fresh operator pins were read from the current owned development attempt and the three retained run catalogs, whose tasks are all succeeded. The managed read-only preparation returned `validated-read-only` with `application_started=false` and `compute_started=false`; proof path `runtime-services/container-recovery/103c7000-cc23-4f8d-96a1-ba2e8888def5/abrupt-stop-proof.json`. This supersedes the unresolved Windows-alias preflight blocker, but does not qualify application recovery or the new UI. Foreign groups were not modified. Publication of the recovery authorization is in progress.

UI run [41048512203](https://github.com/MateuszZelent/fullmag/actions/runs/41048512203), source `cadcce77eb955e67e1ecda1492ead9b7381c7ded`, passed Inspector actions. The broad browser fixture passed the five resonance leaf routing cases, with no error notifications, then failed the Analysis plots responsive assertion: the title had width zero at a 1280-pixel viewport. Artifact 12974341222 was downloaded with verified SHA-256 `1bd9683d097c5518b2fdc0b0c8081abdfec1293a59daf6d2b41bcd45ce373e2c`; one screenshot was visually inspected. The chart header now wraps against its actual column width and reserves a 12rem title flex basis. The separate UI contract job found two test-only TypeScript assertions split before `as`; both were corrected. These fixes still require CI/browser verification.

The workspace-inspect process-spawning lock test now runs in its own CI invocation, after the rest of the library tests. No test is ignored, no global serialization or retry is added, and production lock code is unchanged. The retry regression also proves that its first error is the intended metadata read failure, not lock contention. Suspected concurrent process inheritance is not claimed as a proven runtime root cause; all 103 tests must pass in the rerun.


Independent merge review found three issues, all addressed and rechecked in source: an undefined V3 schema-deserializer attribute was removed while retaining explicit dispatch; scalar deduplication now includes session/run/request-epoch provenance and revision, with identical reruns republished under their own source; positive durable state dt is checked exactly while the legacy zero sentinel remains unspecified. Regressions cover same-run idempotence, new-run rebinding, legacy dt tampering and zero-dt compatibility. Source review and parser checks pass; compilation/tests/runtime remain pending.


Master integration is committed as `433e30948`, followed by the latest upstream verification updates in `286953713` (master `3bf5e0c86`). The normal first merge hook reported an internal React Doctor/oxlint AST decoding failure, so that scan is incomplete and is not counted as lint PASS. The second merge hook reported two lookup-performance warnings in the incoming browser QA harness; no rules or hooks were suppressed. Owned diff whitespace checks pass; the single staged trailing blank line in the upstream live-quantity audit was byte-identical to master and retained.

The required CI list now explicitly runs `accepted_study_worker::accepted_final_step_stats_tests` on the accepted-worker binary, covering the new receipt migration and real-CAS recovery regressions. Existing projection tests run separately. Full PR workflows were triggered by the push; green CI is still required before integration.


### 30 October: full CI evidence and published recovery authorization

Full bootstrap run [41057502235](https://github.com/MateuszZelent/fullmag/actions/runs/41057502235) on `b55376444e33a5750349add966c2a10f556d4065` passed generated-API determinism, Control Room contracts, Inspector actions, Windows storage/checkpoint checks, FDM relaxation qualification and Python live-client contracts. Rust passed startup/projection (including new-run scalar provenance), all **28 receipt regressions**, and read-only FDM/FEM playback/binary routes. It later failed the broad API suite with **1201 passed, 1 failed, 3 ignored**: the exact OpenAPI tag list omitted the intentionally added `workspace_results` group. That expectation is updated without relaxing the equality assertion.

The Python lifecycle gate found twelve frontend-refresh fixture subcases missing the retained backend environment. The fixture now supplies the real group-ledger profile and matching durable ledger record; production validation and lease-retention assertions remain unchanged. The initial cleanup diagnosis was incorrect: the pinned React Doctor diagnostic artifact identifies `Vector3.sub()` as a subscription. The actual camera registration already returned its disposer; making that return explicit did not clear the alarm. The camera direction now uses equivalent `Vector3.subVectors(camera.position, target)` (official Three.js Vector3 contract), without a fake cleanup or rule suppression. Artifact 12979512623 SHA-256: `1e7914cbcc2b25753a490a776c5aa5ec6c4a6a8d9890adfc8668bb0a07310c7d`. CI verification remains pending.

Browser execution passed the responsive chart assertions after the title fix, then reached a second closed Analysis results accordion in the reference-import fixture. That harness now opens the section idempotently and returns the complete empty current-results catalog DTO. IDs, assertions and request budgets are retained. The final complete browser run is still pending.

Recovery preparation command exited 0 and its durable operation receipt `ba1746e116c94044a54f057ab228a73f` is `succeeded`; its exact result is `prepared-awaiting-explicit-start`. The wrapper's single-document JSON parser failed on multiple stdout documents; the saved stream and durable result were checked without replaying publication. Managed recovery was then started for the owned group on its retained frontend port 3298, using the published operator reference. Application startup and current-source runtime/UI qualification remain pending.


### 30 October: complete Rust and browser gates

Bootstrap run [41061996491](https://github.com/MateuszZelent/fullmag/actions/runs/41061996491), source `bd4cf7715c1504bb40ef70f812c79f602ac59725`, passed the complete Rust contracts job, the full browser fixture and Inspector actions. The retained-profile lifecycle fixture also passed. The Python job subsequently found three SceneDocument script round-trip failures involving legacy base sampling. Contract review confirmed that adding raw `sampling` to Run would violate the Rust materializer; source repair and behavior coverage are in progress. The UI contract failure was README/About text drift after upstream `e5a1c01864`; the About copy is aligned without changing its equality test. The equivalent camera arithmetic fix still awaits pinned React Doctor CI. Managed recovery remains in progress; these CI passes do not qualify the current-source deployment or actual playback UI.


Managed recovery completed with exit 0 and a verified succeeded development receipt `b3f78da7d700482694724d74b19a30d3`, configuration `24818b7110d2a4c97220a3e13b9442d9c1a550561f43b8b8e13c0c23c2940315`. It built source `0e81b4b5056bcd66318190e348e7539df54c9e2d` (backend package cache miss) and serves port 3298. Retained item 11 playback and Results catalog return HTTP 200: six m frames, six H_eff samples and six table rows. The old m data has explicit 3D geometry; the old H_eff data correctly refuses 3D without its persisted geometry mapping. The session list is empty and current/status returns the explicit no-active-workspace 404. A fresh authorized FEM run is needed for current-producer geometry and completed-run/Return-to-Live UI evidence.

The sampling fix now rejects base TimeEvolution outputs that SceneDocument cannot represent, without changing direct Loaded.to_ir execution. Canonical Run nodes accept a five-field renderable subset of the Rust contract; `output_every_seconds` is rejected explicitly because this renderer cannot preserve it. Independent output actions remove only exactly redundant captured snapshots; unsupported per-run fields remain errors. Positive tests use StageAutosave with distinct table/field clocks, requested auto policy and a following Run with no inherited policy. Rejection, direct-IR preservation, grouped canonical authority and legacy flat compatibility are covered in source tests; execution is pending. Independent review findings were addressed: explicit handling of the unsupported output cadence, the base-output boundary even before a later clear, and action enable/replace/disable/table transitions plus an unrecorded-delta rejection.


### 30 October: preserve base Autosave and accepted execution semantics

Bootstrap [41073966648](https://github.com/MateuszZelent/fullmag/actions/runs/41073966648), source `2569f18af1b1caa7294ca455102e27d9f8e5c769`, passed the full Rust, Control Room, browser fixture, Inspector, generated API and Windows gates. Pinned React Doctor passed in [41073966435](https://github.com/MateuszZelent/fullmag/actions/runs/41073966435). Python live contracts exposed a regression in the blanket base-output rejection described above: the flat API supplies default m and E_total outputs even during ordinary authoring. The Python scene contract also exposed a fixture mixing its Relax table assertion with unsupported Run-local solver controls.

The replacement source change translates exactly representable base SaveField/SaveScalar policies into deterministic initial Autosave nodes, without changing native Loaded.to_ir or generic pipeline export. It checks DSL reconstruction against the original output IR, rejects duplicates and unsupported kinds, avoids nested ID collisions, and leaves existing authored canonical nodes intact. Run snapshot normalization retains its original generated-flat-only boundary. The table fixture now isolates Relax, with a separate assertion that canonical Run-local solver overrides remain rejected.

Cross-layer review found that accepted compilation previously treated Autosave as an unsupported execution. The accepted adapter now removes only Autosave/TableAutosave execution bindings after the existing materializer has applied their policies to subsequent Run IR. The authored tree, hash, nodes, Run IDs and physical State chain remain. Source validation prohibits configuration nodes from claiming execution IDs. Regression coverage includes field/scalar/table replacement and clearing, disabled groups, malformed and unrelated unsupported actions, and a real Python capture → Scene → execution config → accepted catalog → plan test. These new changes have source/AST/diff review only; their CI and runtime qualification are pending.

The managed iteration `dacf3db158f542fa861c58ee6a7a4c4f` successfully updated port 3298 to source 2569 (backend package cache miss). The convenience recipe then rejected its `run-script` line before dispatch; no test simulation was submitted. The next qualification uses the existing receipt-validated `docker-dev-script` route after the source update. Fresh completed FEM playback, H_eff geometry, snapshot scrubbing and Return to Live are still NOT VERIFIED in the deployed browser.


### 30 October: fresh FEM publication exposed immutable-geometry mutation

Managed source update `ae05fb226c494fc6b6ee792e99995e29` and activation `f6c755b837eb4ea0911aace95af8819d` succeeded on clean source `a3e341c64fb2a455db6e389035210d110ef904c3`. Run `run-live-8b8de26deb5970dc4fd272ad9f310153484b2ac4e932eeeba865ba7da42d9de9` completed 101 steps at 100 ps. Its current Results collection has 39 entries, six m/H_eff frames and six table rows. The scalar endpoint independently reports terminal step 101, time 1e-10 and matching observation provenance. This qualifies the terminal projection through the actual native FEM runtime; the deployed UI is still pending.

Both fields refused 3D because the mesh object referenced as `cfaed88556b51047ea1a8c80539e8bcf95123f64ae43b989f4bef93fdeafa874` was declared as 113716 bytes but published as 309145 bytes with hash `47510b7fed77faee82c280d123702101f6b67f90290ea1cb8eb9938d4bd03018`. The provenance finalizer recursively selected hash-named geometry JSON, added execution resolution and pretty-printed it. The project-storage copy preserves bytes and is not the cause. The source fix treats the reserved `.fullmag_geometry` subtree as immutable while finalizing adjacent field/root metadata. The producer regression now crosses real provenance finalization and checks mesh and both field-semantics bytes, lengths, hashes and parser validity; it is explicitly included in the bootstrap CI command. Existing published results are preserved, and reader integrity checks remain strict.

The complete Rust job at a3e341 passed, including the new accepted Autosave and Python-source capture integration tests. Python live passed. Ordered roundtrips found a separate renderer defect: a payload `enabled=False` on Autosave/TableAutosave was mistaken for a disabled pipeline node. Source repair retains policy-clear actions while respecting outer disabled nodes, with both cases asserted. The migrated discretization fixture now uses the actual StudyBuilder exchange/b_ext API. These follow-up changes require new CI. Browser proof is also being migrated to opaque collection IDs and exact owned leaf paths, with explicit H_eff checks; the old saved/current ID equality is invalid for the collection API.


### 2026-10-30 — świeży FEM i rzeczywiste przewijanie m/H_eff

Wersja `20cf98cba` opublikowała poprawną geometrię: nowy run zakończył 101 kroków przy 100 ps, po sześć snapshotów m i H_eff. Oba pola mają poprawne powiązania 3D (459 węzłów, 1688 komórek), a terminalny wiersz skalarny odpowiada dokładnemu runowi. Pełny Rust CI przeszedł, łącznie z regresją finalizacji niezmiennych obiektów FEM. [Dokładne identyfikatory i dowody](2026-10-30-results-fem-runtime-checkpoint.json).

Zarządzany browser potwierdził saved/current przewijanie próbek 0/2/5, zgodność payloadów, osobne ustawienia, obsługę opóźnienia/błędu, H_eff w A/m, powrót do live, zachowanie draftów Object/Airbox i układ przy szerokościach 768–1920 px. Kadr był wyśrodkowany i mieścił obiekt. Pełny przebieg pozostał czerwony: Ctrl+Shift+P po użyciu suwaka było blokowane przez ogólną ochronę pól edycyjnych. Przygotowano wąski wyjątek tylko dla globalnej palety; inne komendy i defaultPrevented nadal są chronione. Wcześniejszą utratę logu po timeout uzgodniono dokładnym reconciliatorem, bez powtarzania solvera.

Python przeszedł nowe roundtripy, ale stara asercja API oczekiwała dwóch węzłów; kanoniczny eksport poprawnie zawiera Autosave/Relax/Run. Migracja sprawdza dokładną kolejność oraz niezmienione IR zapisu, zachowując asercje dwóch etapów wykonawczych. Pełne strony tabel oraz typed zapisane analizy pozostają osobnymi brakami funkcjonalnymi, nie są dowiedzione samą widocznością plików.


### 2026-10-30 — odrzucony preflight odświeżenia frontendu

Próba `929f2721bb85469d910a8237c97f00e3` została odrzucona przez warunek `Frontend refresh requires an empty healthy API`, zanim powstał Compose lub zatrzymano usługę. `development/current.json` wskazuje jednak tę nieudaną próbę, podczas gdy `development/verified.json` nadal wskazuje poprawne `b3f78da7d700482694724d74b19a30d3`. Odczyt potwierdził zgodność bajtów current/receipt/terminal, brak Compose tej próby oraz brak aktywnego lease. Standardowe wznowienie nie może odczytać nieistniejącego Compose. Kontenery i zakończony run pozostają zachowane; poprawka palety z `78b35614e` nie została jeszcze wdrożona.

Naprawa ma przenieść zwykłą kontrolę preflight przed otwarcie operacji i powtórzyć ją pod blokadą. Odzyskanie istniejącego stanu wymaga jawnego dowodu powiązanego z surowymi hashami nieudanej próby oraz zweryfikowanego rodzica, sprawdzanego ponownie pod lease przed zatrzymaniem usług. Nie wolno ręcznie przestawiać wskaźników ani usuwać wyników. Testy tej ścieżki i istniejących zabezpieczeń frontendu są jawnie dodane do Python CI; helper offline wymaga zatrzymanego backendu, więc nie służy do testowania naprawy przed jej pierwszym użyciem na obecnie działającej grupie.

Na `78b35614e` Python, Python live, Control Room, browser fixture, Inspector oraz etap Rust odtwarzania FDM/FEM przeszły. Pełny Rust CI nadal trwał przy tym odczycie. To nie zastępuje końcowego dowodu z przeglądarki na wdrożonej wersji.

Dalszy odczyt CI: bootstrap `41093195981` zakończył się sukcesem w całości. Osobny workflow `dispersion-artifact-consumers` (`41093196044`) ma czerwony job Windows `124192110009`: 81 testów przeszło, 13 testów czytnika wyników zgłosiło `SourceChanged` podczas budowy katalogu. Odpowiedni job Linux przeszedł. Przyczyna Windows pozostaje w diagnozie; wyników tych nie wolno pomijać przy decyzji o scaleniu.
