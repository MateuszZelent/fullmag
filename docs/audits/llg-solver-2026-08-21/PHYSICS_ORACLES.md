# Macierz oracles fizycznych LLG

| Oracle | Weryfikowana własność | Wymagane lane |
|---|---|---|
| Jednorodny spin w stałym polu | znak precesji, `gamma`, `mu0`, `1/(1+alpha^2)` | FDM/FEM CPU/GPU |
| Damping-only energy law | monotoniczność energii przy braku napędów | FDM/FEM CPU/GPU |
| Długi przebieg macrospin | dryf `|m|`, order czasowy | FDM/FEM CPU/GPU |
| Manufactured exchange mode | błąd przestrzenny i czasowy | FDM/FEM CPU/GPU |
| Material-interface fixture | skoki `Ms/Aex/DMI`, inactive DOF | FDM/FEM CPU/GPU |
| PBC fixture | identyfikacja brzegów/linków/DOF | FDM/FEM CPU/GPU |
| Airbox exclusion | brak auxiliary DOF w LLG | FEM CPU/GPU |
| Thermal variance | zależność od `dt`, temperatury, objętości, `alpha`, bare `gamma_mu0` i `M_s`; zakaz użycia gamma zredukowanej mianownikiem Gilberta w amplitudzie | wszystkie lane z termiką; osobny test odrzucenia kombinacji nieobsługiwanych |
| RHS/stage/step parity | zgodność CPU/GPU przed pełną trajektorią | FDM CPU↔GPU, FEM CPU↔GPU |

Każdy oracle musi zapisywać parametry, tolerancje, requested/executed backend, precision i pełne provenance operatorów.
