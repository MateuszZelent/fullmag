# S01/S12 — niezależna kontrola referencji DE

Oracle profili przez grubość sprawdzono w dokładnej magnetostatycznej granicy A=0. Dla |k|t=0.25/1/2 i N=8/16/32 najwyższa dodatnia gałąź zbiega do wzoru powierzchniowego Damona–Eshbacha. Maksymalny względny błąd N32 = 1.5513451168125414e-7. Przy Γ wszystkie dodatnie mody bez wymiany mają częstotliwość Kittela, bez sztucznego rozszczepienia. 7 testów oracle PASS.

Raport z parametrami SI i hashami źródeł oraz obejrzany PNG/PDF: storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/scientific-batches/exchange-free-de-oracle-20260930/comparison.json, comparison.png, comparison.pdf.

To kontrola referencji analitycznej przy A=0; nie nowe obliczenie FEM. W rzeczywistym benchmarku A=13e-12 J/m nie można zastępować referencji tym wzorem ani automatycznie wybierać najwyższego modu. Zbieżność bazy oracle nie dowodzi zbieżności siatki/airboxu FEM. Podstawowe źródło: Damon–Eshbach 1961, DOI 10.1016/0022-3697(61)90041-5. Pełny S00–S12 pozostaje otwarty; runtime po naprawach obserwatora jest następną bramką.
