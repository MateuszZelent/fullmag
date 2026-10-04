# P8-53AN — transport żądania restartu i wspólny koordynator

Data: 04.10.2026. Stan: transport natywny PASS; pełny restart z UI NOT VERIFIED.

## Cel

Połączyć dane niezależnych właścicieli UI z natywnym właścicielem procesu.
Scena sesji pochodzi z prywatnego acquisition, a `editor`, `workspace` i
`project_document` z jawnego, przypiętego żądania przeglądarki. Przeniesienie
dokumentu projektu nie synchronizuje go automatycznie ze sceną.

## Zakres kodu

- `fullmag-session::development_restart_transport`: ograniczone typowane
  request/result, canonical JSON, SHA-256, atomowy zapis i niezmienny slot
  starej instancji API. Częściowy zapis i konflikt zachowują dane.
- API v2: POST żądania i GET statusu pod
  `/v2/platform/development-restart-requests`. Dokładny lokalny Origin,
  obowiązkowy bieżący pin przy POST, osobny token statusu i `Cache-Control:
  no-store`. W storage pozostaje wyłącznie hash tokenu.
- Tożsamość sesji/epoch ustala API pod blokadą przejścia. Owned guard zostaje
  przeniesiony do zadania publikacji, aby anulowanie HTTP nie zwolniło go
  przed zapisem. `session_id` musi być obecne; pusty workspace używa jawnego
  `null`. Dane sceny, PID i ścieżki hosta nie są parametrami żądania.
- Koordynator CLI używa istniejącego supervisor/commit/restore/replacement
  zamiast osobnego przebiegu diagnostycznego. Po przekroczeniu granicy commitu
  błąd pozostawia `unknown`, własny proces oraz fence do uzgodnienia.

POST jest domyślnie niedostępny. Flaga koordynatora nie jest jeszcze ustawiana
przez produkcyjny launcher. `restart_available` pozostaje `false`: samo
przyjęcie requestu nie dowodzi odtworzenia modelu ani paneli UI.

## Kontrole i następne kroki

Dedykowana recepta `just verify-windows-development-restart-transport`
obserwuje własny API i tymczasowy storage, bez kompilacji testów i bez
restartowania sesji użytkownika. Sprawdza Origin/pin/token, strict schema,
session/epoch, trwałe rozdzielone dane UI, niezmienny replay i konflikt slotu.
Zarządzany build Windows `backend-dev`: PASS. Poprawiono użycie przeniesionego
owner record w kontrolnej ścieżce commit-only; acquisition pobiera teraz
potwierdzonego właściciela z supervisora. Uzupełniono również zamkniętą listę
recept wrappera `just` o zakres `--restart-transport-only`.

Natywny transport: **20 kontroli PASS**, receipt
`f09da8dc49cd4d689e51678036f9cb13`, exit 0. Źródła backendu przed/po:
`502929a11da73005e060f08c988ad9e541407f245576ed1336b78e8edb21aaad`;
build commit `960fd925b78d71f9018b2b6e093d0523a323ae34`, dirty snapshot
`a8b85cffb59626f58b829aefd61ad1d07901d375827fd87f418f81e242c13d82`.
Receipt obejmuje własną instancję API i terminalne oczekiwanie na jej proces.
Nie kompilowano testów jednostkowych. Surowy OpenAPI pochodzi z kanonicznego
eksportu tego samego EXE i został zaimportowany z kontrolą terminalnego receipt.
Szersza próba natywna: **398 kontroli PASS**, receipt
`3f844250ad164834abbd8c0cba329b0e`, exit 0, te same źródła backendu przed/po.
Wspólny koordynator przeszedł zastąpienie własnego procesu, odtworzenie
kanonicznej sceny z assetami i ponowne otwarcie mutacji HTTP, również z
utraconym ACK oraz kandydatem z wcześniejszego buildu
`32471c8c91494cf283abf002285ae6b3`. Wszystkie procesy próby mają terminalne
oczekiwanie. To nadal osobny zakres od konsumenta produkcyjnej pętli CLI.

Generacja klienta z zaimportowanego OpenAPI: PASS, receipt
`6a329d29721448ebb0a924af9436f2c4`. Kontrole produkcyjnego źródła i higieny
API: PASS, odpowiednio receipty `5a2edd75b6bb478dae206acad3a42033`
i `f65498c2a42d4617ae0f67cb3bcae95b`. Review kodu transportu, koordynatora
i zamkniętej recepty bez otwartych findings. `git diff --check`: PASS.

Pozostają: konsument requestu w produkcyjnej pętli CLI, zweryfikowane
wybranie gotowego kandydata, bezpieczne zakończenie i ponowne przypięcie
attach/scratch observers, publikacja terminalnego wyniku po completion,
nowa facade/cache scope, hydration rzeczywistych paneli oraz przebieg
Windows/browser dla niepustego modelu i aktywnej symulacji.

Jeden slot starej instancji nie jest automatycznie zwalniany po błędzie.
Retry dla tej samej instancji wymaga osobnej jawnej procedury. Nie jest to
pełna kwalifikacja restartu, fizyki ani wydania.
