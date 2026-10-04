# P8-53X — rezerwacja zimnego magazynu zaakceptowanych zadań

## Zachowanie

Brak skonfigurowanego service nie dowodzi globalnego idle. Nowa trasa wymaga
istniejącego magazynu i braku `APPLICATION.json`, `OWNER.lock`, `OWNER.json`
oraz `LAUNCH.json`. Historyczny lub niepewny owner wymaga osobnego recovery.
Nie inicjalizujemy brakującego magazynu podczas obserwacji.

Rezerwacja utrzymuje blokadę launchera oraz osobną blokadę przejmowania ownera
`STARTUP-GATE.lock`. Ten sam mechanizm obejmuje bezpośredni start service,
przed utworzeniem `OWNER.lock` i publikacją `Starting`. Stały plik blokady
nie jest zapisem ownera i pozostaje po zwolnieniu blokady systemowej.

Po sprawdzeniu całego magazynu istniejący mechanizm zakłada trwały admission
fence. Drop zwalnia tylko blokady systemowe. Nowy service odrzuca przejęcie
także po Drop lub awarii procesu, dopóki fence nie zostanie jawnie rozpoznany
i zwolniony. Błąd lub timeout nie oznacza zgody na jego usunięcie.

Konsument CLI wymaga kapsuły z tego samego aktywnego przejęcia API i braku
jawnej konfiguracji resident service. Przed rezerwacją i po niej weryfikuje
UUID API, źródła oraz binding zaakceptowanego magazynu. Potwierdza guard
na tym samym kanale; błąd unieważnia połączenie i zachowuje trwały fence.

## Weryfikacja

Review wykrył wyścig pierwszej publikacji deskryptora blokady. Poprawka
serializuje utworzenie i zapis przez istniejący WRITER przed udostępnieniem
blokady startup. Zastany uszkodzony plik nadal wymaga recovery. Natywna sonda
obejmuje osiem równoczesnych pierwszych prób i potwierdza późniejsze użycie
kompletnego deskryptora. Review poprawki nie znalazł kolejnych błędów.

Zarządzany build `just windows-workspace-build dev dev 3197 auto` zakończył
się exit 0, również po poprawce inicjalizacji i dodaniu regresji konkurencji.
`just verify-windows-development-backend-api` wykonał **110
sprawdzeń**, exit 0, **24 procesy** z potwierdzonym wait. Receipt:
`development-backend-api-checks/checks/cecdc7f87a5e4d46ad15703ca0e32ff8/receipt.json`.
Digest backendu przed/po:
`bc7e3efc787bac56b8dd04cd8bd265c46d07218c94e9f116aa62664f2b89cd7e`.
Snapshot buildu:
`e3d479ba1fb4d66b9b55b977a42ca843ff3df27174451a89df8532dc5e076476`.
Poprzednia seria 109 sprawdzeń (`6c659c11a1f24648bbfdfc86365d752d`)
została zachowana; końcowy dowód obejmuje poprawkę wyścigu i jej regresję.

Sonda uruchomiła własny service bezpośrednio, wymagała konkretnych przyczyn
odmowy i potwierdziła zakończenie obu procesów. Sprawdziła brak publikacji
ownera, zachowanie fence po Drop oraz ponowną rezerwację po jawnym abort
własnego fixture. Następnie istniejący service i pozostałe bramki przeszły
dotychczasowy przebieg. Nie kompilowano testów jednostkowych.
UI 3197 nie był restartowany i nadal odpowiadał HTTP 200.

## Otwarte bramki

Pozytywny przebieg staging + pasujący binding API + rezerwacja jako jedna
transakcja pozostaje **NOT VERIFIED**. Tak samo atomowy commit, graceful
shutdown API, replacement, nowy pin oraz hydration UI. Brakujący magazyn
wymaga osobnej zarządzanej inicjalizacji. Procenty całego planu bez awansu.
