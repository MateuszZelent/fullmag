# Runner: retencja kopii roboczych, źródeł i runtime

Status: implementacja rozpoczęta. Priorytet użytkownika z 2026-10-05 przed
dalszymi obliczeniami dyspersji. Bazowy commit:
`3da4b53d16bf3bbf57c6dde3c0f7541e17e9442c`.

## Cel i granice

Zatrzymać narastanie jednorazowych danych, zachowując wejścia, wyniki naukowe,
manifesty, logi, receipty i runtime potrzebny do odtworzenia wyników.
Pracujemy w istniejącym worktree eigensolve. Aktywny build #232 i jego kapsuła
pozostają chronione. Zakaz kompilowania testów jednostkowych pozostaje w mocy;
regresje tego etapu są interpretowanymi testami Pythona.

Audyt z 2026-10-04 wykazał 87,29 GB logicznych `execution`, 46,36 GB `source`
i 10,83 GB `artifacts`. Nie są to aktualne fizyczne bajty do odzyskania.
Wykonawca musi mierzyć wynik operacji, nie przepisywać estymaty do pola sukcesu.

## Kolejność i odbiór

| Etap | Zakres i pliki | Dowód wymagany do zamknięcia | Stan |
|---|---|---|---|
| R1 | `retention.py`, nowy executor, `observability.py`, `container_main.py`: rzeczywiste usuwanie wyłącznie przeterminowanych prywatnych `execution` | Rewalidacja kolejki, journalu, receipt, pinów, blokad i kontenerów; odrzucenie obcej/aktywnej ścieżki; linki usuwane bez naruszenia celu; terminalny raport również po częściowym błędzie; ponowienie nie usuwa nowych danych | OPEN |
| R2 | `source.py`, nowy magazyn treści, CLI: współdzielenie identycznych plików, osobny manifest kapsuły | Identyczny digest przed/po; wspólne dane tylko readonly; zapisywalne execution niezależne; test korupcji, zmiany trybu i równoległego capture; bez migracji aktywnej kapsuły | OPEN |
| R3 | Indeks referencji i retencja pakietów `artifacts/outputs`, konsumenci runtime | Ochrona wyników, aktywnych instancji, bieżących wersji, pinów i jobów; niepełny/nieznany legacy indeks zatrzymuje usuwanie; min. liczba wersji nie zastępuje referencji | OPEN |
| R4 | API i istniejące UI runnera | UI rozróżnia podgląd, wykonanie, częściowy błąd i zatrzymanie; tryb automatyczny dostępny tylko z podpiętym wykonawcą; brak pozornie działających TTL | OPEN |
| R5 | Testy, review, wdrożenie i pierwszy kontrolowany przebieg | Testy Python, review całego diffu, wymiana pojedynczego koordynatora dopiero przy wolnym slocie, proof z live API/UI, zmierzone usunięcie wybranej klasy, odczyt zachowanych wyników | OPEN |

## Decyzje

- Istniejące plany są podglądem. Operacja apply wykonuje powtórną walidację
  konkretnego zakresu; nowo znalezione katalogi nie dołączają do starej zgody.
- Automatyczny przebieg działa pomiędzy zadaniami i okresowo, z tymi samymi
  zabezpieczeniami co apply. Nie restartuje ani nie przerywa aktywnego buildu.
- Błąd pomiaru, pinów, Docker lub tożsamości oznacza zachowanie danych z powodem.
- Źródła zachowują dotychczasowy manifest v1 i widok `source/tree`; nowy magazyn
  treści nie zastępuje dirty snapshotu samym SHA Git.
- Nie usuwamy Cargo target, współdzielonych cache kompilacji ani wyników
  naukowych w ramach retencji `execution`.
- Wdrożenie nie oznacza ukończenia całego planu eigensolve S00–S12.

Kontrakt architektoniczny: [ADR 0052](../../adr/0052-runner-storage-retention.md).

## Weryfikacja

Każdy etap otrzymuje datowany wpis: zmienione źródła, uruchomione kontrole,
pełny commit i wynik live. Docelowe kontrole obejmują
`scripts/test_local_runner_retention.py`, nowe testy executora/magazynu,
`scripts/test_local_runner_source.py` oraz istniejące testy API/observability.
Nie przedstawiamy testów na katalogach tymczasowych jako dowodu wdrożonego
sprzątania produkcyjnego storage.

### Checkpoint R1 — 2026-10-05

