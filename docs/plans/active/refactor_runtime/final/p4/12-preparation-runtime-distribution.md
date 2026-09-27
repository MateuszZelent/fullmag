# P4-B — dystrybucja runtime preparacji FEM

Data: 28.09.2026
Implementacja: `390df0802`

## Zakres

Cztery procesy składające się na accepted-run preparation FEM są teraz częścią
pełnych artefaktów dystrybucyjnych Fullmag:

- `fullmag-api-accepted-fem-preparer`;
- `fullmag-api-accepted-fem-preparation-supervisor`;
- `fullmag-api-accepted-fem-preparation-scheduler`;
- `fullmag-api-preparation-resource-pool`.

Pakiet portable Linux wymaga każdego pliku przed złożeniem paczki, kopiuje go
do `bin/` i ustawia RPATH na prywatny katalog bibliotek dystrybucji. Walidator
pakietu sprawdza obecność, brak nierozwiązanych zależności dynamicznych oraz
oczekiwany RPATH dla każdego procesu.

Skrypt Windows MSI dodaje te same cztery procesy do stagingu, manifestu i
kontroli kompletności układu. Kontrakt źródłowy wydania obejmuje odtąd zarówno
dotychczasowy accepted scheduler i resource pool, jak i cały nowy łańcuch
preparacji FEM.

Minimalne archiwa GitHub Release zachowują istniejący zakres aplikacyjny. Nie
zawierają także starszych procesów accepted-runtime; ten przyrost nie zmienia
więc ich kontraktu pośrednio.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| Parser Git Bash dla obu skryptów Linux | **PASS** |
| Parser PowerShell dla skryptu MSI | **PASS** |
| Parser AST kontraktu Python | **PASS** |
| Statyczna kontrola trzech punktów pakowania każdego z czterech binariów | **PASS** |
| `git diff --check` i staged diff check | **PASS** |
| Testy jednostkowe | **NOT RUN** — aktywny zakaz ich kompilowania |
| Zbudowanie i walidacja rzeczywistego portable/MSI | **NOT VERIFIED** |
| Managed scheduler/process/native FEM E2E | **NOT VERIFIED** — Docker Desktop coordinator nie odpowiada |

Dystrybucja usuwa lukę, w której produkcyjne procesy istniały wyłącznie w
źródłach. Nie dowodzi ich działania ani poprawności native FEM. P4 pozostaje na
**50%**, a cały plan na około **49%** do czasu zarządzanego process E2E i
kwalifikacji artefaktów wydania.
