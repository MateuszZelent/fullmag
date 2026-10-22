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
- Zakaz kompilowania testów jednostkowych pozostaje w mocy. Weryfikacja
  używa kontroli źródeł, lint, TypeScript bez testów oraz regresji przeglądarkowych.
  Pełna bramka testów pozostaje jawnie niewykonana, dopóki obowiązuje zakaz.
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
