# Propozycja oddzielnego limitu inventory accepted-store dla recovery v4

Status: **przygotowane, nie zastosowane; 157 testów PASS; rzeczywisty odczyt zatrzymany na historycznych próbach**.

Bazowy commit: `cc99de027bf1c32161239b4e2e0773238b9a5907`.
Patch: `2026-10-28-v4-store-inventory.patch.txt`.
SHA256 patcha: `b0155ef787a45af56b90be101c5d93888cd2a4363794154b7eae94579c34ee80`.

## Problem i dokładny zakres

Chroniony store ma 15 919 plików. Obecny wspólny `MAX_ENTRIES=8192`
blokuje odczyt pełnej historii przed kwalifikacją dokładnych pinów.
Propozycja rozdziela wyłącznie budżet odczytowego inventory w trybie v4.
Nie stanowi zgody na restart, release, Solve ani zmianę danych naukowych.

| Ograniczenie | Legacy / v1–v3 | Proponowane v4 |
|---|---:|---:|
| Pliki całego store | 8192, bez zmiany | `MAX_STORE_FILES=32768` |
| Runy katalogu `runs` | 8192, bez zmiany | 128 |
| Odwiedzone katalogi, łącznie z root | bez nowej polityki | 4096 |
| Czas skanu runów i przejścia store | bez nowej polityki | 30 s |
| Wpisy pojedynczego artifact catalog | 8192, bez zmiany | 8192, bez zmiany |
| Pojedynczy obiekt CAS | 128 MiB, bez zmiany | 128 MiB, bez zmiany |
| Łączny odczyt CAS | 128 MiB, bez zmiany | 1 GiB, bez zmiany |

`MAX_ENTRIES` pozostaje 8192. Nowe limity stosują się tylko przy
`observation.get('v4_mode') is True`, analogicznie do istniejącego kontraktu.
30 sekund obejmuje skan runów oraz walk, z kontrolą przed każdym runem,
katalogiem i plikiem. Zewnętrzny istniejący alarm helpera 45 s (dla trasy
ledger-volume) oraz timeout procesu 90 s pozostają niezmienione. Bramka
odmawia po przekroczeniu granicy; nie obcina inventory ani nie pomija plików.

Cała walidacja exact pins, terminal/held-manual, braku start_release, stanów
zadań, lease, host-before-store i CAS pozostaje niezmieniona. Patch nie
zmienia kanonicznego native recovery ani schematu żądania.

## Przypięcie źródeł bazowych

- `scripts/docker_volume_container_recovery.py`: `f1f6b9df7693483930c211bbd95d624e40dd04215245eeea9053158e7729fe10`.
- `scripts/test_docker_volume_abrupt_stop_recovery.py`: `4cc19d7ff83cbcc5c071b6abba934bb354c1bdc0a0d3b1a076dde7c1f2816519`.

Patch zmienia produkcyjnie wyłącznie embedded helper w
`scripts/docker_volume_container_recovery.py::_ledger_and_store_snapshot`.
Drugim docelowym plikiem jest istniejący
`scripts/test_docker_volume_abrupt_stop_recovery.py`.
Źródła tych dwóch plików w worktree nie zostały zmienione przez przygotowanie.

## Regresje proponowane w patchu

Testy pobierają faktyczny tekst embedded helpera przez AST istniejącej funkcji.
Wykonują jego nieprzepisany blok inventory i rzeczywiste stałe na syntetycznych
`os.scandir` / `os.walk` i metadanych Path, bez tworzenia 32 tysięcy plików.
Nie implementują osobno warunków limitów. To weryfikacja części inventory;
nie jest dowodem przejścia całego recovery.

- legacy: 8192 przyjęte, 8193 odrzucone;
- v4: 8193 oraz 32768 przyjęte, 32769 odrzucone;
- v4: 4096 katalogów przyjęte, 4097 odrzucone; legacy bez nowego limitu;
- v4: 128 runów przyjęte, 129 odrzucone;
- timeout w skanie runów, katalogów i plików;
- symlink katalogu/pliku i nie-regularny plik nadal odrzucane.

Istniejące testy exact-pin, unknown evidence, start-release, lease i CAS nie
są usuwane ani osłabiane. Patch wymaga zastosowania w kontrolowanej kopii,
wykonania testów oraz niezależnego review przed publikacją zmiany.

