# P8-C — rekurencyjny audyt natywnych bibliotek Python

Data: 02.10.2026. Stan: implementacja kontroli pakietu; runtime NOT VERIFIED.

Dotychczasowy audyt PE obejmował płaski katalog interpretera. Nowa kontrola
`scripts/windows/verify_python_native_dependencies.py` obejmuje wszystkie
EXE/DLL/PYD w `python` (także site-packages i katalogi wheel .libs) oraz bin.
Odrzuca brakujące statyczne i delay-load zależności, niezgodną architekturę
x64/PE32+, różne binaria o wspólnej nazwie importu, symlinki/junctions oraz
zmianę zestawu lub hashów plików podczas kontroli. Nie pobiera bibliotek
z PATH, SDK ani środowiska hosta. Driver NVIDIA jest wyłącznie jawną
zależnością zewnętrzną dla wariantu CUDA; kopiowanie nvcuda.dll jest zabronione.

Producent MSI wykonuje kontrolę po instalacji wheelhouse, przed import smoke.
Wynik i hashe wszystkich obrazów trafiają do version metadata oraz stage
manifest. Po smoke producent sprawdza niezmienność raportu i porównuje cały
zestaw ścieżek/hashów obrazów. Wykrywa także dodane i usunięte obrazy.
Dotychczasowy płaski audyt interpretera i plan jego zależności pozostają.

## Zakres dowodu

Raport potwierdza **obecność** zależności importów w pakiecie. Rozróżnia
katalog importera, katalogi runtime oraz biblioteki w innych katalogach
pakietów (`bundled_package_loader_required`). Nie uznaje obecności DLL
w dowolnym katalogu za dowód, że loader Windows ją znajdzie. W każdym
raporcie `runtime_qualified=false`. Rejestracja katalogów przez wheel,
kolejność ładowania, dynamiczne LoadLibrary, symbole/ABI i wykonanie
obliczeń wymagają rzeczywistych testów runtime. Konserwatywna odmowa dla
różnych DLL o jednej nazwie może wymagać jawnego rozstrzygnięcia vendor/ABI;
nie wybieramy arbitralnie jednej kopii.

19 nowych testów interpretowanych PASS na nieuruchamialnych PE fixtures
z atrapą dumpbin; obejmują nested .libs/PYD, lokalne/wspólne katalogi,
transitive missing, x86, driver, konflikt, link oraz zmianę/add/remove.
Dotychczasowe 26 testów PE PASS. Testy nie kompilują unit tests Rust.
Dwie regresje rzeczywistego CLI sprawdzają zapis raportu i odmowę po dodaniu
obrazu po smoke. Integracja producenta: 110 testów interpretowanych PASS
(MSI storage/FEM assembly, CPython staging i wheelhouse). PowerShell
zachowuje nested inventory w stage manifest. Łącznie 155 różnych testów PASS.

Rzeczywisty lock/export, CPython embeddable, scientific wheels/dumpbin,
MSI clean install/upgrade/rollback, runtime i nauka pozostają NOT VERIFIED.
Nie zmieniamy fizyki, API, IR ani czterech realizacji obliczeń. 3104 i
pozostałe lokalne zmiany zachowane; cały P0–P8 nadal w toku.
