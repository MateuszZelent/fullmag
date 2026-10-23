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
