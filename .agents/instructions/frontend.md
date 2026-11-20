# Frontend i API Fullmag

Wiążące rozwinięcie [AGENTS.md](../../AGENTS.md) dla `apps/control-room`, API v2 i wszystkiego, co użytkownik widzi w Control Room. Czytaj sekcje dotyczące zadania. Ścieżki w backtickach są względem repozytorium. Zasady procesu, uprawnień i worktree określa główny AGENTS.md.

Wersja z 20.11.2026 zastępuje wcześniejsze reguły wizualne. Dawne zakazy glassmorphizmu, animacji przezroczystości i rozmycia nie obowiązują; obowiązują reguły z sekcji 3–7.

## 1. Cel i punkt odniesienia

Control Room ma wyglądać i działać jak najlepsze profesjonalne narzędzia projektowe i naukowe: nowocześnie, spójnie, czytelnie i z charakterem. Estetyka jest wymaganiem, nie dodatkiem. Każdy ekran, panel i okno używa tego samego języka wizualnego.

- Referencją wyglądu i zachowania jest makieta w `docs/design/inspector-redesign/` (React + shadcn/ui, uruchamiana przez `npm ci && npm run dev` w tym katalogu). Opis zasad: `docs/design/inspector-redesign/README.md`.
- Kontrakty szczegółowe: `docs/specs/frontend-v2/09-css-design-system.md` (tokeny, szkło, cienie, ruch), `10-shell-menu-and-navigation.md` (powłoka), `11-explorer-view.md` (panele lewej listwy), `13-inspector-and-property-editing.md` (szablon Inspectora).
- Jeżeli makieta i specyfikacja się różnią, najpierw zaktualizuj specyfikację, potem kod. Makieta pokazuje kierunek; wartości przykładowe w niej nie są danymi fizycznymi.

## 2. Architektura (bez zmian merytorycznych)

- Kanoniczny kontrakt przeglądarki to API v2 sesji i zasobów (`docs/specs/resource-first-control-room-api-v2.md`, `docs/adr/0011-resource-first-api.md`): trasy `/v2/platform/...` i `/v2/sessions/current/...`, rodziny `platform`, `sessions`, `model`, `meshing`, `simulation`, `data`, `visualization`, `workspace`, `analysis`, `persistence`, `diagnostics`. `GET /v2/sessions/current/status` pozostaje cienki i rewizyjny; ciężkie pola i topologia idą binarnym data plane ze scope dla obiektu, części siatki, airboxa i zaznaczenia.
- Jeden typowany klient API, jedna warstwa resource hooks, jedno słownictwo capability, jedna warstwa adapterów domeny, jedno drzewo UI, jedna powłoka workspace. Komponenty nie wywołują `fetch()` ani nie składają ścieżek endpointów; zmiana JSON aktualizuje OpenAPI i typy (`just docker-dev-codegen`).
- Moduły v2 mają manifest i komunikują się przez kernel, event bus, rejestr poleceń, resource hooks albo wspólne prymitywy (`docs/adr/0013-frontend-v2-module-kernel.md`, `docs/specs/frontend-v2/README.md`). Menu, ribbon, toolbary, skróty, menu kontekstowe i paleta poleceń renderują jeden rejestr poleceń.
- Jeden workspace z kontekstami (`Workspace`, `View`, `Definitions`, `Geometry`, `Materials`, `Physics`, `Mesh`, `Study`, `Results`, `Automation`). Kontekst zmienia grupy ribbonu, domyślne panele, presety viewportu i dostępność poleceń; nie przełącza osobnej aplikacji. Brak osobnych drzew FDM/FEM i brak etapów `Build`/`Study`/`Analyze` jako źródła prawdy.
- Kod legacy (dawne `legacy_web`) jest tylko referencją zachowania; kod v2 go nie importuje ani nie kopiuje hurtowo.
- Dotykając `apps/control-room`, załaduj właściwy skill `.agents/skills/frontend-v2-*`.

## 3. Język wizualny

Materiał: **szkło nad żywym viewportem**. Viewport wypełnia okno aplikacji; drzewo, Inspector, dok, paski i okna są matowymi, zaokrąglonymi warstwami nad nim. Głębię budują przezroczystość, rozmycie tła, cień i delikatna jasna krawędź u góry warstwy.