- Executor, nieblokujące API, harmonogram, trwałe wyniki i UI są zaimplementowane.
  Stany `planning/accepted/running` są obserwowane przez GET tego samego ID;
  browser zachowuje ID operacji po odświeżeniu. Błąd inventory blokuje apply.
- Regresje Pythona: plan/executor, pin/lease/mount, symlink leaf, aktywny owner,
  częściowe usunięcie, idempotencja, API auth/ACK/poll, admission/drain, log 4001
  linii oraz odmowa utraty bajtów w logach. Zestaw 122 kontroli miał 121 sukcesów
  i jedną dawną asercję `0` zamiast niezmierzonego `null`; po korekcie kontraktu
  ta kontrola oraz 19 dotkniętych kontroli przeszły. Pozostałe 10 kontroli
  planera przeszło wcześniej na niezmienionych źródłach. Składnia 3 plików JS PASS.
- Niezależne review R1: SOURCE PASS, wszystkie znalezione P1/P2 poprawione.
  Review obejmuje zachowanie pełnego dostępnego logu przed usunięciem kontenera,
  wyjątki inventory oraz współbieżność build/cleanup i drain/replacement.
- Wdrożenie, produkcyjny cleanup i kontrola przeglądarki: NOT VERIFIED.
  Trwający #232 pozostaje chroniony. R1/R4/R5 są nadal OPEN do uzyskania tych
  dowodów; nie uznajemy temp-dir tests za odzysk miejsca na rzeczywistym dysku.

### Checkpoint R2 i przeglądarki — 2026-10-05

- R1 commit: `d672c1e10ae57e1204532876a9eaf9f75d5a541f`, wypchnięty na branch zadania.
- Nowe capture współdzielą treść przez CAS; manifest v1/digest i dirty snapshot
  pozostają bez zmiany. Regresje źródeł: 15/15 PASS; CAS: 9/9 PASS, w tym
  rzeczywista materializacja execution, concurrent capture i cleanup po
  częściowej awarii. Niezależne R2 review: SOURCE PASS, brak otwartych P1/P2.
- Test w prawdziwym Chromium na oddzielnym backendzie z tymczasowymi danymi:
  preview → accepted → succeeded, usunięcie 5-bajtowego execution, ten sam
  wynik i ID po reload, brak błędów strony; nieaktywne TTL źródeł/logów oraz
  opcja automatyczna odpowiadają podpiętemu wykonawcy. To proof UI i integracji
  na fixture, bez produkcyjnego Docker/delete. Zrzut zapisano w evidence wątku.
- Produkcyjna migracja historycznych kapsuł i proof managed capture nadal
  NOT VERIFIED. Nie dopisujemy oszczędności fizycznych na podstawie liczby hashy.

### Checkpoint ochrony użytkowników — 2026-10-05

- R2 commit: `0b8d793263942a43eafa5ef1696f6b25623c8b09`, wypchnięty na branch.
- COMSOL, DE, oba launchery UI oraz eksport OpenAPI publikują ticket przed
  właściwym użyciem runtime i zachowują go do końca operacji lub utrwalenia
  konsumenta. R1 sprawdza tickety pod tą samą bramką przed usuwaniem.
- Zestaw admission/executor/OpenAPI: 55/55 PASS; po korekcie no-follow
  admission: 8/8 PASS. Launchery: 98/98 PASS oraz 125 podtestów PASS.
  Niezależne review: SOURCE PASS, brak otwartych P1/P2.
- Probe na rzeczywistym mapowaniu storage Windows↔Docker Desktop potwierdził
  wzajemne wykluczenie `mkdir` w obie strony. Dotyczył nowego katalogu testowego,
  który po sprawdzeniu tokenu został usunięty; nie zmieniał jobów ani cache.
  Dowód: `storage-admission-cross-host-proof-20261005.json` w evidence wątku.
- Wdrożenie retencji produkcyjnej i usunięcie historycznych danych nadal OPEN;
  #232 pozostaje aktywny. Ten probe nie zastępuje dowodu rzeczywistego cleanup.

### Checkpoint kompakcji i review retencji runtime — 2026-10-05

- Ochrona użytkowników i probe Windows/Docker: commit
  `68f8c0646656c075fad31838ed69a082127bd26e`, wypchnięty na branch zadania.
- Kompakcja historycznych kapsuł jest zaimplementowana: weryfikuje manifest
  przed i po atomowej podmianie identycznych plików na linki CAS, chroni obce
  hardlinki i zapisuje postęp partiami. Testy na Windows: 7/7 PASS;
  niezależne review modułu: SOURCE PASS. Produkcyjna kompakcja: NOT VERIFIED.
