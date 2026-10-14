# Natywne providery Windows FEM — checkpoint 2026-10-14

Zakres etapu: przypięte źródła HYPRE, libCEED i MFEM, adaptery Windows/MSVC/CUDA,
zarządzane przygotowanie zależności, inventory oraz niezmienione licencje providerów.
Nie jest to kwalifikacja całego Fullmaga ani wydania instalatora.

Zarządzane polecenie: `just fullmag windows=True build=True dev fem gpu headless examples/fem_relax_gpu_smoke.py`.
Worktree: `fem-script-launch-20261013-50f3956723fcec2d`, profil `windows-native-fem-gpu`.
Frozen source: `1161ee8a61716954c72ea63c06ac2f69313a8f1e142f7b385797c872e6a4c2e9`.
Attempt: `f5ee7c28ef844193804633f7ff760f02`.
Log w profilu: `logs/native-build-5f8ec6bb37484424a7b76fe9857883d7.log`.

## Dowody zakończenia etapu providerów

- HYPRE: kompilacja CUDA, link biblioteki i install PASS.
- libCEED: kompilacja C/C++/CUDA, link biblioteki i install PASS.
- MFEM: 259/259 kroków, link `mfem.lib` i install PASS. Pliki curlcurl oraz hcurl,
  które wcześniej blokowały build przez GNU inline asm, zostały skompilowane po
  zastosowaniu kompatybilnego device `__trap()`; źródła upstream nie były edytowane.
- `provider-receipt.json`: `completed_at=2026-10-14T07:17:13.7612647Z`, CUDA=true,
  architektura 89. Niezależna kontrola rozmiarów i SHA-256 wszystkich 432 plików
  inventory: PASS, zero niezgodności. Inventory zawiera osiem plików licencji/notices.
- Natywne interpretowane testy providerów i kontraktu CEED: 14 PASS. Fixture CMake
  nie konfiguruje kompilatorów ani nie buduje testów jednostkowych Rust/C++.

| Biblioteka | Rozmiar w bajtach | SHA-256 |
| --- | ---: | --- |
| HYPRE.lib | 175058904 | `332dd98443fb03f1ab6d546435b6fd873bdd6c48015ac77d2aa68bb52d373178` |
| mfem.lib | 393662812 | `7c636a00b49b6f9f2031742527563f254e577d7e03286ef4ffc7ed3462580872` |
| ceed.dll | 2097664 | `122120a62a70fa5de9f6e4298d5c34d70f2ce7c1c03e39f711685ca8bf8ca8f5` |

Przypięte źródła: HYPRE `9dc9e18aed6a945a95f966e57daacfb1c269f6ec`,
MFEM `d9d6526cc1749980a2ba1da16e2c1ca1e07d82ec`,
libCEED `4018a20a98d451fac24765d3ddb936861647ce8d`.

## Granice i następny krok

Cała komenda zakończyła się exit 1 po instalacji providerów: launcher PowerShell
używał `(if (...))` jako argumentu `-CudaArchitectures`, co wywołało błąd cmdletu
`if`. Poprawka launchera i jej wykonywalna regresja należą do następnego etapu.
Kompilacja Fullmag DLL/CLI/API, wykonanie symulacji GPU, UI oraz instalator EXE:
**NOT VERIFIED**. Udany build bibliotek nie dowodzi wykonania solvera ani fizyki.

Retencja: zachowano zainstalowane biblioteki, potrzebny cache przyrostowy,
źródła providerów, snapshoty, inventory, logi i receipty. Niczego nie usunięto.
Skill `fullmag-build-stage-cleanup` nie jest dostępny; zastosowano reguły retencji
build-storage governance. Wolne C: po etapie: 7961288704 bajty. Ponowna ocena
po terminalnym wyniku kolejnego buildu i ustaleniu zależności rollbacku.
