# P8-53H — potwierdzone zakończenie ownera

Data: 03.10.2026. Przyrost prywatnego lifecycle; publiczny restart pozostaje niedostępny.

## Zrealizowane granice

Prywatny protokół service otrzymał `drain_confirmed` z tokenem ownera i
jednorazowym bounded nonce. W przeciwieństwie do istniejącego `drain`,
nie zwraca wstępnego ACK `draining`. Utrzymuje połączenie aż do zakończenia
obu schedulerów, kontroli generacji/pól pul i publikacji terminalnego ownera.
Odpowiedź `runtime_service_drain.v1` wiąże nonce, konfigurację i descriptor.
Transakcja writer pozostaje utrzymana podczas bounded zapisu odpowiedzi.

Klient wykonuje świeży probe konfiguracji i ownera przed mutacją, używa
wspólnego deadline, wymaga loopback IPv4 i ogranicza framing. Sukces wymaga
`Drained`, identycznego ownera, source identity, generacji pul oraz dokładnie
dwóch tych samych dzieci `exited_success`. Timeout/disconnect pozostają
nieznanym wynikiem i nie upoważniają do ponowienia albo zastąpienia procesu.
Stary `drain` i obserwacja statusu zachowują swój kontrakt.

## Dowody i ograniczenia

- Niezależny source review protokołu drain: bez konkretnego blockera.
- Scoped rustfmt i diff check: PASS.
- Produkcyjny build `just windows-workspace-build dev dev 3197 auto`: exit 0,
  terminalny `build-status.json` w profilu `windows-native-fdm-cpu-dev`,
  19:25:28–19:28:30 UTC. Source snapshot:
  `5ff9c0c07c1c40ca841d94e5f773a91fea2f1dee7f2386c95768ebf1f04c37f1`.
- Dodano regresje Rust dla terminalnego handshake. Pozostają
  **NOT COMPILED / NOT RUN** zgodnie z zakazem kompilacji testów jednostkowych.
- Rozszerzono `just verify-windows-development-backend-api` o własny pusty
  service, sealed EXE, produkcyjną inicjalizację store i terminalny drain.
  Końcowe wykonanie: **31 sprawdzeń, exit 0**, receipt
  `30bc1fedf7c44f819facbe865d019131` w profilu `development-backend-api-checks`.
  Backend source hash przed/po:
  `4757fb75e7b3327502e2982a4a6f1060c1cb387bfe0e9aacbd41f68731120bd5`.
  Verified build ID:
  `e44529ebcec034afb75a949b3b2038efb3cc1879f0525a64d5022e40a7dd1d9d`.
  Fixture dowodzi odmowy obcego ownera i niepoprawnego nonce, pozostania Ready
  po odmowie, potwierdzenia po obu `exited_success`, publikacji Drained przed
  odpowiedzią i zakończenia procesu service z exit 0. Trzy własne procesy
  API zostały celowo zamknięte przez verifier po obserwacjach HTTP; ich exit 1
  nie jest dowodem graceful shutdown. Wszystkie cztery procesy są waited.
- Pierwsza próba fixture zakończyła się przed startem service z brakiem
  tożsamości hosta. Przekazano rzeczywiste `COMPUTERNAME/HOSTNAME` do
  odizolowanego środowiska; drugie wykonanie jest powyższym dowodem PASS.

Próba fixture sprawdza protokół service. Nie wywołuje jeszcze funkcji Rust
`drain_confirmed` przez produkcyjnego konsumenta restartu ani nie dowodzi
guardu workspace. Powstający odrębnie guard wymaga korekty rzeczywistych
terminalnych kształtów lifecycle mesha i ponownego production gate.

Potwierdzenie drainu nie dowodzi globalnego idle, zapisu sceny, zwolnienia
locka procesu ani odtworzenia workspace. Nadal trzeba podłączyć koordynator
komendy, sprawdzić accepted work, rozwiązać szkice UI, zapisać handoff,
zaobserwować koniec ownera, zainstalować scenę przed listenerem i ustanowić
nowy pin API. Wyścig Start, aktywny solve, fault/restore i przebieg z niepustą
geometrią wymagają odrębnych dowodów. P8-53 i cały plan pozostają otwarte.
