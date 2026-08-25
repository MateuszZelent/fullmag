# Macierz testów lane-specific

| Poziom | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---:|---:|---:|---:|
| pojedynczy składnik pola | wymagany | parity | wymagany | parity |
| pełne `H_eff` | wymagany | parity | wymagany | parity |
| RHS LLG | oracle | parity | oracle | parity |
| jeden stage | oracle | parity | oracle | parity |
| accepted/rejected step | wymagany | parity | wymagany | parity |
| pełna trajektoria | oracle | parity | oracle | parity |
| norma i energia | wymagany | wymagany | wymagany | wymagany |
| PBC/interface | wymagany | wymagany | wymagany | wymagany |
| executed-device/no fallback | n/d | wymagany | n/d | wymagany |
| brak alokacji/assembly steady state | wymagany | wymagany | wymagany | wymagany |
| brak pełnego readbacku | n/d | wymagany | n/d | wymagany |
