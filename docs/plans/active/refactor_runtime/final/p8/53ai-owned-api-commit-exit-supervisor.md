# P8-53AI — właściciel procesu API podczas cold commit

Data: 04.10.2026. Zakres: natywny Windows dev, custody starego API,
jednorazowy commit, wait i uzgodnienie trwałego zapisu. P8-53 pozostaje otwarte.

## Implementacja

`DevelopmentApiSupervisor` przechowuje konkretny `Child` wraz z potwierdzonym
ownerem. `ControlRoomGuard` przejmuje go w rzeczywistej ścieżce `launch_ui`.
Acquisition musi pasować do PID, UUID API, portu, pinów buildu, namespace
storage, generacji i sekretu tego ownera. PID sam nie stanowi dowodu własności.

Koordynator wykonuje commit tylko raz, czeka na ten sam Child i dopiero po
exit 0 uzgadnia trwały HANDOFF-COMMIT z acquisition, proof i staged kapsułą.
Utrata ACK nie powoduje ponowienia. Nie uruchamia replacement API, nie usuwa
fence i nie wykonuje abort ani automatycznego recovery.

Stan nieznanego wyniku odmawia shutdown. Dopóki supervisor istnieje, zachowuje
uchwyt Child; jego Drop nie zabija procesu. Po zakończeniu launchera uchwyt
zostaje zamknięty, lecz proces nie jest przez to zakończony. Dalsza obserwacja
i recovery wymagają osobnej integracji; nie deklarujemy jej gotowości.

Review wykrył błędne utożsamienie lokalnej odmowy z nieznanym wynikiem
transmisji. Acquisition zaznacza `commit_may_have_been_sent` bezpośrednio przed
pierwszym zapisem. Wcześniejsza odmowa daje `CommitNotSent`: natychmiastowy
błąd, brak retry i możliwość shutdown dokładnego własnego Child. Fence nie
jest automatycznie zwalniany. Poprawka przeszła ponowne review.

## Weryfikacja

`just windows-workspace-build dev dev 3197 auto`: exit 0.
Log: `windows-native-fdm-cpu-dev/windows-runtime/owned-api-supervisor-reviewed-build.log`.

`just verify-windows-development-backend-api 809ee2d2d6ae48ee8fb20b0fb760b5dc`:
**306 kontroli, exit 0; wszystkie 104 procesy odebrane**.
Receipt: `development-backend-api-checks/checks/b442fce28cf44ddb9d2e7512c84df93c/receipt.json`.

Backend source przed/po:
`e2752457788bb7a0fe8871b82b4aa7fdd5f9c59126167c8f290469f97127903c`.
Build commit: `6d53422cdd1eb52ee5aeeb7b156f8799ee6d28aa`.
Snapshot: `fc326009a90e8efdcc6171b4206f74dc0147f27fb94fca676c4ab3bbb553e4c1`.

Diagnostic korzysta z tego samego ControlRoomGuard i supervisora co launcher.
Warianty ACK, lost-ACK i innego buildu potwierdzają custody, rzeczywisty wait
i durable readback. Zachowano wcześniejsze próby replacement restore,
completion, kolejnej rezerwacji i mutacji HTTP. Ścieżki dowodów są względem
storage resolvera. Scoped rustfmt i diff check przeszły. Nie kompilowano
testów jednostkowych.

Negatywne gałęzie timeout/nieudany wait supervisora oraz shutdown po
`CommitNotSent` mają review źródeł, ale brak odrębnego fault-injection runtime:
**NOT VERIFIED**. Próba API nie jest dowodem świeżego uruchomienia Tauri ani
hydration interfejsu.

## Pozostałe bramki

Uruchomienie replacement przez produkcyjnego koordynatora, transport z UI,
zachowanie szkiców, hydration, drugi live restart, Compute i warm service
pozostają otwarte. `restart_available=false`; procent całego planu bez awansu.
Sesja użytkownika pozostaje zamknięta zgodnie z poleceniem.
Publikacja na publicznym remote pozostaje zablokowana przez automatyczną
kontrolę zgody.
