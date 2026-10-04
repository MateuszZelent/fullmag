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