- **Tokeny.** Wszystkie decyzje wizualne to tokeny `--fm-*` w `src/design/styles/*`. Surowe wartości kolorów (Catppuccin Mocha dla ciemnego, Latte dla jasnego) występują tylko w plikach tokenów i motywu. Komponenty i CSS modułów używają tokenów albo utility Tailwinda zbudowanych na tokenach.
- **Powierzchnie.** Rodziny tokenów: tło aplikacji i viewportu (z miękkimi poświatami), szkło (`glass`, `glass-strong`, krawędź, jasny refleks), pole wklęsłe (`field`), powierzchnia uniesiona (`raised`), stany semantyczne (ok, warn, error, info, live, stale, degraded, unsupported).
- **Zasada zaznaczenia.** Pola i niewybrane opcje są lekko wklęsłe i nie świecą bielą; wybrana opcja jest uniesiona (`raised` + cień sm + obrys w kolorze domeny). Dotyczy przełączników, kafelków, kart, nakładek, listew ikon i drzewa.
- **Kolory domen.** Geometria, materiał, fizyka, badanie, wizualizacja, siatka i definicje mają własny odcień (token `--fm-hue-*`). Odcień oznacza domenę w ikonie tożsamości, aktywnej sekcji, kafelkach wyboru i ribbonie. Kolor semantyczny stanu jest oddzielony od koloru domeny.
- **Cienie.** Skala elewacji `sm` (pola, pigułki, wybrane opcje), `md` (panele, popovery, menu), `lg` (dialogi, arkusze, paleta poleceń). Wartości odpowiadają skillowi `beautiful-shadows`; na jednym elemencie jedna siła cienia na stan.
- **Promienie.** Skala tokenów od pola (ok. 10 px) przez sekcję (ok. 16 px) i panel (ok. 22 px) do okna (ok. 28 px) oraz pigułki (pełne zaokrąglenie). Bez kwadratowych paneli i jednego promienia dla wszystkiego.
- **Typografia.** Inter dla UI (z cyframi tabelarycznymi dla liczb), JetBrains Mono wyłącznie dla identyfikatorów, ścieżek i kodu, kursywa szeryfowa (STIX Two Text lub zgodna) dla symboli fizycznych (Mₛ, A_ex, α, ξ_DL, B₀). Etykiety w sentence case, bez wersalików w etykietach pól.
- **Gęstość.** Zwarta, ale czytelna: kontrolki 28–32 px, wiersze właściwości w układzie etykieta | kontrolka od ok. 22 rem szerokości panelu, pionowo poniżej (container queries). Jednostka siedzi w polu jako menu jednostek z przeliczaniem.
- **Oba motywy są pierwszorzędne.** Każda zmiana jest sprawdzana w jasnym i ciemnym motywie. Kontrast tekstu co najmniej 4.5:1, elementów interfejsu 3:1. `prefers-reduced-transparency` przełącza szkło na nieprzezroczyste powierzchnie.

## 4. Powłoka aplikacji

Od góry: pasek instancji (Home i karty sesji) → pasek aplikacji (logo, menu główne File/Edit/View/Simulation/Tools/Help, szybkie akcje, wyszukiwarka Ctrl+K, stan API, sterowanie obliczeniami, motyw, licznik problemów) → ribbon (zakładki kontekstów z grupami poleceń; zwijany) → obszar roboczy → pasek statusu.

- **Obszar roboczy:** lewa i prawa listwa ikon w stylu Photoshopa na pełną wysokość; między nimi panele i viewport, a pod nimi dok na pełną szerokość między listwami.
- **Lewa listwa** przełącza panele budowy modelu (Model, Results, Live charts, Library i kolejne zakładki Explorera). **Prawa listwa** przełącza karty Inspectora (Inspector zaznaczenia, 3D View, History, Python i kolejne). Kliknięcie aktywnej ikony zwija panel, a viewport zajmuje zwolnione miejsce. Szerokość prawego panelu jest regulowana uchwytem.
- **Pasek narzędzi viewportu** pływa u góry viewportu, wycentrowany; przy wąskim viewportcie chowa mniej ważne grupy (container queries).
- **Dok** (Telemetry, Problems, Logs, Operations, Engine, Quick chart) jest zwijany i ma pełną szerokość.
- **Mały ekran:** panele stają się arkuszami, ribbon przewija się poziomo, menu przechodzi pod przycisk menu, viewport pozostaje głównym obszarem. Żadna pozycja menu nie znika tylko przez breakpoint.

