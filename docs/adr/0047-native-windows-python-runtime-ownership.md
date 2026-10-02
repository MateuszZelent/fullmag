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
Dodatkowy rekurencyjny audyt obejmuje scientific wheel EXE/DLL/PYD oraz bin.
Odrzuca brakujące importy i konfliktujące DLL; po import smoke porównuje
cały zestaw ścieżek i hashów z zamrożonym raportem. Dostępność biblioteki
nie dowodzi kolejności loadera ani rejestracji katalogów wheel: te zależności
są jawnie opisane, a runtime_qualified pozostaje false.

Smoke producenta używa dołączonego interpretera, sprawdza izolację przy
pustym PATH i zatrutym środowisku oraz importuje deklarowane runtime extras.
Runtime identity, Python→IR, scientific PYD/DLL, clean install, upgrade,
rollback i brak fallbacku launchera nadal wymagają rzeczywistych dowodów.
CLI/API korzystają ze wspólnej polityki `fullmag-runtime-control/python_runtime`.
Windowsowy executable, `_pth` lub `share/version.json` oznacza obowiązek
dołączonego runtime, także po utracie executable. Nie zastępujemy go
FULLMAG_PYTHON, developerską venv lub PATH. Kontrolujemy podstawowe pliki
i dokładny `_pth`, uruchamiamy z `-I -u`, usuwamy środowisko Python i
ograniczamy PATH do bin/python aplikacji. To sprawdzenie layoutu, nie
kryptograficzna kwalifikacja wszystkich plików podczas każdego startu.
Starszy pakiet Windows bez tego runtime wymaga aktualizacji; nie korzysta
z cichego fallbacku. Historyczny layout bin/fullmag + web/.fullmag także
ustanawia pakiet, gdy nie jest checkoutem DSL. Wykryta instalacja Windows
z bieżącego executable ma pierwszeństwo przed FULLMAG_REPO_ROOT.
CLI i standalone API domyślnie zapisują stan do LOCALAPPDATA/Fullmag
albo USERPROFILE/AppData/Local/Fullmag. Brak obu wymaga jawnego
FULLMAG_STATE_ROOT; nie zapisujemy obok binariów ani w fallbacku temp.
Checkout developerski bez markerów i Linux zachowują
dotychczasowy wybór. Zachowanie runtime nadal wymaga kwalifikacji.

Nie zmieniamy fizyki, ProblemIR, capability vocabulary ani API v2. Linux
zachowuje swoją realizację. Aktualny lock Python jest niespójny i blokuje
realny MSI przed buildem. Regresje źródłowe nie kwalifikują dystrybucji.

Implementacja: `stage_python_runtime.py`, MSI, workflow, Python package ABI
check, płaski PE planner/audyt. Operator odpowiada za pochodzenie/podpis
dystrybucji i licencje całego graphu; kontrola niepustej licencji nie dowodzi
jej autentyczności. Rollback cofa producenta pakietu, bez migracji sesji.

Podstawa: [CPython embeddable package](https://docs.python.org/3.12/using/windows.html#the-embeddable-package).
