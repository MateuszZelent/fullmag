# P8-C — przypięty staging zależności Python dla Windows

Data: 02.10.2026. Implementacja ścieżki źródłowej i lekkie regresje PASS.
Prawdziwy export uv, aktualny pełny pakiet Python, CPython bundle i MSI:
NOT VERIFIED. Bieżący lock pozostaje stale i preflight nadal go odrzuca.

## Zmiana producenta

MSI zastępuje zwykły `pip install` funkcją
`Stage-FullmagLockedPythonPackages` z `scripts/windows/python_package.ps1`.
Wymaga narzędzia uv na executorze, dokładnie jednego świeżo zbudowanego
wheela Fullmaga oraz pustego katalogu stagingu. Interpreter buildu musi
być natywnym Windows x64 CPython 3.12 lub nowszym; jego wersja i platforma
są zapisywane w inventory. Nie jest to dołączenie interpretera do produktu.

Funkcja zamraża SHA-256 pyproject, locka i wheela projektu, eksportuje
requirements z `uv export --locked --all-extras --no-dev --no-emit-project`
i nie modyfikuje locka. Pobiera tylko gotowe wheels z `--require-hashes`
do osobnego katalogu bieżącej próby. Instaluje zależności z niego przez
`--isolated --no-index --require-hashes --no-compile`. Własny wheel Fullmaga
jest instalowany oddzielnie z własnym hashem i `--no-deps`.

Zmiana inputów, requirements lub wheeli zatrzymuje publikację. Błąd
export/download/install nie daje inventory PASS. Częściowy staging
pozostaje wyłącznie w prywatnym katalogu nieudanej próby; nie jest używany
jako gotowy pakiet. Nie usuwamy ani nie nadpisujemy istniejącego stagingu.
Inventory metadanych MSI zawiera host, wejścia, requirements hash,
hash inventory wheeli, wszystkie extras i `qualification=not_verified`.

Po skopiowaniu własnego wheela do MSI producent sprawdza SHA-256 kopii
z zamrożonym wejściem oraz zgodność nazwy i wersji w filename i embedded
METADATA z pyproject. Wymaga dokładnie jednego właściwego katalogu dist-info.
Opis licencji mówi o lockach użytych ze źródeł; nie obiecuje ich obecności
w instalatorze. Pełny audyt licencji zależności pozostaje otwarty.

Tryb `--isolated` ignoruje zmienne pip i konfigurację użytkownika; nie jest
deklaracją izolacji wszystkich globalnych ustawień maszyny. Hash validation
pozostaje wymagana niezależnie od źródła pobrania.
[Dokumentacja pip](https://pip.pypa.io/en/stable/cli/pip/)
i [eksport uv](https://docs.astral.sh/uv/concepts/projects/export/)
określają zachowanie tych narzędzi.

## Dowody

Osiem testów `scripts/test_windows_python_wheelhouse.py`: PASS. Wykonują
rzeczywistą funkcję PowerShell i prawdziwe offline `pip download/install`
na małych, jawnie testowych wheelach `fixturedep` i `fullmag`. UV export
jest atrapą; testy nie dowodzą działania uv ani prawdziwego graphu zależności.

Przypadki obejmują: poprawną instalację i inventory hashów, export failure,
download failure, zmianę locka, zmianę requirements, zmodyfikowany wheel,
failure instalacji projektu oraz ochronę niepustego site directory.
Każda awaria sprawdza konkretny etap zatrzymania i brak końcowego inventory.
Modyfikację wheela odrzuca rzeczywisty pip w trybie wymagania hashów.
Ścieżki ze spacjami są objęte próbą; nie wygenerowano pyc ani nie
kompilowano unit tests, extension modules lub solverów.

Metadane UTF-8 bez BOM dla PowerShell 5/7: 2 PASS, w tym inventory Python
w version/stage JSON i jawny brak kwalifikacji runtime. Niezmienione
wcześniejsze testy pozostałych fragmentów nie były powtarzane.

Siedem dodatkowych regresji prawdziwego CLI walidatora wheela: PASS.
Obejmują zgodny wheel, zmienioną kopię, błędną nazwę lub wersję filename,
błędne embedded Name/Version i dodatkową METADATA. Łącznie 15 regresji
Python staging/integrity oraz 2 testy metadanych; bez pełnego MSI builda.

## Otwarte bramki

Bootstrap uv pozostaje blokowany przez regułę managed kolejki na tym hoście.
Nie wykonano nowej instalacji narzędzia ani obejścia tej reguły. Trzeba
odświeżyć lock z aktualnego pyproject, wykonać rzeczywisty Windows export
i audyt native DLL/PYD oraz staged imports/Python→IR. CPython distribution
z licencją, izolacja module search path, brak zewnętrznego interpretera,
clean install, upgrade/rollback i recovery nadal wymagają domknięcia.

Dotychczasowy build frontend wheela (`python -m build`) i jego build-tool
dependencies wymagają osobnej kwalifikacji reprodukowalności. Nie mylimy
hashowanego stagingu runtime z dowodem całego builda. Wymaganie zewnętrznego
Python 3.12+ w metadanych nie dowodzi przenośności native wheeli między
różnymi minor ABI. Pełny bundle musi przypiąć interpreter i jego ABI.
Nie awansowano procentów całego P8 ani planu; 3104 i cudze zmiany zachowane.