## 5. Inspector: jeden szablon

Każdy węzeł Explorera ma własny widok Inspectora, ale wszystkie widoki renderuje ten sam szablon ze specyfikacji panelu. Panel nie rysuje własnego nagłówka, kafelków stanu ani grup.

Osiem miejsc w stałej kolejności:

1. Ścieżka (breadcrumb) i akcje węzła (szukaj pola, dopasuj widok, menu).
2. Tożsamość: ikona w kolorze domeny, nazwa (edytowalna, gdy węzeł na to pozwala), rodzaj, ID do skopiowania, jedna pigułka stanu.
3. Fakty: najwyżej cztery kluczowe wartości. Wartości nieznane są pomijane, nigdy nie wyświetla się „unknown”. Fakty chowają się przy przewijaniu.
4. Karty, tylko gdy węzeł ma tryby.
5. Komunikaty: ton, tytuł, opis i szybka naprawa albo skok do pola. Błąd walidacji jest też przypięty do pola.
6. Sekcje: jedna zwijana sekcja dla wszystkich paneli, z podsumowaniem wartości po zwinięciu i znacznikiem zmiany lub błędu.
7. Wiersz właściwości: etykieta, symbol fizyczny z kartą definicji (nazwa, definicja, jednostka SI, typowy zakres), pole z jednostką, cofnięcie pola, komunikat. Wartości liczbowe można regulować przeciąganiem symbolu.
8. Pasek zmian: tryby `staged` (Revert/Apply z licznikiem, Ctrl+Enter, potwierdzenie dla operacji kosztownych jak przebudowa siatki), `liveViewport` (zmiany od razu, Reset display), `immediate` (nazwane operacje panelu), brak sesji (bez przycisków mutacji). Przyciski pojawiają się dopiero, gdy jest co zatwierdzić.

Wykresy, tabele i podglądy wchodzą jako wiersz `custom` w zwykłej sekcji. Surowy JSON tylko w jawnie opisanej sekcji zaawansowanej albo w oknie podglądu.

## 6. Ruch i animacje

Animacje są pożądane, gdy pokazują zmianę stanu, prowadzą wzrok albo nadają interfejsowi płynność. Dozwolone są m.in.: przejścia kolorów, cieni i transformacji; animowane rozwijanie sekcji do naturalnej wysokości (`interpolate-size`, `::details-content`, animacje Radix); wejście nowej treści przy zmianie zaznaczenia lub karty (przesunięcie i zanikanie); View Transitions przy zmianie celu Inspectora; przesuwany wskaźnik przełączników i kart; animacje overlayów; skeletony ładowania; puls stanu „live”; licznik i wskaźniki tykające na żywo.

Granice:

- Animacja odpowiada na akcję użytkownika albo na nowy cel. Odświeżenie danych, unieważnienie zasobu i ACK tego samego celu nie odtwarzają animacji wejścia, nie remontują panelu i nie zmieniają przezroczystości trwałych kontrolek.
- Czas: mikrointerakcje 100–200 ms, przejścia paneli i treści do ok. 320 ms; krzywe z tokenów ruchu. Bez animacji wymiarów siatki workspace, które wymuszają ciągły reflow, i bez pętli zmieniających rozmiar canvasu.
- Animacje ciągłe tylko dla wskaźników stanu (live, running, postęp); żadnych dekoracyjnych pętli obok danych liczbowych.
- `prefers-reduced-motion` wyłącza przesunięcia i zanikania; zmiana stanu jest natychmiastowa.

## 7. Szkło, rozmycie i wydajność

- `backdrop-filter` (rozmycie i nasycenie z tokenów) stosuj na stałych warstwach: paski, listwy, panele, dok, overlaye, dialogi, menu. Nie na pojedynczych wierszach list, nie na elementach animowanych w pętli i nie na treści przewijanej wewnątrz panelu.
- Warstwa nad viewportem nie może wymuszać ponownego layoutu ani zmiany rozmiaru canvasu. Zmiany paneli przekazują viewportowi wstawki (insets), a nie zmieniają jego DOM.
- Każda zmiana szkła lub cieni przy viewportcie wymaga pomiaru w przeglądarce: stabilny FPS w spoczynku, brak idle redraw, kontekst WebGL żywy.

