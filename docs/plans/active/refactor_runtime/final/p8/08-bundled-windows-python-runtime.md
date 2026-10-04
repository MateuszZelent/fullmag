# P8-C — staging dołączonego CPython dla Windows

Data: 02.10.2026. Implementacja źródłowa, rzeczywisty runtime NOT VERIFIED.

Producent MSI wymaga jawnego `FULLMAG_WINDOWS_PYTHON_RUNTIME_ROOT`:
CPython 3.12 x64 embeddable z licencją. Inspektor sprawdza niepuste regular
files, AMD64 PE wszystkich EXE/DLL/PYD, standard library ZIP, domyślne
izolowane `_pth`, platformę i wersję. Zamraża pełny inventory SHA-256.
Staging ponownie kontroluje wejścia, wymaga pustego katalogu Python,
kopiuje dystrybucję i licencję; wygenerowane `_pth` oraz `sitecustomize.py`
mają własne hashe. [ADR 0047](../../../../../adr/0047-native-windows-python-runtime-ownership.md)
opisuje decyzję minor ABI i właściciela runtime.

Python używany do instalowania zależności musi mieć minor ABI 3.12.
Publiczne minimum DSL >=3.10 pozostaje bez zmian. Python EXE/DLL i standard
library PYD podlegają osobnemu płaskiemu plannerowi/audytowi zależności,
bez poszukiwania DLL w PATH lub SDK FEM. Jawna kompletna dystrybucja CPython
jest jedynym źródłem closure, a brak biblioteki zatrzymuje pakowanie.
Rekurencyjny graph scientific wheels ma teraz osobną implementację
[audytu dostępności PE](10-recursive-python-native-audit.md); rzeczywiste
wejścia, loader Windows, ABI i wykonanie pozostają NOT VERIFIED.

Producent sprawdza SHA staged runtime, uruchamia go z pustym PATH,
zatrutym PYTHONHOME/PYTHONPATH, wymaga isolated/no_user_site i lokalnych
sys.path. Następnie używa bundled executable do importu fullmag, numpy,
h5py, zarr, scipy, gmsh, manifold3d, meshio, trimesh i PIL. Wersja,
inventory i płaski PE audit są zapisane w obu manifestach MSI.

## Dowody i pozostały zakres

Regresje inspektora/stagingu oraz smoke proof validation używają jawnych
fixture PE i atrapy executable probe. Nie uruchomiono prawdziwego CPython
embeddable ani scientific imports. Brak rzeczywistego źródła dystrybucji
i nieaktualny uv.lock pozostają bramkami; nie obejściami przez hostową Conda.
Testy nie kompilują unit tests ani natywnych modułów.

Weryfikacja: 18 regresji embed inventory/staging/proof, 26 PE audit,
28 DLL closure plan, 61 MSI assembly/metadata oraz 16 wheelhouse/integrity
PASS — 149 różnych przypadków. Po zmianie ABI powtórzono właściwe staging
i wheelhouse; po pozostałych zmianach ponowiono parser PowerShell: PASS.
Probe executable CPython, dumpbin dla fixture oraz export uv są atrapami.
Nie podnosimy tego dowodu do realnego bundled Python lub MSI. Pełne
MSI, Python→IR, ścisły brak fallbacku launchera, provenance/autentyczność
licencji i runtime, scientific ABI/DLL, clean install, upgrade/rollback,
trwałe sesje i kwalifikacja czterech lane'ów pozostają otwarte. Nie zmieniono
3104 ani cudzych zmian Rust; procenty całego planu nie zostały awansowane.
