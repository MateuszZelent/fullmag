# Frontend — audyt i poprawki produkcyjne

Cel: poprawić rzeczywiste błędy i niedopracowane zachowania Control Room,
w szczególności Model Explorer, inspektory i współdzielone kontrolki.
Zakres obejmuje funkcjonalność, wiarygodność danych, dostępność i design.
Ukończenie pojedynczego etapu nie oznacza ukończenia całego celu.

## Tożsamość i ograniczenia

- Worktree: `C:/git/fullmag/worktrees/frontend-production-audit-20261022`.
- Branch: `codex/frontend-production-audit-20261022`.
- Baza: `f3730d1f60ab101b3cb009d797bfa77510396987`.
- Owner: `codex:01a16505-c1b4-71e3-ad3b-f0ece8b7d9bf`.
- Rejestr: `frontend-production-audit-202610-1ea874b4f7f2ed95.json`.
- Grupa: `fullmag-worktree-frontend-production-audit-202610-1ea874b4f7f2ed95`.
- Cudze zmiany i pozostałe grupy Docker pozostają pod swoimi właścicielami.
- Jeden workspace, klient API i warstwa resource hooks; zachowany system
  Catppuccin Mocha/Latte, tokeny `--fm-*` i współdzielone prymitywy.
- Zakaz lokalnego kompilowania testów jednostkowych pozostaje w mocy. Weryfikacja
  używa kontroli źródeł, lint, TypeScript bez testów oraz regresji przeglądarkowych.
  Automatyczne CI PR wykonuje własne obowiązkowe bramki; jego wyniki są poniżej.
- Buildy i dane techniczne wyłącznie w wolumenach wskazanej grupy Compose.

## Kierunek

Najpierw usuwamy potwierdzone przyczyny awarii, utraty edycji i nieprawdziwej
prezentacji danych. Następnie porządkujemy nawigację, walidację, komunikaty,
układ i dostępność na podstawie działających ekranów. Nie zastępujemy danych
serwera założonymi wartościami. Domyślne parametry autora i tokeny wizualne
nie są same w sobie błędem; oceniany jest ich kontrakt i widoczna semantyka.

## Etapy i dowody odbioru

- [ ] **Model Explorer:** filtr, rozwijanie drzewa, roving focus, wybór,
  zmiany sesji, widoczność, akcje kontekstowe, dane i stany błędów.
  Dowód: aktualne źródła i regresja przeglądarkowa myszy/klawiatury.
- [ ] **Wspólne kontrolki inspektorów:** parsowanie, jednostki, min/max,
  puste i niefinitywne liczby, etykiety, walidacja i błędy zapisu.
  Dowód: przypadki graniczne przeciw produkcyjnym kontrolkom.
- [ ] **Inspektory obiektów i Airbox:** tożsamość, draft, Apply/Revert,
  ACK, konflikt i refresh; kontrola wartości po zmianie celu/sesji.
  Dowód: stabilny root, scroll/focus/draft, brak wyłączania obcych pól,
  animacji opacity i nadmiarowych żądań.
- [ ] **Pozostałe rodziny inspektorów:** geometry/material/physics/mesh,
  study/results/diagnostics oraz routing każdego semantycznego węzła.
  Dowód: lista ocenionych rodzin, ustalenia i ich rozstrzygnięcia.
- [ ] **Chrome i design:** toolbar/ribbon, komunikaty, stany ładowania,
  błędów i pustych danych, kontrast motywów, wąskie panele i powiększenie.
  Dowód: renderowane ekrany i działające klawiaturowe interakcje.
- [ ] **Weryfikacja i integracja:** stosowne bramki architektury/API,
  lint bez ostrzeżeń, produkcyjne typy, React diagnostics, browser,
  niezależny review, commit etapów, PR/CI/merge i bezpieczny cleanup.

## Ryzyka do sprawdzenia

1. Odświeżenie drzewa podczas filtrowania lub nawigacji klawiaturą.
2. Puste, częściowo wpisane i spoza zakresu liczby oraz zmiana jednostki.
3. Odpowiedź na starą operację po zmianie wyboru lub sesji.
4. Nietypowe nieprzezroczyste identyfikatory i nazwy użytkownika.
5. Brak uprawnień przeglądarki, brak zasobu i odrzucenie komendy.

## Bieżący checkpoint

2026-10-22: audyt źródeł objął Explorer, wspólne kontrolki, Object/Geometry,
Airbox/FDM Universe, regiony i pola materiałowe, interakcje i graf fizyki,
Study/execution profile/hysteresis, analysis results oraz shell/dock/menu/ribbon.
Poniższe ustalenia mają konkretną ścieżkę poprawki. Lista nie jest deklaracją
wykonania wszystkich scenariuszy runtime ani kwalifikacji produkcyjnej.

| Obszar | Potwierdzony problem | Poprawka i wymagany dowód |
|---|---|---|
| Explorer: filtr | Trafienia pod zwiniętymi rodzicami pozostawały niewidoczne | Lokalne rozwinięcia podczas filtrowania; powrót do zapisanych rozwinięć po Clear/Escape; browser |
| Explorer: brak wyników | Przypięty wybór maskował pusty wynik wyszukiwania | Jawny komunikat bez usuwania wyboru; browser |
| Explorer: refresh | Przycisk zmieniał filtr/rozwinięcia zamiast odświeżać zasoby | Refetch istniejących resource hooks z zachowaniem wyboru i focus; browser GET |
| Explorer: klawiatura | Nawigacja obejmowała tylko wyrenderowane wiersze wirtualnego drzewa | Nawigacja po pełnej liście logicznej, scroll i focus po renderze; ponad 200 wierszy |
| Explorer: hierarchia | Strzałki nie przechodziły do rodzica/pierwszego dziecka | Semantyka drzewa i widoczny focus; browser |
| Explorer: zasób | Brak danych wyglądał jak pusty model | Jawne loading/error/stale; źródła i browser |
| Inspector: identyfikatory | Dekodowanie opaque ID mogło rzucać wyjątek dla `%` lub zmieniać ID | Zachowanie dokładnego ID, nazwa użytkownika osobno; browser |
| Inspector: clipboard | Sukces ogłaszano przed wynikiem schowka; ID zależało od skróconych metadanych | Oczekiwanie na wynik, feedback błędu, ID poza limitem metadanych, fence async; browser |
| Vector3Field | Jedna zmiana wywoływała callback przez onInput i onChange | Jeden kanał zmiany i aria-describedby błędu; browser |
| Walidacja geometrii | Loading/error bez wiadomości wyglądały jak sukces | Wspólna prezentacja statusu i zachowanych danych; rzeczywiści konsumenci Object/Geometry |
| Airbox/Universe | Statyczne etykiety sugerowały opublikowane dane przy braku odpowiedzi | Etykiety wynikające ze źródła i statusu; źródła i browser |
| Region: CSG | Zapis zwykłej nazwy mógł zastąpić CSG domyślnym boxem | Zachowanie oryginalnego shape, readonly dla nieobsługiwanego edytora; browser payload |
| Region: materiał | Uproszczenie override do stałej mogło utracić typ, parametr, wektor lub zero | Bezstratny passthrough, pomijanie niezmienionych pól, zachowanie metadanych i lane fences; browser payload |
| Region: dziedziczenie | Przy braku danych rodzica pokazywano wartości domyślne jako odziedziczone | Jawna niedostępność zamiast udawanej wartości |
| Physics: interakcja | Nieobecna opcjonalna interakcja z domyślnym enabled była Active | Status Absent i odrębne sprawdzenie aktualności danych przed edycją |
| Physics: graf | Trwające ładowanie sugerowało usunięcie modułu | Rozdzielenie missing/loading/error i poprzedniej rewizji |
| Analysis results | Błąd projekcji znikał za kompletnym manifestem | Oddzielne completeness i transport; jawny błąd projekcji |
| Dock | Suma minimów przekraczała szerokość małego okna | Ograniczenia od rzeczywistej szerokości grupy; browser 640/899/1024/1280 |
| Menu/ribbon | Menu znikało poniżej 900 px; range bez nazwy; ukryty overflow | Dostępne menu kompaktowe, etykiety kontrolek, widoczne przewijanie |
| Kolor w menu | Zagnieżdżona kontrolka nie należała do nawigacji Radix | Jeden natywny input jako element menu; strzałki, disabled, focus-visible i Escape |
| Listy materiałowe | Klucz indeksowy przenosił lub usuwał niepoprawny tekst po Remove wcześniejszego wpisu | Tożsamość draftu niezależna od pozycji; usuwanie tylko draftów usuniętego pola |
| Apply Region | Lokalne Apply mogło wysłać starą wartość liczbową mimo widocznego niepoprawnego tekstu | Sprawdzenie aktualnego magazynu draftów przed rozpoczęciem mutacji |
| Mode breadcrumbs | Dekodowanie surowego objectId z `%` powodowało URIError podczas renderu | Zachowanie surowego ID, regresje `%`, `%ZZ` i `%2F`; produkcyjne typy i CI |
| Branch CSV | Odrzucony Promise schowka pozostawał bez obsługi; brak API rzucał wyjątek | Wspólny helper schowka, komunikat wyniku i fence tożsamości wyniku; regresje DOM i browser |
| Region visualization IDs | Parser dekodował surowego ownera, a porównania dekodowały surowe ID manifestu | Rozdzielenie raw owner/manifest od kodowanego sufiksu regionu; zachowanie literalnego `%2F` i istniejącego `_geom` |

Wycofane podejrzenie: brak stylowania `aria-invalid` w FormField. Bieżący CSS
już je obsługuje; nie wprowadzamy pozornej poprawki.

Niezależny review źródeł ujawnił trzy dodatkowe przypadki uwzględnione
w poprawkach: Refresh musi odświeżać także memberships regionów FEM;
zmniejszenie filtrowanego drzewa przy niezmienionym wyborze musi ograniczać
offset wirtualizacji do nowej długości; lista parametrów odziedziczonych musi
używać aktualnie edytowanego parametru override. Scenariusze przeglądarkowe
obejmują odzyskanie memberships po HTTP 503, zmniejszenie drzewa nadal
przekraczającego 200 wierszy oraz zmianę parametru override i powrót.

Review harnessu oddzielił stabilność zewnętrznego korzenia Inspectora od
stabilności jego rzeczywistego viewportu Radix. Dowód mutacji wymaga
niezerowego przewinięcia, zachowania tożsamości i fokusu oraz porównania
disabled i opacity poszczególnych kontrolek. ACK jest wiązany z konkretną
odpowiedzią HTTP i końcowym stanem UI, a nie wyłącznie z przechwyceniem
requestu lub komunikatem pozostałym po poprzedniej operacji.

Stan weryfikacji na tym checkpointcie:

- Konfiguracja hosta i obraz toolchaina: PASS. Techniczne dane w wolumenach
  własnej grupy. Pierwszy start przerwany przez zmianę pliku podczas sync;
  druga próba zakończyła kompilację i uruchomienie backendu oraz frontendu.
  Launcher: `succeeded`, attempt `4d50d7b666d340568e9eb12e993284b7`, port 3210.
- Produkcyjne typy i architecture hygiene przeszły. Pełny ESLint zakończył
  się kodem 0, bez ostrzeżeń, dla niezmienionych źródeł:
  `verification/frontend-production-source-389c9972334341ddbbc0f1514f91c400.json`.
  Końcowe produkcyjne typy, architecture hygiene i lint zmienionych plików
  po poprawkach koloru, tożsamości i ACK także przeszły, dla stabilnych źródeł:
  `verification/frontend-production-source-9931fb9fb7ee4a618184750398c97af8.json`.
  Manifest bazowy: `verification/frontend-lint-baseline.json`.
  Ostatnia korekta selektorów i dowodu ACK w helperze regionów przeszła osobny
  lint: `verification/frontend-production-source-6ee45e8731a14ec998bb429afb3d3997.json`.
- `check-api-hygiene`: PASS, interpretowane regresje `.mjs`, bez kompilacji
  testów. Użytkownik jawnie zezwolił na tę konkretną bramkę po odmowie
  automatycznej kontroli. Receipt w wolumenie kontrolnym:
  `verification/frontend-api-hygiene-1ed6923360a94bdc88f0cc229f8e3057.json`.
- React Doctor: zakończona analiza 23 zmienionych plików produkcyjnych.
  Jedyny raportowany błąd cleanup efektu Airbox został zweryfikowany jako
  false positive: callback z EventBus usuwa listener i jest zwracany przez efekt.
  Ostrzeżenie o indeksowych kluczach listy wykazało rzeczywisty błąd draftów
  i spowodowało poprawkę. Nie używamy punktowej oceny jako dowodu odbioru.
- Browser: **NOT VERIFIED**. Próba uruchomienia helpera została zatrzymana
  przed startem przez preflight: `Docker build filesystem has less than 32 GiB free; admission refused`.
  Nie powstał raport wykonania scenariuszy tej próby. Późniejszy pomiar wykazał
  72 106 369 024 B dostępne na dysku Windows stanowiącym backing Dockera;
  uruchomiono ponowną próbę bez zmiany progów admission. Wynik oczekuje.
- Integracja: **NOT VERIFIED**; użytkownik zlecił utworzenie PR do `master`.
  Przygotowana regresja browser używa jawnych mocked API; jej wynik będzie
  oddzielony od dowodu działania rzeczywistego backendu i obliczeń.

`.github/workflows/bootstrap.yml` uruchamia dla PR między innymi kompilację
testów C++ oraz `cargo test`. Lokalne testy jednostkowe nie były kompilowane
ani uruchamiane. PR jest tworzony na jawne zlecenie użytkownika; wymagane CI
repozytorium pozostaje osobną bramką. Brak browser proof oznacza status draft.

## Commity etapów

- `37c2a281dfdc6a3f241037f4ce505fb9784bc8b6` — Explorer, wiarygodne statusy
  zasobów oraz wspólne kontrolki Inspector; pełny lint i produkcyjne typy PASS,
  niezależny review źródeł; browser pozostaje do potwierdzenia.
- `93eb1cc89328834dc23a9f1f42ffab07b7922499` — bezstratna edycja regionów,
  stabilna tożsamość list materiałowych i porównanie payloadu po ACK;
  końcowe produkcyjne typy, architecture hygiene i scoped lint PASS;
  regresje modelu zapisane, bez kompilacji i uruchomienia testów jednostkowych.
- Chrome, menu i browser harness stanowią trzeci logiczny commit. Końcowy HEAD
  oraz URL PR zostaną zapisane w rejestrze worktree.

## PR i checkpoint po pierwszym CI

