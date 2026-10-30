# Selektywne review historycznej poprawki exact Gamma

Data: 27.10.2026. Bieżąca baza przed adaptacją: 0ebf1594e. Historyczne źródło: commit f0986ede9853828dfd573a2bee12302385213321, repozytorium /mnt/c/git/fullmag/fullmag, branch inwentarza k0-exchange-only-diagnosis. Odczyt przez git show; bez checkoutu, fetch ani modyfikacji starego worktree.

## Decyzje dla fragmentów

| Fragment | Dowód i decyzja |
|---|---|
| C ABI boundary marker | api.cpp odrzucał marker 0 dla każdego warunku; historyczny fix rozróżnia pure_neumann. Adaptowano: 0 dozwolone dla pure Neumann, fizyczny marker odrzucany dla tego kontraktu; pozostałe warunki nadal wymagają niezerowego markera. |
| Exterior facet proof | poisson_airbox_shared_domain.cpp wymagał zewnętrznej ściany o markerze payloadu, więc sentinel 0 odrzucał poprawną mapę exterior. Adaptowano naturalny warunek na exterior, wyłączając periodic seams; konkretne markery pozostają wymagane dla essential/Robin. |
| Mode topology identity | Bieżący eigen_output.rs publikuje modal_source_topology_fingerprint i ma odrębną kontrolę source_mesh_topology_sha256. Historycznego bezpośredniego fallbacku nie kopiowano ponad nową tożsamość. To odpowiednik zamiaru, nie dowód zgodności wszystkich przypadków. |
| Relax certificate cache vs topology | Bieżący relax/finalize.rs liczy fem_mesh_topology_fingerprint z FemMeshPayload, a nie z fem_mesh_generation_id. Historyczna zamiana cache ID na SHA nie jest potrzebna w tej postaci; aktualny handoff ma własne walidacje. |
| Automatyczna zmiana warunków dynamicznych k0 | Historyczny planner wymusza pure Neumann dla periodic_airbox_k0 i zmienia routing GPU. Nie przeniesiono automatycznie: bieżący benchmark jawnie używa finite Dirichlet i porównuje się z odpowiadającym mu modelem. Zmiana wymaga osobnego określenia fizycznego scope i zgodności k→0, nie może służyć obejściu awarii frequency-window. |
| Demag policy i budżet bias relax | Pozostają do osobnego review; nie są zamknięte testem jednorodnego filmu ±10. |
| Build/toolchain/pozostałe hunki | Pozostają otwarte. Stare Windows launchery nie zastępują bieżącej grupy Docker. |

W inwentarzu status commita zmieniono z pending-semantic-review na partially-adapted. Nie oznacza to przeglądu całej historycznej linii ani integracji wszystkich 31 plików.

## Weryfikacja

Dodano negatywną i pozytywną regresję C ABI dla markerów Neumanna oraz rzeczywistą shared-domain assembly z markerem zero i mean_zero_augmented. Zachowano test odrzucenia nieznanego markera dla dotychczasowego warunku. Lokalnie diff check PASS; testy native wymagają GitHub Actions zgodnie z zakazem lokalnej kompilacji testów.

Wymagane CI: bootstrap/native-modal (C ABI) oraz bootstrap/positive-mass (MFEM shared-domain assembly). Nie jest to dowód wykonania runtime FEM/SLEPc ani rozwiązanie Gamma frequency-window. Nowy build blokuje pełny dysk WSL (~169 MiB wolnego przy odczycie).
