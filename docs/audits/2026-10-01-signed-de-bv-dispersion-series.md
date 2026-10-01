# Rzeczywista seria signed-k DE/BV — 2026-10-01

Model `examples/fem_de_smoke_numeric.py` pozostaje jednym publicznym skryptem
Python. Wrapper wybiera pojedynczy signed wektor przez FULLMAG_DE_SMOKE_SAMPLING.
Obliczenia są sekwencyjne, nie równoległe: każde ma własną relaksację, modalny
solve, receipt i diagnostykę na jednym niezmiennym managed runtime.

Seria `signed-13`: każda geometria DE/BV otrzymuje 0 oraz ±2, ±5, ±10, ±15,
±20, ±25 rad/µm. L2, 3 warstwy filmu10nm, Ms800kA/m, A13pJ/m, B0.1T,
gamma0=221100m/(A s), demag periodyczny/Floquet. Znak trafia do IR i CSV.
26 punktów nie jest odbiciem wyników; kolektor mierzy f(+k)-f(-k).
Do tego4 kontrolne przebiegi dodatniego k25 na6/9warstwach: łącznie30runów.

Zachowano domyślną serię7przypadków oraz osobny convergence-results.json;
nie osłabiono kontrolera, certyfikatów, residuali1e-8 ani bramek pól.
Kolektor wymaga całej serii, poprawnych ścieżek, tego samego źródła/modelu,
materiału i parametrów siatki. Brak wyniku lub awaria zatrzymuje odbiór.
Wykres używa ujemnych współrzędnych faktycznych rekordów i signed referencji.

35 nowych lekkich testów Python PASS: actual Python→IR dla26wektorów,
plan serii, znak w odbiorze, wykrycie asymetrii, missing/failed/duplicate/path/
identity rejection. Istniejące49testów wrappera/kontrolera/kolektora i21subtestów
przeszły przy pierwszym przebiegu35nowych testów rozszerzonym później o6.
To dowody źródeł/kontraktów, nie nowych częstotliwości FEM.

Następny krok: snapshot runtime-v2 zawierający poprawkę kanonicznych map
f33ca4e5c3c96c408eef5ca6d8edb31dea656f87 i Ku v2, zweryfikowany receipt,
nowa seria signed-13, odbiór, N32/P00, wykres od−25do25. Dopóki te etapy
nie przejdą, brak aktualnego zestawu numerycznego; cały S00–S12 jest otwarty.
