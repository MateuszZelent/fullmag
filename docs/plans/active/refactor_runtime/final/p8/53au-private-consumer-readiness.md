# P8-53AU — prywatne potwierdzenie gotowości konsumenta restartu

Data: 05.10.2026. Build, prywatny protokół i regresja konsumenta PASS w opisanej
kopii weryfikacyjnej. Pozytywny cykl gotowości pompy między dwoma buildami
zaliczono następnie w [P8-53AV](53av-asynchronous-candidate-preparation.md):
13 kontroli, exit 0, pierwszy krok 17 ms. Fault gates i pełny restart pozostają otwarte.
Zakres wynika z [P8-53AT](53at-development-restart-action.md) i
[ADR 0050](../../../../../adr/0050-development-backend-restart.md).
Publiczne `restart_available` pozostaje `false`. Ten przyrost nie zamyka
[całego planu P0–P8](../03-plan-refaktoryzacji.md).

## Problem i zakres

Konfiguracja transportu i heartbeat watchera nie dowodzą, że launcher
potrafi obsłużyć gotowy pakiet. API potrzebuje osobnego, krótkotrwałego
potwierdzenia od uwierzytelnionego właściciela. Nie wolno wyprowadzać z niego
idle proof, przejęcia dokumentu, zgody na przerwanie symulacji ani completion.

Prywatny kanał ownera otrzymuje `consumer_status` i `consumer_readiness`.
Nie są to endpointy HTTP ani rozszerzenie publicznego OpenAPI.
Status nie odnawia ważności i nie zdobywa freeze/transition guard.
Jawne `readiness: null` wycofuje potwierdzenie po uwierzytelnieniu;
pominięcie tego pola w odnowieniu jest odmową. Pozostałe polecenia nie mogą
odnawiać potwierdzenia ani przemycać tego payloadu do acquisition.

API przechowuje pojedynczy rekord wyłącznie w pamięci procesu. Ważność to
stałe 5 sekund czasu monotonicznego; klient nie ustawia zegara ani TTL.
Rekord wiąże UUID API, worktree, generację watchera, ready build/source oraz
ID i digest manifestu zweryfikowanego bundle. Brak rekordu, wygaśnięcie,
niezgodność scope, brak świeżego `Ready`, taki sam source jak uruchomiony,
wyłączony transport, konfiguracja warm service i zatruty mutex odmawiają.
Obserwacja niezgodnego lub niedostępnego watchera unieważnia dawny rekord;
powrót tego samego kandydata nie przywraca ważności bez nowego odnowienia.
Nieuwierzytelniony pakiet nie może wycofać prawidłowego potwierdzenia.

## Launcher i wybór kandydata

Pompa sprawdza gotowość najwyżej raz na sekundę. Po nowej tożsamości ready
używa istniejącego selektora, który sprawdza źródła i manifest, pieczętuje
bundle, weryfikuje ownera kandydata i ponownie sprawdza watcher. Każde
odnowienie ogranicza rozmiar manifestu i porównuje jego SHA256.

Jedna niezmieniona tożsamość API/build/source ma najwyżej jedną próbę
selekcji. Błąd helpera nie powoduje kolejnego pieczętowania co sekundę.
Zmiana tożsamości albo obserwacja ineligible pozwala na następną próbę.
Zweryfikowany kandydat trafia do cache przed wysłaniem odnowienia, więc
utrata ACK ponawia ten sam pakiet. Cache przechowuje najwyżej jednego
kandydata i jedną tożsamość próby; nie zmierzono kosztu pamięci procesu.

Przed konsumpcją trwałego intentu pompa wycofuje potwierdzenie. Restart
wciąż wymaga istniejącej acquisition, cold-idle proof, fences, journal,
potwierdzonego exit, restore i completion. Samo zakończenie buildu lub
odnowienie potwierdzenia nie restartuje backendu ani symulacji.

## Sprawdzenia i granice dowodów

- Review źródeł nie pozostawił kolejnych Required findings po korekcie
  importu, kolejności przenoszenia `AppState`, pełnej invalidacji oraz
  ochrony przed ponownym pieczętowaniem po błędzie lub utracie ACK.
- Python AST dla driverów, składnia zamkniętego wrappera i deklaracja
  recepty PASS. Fokusowany rustfmt/parser nowego stanu i pompy PASS.
  To nie jest runtime ani kompilacja testów jednostkowych.
- Pierwsze `just windows-workspace-build dev dev 3197 auto` zakończyło się
  FAILED, exit 1. Faza CLI/API skompilowała poprzedni wariant pompy;
  desktop zatrzymał `E0432: fullmag_ir::MaterializedExecutionRequestIR`
  w równoległym `crates/fullmag-plan/src/study_catalog.rs`. Po tej próbie
  dopracowano latch/cache; wcześniejsza kompilacja go nie weryfikuje.
  Odczytany wtedy `windows-native-fdm-cpu-dev/build-status.json` wskazywał
  04.10.2026 23:50:26–23:55:31 +02:00, HEAD
  `e9f29dda537ca9866fbbcedcbb2b9da97552b19b` i wynik FAILED.
