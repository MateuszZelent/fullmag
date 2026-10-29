# Przeglądarka folderu wynikowego

Explorer → Results zawiera katalog plików faktycznie zapisanych w folderze wynikowym, w tym grupy i tablice Zarr, autosave, tabele oraz pozostałe artefakty. Istniejące widoki semantyczne modów i eigensolve pozostają dostępne. Nieznany format pozostaje widoczny w katalogu; sama obecność pliku nie oznacza możliwości pokazania go w 3D.

Po wybraniu tablicy Inspector pokazuje najpierw dostępne próbki i ustawienia Visualization. Metadane oraz surowe wartości znajdują się w zwijanych sekcjach. Suwak oraz przyciski First/Previous/Next/Last wybierają próbkę. Czas fizyczny jest prezentowany w ns, kroki zaakceptowane zachowują dokładną wartość całkowitą; bez zapisanej współrzędnej pokazywany jest indeks próbki. Tabele zachowują nazwy zapisanych kolumn. Surowa próbka jest pobierana dopiero po rozwinięciu **Decoded values** albo załadowaniu pola do 3D. Ponowny wybór tej samej serii przywraca ostatnio wybraną próbkę w tej samej rewizji.

Akcja **Load into 3D** przełącza wspólny viewport na zapisane pole. Ustawienia Visualization należą do konkretnego snapshotu: źródło, run, etap, tablica, quantity, indeks i rewizja. **Return to live** przywraca bieżące źródło, zachowując ustawienia snapshotów. Przełączanie źródeł nie uruchamia Solve ani nie wznawia symulacji. Podczas odczytu następnej próbki z tej samej serii i rewizji pozostaje ostatnia poprawna klatka wraz z jej legendą. Nagłówek rozróżnia **Displayed** (rzeczywiście wyświetlana próbka) i **Requested** (próbka oczekująca na odczyt). Zmiana źródła, runu, serii lub rewizji nie przenosi poprzedniej klatki.

Folder zarejestrowany w workspace można otworzyć z Home albo **Results → Saved → Workspace result folders → Open folder**, niezależnie od aktywnej sesji i projektu. Lista obejmuje do 500 zarejestrowanych folderów; brakujące lub nieczytelne źródła mają jawny powód niedostępności. Folder bez starszego opisu playback otwiera przeglądarkę outputu; pole pojawi się w 3D po jawnym załadowaniu tablicy mającej potwierdzone powiązanie z geometrią.

Panele Saved folder i Inspector obsługują ukrywanie, przywracanie oraz odpinanie zgodnie z układem workspace. Jeżeli istnieje bieżąca sesja, jej stopka pozostaje dostępna i jest oznaczona **Live session diagnostics**: te wartości dotyczą sesji, a nie wybranego historycznego snapshotu. Przy braku sesji stopka nie jest pokazywana. W małym oknie dalsze ustawienia Visualization są dostępne przez pionowe przewijanie Inspectora.

## Kontrakt odczytu

Dwie rodziny zasobów korzystają ze wspólnego czytnika:

- `/v2/workspace/items/{id}/results` — zarejestrowany folder wynikowy;
- `/v2/sessions/current/data/results` — folder bieżącego runu.

Każda rodzina udostępnia katalog, `arrays/{array_id}`, `arrays/{array_id}/samples/{sample_index}` i `entries/{entry_id}`. Identyfikatory są nieprzezroczyste; klient nie przekazuje ścieżki systemowej. Katalog jest stronicowany, a kursory i dalsze odczyty są przypięte do rewizji. Odświeżenie katalogu zachowuje filtr i rozwinięte gałęzie. Dla dokładnie tej samej tożsamości źródła/runu/sesji stan ten jest wspólny dla Explorera i Results Navigator. Starszy folder bez pełnej tożsamości ma działający stan lokalny, który nie przenosi się na inny run. Folder outputu jest pokazywany przed zwijaną sekcją analiz; filtry i akcje tej sekcji dotyczą tylko analiz. Jeśli wybrany wynik pochodzi ze starszej rewizji, Inspector pozostaje przy niej, a przeglądarka pokazuje akcję **Update selected output**. Nowy run nie jest automatycznie dopasowywany po ścieżce. Zmiana źródła wymaga odświeżenia katalogu. JSON przenosi metadane i ograniczone podglądy tekstowe, próbki pól korzystają z binarnego f64 little-endian.

Monitorowanie widocznego panelu odświeża metadane co 5 s; ukryta strona zatrzymuje ten polling. Przewijanie pobiera wyłącznie wybraną próbkę. Niepełny zapis, nieobsługiwany układ lub brak mapy geometrii ma jawny stan; nie powoduje przełączenia na dane live.

FDM wymaga zapisanych wymiarów, rozmiaru komórki i początku siatki związanych z tablicą. FEM wymaga kanonicznej topologii i wsparcia pola oraz zgodnego opisu mapy węzłów. Zgodność liczby węzłów sama nie stanowi takiego dowodu.

Stan kwalifikacji runtime i wyniki testów należy odczytywać z checkpointu bieżącego zadania; ten dokument opisuje kontrakt funkcji.

Czytnik folderu nie wymaga statusu `completed`; pojedyncza próbka musi jednak być w całości opublikowana i zgodna z metadanymi. W obecnej ścieżce zarządzanego Docker accepted run folder bieżącej sesji jest udostępniany po zakończeniu publikacji outputu; wcześniej API zwraca `current_results_not_published`. Monitoring kolejnych autosave w trakcie takiego runu nie jest jeszcze zakwalifikowany. Dla bieżącej sesji wymagane jest trwałe powiązanie katalogu z runem oraz sprawdzenie inkarnacji sesji przed i po odczycie. Starszy folder workspace może nie mieć provenance runu; jego odczyty pozostają przypięte do rewizji folderu i nie uzyskują przez to tożsamości bieżącego runu.

Chunki binarne Zarr są składnikami logicznej tablicy. Ich przeglądanie odbywa się przez próbki w Inspectorze; nie wymagamy osobnego wiersza drzewa dla każdego fragmentu binarnego. Dzięki temu długa seria czasowa nie zasłania kolejnych quantity i tabel.

Po zakończeniu nowego accepted runu backend publikuje końcowe rzeczywiste statystyki wraz z tożsamością obserwacji. Powrót do Live pokazuje te wartości; nie przepisuje czasu ze statusu do starszego wiersza energii/magnetyzacji. Starsze wyniki bez takiej obserwacji nie otrzymują statystyk wyliczonych zastępczo.


## Kontekst modelu i wyjście

Jeśli podczas podglądu snapshotu wybierzesz obiekt lub Airbox w Model Builderze, Inspector dotyczy bieżącego workspace. Informacja nad formularzem oddziela ten kontekst od historycznej klatki. **Return to live** zachowuje wybór modelu i jego niezapisany draft. Zmiana wyboru na wynik wymaga jawnego Apply/Discard; Cancel zachowuje formularz. Otwarcie całego Saved folder jest blokowane przy niezapisanych zmianach.

Przy braku potwierdzonej aktywnej sesji akcja wyjścia nazywa się **Close results** i zamyka odczyt wyników, wracając do Home lub otwartego projektu. Nie uruchamia symulacji. Etykieta **Return to live** pojawia się przy istniejącym kontekście sesji.

Drzewo porządkuje rodzeństwo: katalogi/grupy Zarr, tablice, następnie zwykłe pliki; wewnątrz kategorii zachowuje porządek alfanumeryczny. Pełny Run i Revision są dostępne w rozwijanym **Source details**. Żaden wpis nie jest usuwany ani ukrywany z katalogu przez tę zmianę kolejności.
