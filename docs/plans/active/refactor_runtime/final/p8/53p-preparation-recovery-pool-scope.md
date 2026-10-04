# P8-53P — zakres recovery preparation i globalna bramka restartu

Data: 03.10.2026. Stan: poprawka źródeł i częściowy dowód procesu PASS.
Pełny restart workspace, transfer zasobów pomiędzy pulami i science pozostają
NOT VERIFIED. Nie zmieniono fizyki ani możliwości wykonania FEM.

## Defekt i poprawka

Rozszerzenie produkcyjnego verifiera o aktywne compute/preparation leases
spoza konfiguracji usługi potwierdziło odmowę idle drain. Jednocześnie
preparation scheduler próbował nadzorować obcy lease: globalną listę
traktował jako własną kolejkę recovery, zanim odczytał swój resource pool.
Własna sesja testowa zakończyła się błędem braku katalogu dla tego lease.
Dowód niepowodzenia zachowano w receipcie
`641943bb7b274aca8338014aa083d044`; nie został zaliczony jako PASS.

Scheduler teraz odczytuje i waliduje bieżącą pulę przed recovery. Adoptuje
nowy lease tylko dla aktualnej oferty ze zgodnym budget. Historyczne
`observed_resource_ids` są informacją do receipt, nie uprawnieniem do późniejszych
leases. Review odrzuciło wcześniejszą wersję opartą na historii ofert, ponieważ
mogła przejąć późniejsze zadanie innej puli po transferze tego samego zasobu.

Odczyt puli, skan leases i wstawienie konkretnego lease do `active` odbywają
się pod wspólnym `WRITER.lock`. Zmiana puli i publikacja lease nie mogą wejść
pomiędzy te czynności. Supervisor powstaje w osobnym wątku; scheduler nie czeka
na jego zapis, a writer zwalnia przed admission, sleep, join i drain.

Już posiadane handles pozostają nadzorowane po wycofaniu oferty. Nieznany
lease spoza aktualnej puli nie jest uruchamiany, zwalniany ani usuwany.
Globalny idle scan nadal obejmuje wszystkie leases i blokuje restart.

## Weryfikacja

- Końcowe review źródeł: brak otwartego blockera po poprawieniu zakresu
  i serializacji pod writer.
- Zarządzany build Windows oraz końcowe
  `just windows-workspace-build dev dev 3197 auto`: exit 0; source identity passed.
- `just verify-windows-development-backend-api`: **55 sprawdzeń, exit 0**,
  receipt `703f86aaae4c4342a74ca456117605c7` w profilu
  `development-backend-api-checks`. Wszystkie 12 procesów fixture odczekane.
- Aktywne leases compute i preparation spoza puli odmawiają idle drain,
  pozostawiają usługę Ready i nie publikują markera. Po oznaczeniu własnych
  fixture jako Released historia pozostaje w store; końcowy idle drain kończy
  oba schedulery i usługę poprawnie, zachowując admission fence.
- Backend digest przed/po:
  `dc5c6fa9edcf09da2153ecdf9222641d8de2d3d68051fabc6967e260caa54e4b`.
  Snapshot buildu:
  `fac3e2577c669055f407a73c435f62241b45eef0b9becbbe17c05fdd63d419f0`.
  Baza: `59fbb7802c4faabc31a1cbbcddb416ecef6a979f` + ten przyrost.
- Parser Python, rustfmt i diff whitespace PASS. Nie kompilowano ani
  nie uruchamiano testów jednostkowych. Aktywne UI 3197 pozostało uruchomione.

## Ograniczenia i następny krok

Lease nie przechowuje `pool_id` ani generation. Po cold start nie da się
udowodnić prawa do recovery wycofanego zasobu na podstawie samego resource ID.
Taki rekord pozostaje zachowanym blockerem global idle, do jawnego recovery
albo przyszłej migracji trwałego provenance. Transfer puli i crash recovery
własnej pracy wymagają osobnych dowodów runtime; ten fixture nie wykonuje solve.

Eksploracja managera potwierdziła potrzebę trwałego supervisora CLI wymieniającego
wyłącznie API, z zachowaniem frontendu i okna. `ControlRoomGuard::drop` zamyka oba
procesy, a `axum::serve` nie ma jeszcze kontrolowanego shutdown. Kontrakt kolejnej
integracji doprecyzowano w ADR 0050; publiczny restart nadal pozostaje wyłączony.