- Próba nowej recepty odmówiła w preflight niezgodnego manifestu/binarnych
  plików po częściowym buildzie. Nie uruchomiono testowych API; runtime
  pozostaje NOT VERIFIED. Dodano terminalny zapis takiej odmowy, bez
  nadpisywania ostatniego manifestu ani wykonywania częściowych plików.
- Kolejna próba na masterze (05.10.2026, 00:26:26–00:35:14 +02:00)
  skompilowała CLI/API w 5 min 05 s oraz desktop w 2 min 23 s. Kontrola
  końcowa prawidłowo odrzuciła pakiet: w czasie kompilacji master przeszedł
  z `e9f29dda537ca9866fbbcedcbb2b9da97552b19b` na
  `39427c8683911f69b4f77790468543642a5158ae`, a źródła uległy zmianie.
  Sukces faz kompilacji nie stanowi PASS całego pakietu.
- Odmowa nowej recepty jest potwierdzona terminalnym receipt
  `development-backend-api-checks/checks/2ce8ef4bf71b4c9ab9e24654c1522778/receipt.json`
  w buildach worktree `fullmag-0950f4dca4ffe38f`: `state=blocked`, exit 2,
  `phase=native_package_preflight`, zero uruchomionych procesów.
  Obok zachowano `rejected-build-status.json` o SHA256
  `8f515986be6c691f1081ba73dfe3c2d93dbd6df32fa36a20540606dcbca1f457`.

`just verify-windows-development-consumer-readiness` potwierdził rzeczywisty
prywatny protokół w trzech własnych API, z kontrolowanymi klatkami watchera
i pinami kandydata. Driver sprawdza auth, scope, kształt, wygaśnięcie mimo
odczytów/heartbeat, odnowienie, brak revival, revoke i otwarte admission.
Kontrolowane piny nie dowodzą pracy selektora, dwóch różnych buildów,
rzeczywistego warm service, hydration ani pełnego browser/native flow.
Testów jednostkowych nie kompilowano ani nie uruchamiano.

## Odizolowana weryfikacja

Powtarzające się zmiany współdzielonego mastera uniemożliwiały uzyskanie
spójnego pakietu. Przygotowano jedną kopię weryfikacyjną
`worktrees/p8-readiness-20261005`, branch `codex/p8-readiness-20261005`,
na bazie `39427c8683911f69b4f77790468543642a5158ae`. Implementacja zadania
pozostaje na masterze zgodnie z wyborem użytkownika.

Kopia zawiera dokładnie 18 plików P8-53AU. Zgodność bajtów przy kopiowaniu
i wyłączny zakres diffu PASS; rejestr źródeł znajduje się w
`runtimes/p8-readiness-20261005-06f19fcabeccf5fa/p8-readiness-source-copy.json`.
Właściciel: `codex:01a0be34-da2b-78d3-b0a9-52ebb7e8ecde`.
Rejestr worktree i rezerwacja zapisują bazę, cel oraz następny krok.
Nie kopiowano `.env`; resolver czyta konfigurację głównego checkoutu.

Zakres dowodu obejmuje tę bazę i poprawki P8-53AU. Równoległe WIP innych
zadań na masterze pozostają poza nim. Implementacja trafiła w międzyczasie
do commita `c0eebebf818eafbf079b7728bbc936ae88a1bcb8`; porównanie z masterem
`056d4f50d10389be83a68b9941d2fbcdcb8fc072` potwierdziło zachowanie zmian AU.
Nowsze dodatki eksportu skryptów w `types.rs` i `router_v2/tests.rs` nie są
objęte buildem kopii. Poniższy PASS nie kwalifikuje całego nowszego mastera.
Kopię zachowujemy do kolejnych bramek P8-53; nie zgłaszamy zakończenia
integracji ani cleanupu.

### Dowody z 05.10.2026

Wszystkie ścieżki poniżej są względem
`builds/p8-readiness-20261005-06f19fcabeccf5fa/` w storage projektu.

| Bramka | Wynik | Dowód |
|---|---|---|
| `just windows-workspace-build dev dev 3197 auto` | PASS, exit 0; CLI/API i desktop, bez testów jednostkowych | `windows-native-fdm-cpu-dev/build-status.json`, 00:48:13–01:00:51 +02:00 |
| `just verify-windows-development-consumer-readiness` | PASS, 40 kontroli; 3/3 procesy zakończone i odebrane | `development-backend-api-checks/checks/69773709c8134e8abd8fa7dc35759e48/receipt.json` |
| `just verify-windows-development-restart-consumer` | PASS, 39 kontroli; 20/20 procesów odebranych | `development-backend-api-checks/checks/d33d4fe78ce344e295e41a8bc761cf8f/receipt.json` |