## Rzeczywiste bramki i ograniczenia

Przygotowanie patcha nie uruchamiało testów ani helperów; późniejsze wykonanie
kontrolne opisano poniżej. Większy limit nie dowodzi przejścia całego store. Osobnymi
nierozstrzygniętymi bramkami pozostają dowód izolacji aliasów Desktop-prefix
oraz rzeczywista kwalifikacja zawartych linków LX. Nie wolno ich omijać.
Po pozytywnych regresjach potrzebny jest nowy pełny preflight 43 runów,
weryfikacja zachowania całej historii i dopiero dalsze przypięte kroki recovery.
Wyniki Failed/unassessed nie zmieniają kwalifikacji naukowej przez ten patch.


## Wykonana weryfikacja kopii — 28.10.2026

Root zastosował przypięty patch wyłącznie w kopii dwóch plików w wolumenie
kontrolnym naszej grupy, pod `verification/v4-store-inventory-proposal-20261028/candidate`.
Nie zastosowano go do źródeł produkcyjnych i nie uruchomiono API ani Solve.

- `git apply --check` oraz parser Python 3.8: PASS.
- Sześć powiązanych modułów testowych: **157 testów, 0 błędów, 0 failures,
  0 pominiętych**, 9.312 s, exit 0. Log i metadane: `tests.log`, `tests.json`
  w tym samym katalogu dowodowym. Komunikaty fixture o publication/recovery
  w stdout testów nie oznaczają wykonania rzeczywistej operacji.
- Niezależny przegląd pełnego patcha: brak Required findings. Limit 30 s jest
  sprawdzany pomiędzy operacjami, nie przerywa pojedynczego blokującego odczytu;
  istniejące zewnętrzne ograniczenia czasu pozostają.
- SHA256 kandydata recovery: `1863548a8dfd766acf7552d5dd1b56cc38d8122d4da18a6df462f2f9f23bbe1e`.
- SHA256 kandydata testów: `e36ed9e389998cb4114df6f22697a21681863fbd5ce6f3d25bbbda8051a8bbfc`.

Odczytowa próba `_ledger_and_store_snapshot` na rzeczywistym, przypiętym store
przeszła limit plików, lecz zakończyła się odmową po 10.671 s:
`unsupported historical retry: retained solver lease differs from current terminal catalog attempt`.
To kontrola komponentu, nie pełny kanoniczny preflight i nie zgoda na restart.
Dowód: `actual-store-readonly.json`.

Odczyt katalogów i 38 rezerwacji wskazał dwie rozbieżności historyczne:

| Run | Zwolniona próba historyczna | Aktualna próba katalogu |
|---|---|---|
| `run-live-255fa587f4084d187d7e690f4d75076a4889fcf685a044ee02e4e8486a06b2da` | `attempt-35f480a608e6427ebebf02d127657ab8`, epoch 1 | `attempt-37daccd7aa964bc88f6143ad9613ba06`, epoch 2, succeeded |
| `run-surface-prepared-source-20261025-02` | `attempt-56642ebad7874adfa9c9367a8945e319`, epoch 1 | `attempt-33df698e66944c87b9409baf0200c887`, epoch 2, succeeded |

Oba stare rekordy mają stan `released`. Nie dowodzi to samodzielnie bezpiecznego
recovery całej historii. Należy uzgodnić kontrolę wszystkich prób z kontraktem
natywnym, receiptami zakończenia i artefaktami. Nie usuwano starych rezerwacji,
nie zmieniano ich attempt/epoch ani końcowych katalogów. Szczegóły:
`historical-leases-readonly.json`. Ten patch nie rozszerza obsługi historycznych
prób; ich odmowa pozostaje. Pełny restart wciąż wymaga tej kontroli oraz
wcześniej wskazanych dowodów aliasów Desktop i topologii LX.

Dwa puste wiersze kontekstu patcha zapisano bez końcowej spacji dla zgodności
z kontrolą whitespace repozytorium. `git apply --check` nadal przechodzi;
zmiana dotyczy zapisu patcha, nie testowanego kodu. Pierwotny hash patcha
w receipt testów: `13591f6436a9f925006468cea5795ba7dfd534dddc01fa97eefa34f7ce226b35`.
