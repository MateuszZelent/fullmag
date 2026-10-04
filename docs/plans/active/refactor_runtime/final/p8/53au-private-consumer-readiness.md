# P8-53AU — prywatne potwierdzenie gotowości konsumenta restartu

Data: 05.10.2026. Implementacja przygotowana; aktualna bramka runtime w toku.
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

`just verify-windows-development-consumer-readiness` ma badać rzeczywisty
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

Zakres kolejnego dowodu obejmuje tę bazę i poprawki P8-53AU. Równoległe WIP
innych zadań na masterze pozostają poza nim. Zarządzany build kopii jest
w toku; prywatny runtime oraz regresja konsumenta nadal NOT VERIFIED.
Kopię zachowujemy do kolejnych bramek P8-53; nie zgłaszamy zakończenia
integracji ani cleanupu.

## Następne bramki

1. Aktualny zarządzany build i terminalny PASS prywatnego drivera; po zmianie
   pompy również regresja konsumenta empty/scene z odbiorem własnych procesów.
2. Rzeczywisty cykl selekcji/odnowienia innego buildu przez działającą pompę,
   a następnie własna próba native/browser z niepustą sceną i dokumentem.
3. Dopiero przy potwierdzonych warunkach podłączyć stan do publicznego zasobu.
   ETag musi zmienić się po wygaśnięciu; 304 nie może zachować dawnego `true`.
   Pozostają wspólne TypeScript/lint, warm-service i fault/release gates.

Nie podniesiono procentów planu na podstawie samego kodu ani kontrolowanych
pinów. Publikacja na publicznym remote pozostaje osobną, wcześniej odrzuconą
akcją; niniejszy przyrost nie daje nowej autoryzacji do jej ponowienia.