Snapshot buildu: `91ef364d3319cf75bf2338c2a475cc453241b6355998ae37160a977f04e5c34b`.
Backend source obu prób, niezmieniony przed/po:
`f57116d0d83089f82206a6761aa04be4816e430bdd0cc762404efc7314f3f389`.
Raw manifest SHA256:
`151dcb2bc54bae166ffeec376c2e7cf4a1053daaa500d3a1f5af6bf4573073ab`.
Helper prywatnego protokołu zachował SHA256
`882004b1fc293ea4180aa6becf9c03bc82f37d57bff008d5e1e67041ed13d77d`.

Regresja konsumenta potwierdziła empty/scene, dokładny payload UI, nową
tożsamość API/sesji, odmowę starego pina, brak ponownej konsumpcji i możliwość
edycji po odtworzeniu. Własne API zakończono kontrolą procesu przez verifier;
sam `waited=true` nie oznacza graceful shutdown. Nie jest to browser hydration
ani pomiar działania symulacji. Istniejący probe wysyła request przed pierwszym
krokiem pompy, więc jego PASS nie dowodzi odnowień gotowości bez requestu.

Próba `just check-control-room-production-source` na nowszym masterze nie
wystartowała: aktywne obce zadanie zajmowało blokadę checkoutu. Nie przejmowano
blokady i nie zastąpiono dawnych wyników TypeScript/lint nowym PASS.

## Następne bramki

### Próba dwóch pakietów 05.10.2026 — niezaliczona

Po dwóch rzeczywistych buildach P8-54 uruchomiono
`just verify-windows-development-consumer-pump 3b1de31747fb4fe7b5275b8cfdec42cd`.
Pakiet A ma manifest buildu `65851fe704eb603678252bef9d9788fa9d631ca86ac9865079179f4f4d9367e8`,
ready B `44137ba584458288cd57110696133e7bb06dcb8fc19f06c45a42ea1e5b9342fb`.
Próba `development-backend-api-checks/checks/3c7f86cd3a3d4adea54909c868f3d747`
zakończyła się `failed`, exit 1, **0 zaliczonych kontroli**. Log pompy zawiera
`development acquisition helper timed out`. Sam helper pompy zakończył się
wcześniej exit 0; nie wolno utożsamiać tego z sukcesem acquisition ani pompy.

Initializer, CLI B i helper mają odnotowane zakończenie. API A (PID 85472,
port 11654) pozostało w receipcie `unknown`, bez potwierdzonego odebrania.
Późniejsza kontrola systemowa potwierdziła brak tego PID i listenera;
osobny `process-reconciliation.json` przypina hash pierwotnego receiptu
i wynik `observed_absent_exit_code_unknown`. Nie zmieniano starego receiptu
ani nie dopisywano nieznanego exit code. Działający workspace na 3197
pozostał na API instance `dd582f13-cad8-43f8-8d6b-2ec957551fc0`.
Publiczny restart nadal jest niedostępny.

Przegląd źródeł wskazał `STAGE_HELPER_TIMEOUT = 20s` w
`crates/fullmag-cli/src/development_api_owner.rs`. Po starcie API A pompa
przechodzi przez `refresh_consumer_readiness` do selektora
`select_development_candidate.py`, uruchamianego pod tą samą granicą.
Około 20,54 s od startu API do końca receiptu oraz brak nowego sealed
candidate przemawiają za timeoutem pierwszego selektora. Nie potwierdzają
jednak konkretnej fazy Python: stderr jest odrzucany, a postęp i PID helpera
są raportowane dopiero po powrocie kroku. Następny krok: odseparować kosztowne
przygotowanie kandydata od krótkiego acquisition albo usunąć wykazane
powtórne skany, zachowując pełną weryfikację; nie zwiększać globalnego timeoutu
i nie przedstawiać tej próby jako zaliczonej.

1. Rzeczywisty cykl selekcji/odnowienia innego buildu przez działającą pompę,
   reuse jednego zapieczętowanego pakietu oraz wygaśnięcie po zatrzymaniu kroków,
   a następnie własna próba native/browser z niepustą sceną i dokumentem.
2. Dopiero przy potwierdzonych warunkach podłączyć stan do publicznego zasobu.
   ETag musi zmienić się po wygaśnięciu; 304 nie może zachować dawnego `true`.
   Pozostają wspólne TypeScript/lint, warm-service i fault/release gates.

Nie podniesiono procentów planu na podstawie samego kodu ani kontrolowanych
pinów. Publikacja na publicznym remote pozostaje osobną, wcześniej odrzuconą
akcją; niniejszy przyrost nie daje nowej autoryzacji do jej ponowienia.
