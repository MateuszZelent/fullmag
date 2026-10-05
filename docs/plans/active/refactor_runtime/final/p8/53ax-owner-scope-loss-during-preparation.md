# P8-53AX — utrata właściciela podczas przygotowania backendu

Data: 05.10.2026. Stan: implementacja w toku; native NOT VERIFIED.
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
Pozostają: końcowy wynik buildu i realne wykonanie rozszerzonej próby.
Publiczne `restart_available=false`, pełny
restart niepustego workspace, browser hydration i procenty P0–P8 pozostają
bez awansu na podstawie samych kontroli źródłowych.
