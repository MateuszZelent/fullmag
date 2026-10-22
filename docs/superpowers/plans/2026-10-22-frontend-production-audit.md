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