## 8. Komponenty i prymitywy

- Interaktywne prymitywy pochodzą z warstwy shadcn/ui w `src/shared/ui` (Radix): menu, menubar, ribbon, zakładki, przełączniki segmentowe, toggle group, dropdown, context menu, dialog, alert dialog, sheet, popover, hover card, tooltip, command palette, select, slider, switch, toast. Dostępność zapewnia prymityw; wygląd nadają tokeny i warianty CVA.
- Własny widget jest dopuszczalny, gdy żaden prymityw nie pasuje; budujemy go na prymitywie Radix i dokumentujemy w manifeście modułu lub specyfikacji.
- Klasy CSS w `apps/control-room` mają prefiks `fm-`; utility Tailwinda są dozwolone. `app/globals.css` zawiera tylko importy; style współdzielone są w `src/design/styles/*`.
- Ikony z lucide, przekazywane jako komponenty; ikony w przyciskach z `data-icon`; każdy przycisk z samą ikoną ma etykietę dostępności i tooltip.
- Fokus jest zawsze widoczny; menu, ribbon, drzewo, Inspector, dok i dialogi są osiągalne z klawiatury.

## 9. Wykresy i telemetria

- Wykres i telemetria to instrumenty naukowe: fizycznie sensowne osie, widoczne jednostki SI, legendy, sformatowane tooltipy, stany nieobsługiwane i zdegradowane.
- Pokazuj tylko porównania, które mają fizyczny sens. Bez pasków udziału między wielkościami bez wspólnego odniesienia (np. składniki energii o różnych znakach i dowolnym zerze). Zamiast tego: wartości, ich przebieg w czasie, osie z jednostkami.
- Bez mieszania jednostek na jednej osi y bez selektora, rozdzielonych paneli lub opisanej podwójnej osi.
- Duże dane są ograniczane, decymowane lub stronicowane przed renderowaniem; bez rozkładania dużych tablic w `Math.min`/`Math.max` i bez dużych tablic typowanych w stanie React.
- ECharts i podobne: jedna instancja na zamontowany wykres, aktualizacja z rewizji zasobu lub interakcji, resize przez observer, dispose przy odmontowaniu, bez pollingu i idle redraw.
- Nowy wykres naukowy ma testy modelu i co najmniej jeden test renderowania lub smoke w przeglądarce, gdy zmienia interakcję, cykl canvasu albo tooltip.

## 10. Stabilność Inspectora i stanu

- Stan pending jest śledzony na poziomie pola lub transakcji, nie jako jedna flaga celu. Nie wygaszaj i nie wyłączaj niezwiązanych kontrolek.
- Dla tego samego celu zachowuj ostatni poprawny panel. Odświeżenie danych nie remontuje Inspectora i nie resetuje przewijania, fokusu ani szkiców. Subskrypcje są per cel, z jednym właścicielem subskrypcji zasobu w drzewie panelu.
- Szkice Inspectora to jawne transakcje; zasoby serwera zostają w resource hooks. Pochodne dane liczymy selektorami, nie kopiujemy przez `useEffect`.
- Komponenty klienckie czytające magazyny zewnętrzne, localStorage lub cache API mają pierwszy render zgodny z SSR (`useSyncExternalStore` ze snapshotem serwera albo jawna bramka hydracji).
- Każda zmiana mutacji Inspectora ma regresję w przeglądarce dla Object i Airbox (tam, gdzie dotyczy): stabilna tożsamość korzenia, brak niezwiązanych zmian disabled/przezroczystości, brak animacji wejścia przy odświeżeniu, ograniczona liczba renderów i żądań, zachowany fokus i przewijanie przez pending i ACK.
- Encje sceny mają niezmienne `object_id`, nazwę `name`, prezentacyjny `type` i jawnie zadane moduły fizyki. Nazwa ani typ nie aktywują fizyki.

## 11. Viewport i WebGL