- Integracja source/runtime obejmuje plan związany z zakresem i wyborem jobów,
  asynchroniczne API, CLI i UI oraz osobne włączenie automatycznej retencji
  runtime. Busy preview nie zwraca ID innego planu. Częściowe usunięcie runtime
  wymaga ręcznego sprawdzenia danych; nie jest automatycznie ponawiane.
- Review retencji runtime ujawniło braki ochrony: worktree-scoped OpenAPI/UI,
  managed-browser, custom output scientific-batches, uszkodzone dokumenty
  odwołujące się do różnych buildów oraz piny w receiptach. Korekty są w toku;
  R3 pozostaje OPEN. Brak autorytatywnego rejestru historycznych lokalizacji
  wyników blokuje wszystkich kandydatów runtime; nie deklarujemy kompletności
  na podstawie samego braku znalezionych odwołań.
- Service/CLI: 25/25 PASS; root source maintenance: 11/11 PASS;
  API: 16/16 PASS. Zestaw runtime przed ostatnią zmianą kompletności: 9/9 PASS.
  Nowa regresja kompletności i rozszerzone review wymagają końcowej weryfikacji.
- Produkcyjny #232 nadal ma aktywny zapis. Runner zgłosił timeout, a dysk C:
  zapełnił się (nawet mały fixture browser zakończył się Errno 28). Nie wykonano
  podmiany koordynatora ani produkcyjnego usuwania. Nowe proof przeglądarki,
  wdrożenie i realny odzysk miejsca pozostają NOT VERIFIED.

### Checkpoint odzyskania miejsca i nowego UI — 2026-10-05

- Kompakcja: commit `c38ec0a8e538a7c8d1c64a81d290967ee2eedb7a`, wypchnięty.
- Po zwolnieniu miejsca runner ponownie zgłasza healthy, brak worker error
  i około 37,6 GB wolnego; #232 nadal running. Nie zastąpiono koordynatora.
- Admission/registration, runtime executor i source wrapper: 30/30 PASS;
  COMSOL producer: 22/22 PASS; observability: 23/23 PASS; składnia 3 plików JS PASS.
- Chromium z rzeczywistym testowym API: sources i runtime
  preview→apply→succeeded, zachowane manifesty i frequency.csv, ten sam runtime
  plan ID po reload, brak page errors, dostępne oddzielne opt-in runtime.
  Dokładna paczka fixture została usunięta; źródła i dane naukowe pozostały.
  Dowody: `storage-maintenance-browser-proof-20261005.json` oraz PNG w evidence.
  To proof integracji na danych tymczasowych, nie produkcyjnego odzysku miejsca.
- Nowe COMSOL/DE output są rejestrowane automatycznie przed oddaniem ochrony.
  `legacy_inventory_complete` pozostaje false dla nowego rejestru. Historyczny
  audyt/enrolment i produkcyjny cleanup nadal OPEN.

### Końcowa weryfikacja integracji źródeł — 2026-10-05

- Braki ochrony runtime z review zostały poprawione: rzeczywiste lokalizacje
  OpenAPI/UI i managed-browser, bounded metadane scientific-batches, globalna
  ochrona przy błędnym consumer cross-job, wszystkie historyczne receipt piny
  oraz klucz exec. Planner: 15/15 PASS; executor runtime po ostatecznej korekcie
  walidowanego odczytu rejestru: 10/10 PASS.
- Rejestr nowych output nie poświadcza historii; planner odczytuje listę roots
  i flagę kompletności z jednej walidowanej, niepodążającej za linkami kopii.
- Poprawiony wybór minimalnej liczby runtime jest walidowany w UI i API,
  bez cichego zaokrąglania wartości operatora.
- Nieudana próba łagodnego Drain miała nieznany wynik HTTP. Odczyt trwałego
  requestu potwierdził requested=false; nie ponowiono mutacji. Serwis pozostaje
  w reconciling z timeoutami Dockera i aktywnym #232 mimo dostępnego miejsca.
  Przed wdrożeniem trzeba ustalić rzeczywisty stan kontenera, zakończyć aktywny
  job, potwierdzić Drain i brak użytkowników. Bez tych dowodów nie podmieniamy
  koordynatora i nie usuwamy produkcyjnych danych.

### Wdrożenie i korekta kosztu pierwszego preview — 2026-10-05

