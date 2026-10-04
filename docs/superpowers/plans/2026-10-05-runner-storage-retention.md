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
