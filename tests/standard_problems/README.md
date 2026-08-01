# Standard problems

Ten katalog jest kanonicznym miejscem współdzielonych, publikacyjnych testów
walidacyjnych solverów Fullmag. Kontrakt fizyczny i oficjalne referencje są
wspólne dla realizacji FDM i FEM; realizacje backendów znajdują się w osobnych
podkatalogach problemu.

Pełna bramka µMAG SP4 dla strict FEM CPU i GPU jest uruchamiana wyłącznie
zarządzaną recepturą `just verify-fem-standard-problem-4`. Obejmuje oba pola,
three-mesh convergence, dwa airboxy oraz parytet CPU/GPU. Szybkie testy Python
i smoke runtime nie stanowią kwalifikacji fizycznej.

`tests/stdprob4_dynamics.py` pozostaje historycznym prototypem FDM i nie jest
dowodem kwalifikacji FEM.
