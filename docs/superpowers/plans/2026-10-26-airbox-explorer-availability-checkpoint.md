# Dostęp do wizualizacji Airbox przed siatką — 26.10.2026

Status: niezależna poprawka źródeł drzewa, bez potwierdzenia pełnego pola.

`apps/control-room/src/modules/explorer/builders/buildModelTree.ts::buildModelTree`
zachowuje ścieżkę Universe → Airbox → Visualization również bez rozpoznanej
domeny albo zbudowanego nośnika. Nowy
`apps/control-room/src/modules/explorer/builders/airboxExplorerNodes.ts::buildAirboxPresentationNode`
ma status root unavailable i badge no mesh, a dostępny węzeł Visualization
prowadzi do istniejącego ownera airbox. Nie tworzy węzła Mesh, fikcyjnej siatki
ani field ID; nie aktywuje fizyki. Istniejące gałęzie FDM/FEM mają pierwszeństwo.
Właściwy mesh oraz ilości fizyczne nadal wymagają własnych zasobów i bramek.

Izolowany kandydat obejmuje dwa pliki produkcyjne, aktualizację dwóch oczekiwań
w istniejącym teście drzewa oraz interpretowany check-airbox-explorer-availability.mjs.
Pozostały frontendowy WIP zastąpiono HEAD wyłącznie w pamięci harnessu;
nie zmieniano rzeczywistych plików HMR. Nie dołączono zależnego routingu
Universe ani współdzielonego staged ArtifactInspectionSource.tsx.

Regresja odtwarza RED na produkcji HEAD: brak węzła Visualization (0 zamiast 1).
GREEN obejmuje sześć scenariuszy: brak snapshotu, FEM bez siatki, FDM bez gridu,
historyczną antenę z osobnym sampling, istniejący authored i realized FEM.
Sprawdza dokładną ścieżkę, pojedynczy węzeł, brak fikcyjnego Mesh i statusy.
Izolowany TypeScript 6.0.3 z kanoniczną konfiguracją/noEmit i typecheck-env.d.ts,
z dwoma produkcyjnymi rootami i ich rzeczywistymi importami: zero diagnostyk.
To nie pełna repozytoryjna kontrola natywnego TypeScript 7 ani kompilacja testów.
Lint czterech plików: exit 0, zero ostrzeżeń. Testu jednostkowego nie kompilowano.

Dowody w wolumenie kontrolnym grupy:
verification/airbox-explorer-commit-20261026/{source-checks-v2.json,lint.json,
isolated-check.mjs,isolated-input.json}. Zachowano pierwszy błąd harnessu:
zewnętrzny VM używał innego prototypu Array; v2 stosuje wspólny realm dla kodu
regresji i produkcji. Nie zmieniono z tego powodu testu ani kodu aplikacji.

Browser/WebGL i końcowy obraz Inspectora są NOT VERIFIED. Historyczne ręczne
potwierdzenie drzewa i siatki nie zastępuje sprawdzenia tej dokładnej wersji.
Poprawka nie publikuje H w Universe. Bieżącego Solve, API i kontenerów nie
restartowano; nie wykonano kolejnego Solve ani zmiany parametrów naukowych.
