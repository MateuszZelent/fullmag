# ADR 0047 — Python należący do natywnego pakietu Windows

Status: accepted; producent źródłowy, runtime i instalacja NOT VERIFIED.
Data: 02.10.2026.

## Decyzja

Produkt Windows dostarcza własny CPython zamiast wymagać instalacji Python
użytkownika. Operator buildu wskazuje jawny absolute katalog
`FULLMAG_WINDOWS_PYTHON_RUNTIME_ROOT` z zatwierdzoną dystrybucją embeddable
CPython 3.12 x64 i `LICENSE.txt`. Nie kopiujemy Conda ani interpretera z PATH.
Wersja patch i SHA-256 wszystkich plików wejściowych trafiają do inventory.

Minor ABI produktu to CPython 3.12; interpreter instalujący runtime wheels
podczas buildu musi używać tej samej wersji minor. To wymaganie pakietu,
nie podniesienie publicznego minimum Python DSL z 3.10. Dalsza aktualizacja
minor wymaga ponownego rozwiązania graphu, audytu PYD i kwalifikacji.

MSI zawiera `python/python.exe`, standard library ZIP, DLL/PYD dystrybucji,
lokalny `site-packages` oraz kopię licencji. Producent zapisuje kontrolowany
`python312._pth`: ZIP, katalog interpretera, site-packages i import site.
`sitecustomize.py` przetwarza lokalne `.pth` przypiętych pakietów i zachowuje
uchwyt DLL search directory do `bin` aplikacji. Zmienne PYTHONHOME/PYTHONPATH
oraz user site nie określają module search path pakietu.

## Obowiązki i granice

Źródło musi być płaską dystrybucją embeddable z domyślnym izolowanym `_pth`.
Staging jest świeży, nie nadpisuje obcej zawartości, hashuje kopie i odrzuca
zmianę wejść. Wspólny planner/audyt rozszerza płaską kontrolę interpretera
o `.pyd`; closure używa tylko własnej jawnej dystrybucji, bez przeszukiwania
SDK FEM lub PATH. Brak wymaganej biblioteki zatrzymuje pakowanie.
To nie obejmuje jeszcze rekurencyjnego graphu rozszerzeń scientific wheels.

Smoke producenta używa dołączonego interpretera, sprawdza izolację przy
pustym PATH i zatrutym środowisku oraz importuje deklarowane runtime extras.
Runtime identity, Python→IR, scientific PYD/DLL, clean install, upgrade,
rollback i brak fallbacku launchera nadal wymagają rzeczywistych dowodów.
CLI/API mają istniejących kandydatów packaged Python; ścisłe pierwszeństwo
i odmowa zewnętrznego fallbacku pozostają osobnym etapem integracji.

Nie zmieniamy fizyki, ProblemIR, capability vocabulary ani API v2. Linux
zachowuje swoją realizację. Aktualny lock Python jest niespójny i blokuje
realny MSI przed buildem. Regresje źródłowe nie kwalifikują dystrybucji.

Implementacja: `stage_python_runtime.py`, MSI, workflow, Python package ABI
check, płaski PE planner/audyt. Operator odpowiada za pochodzenie/podpis
dystrybucji i licencje całego graphu; kontrola niepustej licencji nie dowodzi
jej autentyczności. Rollback cofa producenta pakietu, bez migracji sesji.

Podstawa: [CPython embeddable package](https://docs.python.org/3.12/using/windows.html#the-embeddable-package).