- Każda zmiana viewportu R3F/WebGL ma smoke w przeglądarce: canvas widoczny, kontekst WebGL nieutracony, niezerowy drawing buffer po załadowaniu. Sam TypeScript i testy nie wystarczą.
- `THREE.WebGLRenderer: Context Lost` przy starcie traktuj jako błąd cyklu życia, dopóki `gl.isContextLost()` i wymiary bufora nie pokażą, że to tylko teardown.
- StrictMode w dev pozostaje wyłączony, dopóki stos R3F/Three gubi kontekst przy remountach; włączenie wymaga smoke ze stabilnym canvasem.
- Geometria jest autorowana w tym samym viewporcie 3D dla FDM i FEM; tryb Geometry to preset widoku.
- Wireframe Airboxa nie jest tym samym kontraktem co wireframe siatki magnetycznej: pełny zasięg airboxa zawsze ma wewnętrzną nakładkę granic z semantyką ukrytych krawędzi; zasięg powierzchniowy może renderować tylko krawędzie powierzchni; przezroczystość powierzchni nie tłumi przezroczystości wireframe.
- Kwalifikacja wektorów FDM Airbox zapisuje osobne klatki `wireframe on → wireframe off → vectors on`. Odrzuć klatkę z wireframe włączonym, zerem glifów, glifami subpikselowymi albo tak gęstymi, że zakrywają trajektorię. Domyślna długość glifu wynika z granic celu, liczby glifów i zakresu geometrii; ruch kamery jej nie zmienia.
- Poprawki wydajności zachowują bieżącą jakość wizualizacji. Niższa jakość, mniej glifów, ukryte warstwy i uproszczona topologia to jawne tryby awaryjne, gdy optymalizacja bez straty jakości zawiedzie.

## 12. Dane pól

- Już obliczone wielkości są danymi, nie poleceniami podglądu: runtime publikuje pola, API wystawia cienki status, katalog pól i bufory; przełączanie dostępnej wielkości jest lokalne i natychmiastowe, bez kolejkowania pracy podglądu.
- Rewizja geometrii i topologii jest oddzielona od rewizji pola; statystyki dla legend i skal są w miarę możliwości liczone wcześniej.
- Błędy dostępności wielkości naprawiaj w kanonicznym katalogu wielkości, fasadzie field store/API i ścieżce materializacji `compute_fields`, nie łatkami dla jednego ID pola.

## 13. Build i artefakty frontendu

- Build, cache i storage przeglądarki podlegają ADR 0030 oraz ADR 0076. W Docker DEV `node_modules` i cache frontendu są w `private/frontend` stabilnego `BuildControl.volume`; store pnpm jest współdzielony per projekt. Frontend nie dostaje rootu control ani danych backendu.
- Poza Docker DEV duże wyjścia (pnpm store, cache npm/Playwright/Vite/TypeScript, duże wyniki testów) trafiają do zaakceptowanego `storage/cache`, `storage/builds/<worktree-id>/<profile-id>` albo `storage/runs/<task-id>/<run-id>`; bez zapisu do checkoutu, rootu dysku, profilu użytkownika ani niekwalifikowanego `TEMP`. Odmowa ścieżki kończy polecenie przed instalacją.
- Launcher Control Room zatrzymuje tylko proces frontendu, który sam uruchomił; ponowne użycie serwera dev nie oznacza własności portu.
- `apps/control-room` pozostaje na Next.js 16, dopóki użytkownik nie zatwierdzi zmiany wersji.
- Makieta w `docs/design/inspector-redesign/` ma własne zależności npm i nie jest częścią workspace pnpm ani buildu aplikacji.

## 14. Bramka jakości

Zmiana w `apps/control-room` jest gotowa dopiero wtedy, gdy:

- przechodzi typecheck, lint (`--max-warnings=0`) i dotknięte testy;
- nie zostawia martwych importów, nieużywanych zmiennych ani zakomentowanego kodu;
- zgadza się ze specyfikacją (a jeśli specyfikacja była błędna, została najpierw poprawiona);
- została obejrzana w przeglądarce w jasnym i ciemnym motywie oraz przy wąskim panelu, z porównaniem do makiety dla zmienionych elementów;
- ma wymagane dowody z sekcji 10 i 11, gdy dotyka mutacji Inspectora lub viewportu.

Rozmiar pliku jest sygnałem do review, nie automatycznym nakazem podziału; dziel, gdy zmniejsza to mieszanie odpowiedzialności, ryzyko cyklu życia lub koszt zrozumienia.
