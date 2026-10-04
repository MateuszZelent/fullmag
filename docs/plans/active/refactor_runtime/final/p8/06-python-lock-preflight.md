# P8-C — niespójny lock zależności Pythona przed bundle

Data: 02.10.2026. Preflight źródłowy i regresje PASS.
Synchronizacja lockfile, CPython bundle i pełny MSI: NOT VERIFIED.

## Ustalenie

`packages/fullmag-py/pyproject.toml` deklaruje Python `>=3.10`, trzy zależności
podstawowe oraz grupy `meshing` i `figures`. Obecny `uv.lock` deklaruje
`>=3.12`, inne minima wersji, tylko `meshing`; brakuje deklaracji `manifold3d`
oraz grupy `figures` z Pillow. Nie wolno traktować tego lockfile jako
zsynchronizowanego kontraktu pełnego pakietu Python.

Obecny MSI instaluje tylko wheel podstawowy wraz z zależnościami przez
zewnętrzny Python. Nie dostarcza interpretera i nie instaluje meshing extras.
To pozostaje otwarte; samo poprawienie preflight nie jest Python bundle.

## Wykonana ochrona

`scripts/check_python_dependency_lock.py` porównuje deklaracje projektu
z metadanymi jego jedynego wpisu w lockfile: nazwę/wersję, zakres Pythona,
zależności, optional extras i dev groups. Normalizuje nazwy oraz kolejność
specifierów. Obecnie obsługuje prostą składnię registry requirements używaną
w projekcie; nowe formy PEP 508 kończą się jawnym błędem i wymagają
rozszerzenia kontroli. Nie pomija ich po cichu.

MSI wywołuje kontrolę przed buildem. Niespójność daje exit 1 z poleceniem
odświeżenia lockfile. To kontrola deklaracji, nie dowód kompletności graphu,
hashów wheeli, ABI ani działania runtime. Pełny export/install nadal wymaga
zatwierdzonego narzędzia uv oraz jego własnego sprawdzenia locka.

13 lekkich regresji PASS: zgodny kontrakt, siedem rodzajów driftu,
trzy nieobsługiwane formy wymagań oraz prawdziwy frontdoor CLI/TOML dla
poprawnych i błędnych wejść. Dodatkowo metadane MSI w PowerShell 5/7:
2 PASS. Rzeczywisty projekt zwraca oczekiwany exit 1 dla niezgodnego
`requires-python`. Nie kompilowano unit tests, solvera ani pełnego buildu.

Niezależny review nie wykazał nowego P0 w preflight. Dwa blokery P1
całego produkcyjnego bundle pozostają jawnie otwarte: obecny stale lock
oraz zwykły `pip install`, który nie konsumuje jego hashów i może pobierać
transitive dependencies z aktualnego indeksu. Po odświeżeniu locka należy
zastąpić ten krok przypiętym Windows wheelhouse, instalacją `--require-hashes`
i `--no-index`; sama kontrola metadanych tego nie rozwiązuje.

Późniejszy [przyrost wheelhouse](07-locked-windows-python-wheelhouse.md)
zastępuje ten zwykły krok pip na poziomie producenta i sprawdza realny pip
na fixture wheelach. Prawdziwy export uv, lock i pełny Python bundle nadal
pozostają NOT VERIFIED; ten zapis nie zalicza kwalifikacji produkcyjnej.

## Pozostała kolejność

1. Dostarczyć uv przez zatwierdzoną trasę narzędzi buildu i odświeżyć
   `uv.lock` z aktualnego pyproject bez zmiany publicznego minimum Pythona.
   Wykonać eksport z kontrolą niezmienności locka, wszystkimi wymaganymi
   extras i hashami wheeli Windows.
2. Dołączyć zatwierdzoną natywną CPython distribution z licencją i
   pełnym inventory; izolować module search path od instalacji użytkownika.
3. Zainstalować przypięte Windows wheels podczas pakowania, nie na komputerze
   użytkownika; objąć DLL/PYD audytem i wykonać staged imports oraz Python→IR.
4. Zweryfikować CLI/API/UI na czystym Windows, instalację, upgrade i recovery.

Brak uv na PATH i w sprawdzonym managed tools. Próba instalacji gotowego
wheela uv przez `fullmag_storage.py run` w profilu
`windows-python-package-lock` została zatrzymana przez regułę:
`Container runner owns heavy builds on this host; submit a snapshot through
just runner-build`. Nie użyto trasy poza wrapperem i nie zmieniono reguły,
runnera ani aktywnych jobs. To blokada tej trasy bootstrapu, nie automatyczna
odmowa review i nie zakończenie pełnego celu. Instalacja narzędzia nie
nastąpiła. CPython bundling pozostaje następny po synchronizacji zależności.

Podstawa projektu pakowania:
[CPython — embeddable package](https://docs.python.org/3.12/using/windows.html#the-embeddable-package)
oraz [uv — export](https://docs.astral.sh/uv/concepts/projects/export/).
Dokumentacja przewiduje instalację zależności aplikacji podczas jej pakowania;
nie należy uruchamiać pip jak dla zwykłej instalacji na embedded runtime
użytkownika.
