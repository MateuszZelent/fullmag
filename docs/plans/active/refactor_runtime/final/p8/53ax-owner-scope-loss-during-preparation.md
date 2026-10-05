# P8-53AX — utrata właściciela podczas przygotowania backendu

Data: 05.10.2026. Stan: natywna bramka utraty owner scope PASS, 18/18 kontroli.
Kontynuacja [P8-53AW](53aw-candidate-preparation-fault-gates.md).
Kontrakt: [ADR 0050](../../../../../adr/0050-development-backend-restart.md),
asynchroniczne przygotowanie kandydata.

AW potwierdziło awarie pojedynczego helpera, a AV pozytywny cykl pompy.
AX ma wykazać, że produkcyjna pompa po utracie scope anuluje rzeczywiste
przygotowanie i nie przyjmuje jego spóźnionego wyniku. Sam brak joba nie
jest dowodem zakończenia procesu.

Scope przygotowania obejmuje API, worktree, generację, build i źródła.
Nie obejmuje revision modelu: edycja modelu nie powinna anulować kompilacji
ani niepotrzebnie odrzucać niezmiennych binariów. Session ID i epoch mają
odrębną kontrolę przy świeżym acquisition przed stage/restartem.

## Scenariusz i kryteria

Rozszerzamy istniejącą zarządzaną próbę `verify-windows-development-consumer-pump`.
Zbudowany CLI B pracuje z osobno zweryfikowanym, własnym API A w nowym
scoped accepted store. Działający workspace użytkownika na 3197 pozostaje
odrębnym procesem i magazynem.

Po pozytywnych kontrolach gotowości, lease i reuse druga pompa rozpoczyna
rzeczywisty selector B przy wciąż żywym A. Próba potwierdza PID i live/pending,
następnie zamyka wyłącznie własne diagnostyczne A przez jego supervisor.
Kolejne kroki pompy muszą odrzucić poprzedni scope i odebrać helper wraz
z transportami. Każdy krok jest ograniczony; unknown cleanup nie może
przejść w sukces ani pozwolić na następną selekcję.

| Kontrola AX | Wymagany dowód |
|---|---|
| Pending przed utratą scope | Wczesny PID i potwierdzona żywotność rzeczywistego selektora |
| Nieblokujące anulowanie | Najdłuższy obserwowany krok poniżej 1000 ms |
| Helper odebrany | Ten sam PID, waited true, rzeczywisty całkowity exit code po zakończeniu transportów |
| Brak przyjęcia wyniku | Druga pompa nie ma wybranego kandydata ani wykonania restartu |
| Brak zastąpienia procesu | Jedno własne API w śladzie, terminalne zamknięcie tego samego PID |

Driver zachowuje wszystkie wcześniejsze kontrole. Oczekuje 17 kontroli
pompy oraz zgodności kanonicznego OpenAPI. Trzy wcześniejsze helpery
muszą zakończyć się kodem 0; czwarty, anulowany selector, musi mieć
rzeczywisty kod całkowity, także gdy jest niezerowy. `None`, bool udający
liczbę, brak wait albo PID innego helpera nie stanowią terminalnego dowodu.
Oczekiwane są dwa różne early preparation PID dla tego samego API i buildu.

## Weryfikacja źródeł

Interpretowane regresje drivera: `python -B scripts/test_windows_consumer_pump_progress.py`,
9/9 PASS, exit 0. Obejmują utrzymanie dwóch early PID, odrzucenie
niepotwierdzonego/boolean custody oraz dopuszczenie niezerowego exit
wyłącznie dla dokładnego anulowanego PID. Anulowanie musi wskazywać drugi
start w kolejności próby, nie wcześniej zakończony selector. API PID trafia
do receipt jako niepotwierdzony przed zawodnymi walidacjami helperów;
błąd nie pozwala przywrócić statusu, gdy zakończenie własnego API jest unknown.
Wcześniejszy prawidłowy PID pozostaje w receipt także po błędnej kolejnej
ramce; poprawny terminalny progress zachowuje rzeczywisty kod niezależnie
od późniejszej odmowy kontroli zachowania.
To nie dowodzi natywnego anulowania.

Review zmian Rust i drivera: bez pozostałego blokera po korektach.
Parser/rustfmt PASS. Zarządzany build `just windows-backend-dev 3197`
utrwalił capture `3d053dc2540b6913ff10e4f251c70dee35349ef628e9dd3a6610e27c7888cf8f`;
log `native-build-5cd2ca077bc940f8a67c14e360b9c331.log`.
Build zakończył się exit 0: CLI/API 3 min 21 s, desktop 1 min 14 s.
Publiczne `restart_available=false`, pełny
restart niepustego workspace, browser hydration i procenty P0–P8 pozostają
bez awansu na podstawie samych kontroli źródłowych.

## Końcowy wynik runtime

`just verify-windows-development-consumer-pump 3b1de31747fb4fe7b5275b8cfdec42cd`
zakończył się completed, exit 0, 18/18 kontroli. Receipt:
`builds/fullmag-0950f4dca4ffe38f/development-backend-api-checks/checks/8028a78624ef450887ed000915957a93/receipt.json`.
Verified build ID: `d5ea8c2acf441ca7ae01d34955a581a9ba0504e3e0e6f31550d94d45b8b1e0a9`.
Build source identity: `ec81a94ae1e71fca8b42768cb7beb08c0e034ed0d3c269f5ee4acb7982a36eb1`.
Backend source: `21f97348c8e896e76645f17577550e7ccc94dfb9044d99abd4111a56f3bdd396`.

Pierwszy krok przygotowania trwał 58 ms; najdłuższy obserwowany krok
rozpoczęcia/anulowania drugiej pompy 34 ms. Scope loss wystąpiło po
potwierdzeniu żywego, drugiego helpera. Pompa odebrała ten sam PID,
nie zachowała kandydata i nie uruchomiła replacement.

| Własny proces próby | PID | Rzeczywisty exit | Wait potwierdzony |
|---|---:|---:|---|
| Inicjalizacja accepted store | 37496 | 0 | tak |
| CLI B | 105004 | 0 | tak |
| API A na porcie 27613 | 107328 | 1 | tak |
| Pierwszy selector | 89484 | 0 | tak |
| Drugi selector, anulowany po scope loss | 102024 | 1 | tak |
| Walidacja owner bundle | 106396 | 0 | tak |
| Walidacja ownera kandydata | 109360 | 0 | tak |

API A i drugi selector zakończono jawnie na potrzeby próby; ich exit 1
jest rzeczywistym odebranym wynikiem, nie graceful exit 0. Wszystkie
pozostałe procesy zakończyły się 0. Działającego workspace na 3197 nie
restartowano. Przywrócenie diagnostycznego statusu wykonał driver dopiero
po terminalnym potwierdzeniu własnego API.

Zakres PASS: utrata owner scope podczas realnego przygotowania oraz regresja
wcześniejszego pozytywnego cyklu. Nie jest to jeszcze dowód zmiany ready
build podczas joba, ponownego właściciela po nierozstrzygniętym cleanup ani
pełnego restartu/hydration niepustego modelu. Następny etap to zintegrowana
próba native/browser z kanoniczną sceną i niezapisanym dokumentem, przy
nadal wyłączonej publicznej capability.