PR do `master`: [#249](https://github.com/MateuszZelent/fullmag/pull/249), **draft**.
Commit trzeciego etapu: `4f08d271a3a2e287850e1d04490560feeb9b1605`.
Poprawki zdarzeń wektorów, scroll anchoring i harnessu:
`535e26cabd316e4c346a390da6c543f00ee148ea` — typy, architektura i lint
potwierdzone wskazanymi poniżej receiptami; pełny browser nadal oczekuje.
Automatyczne kontrole `contract-guard` i `eigensolve-ui-method-contracts`
przeszły. Workflow `bootstrap` zakończył się błędem; integracja pozostaje
**NOT VERIFIED**. Lokalne testy jednostkowe nie były kompilowane ani uruchamiane.

- CI frontend: trzy nieudane testy przy 8729 udanych. Dwa przypadki dotyczyły
  obsługi wektorów w Scratch i Antenna po zmianie wspólnego `Vector3Field`.
  Kontrolka używa teraz pojedynczego `onInput`, zgodnie z produkcyjnym
  `FormField`; nie wywołuje równolegle `onChange`. Trzeci przypadek był
  nieaktualną nazwą funkcji w asercji źródłowej regionów. Poprawki wymagają
  potwierdzenia kolejnym CI.
- CI Python: fixture retained recovery nie zawierał tożsamości próby.
  Poprawka `5e28a83a0169474e7d8adad3e8090a437529b72f`; 12/12 interpretowanych
  testów Python przeszło, bez kompilacji testów.
- CI browser: wykryte ucięcie wymaganej kontrolki Analysis przy 360 px.
  Dotychczasowy komunikat nie zawierał konkretnego elementu ani jego rectu.
  Diagnoza i pomiar pozostają do wykonania; hipoteza dotycząca stopki nie
  stanowi dowodu przyczyny.
- CI Rust: test retry admission zmienia jawną konfigurację polityki,
  pozostawiając zapisany marker i dokument zgodne ze sobą. Źródła ledgera
  wskazują zatem błąd `stored host resource policy differs from explicit ledger configuration`,
  a test oczekiwał `marker differs`. Poprawiono wyłącznie oczekiwanie i dodano
  wypisanie rzeczywistego błędu przy awarii; limit czasu i retry pozostają.
  Kod produkcyjny nie zmienia się. Weryfikacja wykonania oczekuje na CI;
  lokalnie nie kompilowano ani nie uruchamiano testów Rust.

Własne próby browser potwierdziły filtr i Refresh oraz wykazały rzeczywisty
konflikt natywnego scroll anchoring z wirtualizacją drzewa: po End przeglądarka
cofała offset i usuwała fokusowany wiersz. `overflow-anchor: none` pozwoliło
dojść do odległego obiektu i wrócić Home. Pełna rodzina scenariuszy nadal nie
przeszła. Skorygowano błędne założenia harnessu: Collapse All zwija Session,
nazwa obiektu jest w polu Name, a pierwsze ArrowLeft na rozwiniętym dziecku
zwija dziecko. Rodziny browser zbierają teraz osobne raporty także po awarii
jednej rodziny; dowód końcowy nadal wymaga powodzenia wszystkich rodzin.

Aktualne dowody źródłowe w wolumenie kontrolnym grupy:

- `verification/frontend-production-source-d9d5b7ad61f6440cab1a63205809e28a.json`
  — produkcyjne typy, architecture hygiene i scoped lint PASS, stabilne źródła.
- `verification/frontend-production-source-cf4c7c035bcf452b984a3bbaea6289e5.json`
  — lint po ostatnich poprawkach harnessu PASS, zero ostrzeżeń, stabilne źródła.
- `verification/frontend-production-source-a5fc9936e95f4016825319e12f05815c.json`
  — składnia i lint diagnostyki Analysis PASS; asercje i progi bez zmian.

Runtime: oba kontenery zakończyły pracę równocześnie 22.10 o 21:29:58 UTC,
exit 255, bez OOM; przyczyna zewnętrzna nie została ustalona. Zarządzane
wznowienie `e841490673114facbf2c7c068d4893a8` zbudowało pakiet, ale admission
zakończył się `native service target/build mismatch; attach refused`.
Usługi i dane zachowano. Nie resetowano ownera ani cudzych grup. Nowy
browser/WebGL proof jest **NOT VERIFIED** do rozwiązania tej blokady.

Odczyt potwierdził, że `target_id=docker-all` jest zgodny, lecz OWNER nadal
ma commit bazy i snapshot `c0da3e03…`, a nowy CLI oczekuje `5e28a83…` /
`d6151738…`. PID ownera 20430 nie istnieje w bieżącym kontenerze, ale sam
ten fakt nie kwalifikuje resetu. `restart-idle` wymaga zdrowego API,
`stop-failed` wymaga ownera `failed`, a zachowany owner ma `ready`.
Recepta container recovery wymaga osobnych dowodów namespace, teardown i
przypiętej autoryzacji. Nie wykonano jej ani kolejnego ślepego resume.

### Kolejna bramka CI i dalszy audyt

Nowy CI dla `0a31c30aa4eb3396007243312c7a950530a58b15` potwierdził
`inspector-actions-browser-smoke` oraz bramki API i native C ABI. Python
przeszedł dalej niż poprzednio i wykazał następny niekompletny mock:
`test_docker_volume_pending_resume.py` używał kontrolera bez `read()`.
W tym teście użyto istniejącego `_Control`, który modeluje brak opcjonalnych
receiptów i odrzuca nieoczekiwany obowiązkowy odczyt. 10/10 interpretowanych
testów tego pliku przeszło lokalnie, bez kompilacji.
Commit fixture: `5e0dfafa8b26bc0a0ddd50e6623c364a8cbe31f2`.

Przygotowane cztery rodziny audytu frontendowego zostają włączone do istniejącej
bramki browser w `.github/workflows/bootstrap.yml`. Korzystają z tego samego
przypiętego źródłowo audit buildu i jego serwera. Każdy błąd nadal kończy
obowiązkowy job niepowodzeniem; niezależne rodziny zbierają raporty także po
błędzie poprzedniej. Fixture kontrolek jest dostępny w development oraz przy
istniejącym `NEXT_PUBLIC_AUDIT_BUILD=1`; zwykły build produkcyjny zwraca 404.
Nie tworzy to dowodu działania rzeczywistego backendu ani symulacji.

Zakres governance: nadal etap modules/parity, bez zmiany statusu legacy,
domyślnego wdrożenia ani kryteriów cutover. Audit flag ma dotychczasowy zakres
weryfikacji frontendowej; właścicielem nowej ścieżki fixture jest to zadanie.
Fixture pozostaje tylko tak długo, jak jest używany przez regresje bramki.
Istniejące kontrakty workflow: 15/15 PASS (`python -B -m unittest
scripts.test_bootstrap_workflow_contract`).

Job `control-room-contracts` dla `0a31c30…` zakończył się **PASS**: 843 pliki
testowe i 8732 testy przeszły, 1 plik i 13 testów pominięto. Produkcyjne typy,
lint, kontrole wydajności oraz build aplikacji także przeszły. Wynik ten nie
obejmuje późniejszych lokalnych poprawek breadcrumbs/clipboard/ID i docka.

Nowa diagnostyka Analysis wskazała inną przyczynę niż hipoteza stopki:
`clipped=[]`, `visible=true`, `documentFitsViewport=true`, ale
`rootFitsViewport=false`. Przy viewport 360 px root zaczyna się na
`65.359375` px, ma `310.546875` px szerokości i kończy na `375.90625` px.
Wszystkie badane kontrolki mieszczą się w root; poza okno wychodzi cały panel.
Naprawa musi dotyczyć rzeczywistej geometrii dock/layout, nie ukrywania
kontrolek ani osłabienia asercji.

Granica pokrycia: dotychczasowy przegląd rodzin Inspector był ukierunkowany
przez registry i descriptors, nie obejmował każdego panelu. Inwentaryzacja
wykazała 113 plików paneli/inspektorów. Nie jest to 113 potwierdzonych błędów
ani 113 wykonanych audytów. Wszystkie etapy odbioru na początku dokumentu
pozostają otwarte, dopóki nie ma odpowiednich dowodów źródłowych i browser.

Po poprawkach opaque ID, kopiowania CSV oraz włączeniu harnessu do audit buildu
produkcyjne typy, architecture hygiene i lint zmienionych plików przeszły
bez ostrzeżeń, dla stabilnych źródeł:
`verification/frontend-production-source-f47fea2fc7184946a451e397909ea749.json`.
Niezależny review tych zmian nie wykazał kolejnych P1/P2. Regresje TS zostały
zapisane, ale nie były lokalnie kompilowane ani uruchamiane. Browser helper
sprawdza teraz odrzucone kopiowanie branch CSV bez fałszywego sukcesu oraz
udane ponowienie; etykieta `Copy branch CSV` odpowiada rzeczywistej operacji.

CI dla `0a31c30…` potwierdziło też krok `Run Docker accepted FEM GPU and
host admission contracts`, obejmujący poprawioną asercję polityki Rust.
Nie jest to dowód wznowienia lokalnej grupy: jej stale-ready owner nadal
pozostaje odrębną blokadą. Kolejny pomiar Analysis obejmuje prostokąty i style
przodków rootu; nie wprowadzono spekulacyjnej poprawki CSS.

Commity tego etapu:

- `85fe0930af4341e27827f2e28491660d3933addd` — zachowanie opaque ID
  w breadcrumbs i wizualizacji regionów; produkcyjne kontrole źródeł PASS,
  niezależny review, regresje wykonania oczekują na CI.
- `e1f5990a2a4ebb899b2b9577359166cfec1dc37f` — prawdziwy feedback kopiowania
  branch CSV z fence tożsamości; produkcyjne kontrole źródeł PASS,
  niezależny review, nowe regresje DOM/browser oczekują na CI.

Retencja etapu: brak nowych ciężkich buildów lokalnych. Zachowano frontend
state/cache używany przez działającą usługę, cache przyrostowy backendu,
pakiet z nieudanym admission oraz wolumen kontrolny z receiptami potrzebnymi
do kwalifikacji recovery. Brak dowodu ich zbędności; ponowna ocena po
rozwiązaniu recovery i integracji. Nie usunięto danych. Pomiar dysku C:
81 962 516 480 B wolne (22.10, około 22:03 UTC).

Podłączenie czterech rodzin audytu do obowiązkowego CI:
`cba4d6ac22d4ea9658ee227acfb438dcf97bf49d`. Po tym commicie wykonano
React Doctor dla czterech zmienionych plików produkcyjnych: wszystkie zostały
przeanalizowane, bez pominiętych kontroli, 0 błędów i 6 ostrzeżeń.
Receipt: `verification/frontend-production-source-e00c93da106447fbb7ecd11c8c7265c9.json`.
Ostrzeżenia dotyczą istniejących łańcuchów iteracji i eksportów helperów
z plików TSX; nie są dowodem awarii poprawionego przepływu. Nie zmieniano
niepowiązanych helperów ani konfiguracji diagnostyki dla poprawy punktacji.
Cały job `rust-contracts` dla `0a31c30…` także zakończył się **PASS**.

### Checkpoint po CI `4b9788128d0e91f7f40a337930685c3c7c050f6e`

`control-room-contracts` i `inspector-actions-browser-smoke` przeszły.
Python ujawnił brak czterech pól środowiska w mocku Compose maintenance.
Commit `29e5a8da8e295bec056b7999ded235b20a54802d` uzupełnia wyłącznie fixture.
Interpretowane testy w usłudze frontend grupy zadania: 35 testów, 2 pominięte,
PASS; receipt `verification/host-ledger-fixture-5af0f373338c449a8641e07a1b2925d9.json`.
Uruchomienie tego zestawu na Windows nie przeszło z powodu braku `os.geteuid`;
dowód PASS pochodzi z Linux w kontenerze, bez zmiany rzeczywistego ledgera.

Nowe rodziny browser ujawniły dwie potwierdzone pomyłki harnessu: selektor
paneli docka wskazywał wewnętrzny element zamiast zewnętrznego `[data-panel]`,
a fixture topologii nie przekazywał wymaganego manifestu. Obie poprawiono.
Nawigacja dużego drzewa przeszła; scenariusz zmniejszenia drzewa i edycja
regionu nadal wymagają diagnozy. Dodano stan błędu przed cleanup fixture,
zdarzenia przewijania i stan wyboru Inspectora. Przyczyny tych dwóch awarii
nie są jeszcze potwierdzone; nie wprowadzono spekulacyjnej zmiany routingu.

Pomiar Analysis przy 360 px potwierdził implicit grid min-content:
slot miał 112,64 px, a jego kolumna i root 310,55 px. Poprawka `slots.css`
ustala `minmax(0, 1fr)` w obu gridach oraz `min-width: 0` roota.
Potwierdzenie przeglądarkowe poprawki oczekuje na następne CI.

Priority regionu, override'u i pola materiałowego oraz Order siatki używają
wspólnego pola integer z trwałym surowym tekstem. Pusty tekst, znak i urwany
wykładnik blokują Apply zamiast zamieniać się w zero. Priority dopuszcza zero
i wartości ujemne; Order ma minimum 1. Klucze draftów są związane z regionem,
uiKey override'u lub assignmentId pola; Remove i Revert czyszczą właściwy draft.
Zapisano regresje parsera, DOM i browser; lokalnie nie kompilowano testów TS.
Produkcyjne typy, architecture hygiene i lint zmienionych plików: PASS,
stabilne źródła, receipt
`verification/frontend-production-source-f8d2f0d868834f2fbf013a459ee33a56.json`.

Review wykrył i poprawiono dwie usterki nowej integracji: jawne wyłączenie
mesh policy usuwa tylko raw draft Order tego regionu, a testy DOM commitują
przez bąbelkujący natywny `focusout`. Po poprawkach produkcyjne typy,
architecture hygiene i lint ponownie PASS dla stabilnych źródeł:
`verification/frontend-production-source-9d698d08816f4d14b1e3e9f421d9e33f.json`.
Później usunięto jedynie redundantną asercję tekstu implementacji z testu;
regresje parsera, DOM i browser pozostają. Zachowanie wyłączenia polityki
w przeglądarce jest nadal NOT VERIFIED.

Commity poprawek: `c7019363d4af54f79c561c86f31b6545b804a743`
(grid Analysis i harness browser) oraz
`2d5b5b59fbab0eed4bf714817e8db34d0c1632aa` (surowe drafty integerów regionu).
Hook React Doctor zgłosił w harnessie sekwencyjne await i iteracje; scenariusze
celowo wykonują zależne kroki użytkownika. Nie zmieniano konfiguracji reguł.
Hook uruchomiony w root nie wykrywa frameworka, więc nie zastępuje pełnej
diagnostyki React ani bramek runtime.

Otwarte poza tym etapem: pola liczbowe Planar nadal wymagają pełnego kontraktu
surowych draftów i przełączania kontekstu; Priority w tworzeniu nowego regionu
nie jest objęte powyższą zmianą. Zrzut przy 640 px wskazuje też możliwe
nakładanie etykiet zakładek Explorera przy wąskiej kolumnie. Nie są to
zweryfikowane poprawki. Managed runtime pozostaje zablokowany przez zachowanego
ownera poprzedniego buildu; nie wykonano resetu ani usuwania danych.

### Następny etap: zakładki, podział pionowy i drafty Planar

Stan wyjściowy `ef3e0d098651b2c584b568e29f5c0f4b9d56c23d`, czysty worktree.
CI bootstrap `39866139318` jest aktywne; nie restartowano jobów.

Źródła potwierdzają ściskanie etykiet Explorera: wspólne tab buttons mają
`min-width: 0` i domyślny flex-shrink. Scroll wrapper nie chroni tekstu przed
zwężeniem przycisków. Poprawka nadaje liście szerokość max-content i zabrania
kurczenia przycisków. Browser gate mierzy overflow tekstu każdego przycisku
oraz możliwość przewijania listy przy szerokościach 640/899/1024/1280 px.

Odczyt faktycznie zainstalowanego `react-resizable-panels@4.7.6` potwierdził,
że wartości liczbowe oznaczają piksele. Pionowy dock przekazywał defaults
78/22 i minima 42/12 jako liczby, choć model opisuje podział procentowy.
Poprawka konwertuje te cztery wejścia na jawne procenty na granicy biblioteki.
Browser gate sprawdza minima 42% main i 12% footer względem sumy wysokości
obu paneli. Nie zmienia to poprawnych poziomych ograniczeń już zapisanych
z jednostkami ani świadomie pikselowego Inspectora.

Planar — potwierdzone źródłowo, implementacja nadal otwarta:

- `Number("")` zapisuje zero m.in. dla raster/vector/point opacity,
  vector density i manual range. Część zer jest legalna dla API, ale nie
  reprezentuje intencji wyczyszczenia tekstu.
- Wszystkie te pola poza target wireframe należą do jednego planar state
  sesji; source/quantity są kontekstem interpretacji, nie osobnym backendowym
  magazynem. Target wireframe należy do dokładnej pary `(scope, scope_id)`.
- Spójna poprawka użyje QuantityField i jednego trwałego raw store ponad
  gałęzią 2D/3D. Wzorzec agregacji prywatnej child edit-session z istniejącego
  AntennaFieldSolveAuthoring pozwala zachować jednego globalnego ownera,
  także przy staged definicji monitora. Nie należy rejestrować konkurujących
  ownerów ani duplikować historii.
- Pending raw musi blokować zmianę Source/Quantity/Range mode lub zachowywać
  odpowiednie preimage. Sam store z identity zawierającym source/quantity
  gubi tekst przez automatyczne clear. `syncSharedQuiverIntent` przy powrocie
  do 2D nie może nadpisać bazowej wartości pending vector draftu.
- Manual range wymaga pary lokalnych limitów i wysyłki dopiero dla min < max;
  granice parserów muszą odpowiadać API, w tym point size <= 64.

Powyższe kontrole źródeł nie dowodzą jeszcze zachowania browser ani pełnego
odbioru produkcyjnego. Pełny zakres celu audytu pozostaje otwarty.

### Dowody i pozostałe awarie po wykonaniu CI `ef3e0d098…`

`control-room-contracts`: PASS, 844 pliki testowe i 8747 testów przeszły,
1 plik i 13 testów pominięto; dodatkowy zestaw 3 testów także PASS.
Produkcja typów, lint i build w tym jobie przeszły. `rust-contracts` i
`inspector-actions-browser-smoke`: PASS. `python-contracts` doszedł do końca
testów i oblał dopiero `check_repo_consistency.py`: brak sześciu mirrorów
skilli UI w `.github`. Uzupełniono je odnośnikami do kanonicznych instrukcji
w `.agents`, z identycznymi metadanymi i sprawdzonymi ścieżkami. Interpretowana
kontrola spójności repo: PASS. Commit
`cdc871e0d613b1c7c37a1e3b3de5b97bca204087` nie zmienia zachowania skilli.

Tworzenie regionu także zachowuje teraz raw Priority, blokuje Create oraz
Inspector Apply przy pending/invalid tekście i chroni późniejszą edycję przed
ACK. Zakres jest przypięty do sesji i obiektu. Cancel/retarget czyści właściwy
draft. Nowe regresje DOM obejmują zero, ujemne liczby, niedokończony tekst,
późny ACK i zmianę właściciela; oczekują na wykonanie w CI. Review wykrył
brak `act` wokół zdarzeń testu — poprawiono przed commitem. Poprawiono też
semantykę kart regionów: lista `ul/li` zawiera przyciski bez nadpisywania ich
roli na `listitem`. Commit
`3a59f58aa94d5f670f3e033c6e4fab68039b0a00`.

Produkcyjne typy, architecture hygiene i lint, również nowego pliku regresji:
PASS dla stabilnych źródeł, receipt
`verification/frontend-production-source-6807d04c761d4e4881a954a6ecf1e145.json`.
React Doctor obu zmienionych plików produkcyjnych: 0 błędów, 0 ostrzeżeń,
bez pominiętych kontroli; receipt
`verification/frontend-production-source-378430895c294e0e967283c363080d12.json`.
Nie kompilowano lokalnie testów jednostkowych. Dock i zakładki:
`068ade1c37a215fc11a36770cd3dc3dec1944ed3`, review źródeł bez P1/P2;
nowe regresje geometrii oczekują na browser CI.

Nadal czerwony `browser-fixture-smoke` ma już bardziej precyzyjne dowody:

- Explorer: filtrowanie, Refresh oraz pierwszy scenariusz dużego drzewa PASS.
  W scenariuszu shrink po drugim End ostatni debug row dostaje fokus przy
  scrollTop 11069, następnie scroll przechodzi na 10957 i wiersz znika z DOM;
  fokus trafia do body. Stan zapisano przed cleanup. W końcowym stanie
  clientHeight=391, scrollHeight=11824, wiersze mają 28 px. Rozbieżność
  wysokości viewportu/okna jest hipotezą, nie potwierdzoną przyczyną.
- Responsive: właściwe panele są widoczne przy 640 px, ale nawigacja menu
  nie dochodzi do View (fokus Start). Dopisano historię fokusu i otwarte menu;
  nie zmieniono kodu produkcyjnego na podstawie zgadywanej przyczyny.
- Region: aktywny wiersz audit-core jest poprawny, ale Inspector nie ma
  żadnych inputów. Source review wyklucza tłumaczenie pustym modelem:
  Overview zawsze renderuje formularz. Dodano tekst Inspectora, błędy strony
  i konsoli oraz screenshot błędu; przyczyna montowania nadal niepotwierdzona.
- Mesh: komunikat „stale size” porównywał string `"4e-8"` z liczbą `4e-8`.
  Nie dowodzi to starej wartości liczbowej. Kontrakt serializacji wymaga
  dalszego sprawdzenia przed zmianą produkcji lub asercji.
- Analysis: grid fix potwierdzony pomiarem rootFitsViewport=true; root ma
  110,64 px, lecz scrollWidth=160. Pozostał realny poziomy overflow wewnątrz
  panelu. Dotychczasowe `fits` sprawdza tylko kierunek poziomy, więc pionowe
  przewijanie nie wyjaśnia tej awarii. Dodano pomiary potomków oraz kontrolę
  root.scrollWidth <= root.clientWidth, zachowując etykiety osi i jednostki.

Artefakt browser `12464283719`, SHA256
`d2e98a7330f933253942cfca46121108a33ee52dacea9c5eb7888132c1b15f9a`.
Odczytany w pamięci, bez rozpakowania do hostowego storage. W tym etapie
nie usuwano cache, runtime, wyników ani receiptów; nadal są używane przez
sprawdzenia i potrzebne do diagnozy zachowanego ownera. Pełny managed runtime,
odbiór browser oraz cały audyt produkcyjny pozostają NOT VERIFIED.

Wyjaśniono typ wire polityki Object: `objectMeshPolicyWireRequest` w
`ControlRoomApi` celowo zamienia maximum_element_size na string, zgodny
z `ScriptBuilderPerGeometryMeshState.maximum_element_size: Option<String>`.
Adapter i istniejący test ControlRoomApi potwierdzają ten kontrakt. Harness
sprawdza teraz dokładnie string `"4e-8"` dla Object i liczbę `4e-8` dla Airbox,
w obu miejscach (PUT i ACK). Nie zmieniano produkcyjnego serializera.
Składnia oraz lint poprawki PASS, stabilne źródła:
`verification/frontend-production-source-ddc173a22ee1467caeaf38555016513f.json`.

Rozszerzono probe Explorera o clientHeight, okno zamontowanych wierszy,
spacery i zdarzenia ResizeObserver; bufor 200 zdarzeń i cleanup. Pozwoli to
sprawdzić wysokość w chwili End, której stary log nie zapisywał. Składnia
i lint pozostałych nowych pomiarów browser PASS, stabilne źródła:
`verification/frontend-production-source-95e962a262d847f2be165c3c0d8a3c77.json`.

Commit pomiarów i asercji wire:
`23dd27221bca64fbda79951929fd9e76a004cfb2`. Główne poprawki zachowania
mają oddzielne commity od rozszerzeń harnessu. Retencja: frontend jest nadal
używany przez source checks, pakiet backendu i control volume są potrzebne
do recovery; brak dowodu zbędności. Nie usunięto danych. Dysk C: ma
79 794 331 648 B wolnego miejsca przy checkpointcie. Dalszy krok to wykonanie
nowego browser CI i poprawki na podstawie jego pomiarów; Planar nadal wymaga
wdrożenia opisanego wyżej trwałego właściciela draftów. PR pozostaje draft.

### Checkpoint 23.10 — Planar, dane fixture i wąski Analysis

CI dla `465486a62f671abecc29bcd715cb6cbb69dc3117`, run `39869732753`,
jest terminalny: Python, Rust, generated API, API hygiene i Inspector actions
browser PASS. Control Room: 8751 testów PASS, jeden FAIL, 13 pominiętych.
Jedyna awaria dotyczy nowego testu DOM Priority: React DOM był importowany
przed instalacją testowego DOM i wybrał niewłaściwą ścieżkę input events.
Import przesunięto po instalacji DOM. Nie uruchamiano lokalnie testów TS.

Browser fixture FAIL. Ustalono przyczynę pustego Inspectora regionu:
fixture zwracała `mesh_pipeline_status` jako string, podczas gdy kontrakt
wymaga tablicy faz. Konsola potwierdzała `.some is not a function`.
Poprawiono fixture, zachowując produkcyjny kontrakt. Obie korekty:
`5194df8b229859141bbe0357d1b9e4ab0d93979f`; wykonanie regresji czeka na CI.
Artefakt browser `12464969626`, SHA256
`6786b60dcfa761358637590c74726d0f95b530db6cc70712e4ae3c617ff58230`,
odczytano w pamięci, bez rozpakowania do hostowego storage.

Nowe pomiary wykluczają poprzednią hipotezę starej wysokości Explorera:
clientHeight wynosi 391 już przy End. Po focusin ostatni wiersz ma rect
1011..1039, scrollTop 11069; kolejny scroll 10957 usuwa go z okna DOM.
Dokładny writer drugiego przewinięcia nadal wymaga diagnozy. Compact menu
pozostaje na Start mimo ArrowDown; nie zastąpiono regresji klikaniem.
Kontrola Object wire string przeszła dalej; następna awaria dotyczy
zachowania pozycji przewijania Airbox po ACK.

Analysis: pomiary wykazały min-content szerokość wewnętrznego nagłówka
138,7 px przy panelu 92,64 px oraz implicit grid column wykresu.
Dodano `minmax(0,1fr)`, ograniczenia dzieci nagłówka oraz container query
dla kontrolek, zależne od panelu zamiast szerokości całego okna.
Commit `2c2c77faee009e32326c0a19ecd88f73d55ddef6`.
Istniejące poziome asercje browser pozostają; efekt renderowania NOT VERIFIED.

Planar: wdrożono właściciela raw draftów nad warunkowym drzewem 2D/3D.
Tożsamość obejmuje sesję i target, kontekst pola obejmuje źródło i jednostki.
Niekompletne pola blokują globalny i lokalny Apply monitora; można je jawnie
odrzucić także po ukryciu pól. Delegacja do właściciela mutacji nie dubluje
historii; ACK sprawdza tożsamość, wersję raw store i późniejsze edycje.
Commit Planar: `687ee8c16efaf7d58d4165ff404f734351117da6`.
Liczby zatwierdzane są po blur/Enter, z ograniczeniami kanonicznego API.
Pusty tekst, znak i niedokończony wykładnik pozostają tekstem. Manual range
zatwierdza wyłącznie poprawną parę min < max; późniejsza edycja drugiego
limitu może dokończyć pierwszy. Parser wydzielono z komponentu dla HMR.

Dodano regresje parsera, DOM właściciela i pary zakresu oraz pierwszy
scenariusz browser w istniejącej fixture frontend-controls. Zakres browser:
produkcyjne prymitywy, remount pól, zero, para zakresu i Discard ukrytego
draftu. Nie dowodzi on rzeczywistego przełączania viewportu Object 2D/3D,
lokalnych akcji monitora ani API. Testy jednostkowe lokalnie nie były
kompilowane ani uruchamiane. Review zmian produkcji i nowych testów:
bez otwartych P1/P2 po poprawce lokalnego Apply/Discard monitora.

Typy produkcyjne, architecture hygiene i scoped ESLint (również nowe testy):
PASS, stabilne źródła, receipt
`verification/frontend-production-source-f72a049ca7f542e18829f5dff47999e4.json`.
React Doctor: 9 plików przeanalizowanych, bez pominięć, 0 błędów;
`verification/frontend-production-source-a69b8a9a950b482fa761ec92abc9cf68.json`.
Cztery ostrzeżenia dotyczą istniejących iteracji i efektów Object/Monitor:
retencja ostatniego dobrego zasobu i rebazowanie czystego draftu po nowej
rewizji. Nie usuwano tych zabezpieczeń dla wyniku skanera; wymagają osobnego
profilowania/review synchronizacji. Nowy parser nie ma ostrzeżenia HMR.

Retencja: cache, control volume i pakiet pozostają potrzebne do bieżących
kontroli oraz recovery starego ownera. Nie usunięto danych ani nie resetowano
ownera. Główny checkout pozostaje nietknięty. PR #249 jest draftem;
pełny audyt frontendowy, browser acceptance i integracja pozostają otwarte.

Po push `cf3da9d72cda6d0d8e37e21f8fac32fe99f0e99d` uruchomiono
bootstrap `39872650494`. Równolegle przygotowano dalsze pomiary pozostałych
awarii, bez zgadywanych poprawek produkcji:

- Compact menu: po każdym ArrowDown test oczekuje na konkretną następną
  pozycję menu. Przy timeoutcie zapisuje role, disabled, tabindex i rejestrację
  elementów Radix. Nadal używa prawdziwej klawiatury. Natychmiastowy odczyt
  po klawiszu nie rozstrzygał odroczonego fokusu biblioteki.
- Explorer: probe deleguje scrollTop do natywnego accessora i zapisuje
  requested/before/actual oraz stos. Rejestruje także scrollIntoView drzewa.
  Cleanup przywraca deskryptory. Pomiary rozróżnią synchroniczne przycięcie
  offsetu od późniejszej korekty DOM/przeglądarki; nie są zmianą wirtualizacji.
- Airbox: raport zachowuje baseline/during/after także dla nieudanego celu,
  a błąd podaje scrollTop, clientHeight i scrollHeight przed/po. Dotychczas
  błędny cel nie trafiał do końcowej listy udanych scenariuszy.

Składnia i lint helperów PASS, receipty stabilnych źródeł:
`13f2eb1c384b4c34b3ee05123c9f835f` (mesh),
`03bc6ee2c080400992d31642db3f779a` (responsive),
`0fdbaa2e50734aae9de2581532a52d9b` (Explorer), pod
`verification/frontend-production-source-<id>.json` w tym samym wolumenie.

Log joba `120150551642` (HEAD cf3da9d72, workflow zastąpiony przez nowszy)
zawiera wynik testów: 8780 PASS, 2 FAIL, 13 pominiętych. Wszystkie nowe testy
parsera, raw ownera i pary zakresu przeszły; oba błędy pochodzą z istniejącego
testu stabilności Object/Airbox, który oczekiwał zapisu natychmiast po input.
Test uzupełniono o asercję braku zapisu po input i jawne zatwierdzenie Enter,
z zachowaniem kontroli fokusu, scrolla oraz liczby mutacji. Zmiany produkcji
nie były potrzebne. Scoped ESLint PASS, stabilne źródła:
`verification/frontend-production-source-d462f6709ce3473baa772ee43dba1723.json`.
Lokalnie nie kompilowano ani nie uruchamiano testów TS; wynik poprawki czeka na CI.

### Dalszy audyt — brakujące skalary wyników

W `FrequencyDomainResultInspectors` parser `Number(value)` traktował null,
false, pusty tekst i pustą tablicę jak opublikowane zero. Potwierdzony skutek:
`residualNorm: null` w punkcie bez surowego residuum pokazywał `0`, a błędne
surowe residuum mogło przesłonić poprawne `5e-5` w podsumowaniu. Ten sam
parser obsługuje pola częstotliwości, amplitudy i metadanych.
Zastosowano istniejący `finiteModalScalar`, używany już przez EigenMode:
liczby i niepuste legacy numeric strings pozostają obsługiwane, zero zostaje
zerem, a brak danych uruchamia fallback albo jawną niedostępność.
Nie zmieniono fizyki, obliczeń ani API. Regresje sprawdzają eksportowany
builder residuów, przypadki brakujące/nieprawidłowe i zachowanie prawdziwego
zera oraz legacy stringów; wykonanie w CI oczekuje.

Review wszystkich wywołań parsera i pośrednich helperów: bez P1/P2.
Produkcja typów, architecture hygiene i scoped lint PASS, stabilne źródła:
`verification/frontend-production-source-901389be260046deaed7e934614c103c.json`.
React Doctor przeanalizował zmieniony plik bez pominięć, 0 błędów:
`verification/frontend-production-source-58f0dad70034433f91f717e06e266e75.json`.
Dwa istniejące ostrzeżenia: indeks jako ostatni składnik klucza stateless
karty peak oraz statyczna tablica przycisków 3D tworzona przy renderze.
Nie potwierdzono utraty draftu w karcie (brak edytowanych pól); poprawka
parsera nie zmienia obu miejsc. Nie kompilowano lokalnie testów jednostkowych.

### CI f2c9292 — potwierdzone zachowania i dalsze poprawki

Bootstrap `39873154544`, browser job `120152476393`: FAIL, z nowymi pomiarami.
Inspector actions PASS. Control Room nadal ma tylko te same dwa nieuzupełnione
zatwierdzenia Enter; ich korekta jest w lokalnym commicie
`86586e993427bf81da3c4e3bbeba4d34659a097d`, czeka na push/CI.
Parser brakujących skalarów: commit
`3f6c7ba038902e2f2a331e4fef03925f40341c5f`.
Artefakt `12467572268`, SHA256
`d5fe3a6afd5656b80c28bc0171dd658cced64aa983e7c7d52888e04489e224ba`;
raporty i screenshot odczytane w pamięci, bez hostowych plików buildu.

- Planar raw/remount fixture PASS: blank, jawne zero, para 5..10, Discard
  ukrytego draftu, dokładnie dwa commity. Nadal bez dowodu właściwego viewportu
  Object 2D/3D i API.
- Explorer: filtr, Refresh i duże drzewo PASS. Przy shrink setter otrzymał
  11425 i natychmiast zwrócił 11425, z viewportem 391 i max 11433. Dopiero po
  renderze okna 400..422 browser zmienił offset na 11069, bez kolejnego zapisu
  JS ani scrollIntoView. Następna korekta odmontowała fokusowany wiersz.
  Zastąpiono osobne spacery stabilnym canvasem o wysokości pełnej listy oraz
  absolutnie pozycjonowanym oknem wierszy. Browser wymaga teraz widocznego
  fokusu przez cztery klatki po End. Źródłowy review kierunku bez P1/P2;
  natywny mechanizm przejściowej korekty i efekt poprawki wymagają browsera.
- Screenshot menu pokazuje otwarte Simulation z poprawnie wyłączonymi
  akcjami i powodami. File/Edit/View zostały osiągnięte klawiaturą. Poprzedni
  test wymagał menuitem także wtedy, gdy nie ma legalnej aktywnej komendy.
  Teraz sprawdza fokus kontenera, niepustą listę i powody wyłączenia każdej
  akcji; dla dostępnych komend nadal wymaga aktywnego menuitem.
- Region: rename zachowujący CSG i stabilny Inspector PASS; Priority raw,
  blokada zapisu, zero/ujemna liczba i Revert PASS. Kolejny zapis został
  odrzucony przez globalny limit jednej synchronizacji skryptu w fixture.
  Lokalny interceptor liczy teraz dokładnie jedną synchronizację na każdy
  potwierdzony zapis regionu/pól; duplikat bez zapisu nadal jest błędem.
  Nie podniesiono globalnych limitów i nie osłabiono kontroli payloadów.
- Airbox: root, focus i kontrolki pozostały stabilne; po ACK wysokość treści
  zmalała 1771→1741, scroll przeszedł 657→627 przy stałym viewport 136.
  Zmieniony feedback usuwa wcześniejsze ostrzeżenie dirty. Wyłączono natywne
  kotwiczenie viewportu Inspectora, aby zachowywać offset podczas feedbacku.
  Zasadność efektu pozostaje do potwierdzenia tym samym browser checkiem.
- Analysis: zewnętrzny root mieści się, lecz legendę wymuszało minmax 190px,
  a kolumnowy header dziedziczył wrap i flex-basis 100% z viewport media rule.
  Doprecyzowano regułę kontenera: nowrap, auto basis i jedna elastyczna kolumna
  legendy. Dane, jednostki, etykiety i wymagane asercje nie zostały usunięte.

Dalszy audyt Study potwierdził utratę późniejszych edycji profilu po ACK
oraz zamianę pustych liczb Field Drive na zero. Wdrożenie i regresje są
przygotowane do końcowych kontroli źródeł. Profil zapisuje wysłaną migawkę
jako baseline, zachowuje późniejszy draft i zwraca Apply=false przy kolejnej
niezapisanej zmianie. Review wykrył i doprowadził do poprawki zachowania
warstw w sekwencji profil→Legacy→profil podczas zapisu. Field Drive używa
raw scope i blokad lokalnego/globalnego Apply; review wykrył edytowalny
Stage ID użyty jako tożsamość scope, co wymagało dodatkowej korekty.
Nie kompilowano ani nie uruchamiano lokalnie testów jednostkowych.

Końcowe poprawki Study są zapisane. Scope Field Drive korzysta z kanonicznej
tożsamości etapu, nie edytowalnego Stage ID. Rename zachowuje raw; rzeczywisty
retarget czyści właściwy scope. Lokalny Save jest wyłączony przy pending raw,
a guard imperatywny nadal chroni oba kanały zapisu. Regresje obejmują także
piecewise textarea (niekompletne wiersze nie są filtrowane do starego modelu),
konwersję mT→T, jawne zero, optional width=null, ukryty draft waveform,
Discard i blokadę resetu podczas zapisu. Review obu zgłoszonych P2 zamknięte
na poziomie źródeł; nowe regresje nadal oczekują na wykonanie w CI.

Końcowe typy produkcyjne, architecture hygiene i scoped ESLint bez ostrzeżeń:
PASS, stabilne źródła,
`verification/frontend-production-source-6570645a1603490c95d01844a8f846b7.json`.
Zatwierdzony interpretowany API hygiene PASS:
`verification/frontend-api-hygiene-1b6195b0340b49f99295370f500b44a9.json`.
React Doctor: pięć plików produkcyjnych przeanalizowanych, brak pominięć,
0 błędów, 3 ostrzeżenia w istniejących efektach reveal/synchronizacji
edit-session z rodzicem. Zachowano te kontrakty zamiast usuwać je dla oceny;
`verification/frontend-production-source-cdc0e1b07fdd43cd8864107f66de375c.json`.
Początkowy lint wykazał dwie brakujące zależności stabilnego dispatch —
poprawiono przed końcowym zielonym sprawdzeniem.

Commity etapów:

- Explorer i mocniejszy odbiór po End:
  `56870f2b716939cc0885d8263790d8c5a461f646`.
- Inspector scroll/Analysis narrow layout:
  `d4f998659309cf87f5b8b6cb57aa5721b9b4443d`.
- Dostępność niedostępnych komend i dokładny budżet synców fixture:
  `55e6bba2b8d2bfc90ce9e08482b31008ea736a45`.
- Zachowanie późniejszych edycji profilu po ACK:
  `1d40badb54b8a9843bf7a3268fcce26a7b2f2f71`.
- Raw Field Drive i guardy zapisu etapów:
  `33f82b7bbffe6ebdac1d6f49cf724d4486ab2fef`.

Retencja bez zmian: techniczne wolumeny i pakiet są potrzebne do kontroli
oraz recovery ownera. Nie usuwano danych i nie dotykano głównego checkoutu.
Pomiar C: w tym checkpointcie: 75 514 359 808 B wolnego miejsca.
Nie wykonywano nowego ciężkiego buildu. Pełna kwalifikacja runtime i browser,
pozostałe rodziny audytu oraz integracja nadal nie są ukończone.

### CI b1ae97c4 — nowe dowody i zamknięte przyczyny źródłowe

Bootstrap `39876664384`: Control Room job `120163803516` zakończony FAIL:
8802 PASS, 4 FAIL, 13 pominiętych. Dwa testy Planar wywoływały Enter bez
focusin potrzebnego polyfillowi React w uproszczonym DOM. Testy zachowują
asercje Enter/focus/scroll/ACK i emitują brakujące zdarzenia. Dwa testy
Field Drive szukały wyłącznie aria-label, choć select ma nazwę w natywnym
label-wrapper. Helper rozpoznaje teraz oba poprawne źródła nazwy.
Nie zmieniono kontraktu produkcyjnego dla dopasowania do testów.

Browser job `120163803477` zakończony FAIL; Inspector actions browser job
`120163803659` PASS. Odczytano logi i artefakt `12468258962`, SHA256
`88914056e0bdf59d7a4888ecef8ff43e80dc0a7ecc2ec989fbaf81c130665d36`,
bez rozpakowywania do hostowego storage. Raporty potwierdzają:

- responsywny dock/header przy czterech szerokościach i nazwa range PASS;
- mesh-policy browser PASS, w tym stabilność Inspectora;
- Planar raw/remount, filtrowanie i Refresh nadal PASS;
- regiony: siedem scenariuszy zakończonych przed błędem selektora, w tym
  kolejne zapisy skalarów/pól i raw Priority. Test usuwania zatrzymał się,
  ponieważ ten sam komunikat ma span feedbacku i opis footera. Selektor
  wskazuje teraz dokładny komunikat feedbacku. Asercje braku mutacji,
  zachowania node/raw i Revert pozostają;
- Explorer: stały canvas zachował offset po wirtualizacji. Mocniejsza
  asercja wykryła ucięcie ostatniego wiersza po pierwszym End: 460 wierszy,
  wysokość 12880, viewport 391, scroll 12489, max 12497, ostatni rect
  655..683 przy początku viewportu 288. Obliczenie pomijało 4 px paddingu
  nad canvasem. Reveal klawiaturowy i selection mierzą teraz początek
  canvasu względem scroll viewportu. Regresja liczbowa wymaga 12493,
  a dotychczasowy browser nadal wymaga pełnej widoczności przez cztery klatki.
  Korekta i późniejszy shrink wymagają nowego CI; nie są jeszcze odebrane.

### Schowek, About i Study autosave

Data Preview pokazywał sukces przed zakończeniem writeText i nie obsługiwał
odrzucenia. About/Provenance również nie obsługiwały odrzuceń ani późnego ACK
po zmianie źródła. Wspólny useClipboardCopy używa istniejącego adaptera
Clipboard API/fallback, blokuje duplikaty, ma pending/success/error, cleanup
timera i fencing tożsamości/operacji. Token chroni także A→B→A. Widoki
pokazują dostępny błąd i umożliwiają retry. Data Preview wiąże stan z sesją,
rewizją, ilością, komponentem, próbkami i kopiowanymi metadanymi.

About pokazuje opublikowane build.version albo Version unavailable zamiast
stałego v0.1.0. Stałe cytacji pozostają bez zmian. React Doctor wykrył
istniejące renderowanie hosta zależne od browser globals; oba widoki używają
teraz istniejącego wzorca useSyncExternalStore ze stałą migawką serwera.
Test obejmuje markup SSR i mount desktopowy, nie pełną hydratację.
Nowe regresje schowka obejmują rzeczywisty log, pending/ACK, odmowę, retry,
duplikaty, retarget, A→B→A i unmount. Usunięto test tekstu implementacji.

StageAutosaveSection używał `${index}:${quantity}` jako klucza React,
odmontowując input podczas pisania. Wiersze mają lokalne, stabilne rowKey;
usunięcie wcześniejszego wiersza zachowuje następcę. Serializer jawnie
pomija klucz UI. Run/Autosave/Table Autosave używają kanonicznego parsera
czasu dla Until; poprawne `2 ps` nie jest już wyświetlane jako brak danych.
Niepoprawne/puste/niedodatnie wartości pozostają niedostępne. Testy obejmują
focus/node identity oraz te podsumowania. Review usunął null z tabeli
legalnego StudyStageDraft, którego Until jest wymaganym stringiem.

Commity spójnych etapów:

- harnessy Planar/Field Drive i selektor regionów:
  `01964a2eec7f826bfb2a5adea731f46c449f15d5`;
- pełny reveal wierszy Explorera:
  `baf2033199f6eae54d6b87bb6da086405d7205ab`;
- autosave identity i jednostki Until:
  `9d9b6a1a35f1adcfb25070df9b68549b5773e13b`;
- schowek i prawdziwe metadane About:
  `ced313224bdd165739caa81093f2bc6c39143202`.

Końcowe typy produkcyjne, architecture hygiene i scoped ESLint bez ostrzeżeń
PASS, ze stabilnymi źródłami:
`verification/frontend-production-source-36e7ae3806ae41a7984deffee98ba6e2.json`.
React Doctor: 11 plików, brak pominięć, 0 błędów, jedno istniejące ostrzeżenie
only-export-components w ProvenancePanels:
`verification/frontend-production-source-b6c42cf50fe04cce9dc29a40c8a61bc7.json`.
Pierwszy Doctor `616ff7ffcf4a4a52960de3133f73c8c4` wykazał dwa błędy host
hydration; zielony receipt jest po poprawce. Review źródłowy nowych delt
nie ma otwartych P1/P2. Hook commita zgłosił istniejące await w pętlach
browser fixture: kroki są celowo sekwencyjne i sprawdzają zależne interakcje.
Nie kompilowano ani nie uruchamiano lokalnych testów jednostkowych TS/Rust.
Nowe regresje czekają na CI. Warstwy API/transport nie zostały zmienione.

### Dalsze pokrycie i otwarte prace

Readonly audyt Mode Composition objął inspectory/route adapter/controller,
resources/resource model, API paths/types, realtime invalidation oraz schemat
i handler backendu. Nie wykazano błędu zapisu lub złej tożsamości sesji.
Rate publikuje poprawne prefiksy liczby natychmiast; pusty/sign nie stają się
zerem. Bez ustalonego kontraktu deferred commit jest to kandydat UX,
nie potwierdzony bug i nie został zmieniony.

Nowy potwierdzony problem do następnego etapu: browser legendy response
pokazały `Amplitude [mnot published]` i power density z tym samym prefiksem.
Fixture nie publikuje observable units; frequencyDomainChartModels celowo
zwraca `not published`. chartScalePolicy nadaje jednak prefiks SI także
nierozpoznanemu tekstowi. Należy zachować factor=1 i literal dla nieznanej
jednostki oraz sprawdzić regresję legendy; nie dopisywać jednostek z założeń.
`Phase [mrad]` ma jawne rad i poprawne skalowanie. Odczytano formatter,
frequency-domain models/testy, surface i fixture; poprawka jeszcze nie istnieje.

Zachowano worktree i techniczne wolumeny: służą aktywnym kontrolom źródeł
i recovery ownera. Brak nowego ciężkiego buildu i danych kwalifikujących się
do usunięcia w tym etapie. Pomiar C: 63 842 295 808 B wolnego miejsca.
Stale backend owner nie został zresetowany; managed runtime, właściwy
Object 2D/3D/monitor, pełny browser odbiór i pozostały audyt nadal otwarte.
PR #249 pozostaje draft; nie wykonano merge ani cleanupu worktree.

### Jednostki wykresów i podsumowania Frequency Response / FFT

Nierozpoznana jednostka w chartScalePolicy zachowuje teraz factor=1 i swój
literalny tekst. Zarejestrowane jednostki nadal się skalują, w tym rad→mrad.
Resolver jednostek wymaga własnego wpisu rejestru; `constructor`, `toString`,
`hasOwnProperty` i `__proto__` nie są jednostkami przez dziedziczenie Object.
Regresje formattera/rejestru i renderu AnalysisFrequencySurface wymagają
niezmienionej amplitudy 0.06 z unit `not published` oraz fazy 300 mrad.
Wspólni konsumenci: frequency/table surfaces, chartRenderer, PointsTableDialog,
chartExport i live charts. Nie dopisano jednostek obserwabli do fixture.
Commit `b821bbfde4e3ed62a52e8c28226b90b3d8436eab`.

Kolejny przegląd znalazł Until przez Number także w FFT Response. Widok używa
teraz kanonicznego parsera czasu, a regresja czterech rodzin sprawdza 2 ps,
pusty tekst, zero i tekst niepoprawny. FrequencyResponse miał osobne parsery
podsumowań: pusty lub końcowy token dawał 0 Hz, 5GHz znikało, średnik zmieniał
liczbę punktów, pusta faza stawała się finite 0 deg. Udostępniono istniejące
parsery draftNumber/positiveDraftNumberList z modelu authoringu bez zmiany
gramatyki, DTO czy obliczeń. Formatter i sweep używają ich wspólnie. Lista
z błędnym/niedodatnim tokenem nie udaje poprawnego podzbioru ani liczby
artefaktów. Pusta faza jest niedostępna, niepuste legacy Number pozostaje.
Regresje obejmują jednostki bez spacji, średniki, duplikaty równych wartości
SI, trailing delimiter, błędne listy i częściowe fazy. `5 GHz` pozostaje
niepoprawną listą według istniejącej gramatyki; `5GHz` jest legalne.
Commit `4d9077b4b8ee44e33b5648739ce8a39d744f9e82`.

### CI abcda66f — Explorer odebrany, dalsze przyczyny awarii

Bootstrap `39878842186`, Control Room `120171027729`: FAIL, 8817 PASS,
3 FAIL, 13 pominiętych. Nowe regresje shared clipboard, Data Preview,
autosave oraz poprzednie Field Drive przeszły. Dwa Planar testy wymagały
Selection API dla Enter po realistycznym focusin. Odczytano faktyczne
constructSelectEvent React 19.2.4 z zależności własnego frontendu
(`verification/frontend-production-source-8b394c99c0414b9ba44ab69d8df89de9.json`,
wyłącznie odczyt, nie wykonanie testów). React bezpośrednio czyta cztery
właściwości wyniku getSelection. Lokalny testowy adapter zwraca pusty obiekt
Selection; null byłby błędem. Pozostają Enter i asercje root/focus/scroll/ACK.

Trzeci test wykrył drugi wpis v0.1.0, tym razem w tabeli About. Tabela pokazuje
build.version albo Version unavailable tak jak header. Test obejmuje build
1.2.3. Tytuł Toolchain Declarations nie udaje kwalifikacji aktywnego runtime;
pozostałe deklaracje zależności wymagają osobnego porównania z manifestami.
Commit `ebc1f546daf666a9a8930651496b2d3a80768e13`.
Harness walidacji/getSelection:
`6ba6b806fa32d0deaa60cf0d6df3a5364f2af27e`, następnie dokładny kontrakt Selection
`b85bd3a710b6075ee88007af9134952884572dd6`.

Browser `120171028080`: FAIL; Inspector actions `120171027915`: PASS.
Artefakt `12470241176`, SHA256
`76172318380af0a0fad644eb1a9c9d94c51944fd3d0aad5e3dbf0442d800080e`,
odczytany i zahashowany w pamięci, bez hostowego rozpakowywania.

- Explorer navigation/hierarchy PASS: 461 wierszy logicznych, 30 montowanych,
  45 kroków przez wirtualne okno, End/pełna widoczność przez cztery klatki,
  Home, rodzic/dziecko oraz widoczny focus ring w obu motywach.
- Shrink PASS: 881→422 wierszy, 14 widocznych po zmianie, offset 11433,
  zachowany wybór audit-shrink-60 i fokus ostatniego logicznego wiersza.
- Planar raw/remount, filtr, Refresh oraz memberships 503→200 PASS.
- Real Object/Geometry validation zatrzymało się na loading warning. Test
  czekał na dowolny alert, który jest legalny również podczas loading.
  Teraz czeka na alert zawierający oczekiwaną treść błędu; nadal wymaga GET
  503 i braku pozornego sukcesu. Syntax/lint helpera PASS:
  `verification/frontend-production-source-506fa2f3e9574149a5fd645abc68e86a.json`.
- Wszystkie dziewięć scenariuszy regionów PASS, również usuwanie wcześniejszego
  wiersza bez utraty surowego draftu następcy. Końcowy exact-once check FAIL:
  3 potwierdzone zapisy, 2 synci. To brak produkcyjny w Apply Fields, nie
  błąd zliczania fixture. Dwa region PATCH robiły sync; material-fields
  transaction publikowała ACK bez odświeżenia kanonicznego skryptu Python.

Ścieżka Apply Fields→patchObjectMaterialFields→commitTransaction nie synchronizuje
skryptu w API ani runAuthoringMutationWithHistory. Osobny model/syncs przepisuje
kanoniczny Python, a exporter serializuje material_parameter_fields przez
set_material_field. Przygotowano jeden scoped best-effort sync po ACK,
z ostrzeżeniem przy awarii bez ponawiania transakcji. Review wykrył nowy P2:
ten sam mounted panel może zmienić region w obrębie sesji podczas await sync;
sam session fence nie chroni lokalnego feedbacku. Poprawka właściciela
regionu i jej regresja są wymagane przed commitem tego fragmentu.
Końcowa asercja jednego syncu na ACK pozostaje bez zmian.

Weryfikacja zakończonych delt: produkcyjne typy/architecture/scoped lint PASS,
`verification/frontend-production-source-25618ff90ce14d12b5cb79b7940bb93d.json`.
Lista lint obejmuje także pliki już zacommitowane po bazowym pełnym lint,
nie tylko zmienione wpisy baseline i pliki untracked. React Doctor sześciu
plików bez pominięć, 0 błędów:
`verification/frontend-production-source-431b5aff9a254a7db238c64392e81b76.json`.
Ostrzeżenie o window w StudyStageAuthoringModel:212 to nazwa pola interfejsu
`window: "hann"`, nie odczyt browser global; nie zmieniano kodu dla heurystyki.
Żadnych lokalnych kompilacji ani uruchomień testów jednostkowych TS/Rust.

### CrossSection — potwierdzona następna poprawka

Readonly audyt CrossSectionSettingsEditor, FormField, crossSectionWorkspace,
DraftEditor, InspectorPanel oraz ich testów potwierdził utratę surowych liczb.
Position/Rotation konwertują każdy input przez Number: `12.` traci kropkę,
`-` przechodzi w NaN i sanitizację do 0/-180, pusty tekst zatwierdza zero.
Puste Edge width zapisuje 0 mimo minimum 0.5; sanitizeDraft nie ogranicza go.
Shrink z pustego tekstu przechodzi po cichu na 0.5. Pola potrzebują raw draft,
walidacji przed commit i guardów zapisu; suwaki range pozostają natychmiastowe.
Position/Rotation trafiają do współrzędnej SI i ramki kanonicznego monitora.
Brak aktywnego konsumenta useCrossSectionImageResource: widoczny efekt opcji
Edge width/Shrink jest NOT VERIFIED. Nie potwierdzono błędu sesji/ACK:
istniejący create jest scoped i testuje późny ACK po zmianie sesji.
Ta implementacja pozostaje otwarta; nie wprowadzono lokalnego obejścia,
które pozwalałoby Apply wysłać poprzednią liczbę przy błędnym raw tekście.

### Region sync — zamknięcie P2 i końcowe sprawdzenia źródeł

P2 właściciela zamknięte źródłowo. Memoizowany obiekt właściciela zawiera
sesję, objectId i regionId; aktywny ref jest ustawiany/zwalniany w layout
effect. Stan feedbacku porównuje obiekty właściciela, bez odczytu ref podczas
renderu. Powrót A→B→A tworzy nowego właściciela i nie przyjmuje starego wyniku.
Publish ACK oraz pojedynczy sync nie znikają przy zmianie widoku. Baseline,
draft i feedback są ograniczone do bieżącego właściciela. Globalny lock
mutacji pozostaje do końca sync, więc stary finally nie odblokuje innego
równoległego zapisu. Zwrócenie true dla zaakceptowanego ACK starego właściciela
nie czyści obecnego draftu: rodzic nie wykonuje globalnego reset/acknowledge,
a guard ponownie sprawdza selection/dirty po Apply.

Regresje obejmują jeden sync dopiero po ACK, przechwycony scope, brak sync po
odrzuconej mutacji, warning po sync failure bez replay, późną starą sesję,
retarget tego samego mounted panelu, późniejszy poprawny zapis B i A→B→A.
Review końcowego kodu i tego kontraktu nie ma otwartych P1/P2.
Commit `ad054d562e3215f5e0e25f1ef835ec452ba7edca`.

Końcowe produkcyjne typy, architecture hygiene i scoped lint 78 plików PASS,
ze stabilnymi źródłami:
`verification/frontend-production-source-e938d34663674ff1958701bef4b68e8c.json`.
Zatwierdzony interpretowany API hygiene PASS:
`verification/frontend-api-hygiene-1f95834f395244f0bb08918922cdcb97.json`.
React Doctor ostatniego pliku: bez pominięć, 0 błędów, jedno istniejące
ostrzeżenie rejestracji edit-session u rodzica:
`verification/frontend-production-source-d3ea0bd1259d44968e2cbb9258194cc5.json`.
W trakcie zamykania P2 lint odrzucił odczyt generation ref w renderze oraz
memo dependency wyprowadzone przez JSON.stringify; poprawiono model
właściciela, bez wyłączania reguł i bez pomijania testów/bramek projektu.
Nie kompilowano ani nie uruchamiano lokalnie testów jednostkowych TS/Rust.
Nowe regresje i exact-once browser wymagają kolejnego CI.

Retencja: cache/control/package pozostają potrzebne do kontroli i recovery.
Nie wykonano ciężkiego buildu ani kasowania danych. Pomiar C: 54 469 525 504 B
wolnego miejsca; nie przypisano zmian wolnego miejsca temu etapowi bez pomiaru
jego własnych artefaktów. Główny checkout i pozostałe grupy pozostały bez zmian
tej pracy. CrossSection, porównanie deklaracji About z manifestami, właściwy
Object 2D/3D/monitor, managed runtime/API, dalszy audyt i integracja są otwarte.

### Kolejny etap — przekroje, deklaracje i poprawki po CI

Stan CI dla `b18bcab742ad8fc9d9bc69e8be06f5fed06596b1`, run
`39881518616`: control-room-contracts FAIL (8855 PASS, 3 FAIL, 13 skip).
Jedna awaria dotyczy brakującej obsługi preferencji T→mT; dwie liczą wywołania
mockowanego hooka zamiast rzeczywistych żądań. Browser-fixture-smoke FAIL
ujawnił brak odpowiedzi metrics dla trzech obiektów świadomie wybieranych
przez scenariusze Explorer/opaque ID. Inspector-actions-browser-smoke PASS.
Artefakt browser `12470878438`, SHA256
`22b5296853525e86a5244a9673b470c76956f5b38346fc7fe905b0841687ce53`:
scenariusze rzeczywistych konsumentów walidacji PASS; region browser PASS
(9 scenariuszy, 3 mutacje i dokładnie 3 odpowiadające sync po ACK), responsive
i mesh-policy PASS. Wyniki te dotyczą fixture, nie kwalifikacji live backendu.

Zapisane zmiany:

- `c41bddfbd2effb7b0e61d214d4eac59ffd6cbb50`: T/mT mają wspólny wymiar
  indukcji magnetycznej i poprawne skalowanie; pozostają oddzielone od A/m.
- `fbb43aec142f390ae08669b5557c514c14651f60`: ChangeDevice nie fabrykuje
  identity_copy, backend_transfer, device_change ani żądania CPU, gdy danych
  brakuje. DSL zachowuje rzeczywisty requested intent.
- `33ecdd1d6597405ea5f70bf4f86cd835c429b4e4`: fixture metrics jawnie obsługuje
  film, audit-copy-30, audit-shrink-60 i film%, z encodeURIComponent oraz raw
  object_id odpowiedzi. Strict unknown-path rejection i limit 8 GET na ścieżkę
  pozostają. Test Planar sprawdza stabilne argumenty resource hooks zamiast
  utożsamiać render z HTTP; nadal sprawdza focus, scroll i pojedynczy patch.
- `30aac2a9bd26e174dca5e51e5e1183add9caf0ed`: cztery pola CrossSection
  zachowują raw text i zatwierdzają skończoną liczbę w zakresie po Enter/blur.
  Local/global Apply i New Image sprawdzają bieżący raw store. Slidery usuwają
  raw tylko własnego pola. Monotoniczna draftGeneration odróżnia zastąpione
  drafty, a sesja i plot ID ograniczają owner scope. Discard jest blokowany
  podczas create. Późny ACK nie usuwa nowszych raw/numeric zmian. Store
  ogranicza edgeWidth do 0.5–4. Regresje obejmują także replacement podczas ACK
  oraz A→B→A; ich wykonanie pozostaje zadaniem CI.
- `8a3379511a58f0113d4bc0cef93148a2d507046f`: About importuje deklaracje
  wyprowadzone z manifestów przez deterministyczny generator. Architecture
  hygiene wykrywa drift. Oddzielone są workspace/image Rust, deklarowane
  wymagania pakietów, CUDA Compose default i Dockerfile fallback. Wersja
  FullMag nadal pochodzi z buildInfo. Nie są to pomiary runtime hosta.

Pierwszy architecture check wykrył brak `.node-version` w zarządzanym cieniu
źródeł. Naprawiono istniejącą allowlistę readonly source fixtures o dokładne
pliki `.node-version`, Cargo.toml, rust-toolchain.toml i compose.toolchain.yaml.
Istniejący helper zweryfikował/utworzył wyłącznie te linki we własnym frontend
volume, bez restartu, kopiowania źródeł i zmiany ownera. Dwa interpretowane
testy dokładnych linków/przeciw obcym celom PASS. Receipt
`verification/frontend-production-source-b71cf9f1637c482db18038452abeb332.json`
ma wszystkie kroki PASS, ale cały stan failed z powodu równoległego dopisania
regresji TS i zmiany fingerprintu; nie używa się go jako dowodu stabilnego
całego etapu. Końcowy generator/architecture check wraz z hashami manifestów
PASS przy stabilnych źródłach:
`verification/frontend-production-source-1b1ebfd956874a3e9efb3e3247cb8ecb.json`.

Końcowe produkcyjne typy, architecture hygiene i scoped ESLint 90 plików PASS:
`verification/frontend-production-source-4b77af228e684e4b952ce0e9b56b745e.json`.
React Doctor 7 zmienionych plików produkcyjnych: 0 błędów, 0 ostrzeżeń,
bez pominięć, receipt
`verification/frontend-production-source-11fde358d7db4aaea5a746c8ce1c9e7e.json`.
Zatwierdzony interpretowany API hygiene PASS:
`verification/frontend-api-hygiene-ed68a27bdbd34017a339fb34ea4e1514.json`.
Hook commita wskazał istniejące heurystyki w skryptach smoke/architecture
(parse, sekwencyjne await i array lookup), poza zmienioną logiką; nie wyłączano
reguł ani nie przedstawiano ich jako regresji UI. Review źródeł nie wykazał
otwartych P1/P2 w tym etapie. Lokalnie nie kompilowano ani nie uruchamiano
testów TS/Rust. Browser akceptacja nowych pól przekroju i wykonanie nowych
regresji pozostają NOT VERIFIED do czasu odpowiednich wyników CI/browsera.

Grupa własnego checkoutu nadal ma działające kontenery, ale control receipt
pozostaje failed-confirmed; sam running nie potwierdza gotowości API. Nie
resetowano ownera, nie uruchamiano ciężkiego buildu ani nie usuwano danych.
Cache/control/package pozostają potrzebne do checks i recovery. C: wolne
51 451 351 040 B, bez przypisania różnicy tej pracy. Pełny audyt frontendowy,
live Object 2D/3D/monitor, managed runtime, finalne CI i integracja nadal otwarte.

### CI 45b82c625 — kolejne potwierdzenia i granice osiągalności

Run `39884401610`, HEAD `45b82c625af147fc389eb73aab1ddcd157662e41`:
control-room-contracts zakończone FAIL, 8874 PASS / 3 FAIL / 13 skip (8890).
Wcześniejsze awarie QuickChart T/mT i liczenia renderów Planar nie wróciły.
Nowe trzy błędy były w regresjach: tooltip formatter zachowuje 103.17, a nie
precyzję etykiety osi 103.2; brakowało helpera findElements; symulacja range
ustawiała wartość przez tracker Reacta przed eventem, więc onChange jej nie
wykrywał. Poprawiono wyłącznie setup/asercję właściwego formattera; wymaganie
natychmiastowego slidera i zachowania innych raw pól pozostaje. Commit
`e658d3e23ee5d7c7f8b33d8ac6ae6a3e4563056c`, scoped lint PASS, receipt
`verification/frontend-production-source-cb07615d22f5426dbbf9c0572afc06a1.json`.
Nie uruchamiano lokalnie tych testów TS.

Inspector-actions-browser-smoke PASS. Browser-fixture-smoke FAIL już później:
menu koloru zamykało się, ale natychmiastowa asercja zastała fokus na body.
Artefakt `12471804035`, SHA256
`74402425ebcb9c9cfb098ce0050585d8856ac582a3e5229c46adb9f3f5efa056`,
potwierdza PASS pierwszych 9 scenariuszy frontend-production, w tym raw `%`
i clipboard, rzeczywistych konsumentów walidacji oraz pełnej nawigacji drzewa.
Region browser (9 scenariuszy) i dotychczasowy responsive browser PASS;
page_errors w raporcie frontend-production są puste.

Odczyt zainstalowanego w własnym kontenerze Radix FocusScope 1.3.1 potwierdza
wywołanie unmount autofocus w setTimeout(0). Wrapper nie nadpisuje tej ścieżki,
a fixture zachowuje trigger w tej samej gałęzi. Kontrola czeka teraz do 2 s
na rzeczywisty focus konkretnego triggera, następnie nadal wykonuje ścisłą
asercję; nie używa arbitralnego sleep ani nie wymusza focus ręcznie. Hipoteza
wyścigu jest poparta źródłami, ale wynik po poprawce wymaga kolejnego CI.

Commit `ccc022deaf03ec0500cc84590eb2e7ca186cb34e` dodaje też rzeczywisty
Start → About → Toolchain przez klawiaturę, pomiary bounds/overflow i zrzuty
obu szerokości 320/640 CSS px przed zbiorczym błędem. 640 jest odpowiednikiem
układu 1280 przy 200%, nie pomiarem zmiany browser zoom. Kontrola zachowuje
draft Name i document budget bez resetu. Stały rail 232 px daje źródłowe
podejrzenie clipping przy 320, ale nie zmieniano CSS przed browser dowodem.
Nowy scenariusz pozostaje NOT VERIFIED. Lokalny własny frontend volume nie
ma zainstalowanego Chromium; nie instalowano zależności ani nie budowano
zastępczej ścieżki browsera.

Sprawdzenie rzeczywistych wejść UI zmienia kwalifikację dwóch obszarów:

- View → Monitor wywołuje beginPlanarMonitorDraft, nie beginCrossSectionDraft.
  CrossSection ma zarejestrowane trasy, lecz świeży workspace ma plots: [];
  New Image wymaga istniejącego plotu, a beginCrossSectionDraft nie ma
  produkcyjnego call site poza deklaracją. Nie wstrzyknięto testowego stanu
  przez evaluate, by udawać odbiór czterech poprawionych pól. Browser/live
  odbiór tego przepływu pozostaje otwarty.
- ModeCompositionInspectorRouteAdapter i jego panele nie mają konsumenta
  w aktualnym inspectorRouteCatalog. Commit
  `24b29a911d9093c69778374d31f47c40238a40a4` poprawia wyłącznie opcjonalny
  scaffold: pełną podmianę mode+field_id przy zachowaniu ustawień warstwy,
  optimistic/ACK snapshot i merge bieżącego layera, raw rate finite >= 0,
  owner scope bez resetu na revision oraz obsługę rejected Promise.
  Nie aktywowano nowych tras i nie traktuje się tego jako naprawy działającego
  routowanego UI. Review ujawnił P2 starszego reject nadpisującego nowszy
  feedback; current-operation fence i regresje obu kolejności zamykają go
  źródłowo. Nowe testy DOM nadal oczekują wykonania w CI.

Końcowe produkcyjne typy, architecture hygiene i scoped lint 97 plików PASS
przy stabilnych źródłach:
`verification/frontend-production-source-4a5d5fa2bc8c4aaaa21852a32d01ed59.json`.
Browser MJS syntax i wcześniejszy scoped lint PASS:
`verification/frontend-production-source-3e946e3fae63414493c3823d9f456685.json`.
Interpretowany API hygiene PASS:
`verification/frontend-api-hygiene-e228335133d34e4e9cbce5c72b3247e8.json`.
React Doctor czterech zmienionych plików produkcyjnych: 0 błędów, brak
pominięć, 3 istniejące ostrzeżenia (dwa mixed exports dla HMR i filter/map
na liście compatible objects), receipt
`verification/frontend-production-source-79ac3cd1e262450aa93d89b1d4757095.json`.
Hook commita wskazał też podobieństwo istniejących tabel i sekwencyjne await
w scenariuszach browsera; nie wyłączano reguł ani nie równoleglono zależnych
interakcji dla heurystyki. Pierwszy lint odrzucił mock switch bez role;
naprawiono semantykę mocka, a końcowy lint jest zielony.

Retencja: brak ciężkiego buildu, instalacji Chromium i usuwania danych.
Kontrole oraz receipty pozostają we własnych wolumenach, potrzebnych do
kontynuacji i recovery. C: wolne 45 672 603 648 B; różnicy nie przypisuje się
temu etapowi bez pomiaru właścicieli innych zapisów. Receipt backendu nadal
failed-confirmed. Cały cel jest aktywny: następne kroki to CI bieżących zmian,
reflow About, audyt pozostałych zarejestrowanych tras (m.in. transport,
observation frames i coupling), live odbiór Object/Airbox/2D/3D/monitor,
a następnie integracja. Nie ma podstaw do oznaczenia całego frontendu jako
gotowego produkcyjnie.

### CI e4a6fff3e i aktywne trasy transport/Coupling

Run `39887501130` dla `e4a6fff3e67e59cef3980f0ced05085f219fbbef`:
control-room-contracts FAIL, 8886 PASS / 1 FAIL / 13 skip (8900).
Wszystkie nowe regresje CrossSection, ModeComposition i poprawione wcześniejsze
testy przeszły. Jedyny błąd to osierocona klasa CSS po zastąpieniu starego
inputa ModeComposition przez QuantityField. Usunięto nieużywaną klasę i jej
focus-visible w `3a1e975183af25198df62a72992b7dd501c7a094`; wynik ponownej
bramki testowej pozostaje do potwierdzenia w CI.

Inspector-actions-browser-smoke PASS. Browser-fixture-smoke FAIL wyłącznie
w nowym reflow About. Artefakt `12473542983`, SHA256
`c89d3fdfc732e01b000311af726739c43bbdfa2ec861314fb7a1dff4324a4fcb`,
odczytano z weryfikacją digestu; obejrzano zrzuty 320 i 640 px. Audyt
frontend-production ma 10/10 scenariuszy PASS i page_errors: []. Potwierdzono
przywrócenie fokusu triggera menu koloru, bez ręcznego wymuszenia focus.
Dotychczasowy responsive-dock-and-header-at-four-widths PASS. Nowy About
przy 320 px potwierdza stały rail 232 px, kolumnę treści 88 px, a po gutterach
tylko 40 px dla toolchain; tekst i chipy są obcięte. To dowód browser fixture,
nie akceptacja live backendu ani solvera.

Poprawka Startu przenosi rail nad treść do 640 px, ogranicza go do 35dvh
z zachowaniem scrolla i wszystkich kontrolek Compute. Nawigacja zawija się,
aria-keyshortcuts pozostaje; wizualne kbd nie zabierają miejsca. Status strip
i etykiety chipów zawijają się, a minimum siatki engines nie przekracza
szerokości rodzica. Układ desktopu pozostaje poza tym breakpointem. Tradeoff:
przy 640 px jest mniej miejsca w pionie, ale pełna szerokość treści.
Niezależny review źródeł bez uwag blokujących; ścisły browser probe pozostaje
bez osłabienia i wymaga nowego CI.

Potwierdzono wejścia z Explorer i inspectorRouteCatalog przed poprawkami:

- Transport: wspólny parser `finite` przyjmował pusty tekst i whitespace jako
  zero. Teraz odrzuca brak wartości, zachowując jawne zero. Regresje obejmują
  absolute tolerance current/spin i offset source-cut. Lokalny Resource select
  omijał ochronę globalnego wyboru i porzucał dirty draft; jest zablokowany
  przy dirty/pending z jawną wskazówką Apply/Revert. Pozostałe pola nadal
  pozostają edytowalne. Dwa testy DOM sprawdzają Revert oraz odłożony ACK
  i próbę zmiany ownera także programatycznym eventem. Commit
  `e958f78f9b256d3b3d6dca66378728a02983c776`.
- Coupling: wcześniejsze akcje mogły użyć nieaktualnego zasobu lub kontekstu
  bez scope, powielić klik przed rerender i pokazać feedback poprzedniego
  ownera. Teraz wymagają ready zasobu bez refresh error, bezpiecznej rewizji
  i scope; mają synchroniczny in-flight guard, session/history fence,
  kontrolę zgodności rewizji przed zapisem i spójności ACK. Publikacja oraz
  pojedynczy scoped Python sync następują po ACK. Zmiana celu w tej samej
  sesji zachowuje publikację zaakceptowanej mutacji, lecz nie jej feedback
  w nowym panelu; A→B→A nie omija fence. Błąd sync jest ostrzeżeniem o już
  zapisanej zmianie, bez replay. 14 przypadków DOM obejmuje też stale/loading,
  niezgodną rewizję, niespójny ACK i odrzuconą transakcję. Commit
  `e744b7524e5f47b5509e53f727e95578e4e4569c`.

Końcowy typecheck produkcyjny, architecture hygiene i lint 103 plików PASS,
źródła stabilne, receipt
`verification/frontend-production-source-a703e8ca613b4637809d179006e9a1e4.json`.
API hygiene PASS:
`verification/frontend-api-hygiene-403ed13010a24ca8b54543238f3c2fef.json`.
React Doctor 3 plików produkcyjnych: 0 błędów, brak pominięć, 2 istniejące
ostrzeżenia; receipt
`verification/frontend-production-source-90992fa855ed4d68b8d4a3d6485203af.json`.
Odczyt kodu nie potwierdza ich jako regresji: przyciski interfejsów mają
klucz id+index bez lokalnego draftu, a densityOfStates przechodzi kontrolę
typu i finite przed mnożeniem. Nie wyłączano reguł. Lokalnie nie kompilowano
ani nie uruchamiano testów TS/Rust. Nowe regresje transport/Coupling oraz
browser odbiór reflow pozostają NOT VERIFIED do kolejnego CI.

ObservationFrame pozostaje otwartym obszarem: Explorer bierze domyślnie
pierwsze 50 rekordów i nie konsumuje next_cursor. Pin ma scope sesji,
natomiast endpoint szczegółów i magnetyzacji wybiera aktywny run; pin z innego
run może więc przestać być dostępny po zmianie run/cache. ADR 0025 i P6
nie ustanawiają jednoznacznej obietnicy cross-run pin. Nie rozszerzono API
ani nie przedstawiono nieaktywnych danych jako odczytanych. Następne kroki:
pagination i jawny kontrakt pin/run, pozostałe zarejestrowane Inspectory,
live Object/Airbox/2D/3D/monitor oraz końcowe CI i integracja PR #249.

Retencja: bez ciężkiego buildu, instalowania zależności, restartu grup,
resetu ownera i usuwania danych. Własne wolumeny nadal służą sprawdzeniom
i recovery. Backend receipt pozostaje failed-confirmed; sam działający
kontener nie jest dowodem API/runtime. C: wolne 45 514 788 864 B; brak
podstaw do przypisania zmian miejsca temu etapowi. Cały cel nadal aktywny.

### CI 2cf3b2da2 — bramka kontraktów zielona, aktualność observation source

Run `39890660859`, HEAD `2cf3b2da2a99462b3806534bd1eca71a209892d2`:
control-room-contracts PASS, 858 plików PASS / 1 skip; 8908 testów PASS /
13 skip (8921). Obejmuje nowe regresje transport/Coupling, usunięcie
osieroconego CSS oraz wcześniejsze CrossSection/ModeComposition. Dodatkowe
3 testy compute performance i build aplikacji również PASS. To dowód CI,
nie lokalnego uruchomienia testów ani akceptacji solvera/live viewportu.
Inspector-actions-browser-smoke i pozostałe nieskipowane joby bootstrap PASS;
wyjątkiem pozostaje browser-fixture-smoke.

Artefakt browsera `12474786888`, SHA256
`06b6ef85c13fe7eeb5d11b29774293875f1bdc23f788ec79bfe18f048f7bdcf8`,
odczytano z kontrolą digestu. About ma geometryFailures: [], oba układy
320/640 px obejrzano. Jedyna awaria to kontrola Name podczas otwartego Startu:
beforeHome i afterReturn mają tę samą wartość draftu, whileHome było null.
Kod wyjaśnia przyczynę: layout.css nadaje workspace visibility:hidden podczas
HomeOverlay, a getByRole domyślnie pomija taki element. Ta asercja nie dowodziła
utraty danych. Probe teraz sprawdza zapisane wcześniej DOM refs: isConnected,
równość bieżącego root/input, oba markery i wartość podczas Startu, po reflow
i po powrocie. Widoczny getByRole po powrocie nadal obowiązuje. Screenshot
przewija też sam toolchain do widoku. Review nie znalazło osłabienia wymagania;
wynik zmienionego probe wymaga kolejnego CI.
Commit probe: `76f765979dfcac92a051a376be6685cacc3c0586`.

Zamknięto źródłowo dwa następne problemy rzeczywistych observation routes:

- Inspector używał retained descriptor do aktywowania Pin source mimo stale
  lub refresh error. Pin wymaga teraz ready bez refresh error i zgodności
  frame/run/stage/adapter/accepted step/revision/runtime epoch/state digest
  z selection. Pokazuje błąd lub jawny stan wcześniejszych danych. Pasujący
  istniejący pin zachowuje Unpin także po błędzie odświeżania. Overview mówi
  Loaded frames i sygnalizuje next_cursor, zamiast sugerować kompletny count.
  14 przypadków DOM zapisano; commit
  `aa03f2e688c2286252fb8e79d3a811a0dd1552cc`.
- Viewportowy hook przypiętej magnetyzacji potwierdza aktywny run istniejącym
  resource hookiem. Przy innym/niepotwierdzonym runie wyłącza odczyt i projekcję
  cached payloadu. SceneModel zeruje retained envelope tego źródła; primary
  live fallback pozostaje wyłączony. Pin nie jest usuwany, powrót do jego runu
  może ponownie udostępnić to samo źródło; overlay analizy zachowuje priorytet.
  Status wyjaśnia brak zgodności runu, retry kieruje do current-run resource.
  Commit `8cda33d0b97716c53eb5a61d3cb6ce10a20b9bc8`.
  7 regresji hooka/helpera sprawdza projekcję przy celowo retained warm danych,
  A→B→A oraz niepotwierdzone identity. Mock nie wykonuje loadera: nie jest to
  dowód anulowania prawdziwego requestu, późnego network ACK ani WebGL.

Typecheck produkcyjny, architecture hygiene i lint 108 plików PASS,
źródła stabilne:
`verification/frontend-production-source-adb34cde1cb8477582467830e54e3067.json`.
Końcowy MJS syntax i lint probe/testów PASS:
`verification/frontend-production-source-0aad2ce4c5024ac3be09457e99015d45.json`.
API hygiene PASS:
`verification/frontend-api-hygiene-78c5187a89ff455db1201963437a8c82.json`.
React Doctor 3 zmienionych plików produkcyjnych: 0 błędów/pominięć, 1 istniejące
ostrzeżenie filter/map w SceneModel, poza zmienionym fragmentem; receipt
`verification/frontend-production-source-308f75da584a4e9195875fa47349c3d0.json`.
Nowe regresje observation i browser/WebGL odbiór pozostają NOT VERIFIED.
Testów TS/Rust lokalnie nie kompilowano ani nie uruchamiano.
Hook commita probe zgłosił też 4 await-in-loop i lookup w istniejących pętlach
scenariuszy browsera. Interakcje i resize wymagają kolejności; nie zrównoleglono
ich ani nie wyłączano reguł dla heurystycznego wyniku.

Następny konkretny etap: pager resource hooku dla Explorera, jawne Load more
po 50 cienkich descriptorów i zachowanie wcześniej wybranej klatki. Istniejący
hook jednej strony pozostaje właścicielem klucza sesja/run/stage/cursor/limit.
Akumulator stron musi resetować scope, odrzucać późne wyniki, walidować run,
unikalność frame_id i postęp next_cursor. Refresh odświeża tylko zażądane
strony; retry ponawia dokładnie nieudaną stronę, bez automatycznego pobierania
całego runu. Regresje muszą objąć append bez utraty selection, błąd/retry,
bounded Refresh i zmianę sesji/runu podczas requestu; browser potwierdzi brak
drugiego odczytu bez kliknięcia. Implementacja paginacji nadal otwarta.

Retencja: brak ciężkiego buildu/instalacji/restartu, owner reset i usuwanie
danych nie były wykonywane. Własne wolumeny pozostają potrzebne do sprawdzeń
i recovery; backend receipt nadal failed-confirmed. C: wolne 40 580 079 616 B,
bez przypisania różnicy temu etapowi. Pozostałe rodziny Inspectora, live
Object/Airbox/2D/3D/monitor oraz integracja PR #249 nadal otwarte.

### CI 56391cc61 — zielone bramki, jawna paginacja State snapshots

HEAD `56391cc611a2ef8a00f3688d77f3473e7604e023`: bootstrap
`39892754349` PASS; eigensolve-ui-method-contracts `39892754306`,
contract-guard `39892754321` i dispersion-artifact-consumers `39892754316`
również PASS. Control-room-contracts: 860 plików PASS / 1 skip, 8929 testów
PASS / 13 skip (8942), dodatkowe 3 testy compute performance i build PASS.
Nowe regresje aktualności observation descriptor oraz projekcji pin/run
zostały więc wykonane w CI. Inspector-actions-browser-smoke i główny
browser-fixture-smoke PASS. Nie oznacza to odbioru live backendu/WebGL.

Artefakt `12475726735`, SHA256
`21af6e07048f89a2e747f503136f3f8bdf9f60b9f8774268b0216403544eecd1`,
zweryfikowano przy odczycie; obejrzano toolchain 320/640 po przewinięciu.
Frontend-production: 10 scenariuszy PASS, page_errors: []. Responsive:
3 scenariusze PASS. About geometryFailures i stateFailures puste. Ten sam
root/input pozostaje connected z zachowanymi markerami i wartością Name
podczas Startu, po reflow i po powrocie. Request budget zachowuje ten sam
documentId i documentLabel. Wcześniejsza awaria hidden getByRole nie wróciła.

Commit `ec96942bdb295f4fc29641f2b1601f4742fbc260` dodaje paginację:

- `useObservationFrameListPages` składa wyłącznie zażądane strony istniejącego
  hooka; „Load more snapshots” dopisuje następną stronę bez usuwania pierwszej
  ani zmiany selection. 50/200 pochodzą z kontraktu API, nie z limitu UI.
- Owner obejmuje klienta API, tożsamość sesji, run/stage i limit. Brak exact
  runu nie uruchamia katalogu. Hook strony nadal posiada abortStaleInflight,
  cache/dedup i kanoniczny session-scoped resource key.
- Refresh od początku odwiedza tylko wcześniej zażądane okno stron, według
  świeżych next_cursor. Stary zakres pozostaje widoczny do zakończenia.
  Dotychczasowe immutable ramki wypchnięte poza częściowe okno przez nowy
  etap są zachowane, deduplikowane po późniejszym Load more i czyszczone przy
  końcu pełnego katalogu lub zmianie ownera. To zamyka P2 znalezione w review.
- Walidacja odrzuca obcy run/stage, przekroczony rozmiar, powtórzone frame_id,
  zły next_cursor i zerwany łańcuch. Błąd kolejnej strony nie usuwa wcześniejszych
  danych; Retry ponawia ten sam kursor i blokuje powtórny klik tego samego błędu.
- Grupa paginacji ma aria-busy oraz jawne loading/error/retry. Jej terminalny
  stan można odróżnić od wyświetlania wcześniejszych danych podczas Refresh.

Zapisano 12 przypadków modelu i 5 DOM hooka: append zachowujący descriptor,
bounded Refresh i przesunięte granice stron, koniec katalogu, błędy envelope,
duplikaty, retry i zmiana run/session. Hook DOM używa kontrolowanego zasobu;
nie stanowi dowodu sieciowego anulowania starego requestu.

Nowy browser scenariusz używa 55 cienkich descriptorów. Sprawdza brak drugiej
strony bez kliknięcia, sekwencję cursor null → frame-050, zachowanie wybranej
pierwszej ramki, Refresh dokładnie dwóch stron i wybór ostatniej ramki przez
filtr. Przy Refresh wstrzymuje odpowiedź drugiej strony i czeka na potwierdzone
przechwycenie; sprawdza busy i selection przed zwolnieniem, potem obie odpowiedzi
oraz terminalny stan UI. Fixture wraca do wcześniejszego katalogu w finally.
Limit GET pozostaje 8; dodano jawną asercję requestBudgetViolation === null.
Nowe regresje i scenariusz browsera oczekują wykonania w CI; lokalnie testów
TS/Rust nie kompilowano ani nie uruchamiano.

Pierwszy lint odrzucił synchroniczny setState w efekcie konsumpcji strony.
Zastąpiono go warunkowym dostosowaniem własnego akumulatora przy zmianie
resource snapshot; efekt synchronizuje tylko zewnętrzny refetch. Nie wyłączano
reguły. Końcowy produkcyjny typecheck, architecture hygiene i lint 115 plików
PASS, stabilne źródła:
`verification/frontend-production-source-8e85d9fa070c45c584c98ca116238994.json`.
Po ostatnim doprecyzowaniu browsera syntax i scoped lint PASS:
`verification/frontend-production-source-ffc46c807f354d5aa24eebc16999acfa.json`.
API hygiene PASS:
`verification/frontend-api-hygiene-adf1746618c1421cba22bab0e85a0552.json`.
React Doctor: 5 plików (4 produkcyjne i wspólny fixture), 0 błędów/pominięć,
3 istniejące ostrzeżenia Explorera: dwa mixed exports dla HMR i filter/map;
receipt `verification/frontend-production-source-8118e9e3fbc349eb91d2b7e7ed6939e7.json`.
Hook commita zgłosił też istniejące heurystyki pętli/URL w skryptach browsera;
nowa pętla rozwija kolejne poziomy drzewa, więc wymaga sekwencji. Nie zmieniano
reguł ani nie równoleglono zależnych interakcji.

Retencja: brak ciężkiego buildu, instalacji, restartu, resetu ownera i usuwania
danych. Receipty/cache we własnych wolumenach pozostają potrzebne do weryfikacji
i recovery; backend control nadal failed-confirmed. C: wolne 37 106 233 344 B;
różnicy nie przypisuje się temu etapowi. Następne kroki: CI paginacji, audyt
FrozenSpins i pozostałych aktywnych rodzin, rzeczywiste request/cancellation
oraz live Object/Airbox/2D/3D/monitor, a potem integracja PR #249.

Następny read-only audyt potwierdził aktywną ścieżkę FrozenSpins:
`objectExplorerNodes` → `explorerSelection` → route catalog →
`panels/constraint/FrozenSpinsInspectorPanel.tsx`. Otwarte ustalenia źródłowe:

- P2: `panels/selection/SelectionExpressionBuilder.tsx:396` używa Number(trim)
  i filtruje finite: pusty składnik staje się zerem, a błędny znika. Przykłady
  `1, , 3` → `[1,0,3]`, `x,2` → `[2]`. Lokalny błąd skalara nie wpływa też
  na valid=true globalnej sesji Inspectora.
- P2: retained definition ukrywa błąd odświeżenia (panel:83–100), a resource
  status solvera jest pomijany przy etykiecie „Waiting” (panel:502–504).
- Warunkowy P2: brak membership jest normalizowany do static (panel:949),
  mimo że `docs/specs/frozen-spins-v1.md:104–108` uzależnia domyślną politykę
  od AST i wymaga snapshot_at_activation dla selektora zależnego od stanu.
- P2: builder:494–526 wstawia zastępcze asset/region/selection IDs zamiast
  istniejących referencji; węzeł obiektu rzeczywiście nie ma regionId.
- Niższy priorytet: Delete przy dirty draft uruchamia guard dopiero po ACK;
  wybór Apply w tym momencie próbuje zmieniać już usuniętą definicję.

Nie potwierdzono wycieku późnego ACK Apply/Activate ani zwykłej zmiany ownera.
Ustalenia nie są wykonanymi regresjami. Poprawki wymagają zachowania surowych
tekstów, blokady mutacji przy błędzie i zgodności z kontraktem selekcji;
nie zostały jeszcze zaimplementowane. Cały cel pozostaje aktywny.

### CI paginacji: rozdzielenie nowego i zapamiętanego kursora

CI HEAD `45bd7ad9078bb07177f32887d7529eb425f2781f`, run
`39895819935`, job `120225909793`: 8945 testów PASS, 13 skip,
1 FAIL. Jedyną porażką była asercja liczby ręcznych refetch w regresji
`refreshes only the loaded window and follows refreshed cursors`.
Odczyt hooka wykazał, że dla nowego klucza zasobu stan loading rozpoczyna
automatyczne pobranie; dodatkowy refetch jest potrzebny dla ready cache.
Test obejmuje teraz osobno oba przypadki, wymaga pozostawienia starego
okna podczas oczekiwania i nie dopuszcza wstawienia starego cache.
Nie zmieniono produkcyjnego algorytmu ani nie usunięto kontroli świeżości.

Produkcjny typecheck, architecture hygiene i lint 115 plików PASS,
stabilne źródła; receipt
`verification/frontend-production-source-650d5faaac074ca085c1c17f0a5e8a37.json`.
Lokalnie nie uruchamiano ani nie kompilowano testów TS/Rust.
Nowa para wariantów wymaga potwierdzenia przez CI kolejnego HEAD.
Bez builda, restartu i usuwania danych; potrzebny cache i receipty zachowano.

### Frozen Spins: automatyczna polityka membership bez wymuszonego static

Usunięto frontendowy fallback `membership → static`. Ominięte i null pole
pozostają nieokreślone podczas edycji pozostałych pól. Select pokazuje wtedy
`Automatic (from selector)`; powrót z jawnej polityki do Automatic zapisuje
`null`, co dopuszcza wygenerowany `FrozenSpinsSchema`. Rozstrzygnięcie
geometry_only/state_dependent, również przez named selection, pozostaje
kanonicznej analizie opisanej w §7 `docs/specs/frozen-spins-v1.md`.
UI nie próbuje zastępować jej analizą wyłącznie lokalnego AST.

Dodano trzy regresje DOM: zachowanie undefined i null po edycji nazwy
selektora ref oraz przejście snapshot_at_activation → Automatic. Weryfikują
payload UI, nie wykonanie backendowej analizy named selection.
Source review bez potwierdzonych P1/P2 w delta. Produkcyjny typecheck,
architecture hygiene i scoped lint dwóch plików PASS, receipt
`verification/frontend-production-source-c399f07ce0a74889bf36e4f0b39ccc59.json`.
API hygiene PASS:
`verification/frontend-api-hygiene-75524b1c9b99448288a03b0abd7c1df5.json`.
React Doctor: 0 błędów i pominięć, 5 istniejących ostrzeżeń panelu:
związane useState, 2 aktualizacje baseline w efekcie props oraz 2 eksporty
helperów utrudniające Fast Refresh. Receipt
`verification/frontend-production-source-0f02c8ffe43045278a83b089be7b7da2.json`.
Te ostrzeżenia pozostają do oceny przy dalszym porządkowaniu panelu;
nie wyłączano reguł. Lokalnie bez kompilacji/uruchamiania testów TS/Rust.
Nowe regresje wymagają CI kolejnego HEAD. Cały audyt i live qualification
pozostają otwarte; poprawka membership nie zamyka pozostałych ustaleń Frozen Spins.

### Browser paginacji: jednoznaczny właściciel Inspectora

Zakończony job browser-fixture-smoke `120225909634` dla `45bd7ad90`
potwierdził drugi błąd samej regresji: locator
`[data-inspector-owner="observation-frame"]` dopasowuje zarówno sekcję
Inspectora, jak i wewnętrzny panel. Playwright przerwał scenariusz strict
mode violation przed Load more; nie jest to dowód ukończonej paginacji.
Poprzednie scenariusze frontend-production przeszły, page_errors były puste.

Locator ograniczono do `section.fm-inspector` z tym właścicielem. Scenariusz
czeka też na dokładne ID wybranej ramki w tym Inspectorze przed asercją
zachowania i po przejściu do ostatniej ramki. Nie dodano `.first()` ani
stałego opóźnienia; kontrole świeżych odpowiedzi, zaznaczenia i budżetu
pozostają aktywne. MJS syntax i scoped lint PASS, stabilne źródła, receipt
`verification/frontend-production-source-89d9c9ad196846688485633ac513cf37.json`.
Ponowne wykonanie scenariusza wymaga CI nowego HEAD.

### Potwierdzone CI paginacji i membership — be71f2596

HEAD `be71f259609dec1c1a9c3f5aa6308a7c00e8cce0`: Control Room contracts
job `120230641425` w run `39897269744` PASS: 8950 testów PASS / 13 skip,
862 pliki PASS / 1 skip, compute performance plus 3 testy i produkcyjny build PASS.
Browser fixture job `120230641444` PASS: 11 scenariuszy frontend-production,
w tym paginacja 55 ramek, oraz 3 scenariusze responsive. Page errors puste.
Paginacja: kursory `[null, audit-frame-050, null, audit-frame-050]`, selection
zachowane podczas Load more i obu stron Refresh, ostatnia ramka wybieralna.
About 320/640: geometry/state failures puste, request budget bez zmian.

ZIP artefaktu `12477931353` odczytano w pamięci i zweryfikowano SHA256
`d6f42ae50b4185cc4525ce5fe5d1fa72a6fce7e90da1f2ce3344bff0f44df587`.
Obejrzano screenshot ostatniej ramki: Step 55 zaznaczony, licznik 55,
czytelne drzewo i filtr. Nie jest to nowy dowód live API ani solvera.
Workflow eigensolve `39897269743`, contract-guard `39897269770` i
dispersion-artifact-consumers `39897269833` PASS; bootstrap w chwili odczytu
pozostawał in_progress, więc nie deklaruje się całego runu jako PASS.

### Frozen Spins: wspólne raw drafts, struktura selektora i konflikty

Wszystkie numery selektora korzystają z QuantityField: commit na Enter/blur,
Escape odrzuca tekst, Revert czyści wspólny rejestr i przywraca baseline.
Wektor wymaga dokładnie 3 składników, quaternion 4. Puste, niekompletne,
nieskończone i błędne składniki nie są zamieniane na zero ani pomijane;
jawne zero pozostaje legalne. Obsługiwany jest zapis dziesiętny/naukowy,
z zachowaniem dotychczasowych min/max pól.

Raw draft, także poprawny przed commit, ustawia globalne dirty/invalid i
blokuje lokalne/globalne Apply, Preview i Commit preview. Handlery ponownie
odczytują store. Operator/kind scalar/kind geometry i Remove clause mają
blokady także w handlerach, aby indeksy list nie przenosiły raw tekstu do
innego dziecka. Add clause nie przesuwa istniejących pól. Zwijanie grup
pozostawia dzieci zamontowane, więc raw tekst pozostaje w rejestrze.
Delete wymaga czystego draftu; scope/history/mounted fences chronią jego
ACK. Preview ma ten sam in-flight guard i scope/history fence co mutacje,
snapshot selektora requestu, a nowszy raw draft nie uzbraja Commit preview.
Komunikat nie deklaruje już widoczności w 3D na podstawie samego response.

Review wykryło P2: raw draft + incoming name B pozostawiało canonical name A,
które następny Apply mógł wysłać jako niezamierzone cofnięcie. Naprawiono przez
trójstronne scalanie pól baseline/incoming/draft: niezależne pola serwera są
adoptowane, lokalne pozostają, a konflikt tego samego pola lub zmiana selektora
przy raw pending blokuje mutacje do Revert. Raw pola nie są odmontowywane.
Starszy ACK nie cofa nowszej rewizji/baseline. Ponowne source review bez
otwartych potwierdzonych P1/P2 w delta.

Dodano 18 przypadków parsera, 5 modelu scalania oraz 15 DOM: raw blank/invalid
i valid-pending, lokalne/globalne akcje, Enter/blur/Escape/Revert, legalne zero,
ochrona struktury/usunięcia siblinga, raw wpis w locie Apply/Preview, zmiana
sesji, niezależne incoming fields, konflikt selektora i starszy ACK. To nowe
regresje do wykonania w CI; lokalnie nie kompilowano/uruchamiano testów TS/Rust.

Końcowe produkcyjne typy, architecture hygiene i scoped lint 7 plików PASS,
stabilne źródła:
`verification/frontend-production-source-353d9aee9f8b4a0f9bb4964c14cc1f45.json`.
API hygiene PASS:
`verification/frontend-api-hygiene-8cc5e9d54d2e4f3eb34e0ca4375189f6.json`.
React Doctor: 4 pliki produkcyjne, 0 errors/skips, 7 ostrzeżeń:
1 related useState, 3 aktualizacje props w efekcie (w tym nowa blokada konfliktu),
2 mixed exports, 1 istniejący index key. Ten ostatni ma teraz jawną ochronę
zmian struktury przy raw pending i regresję; nie nazywa się go usuniętym.
Receipt `verification/frontend-production-source-5b6d01f47fee47ccbb0bb25ecd701251.json`.
Bez suppression reguł. Pierwszy source pass `8efbcaef4f4144e0a3d230dabdff052b`
poprzedzał znalezienie P2 i nie jest dowodem końcowego scalania.

Retencja: bez buildu, instalacji, restartu, resetu ownera i usuwania danych.
Potrzebny cache/receipty zachowano. Wolne C: 36 254 400 512 B; różnicy nie
przypisuje się temu etapowi. Otwarte: CI nowego HEAD, retained definition i
solver refresh/errors, referencje selektora i semantyczna walidacja, pozostałe
rodziny Inspectora oraz live kwalifikacja. Cały cel pozostaje aktywny.

### CI raw drafts — 36d516474

HEAD `36d516474f6e7c6912d3b3337c06a929951684bc`, run `39898810758`:
Control Room job `120235365088` PASS — 8988 testów PASS / 13 skip,
864 pliki PASS / 1 skip, compute performance i osobne 3 testy PASS,
produkcyjny build PASS. Obejmuje 38 nowych przypadków numeric input,
rekoncyliacji i DOM Frozen Spins. Browser fixture job `120235364688`
pozostawał in_progress w ostatnim odczycie; nie rozszerza się sukcesu
kontraktów na cały workflow ani live runtime.

### Frozen Spins: retained definition i aktualność certyfikatu solvera

Panel przyjmuje wyłącznie definicję zgodną z wybranym constraint ID. Last-good
aktualizuje się z potwierdzonego ready bez error/refreshError. Przy retained
data błędy odczytu pozostają widoczne, Retry definition ponawia zasób,
a ten sam keyed editor i Name draft pozostają zamontowane. Loading/stale,
brak aktualnych danych i niezgodny ID blokują Apply/Preview/Commit/Delete,
również globalny i imperatywny Apply. Revert nadal pozwala odrzucić lokalne
edycje. Początkowy błąd bez danych ma Retry bez montowania fałszywego edytora.

Status solvera jest osobną bramką. Tylko ready, niepusty zasób bez error ani
refreshError dostarcza bieżący certyfikat do porównania z activation receipt.
Loading/stale/error/unavailable nie są już prezentowane jako oczekiwanie na
aktywację ani potwierdzony/mismatch certyfikat z cache. Epoka i resolved-set
revision są wtedy unconfirmed. Bieżący status bez frozen_spins nadal oznacza
rzeczywiste pending; świeży niezgodny certyfikat pozostaje mismatch.
Refresh solver status umożliwia jawne ponowienie. Akcja quantity znika przy
nieaktualnym statusie i ma ten sam guard w handlerze, in-flight lock oraz
scope/unmount fence przed przeniesieniem focusu po flush.

Receipt opisuje teraz stan **przy commit**, a nie bieżący stan solvera:
Application at commit, Solver at commit i wiadomość kierująca do aktualnego
potwierdzenia poniżej. Komunikat uwzględnia oba warianty
current_runtime_unchanged; nie utrzymuje „still pending” po świeżym potwierdzeniu.
Nie zmieniono porównania tożsamości certyfikatów ani semantyki solvera.

Dodano 12 regresji DOM: retained stale/error → retry → zachowany node/draft,
pending bez błędu, initial failure, wrong ID; solver loading/stale/error/
refreshError/missing → recovery, genuine pending i świeży mismatch, flush
po zmianie sesji. Istniejące asercje receiptu doprecyzowano historycznie.
Review źródłowe nie wykazało otwartych potwierdzonych P1/P2 w delta;
wykonanie nowych przypadków należy do CI kolejnego HEAD.

Końcowy produkcyjny typecheck, architecture hygiene i scoped lint PASS,
stabilne źródła, receipt
`verification/frontend-production-source-eac17836c8514d87b3f7dc51c2b0911f.json`.
API hygiene PASS:
`verification/frontend-api-hygiene-826e163e0d0742fba8e629f61f49cbb2.json`.
React Doctor: 1 produkcyjny plik, 0 errors/skips, 6 istniejących ostrzeżeń
(related useState, 3 prop adjustments, 2 mixed exports), receipt
`verification/frontend-production-source-f6c6dc7b66684198a81610aca31eeba2.json`.
API/Doctor wykonano przed końcową zmianą wyłącznie opisowych etykiet receiptu;
końcowy typecheck/architecture/lint obejmuje też te etykiety. Bez suppression.
Lokalnie nadal bez kompilacji/uruchamiania testów TS/Rust.

Retencja: bez builda/instalacji/restartu/usuwania danych/resetu ownera.
Cache i receipty są potrzebne do dalszej weryfikacji/recovery i pozostają.
Wolne C: 36 252 450 816 B; różnicy nie przypisuje się temu etapowi.
Otwarte: CI tego etapu, referencje/semantyczna walidacja selektora,
pozostałe aktywne rodziny i pełna live kwalifikacja. Cel pozostaje aktywny.

### CI retained resources — 04f695a72

HEAD `04f695a7222666d0830b0e7e703bacdf4861ec10`, run `39899835802`:
Control Room job `120238705550` PASS — 9000 testów PASS / 13 skip,
864 pliki PASS / 1 skip, compute performance + osobne 3 testy i build PASS.
Nowe 12 przypadków definition/solver freshness przeszło. Browser fixture
job `120238705999` PASS: explorer-and-controls (w tym paginacja), responsive,
region editing i Object/Airbox mutation stability; page_errors puste.
Cały bootstrap był nadal in_progress przy odczycie, więc nie deklaruje się
wszystkich bramek jako ukończonych. Dowód fixture nie zastępuje live runtime.

### Frozen Spins: katalogi referencji i nieobsługiwane selektory

Usunięto placeholdery `region`, `selection` i `asset`. Nowa referencja wymaga
jawnego wyboru; nie jest wybierany pierwszy wpis. Istniejący useSceneResource
jest wspólnym, typowanym źródłem obiektów, ich regionów i named selections.
Nazwy służą etykietom; wartości i klucze zachowują dokładne opaque IDs.
Region bez jawnego region_id nie staje się kandydatem na podstawie nazwy.
Lista regionów jest ograniczona do wybranego obiektu; zmiana obiektu czyści
poprzedni region, nawet gdy inny właściciel ma podobną nazwę/ID regionu.

Brakujący bieżący ID jest widoczny jako Unavailable i pozostaje w AST.
Loading/stale/error katalogu nie zmienia wartości ani nie wybiera zamiennika;
blokuje edycję referencji i zależne Apply/Preview/Commit, także globalne oraz
imperatywne. Refresh selector catalog ujawnia błąd i ponawia istniejący zasób.
Odzyskanie katalogu zachowuje Name i numeric raw drafts. Bezpośrednie
nieistniejące referencje, puste klauzule i odwrócone bounds mają blokadę
authoringu. Sprawdzenie obecności named ID **nie dowodzi** poprawności grafu,
braku cykli, zagnieżdżonych referencji ani zgodności z target object;
kanoniczny Preview/commit pozostaje walidatorem i pokazuje jego błąd.

Audyt źródeł potwierdził, że katalog magnetization assets nie jest katalogiem
selection occupancy. Nie dodano takiego adaptera ani nowego endpointu.
IR `crates/fullmag-ir/src/validation.rs` odrzuca imported_solid przez
`selection_imported_solid_unqualified`; evaluator w
`crates/fullmag-plan/src/selection/geometry.rs` nie ma kwalifikowanego occupancy,
zgodnie z walidacją publicznego Python DSL. Tworzenie tego wariantu usunięto
z listy. Istniejący authored selector, także zagnieżdżony, oraz nieznane kinds
mają jawny Advanced/unsupported (preserved), readonly i oryginalny JSON.
Nie są przepisywane na box ani inny domyślny AST. Ten UI guard nie zmienia
semantyki backendu ani nie jest dowodem kwalifikacji fizyki.

Dodano 21 regresji: 10 modelu katalogu/opaque IDs/ownerów/unsupported/depth,
5 DOM buildera (jawny wybór, missing/stale/recovery, brak imported creation,
readonly imported/future) i 6 DOM edytora (global guards, ponowienie katalogu,
missing opaque ID, canonical graph rejection i raw numeric podczas refresh).
Review bez potwierdzonych P1/P2; wskazany brak bezpośredniej regresji raw
podczas refresh uzupełniono. Lokalnie bez kompilacji i uruchamiania TS/Rust
unit tests; wykonanie nowych przypadków wymaga CI następnego HEAD.

Produkcjny typecheck, architecture hygiene i lint 6 plików PASS, stabilne
źródła, receipt
`verification/frontend-production-source-5e0059f4d2fd4939abb1fb1dec9c2d81.json`.
Później dodano wyłącznie 3 przypadki testowe; ich końcowy scoped lint PASS:
`verification/frontend-production-source-c87ed00f26a446b1b7521417bcabbdab.json`.
API hygiene PASS:
`verification/frontend-api-hygiene-58a54851fe24403d818ca277d1594e4a.json`.
React Doctor: 3 pliki produkcyjne, 0 errors/skips, 7 istniejących ostrzeżeń
(related useState, 3 prop adjustments, 2 mixed exports, index key chroniony
blokadą struktury przy raw pending), receipt
`verification/frontend-production-source-9916b9282b7a451c981c962a225b9c47.json`.
Bez suppression, nowych zależności i endpointów. Nie wykonywano nowego
browser/live proof dla formularza referencji; pozostaje do kwalifikacji.

Retencja: brak builda, instalacji, restartu, owner resetu i usuwania danych.
Potrzebny cache/receipty zachowano. Wolne C: 36 234 625 024 B; różnicy nie
przypisuje się temu etapowi. Otwarte: CI nowych 21 przypadków, dalsza walidacja
geometrii/axis/transform i pól aktywacji/referencji, pozostałe aktywne rodziny,
browser oraz managed live qualification i integracja PR #249.

### Checkpoint: synchronizacja kanonicznego Python po Frozen Spins

Potwierdzono lukę: historia mutacji zapisuje scenę, ale Apply, Commit preview
i Delete nie wywoływały osobnego model.syncAuthoringScript. Po ACK używają
teraz istniejącego syncAuthoringScriptBestEffort z przypiętą sesją. Sync może
dokończyć się po unmount w tej samej sesji; lokalny UI, selekcja i przyjęcie
ACK są chronione przez mounted/session/history generation. Błąd sync nie
cofa zatwierdzonej mutacji i nie powoduje jej ponowienia; pozostaje widoczny
jako osobne ostrzeżenie. Edycje podczas oczekiwania zachowują dotychczasowe
trójstronne uzgadnianie i ochronę raw drafts.

Po zatwierdzonym Delete edytor przechodzi do nieedytowalnego potwierdzenia.
Błąd synchronizacji pozostawia Retry script sync i Close; retry wywołuje
wyłącznie sync, nigdy ponowne Delete. Globalny edit session zostaje odłączony.
Panel wyłącza lookup usuniętej definicji; zmiana właściciela selekcji resetuje
ten stan. Test sprawdza przekazaną flagę enabled, nie rzeczywisty brak żądań
sieciowych. To ograniczenie dowodu pozostaje jawne.

Dodano 15 przypadków DOM dotyczących kolejności ACK/sync, błędów, retry,
scope/history fences i powrotu A→B→A. Uaktualniono przypadek unmount:
zatwierdzona mutacja wymaga sync w nadal bieżącej sesji, bez zmian lokalnego
UI. Lokalnie nie kompilowano ani nie uruchamiano TS/Rust unit tests.
Review tej zmiany: brak potwierdzonych P1/P2.

Production typecheck, architecture hygiene i scoped lint PASS, stabilne
źródła: verification/frontend-production-source-91c5a8baa6d0481e9148c1261dcd73d2.json.
Zatwierdzona bramka API hygiene PASS:
verification/frontend-api-hygiene-d31736ab445546448a5f83d3684c7fce.json.
React Doctor: 0 errors/skips, 6 ostrzeżeń (related state, prop adjustments,
mixed exports), bez suppression; stabilny receipt
verification/frontend-production-source-262f7752be4942d9aab38c7aff769092.json.

CI poprzedniego HEAD 71bdf3d66272aa936ca753648ce2b4da88dc09ff:
control-room-contracts PASS, 9021 testów PASS/13 skip oraz production build
i compute performance PASS; inspector-actions-browser-smoke PASS w run
39901391022. Cały run nadal czeka na rust-contracts. Wyniki te obejmują
21 regresji katalogu referencji, nie nowe 15 przypadków synchronizacji.

Retencja: bez builda, instalacji, restartu, resetu ownera i usuwania danych;
cache i receipty pozostają potrzebne. Nowe CI, szerszy audyt frontendowy,
browser formularza oraz managed live qualification pozostają otwarte.