- Integracja commit `0dfc03396a40301aac8f0fc5d879091da093374e`, push PASS.
  Po potwierdzonym Drain bez aktywnych jobów wdrożono obraz
  `sha256:b180a7e9d4ffd7a9867e075d2c38fe2d8c7c25ed7e5624eca2f890476d911a39`.
  Zachowano 7 profili oraz kolejkę; resume i health PASS. Produkcyjne UI:
  widoczny bound plan, brak page errors, osobny runtime opt-in wyłączony.
- Niedestrukcyjny probe POSIX na rzeczywistym bind mount potwierdził hardlinki
  dwóch nowych kapsuł, nlink=3, readonly CAS i niezmienione manifesty. Usunięto
  wyłącznie własny katalog probe po sprawdzeniu tokenu. Historia pozostaje nietknięta.
- Pierwszy produkcyjny preview `plan-fab83fd5c3c14cb38e73199751cafba8`
  obejmuje wybór 151 terminalnych buildów naszego worktree, lecz starszy kod
  mierzy też niewygasłe i chronione wykonania przed filtrem zakresu.
  Wielomilionowy skan na Docker Desktop/NTFS jest za wolny; niczego nie usunął.
- Poprawka: scope, indeksowe piny oraz TTL/receipt piny są sprawdzane przed
  pomiarem. Kandydaci nadal otrzymują pełny fingerprint i rozmiar; executor
  zachowuje walidację źródeł, receiptów, użytkowników, mountów i świeżości.
  Niezmierzone rozmiary są null, nie zero. Preview zapisuje rzeczywiste
  processed_jobs/total_jobs i pierwotny czas requestu; UI pokazuje ten licznik.
- Kontrole: retention 10/10, executor/service 32/32, observability 26/26,
  lifecycle/CLI 35/35 PASS. Chromium fixture zaobserwowała realne 1/2 jobów,
  a potem poprawne sources/runtime apply i replay po reload bez page errors.
- Przygotowano jawny wyjątek maintenance wyłącznie dla named read-only
  execution preview: completed Drain, tryb preview, brak workerów/jobów/błędów,
  zgodne public/raw planning z applied=false, brak operation file i admission
  gate. Po stop ponowna atestacja i walidacja metadanych. Domyślna odmowa
  replacement podczas mutacji pozostaje. Wyjątek nie jest generic force.
  Użycie na produkcji oraz właściwy cleanup: nadal NOT VERIFIED.


### Pierwsza partia wykonania i historyczny kontrakt — 2026-10-05

- Preview `plan-58fa7f7d0242487eb1266a414a5fca19` wskazał tylko wygasłe
  execution #187/#188, 879 901 764 bajtów logicznych. Apply zakończył się
  `partial`: oba katalogi retained, 0 bajtów usuniętych. Manifesty i receipty:
  cztery SHA256 przed/po zgodne. Delta wolnego dysku nie jest odzyskiem tej operacji.
- Przyczyna: dawne runtime-v2 miało `FULLMAG_ENABLE_FEM_GPU=ON`; aktualny
  profil wymaga OFF i nowych attestacji ABI. Użycie walidacji dzisiejszego
  profilu do oceny integralności archiwum trwale blokuje sprzątanie starych buildów.
- Korekta: oddzielny walidator archiwum wyłącznie dla execution; runtime
  nadal korzysta ze ścisłej walidacji. Regresje: archive 4/4, execution 18/18,
  runtime retention 10/10 PASS. Test historycznego succeeded buildu potwierdza
  usunięcie wyłącznie execution i zachowanie źródeł/receiptu/wyników w fixture.
- Faktyczne ponowne sprzątanie wymaga wdrożenia korekty i nowego planu;
  poprzedniej operacji nie odtwarzamy ani nie nadpisujemy.


### Reprezentacja tożsamości mountów — 2026-10-05

Drugi apply `plan-da8b802ff7c847b3b58344c486a51962` jest terminalny partial:
oba execution zachowane, 0 usuniętych bajtów, cztery hashe zachowanych danych
zgodne. Przyczyna to porównanie krotek mount_identity z listami po JSON oraz
normalizacja ścieżek demona Linux przez system klienta Windows. Identyczność
rzeczywistych mountów/obrazu i izolacji potwierdzono odczytem Docker inspect.

Korekta zwraca JSON arrays i normalizuje absolutne ścieżki POSIX niezależnie
od Windows cwd. Build executor 26/26, execution 19/19, runtime retention 10/10
PASS; niezależne review bez defektów. Stare operacje pozostają niezmienione;
nowa próba wymaga wdrożenia i świeżego planu.
