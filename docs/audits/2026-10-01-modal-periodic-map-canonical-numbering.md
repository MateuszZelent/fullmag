# Naprawa numeracji map periodycznych — 2026-10-01

## Przyczyna i zakres

Managed build #187 zakończył się sukcesem, lecz pilot Γ `gamma-t3` zakończył
się przed obliczeniem modów błędem `producer_reduction_map_not_canonical`.
Relaksacja przeszła. Seria DE/BV nie rozpoczęła się i nie ma nowej częstotliwości.

W `modal_shared_domain_equivalence_classes` mapa skalarna nadawała numery
klas według pierwszego węzła, a magnetyczna według sortowania korzeni union-find.
Dotychczasowy korzeń zależał od kierunku i kolejności par. Walidator certyfikatu
v6 wymaga sortowania według najmniejszych węzłów klas; nie należy go osłabiać.

## Dowód

`scripts/replay_modal_periodic_reduction_maps.py` niezależnie buduje komponenty
spójne grafu, odtwarza packing pojedynczego regionu i porównuje zbiór par z
rzeczywistym zaakceptowanym `mesh/periodic_pairs.v1.json` relaksacji #187.
Zgodność zbioru i kolejności pierwszych wystąpień par jest obowiązkową kontrolą; sam hipotetyczny remap nie wystarcza.
Wejścia są związane SHA-256 w `2026-10-01-modal-periodic-map-replay.json`.

Siatka: 6138 węzłów, 396 magnetycznych, 1116 unikalnych par periodycznych.
Stara mapa: 0 błędów skalarnych, **48 błędnie ponumerowanych węzłów
magnetycznych**. Mapa po poprawce: **0 błędów**, także po odwróceniu wszystkich
par i ich kolejności. Liczba klas pozostaje identyczna: 328 magnetycznych.

## Poprawka i weryfikacja

Union-find zawsze przyłącza większy korzeń do mniejszego. Minimum klasy staje
się reprezentantem w obu mapach przed złożeniem operatorów i obliczeniem digestu.
Kontrola certyfikatu, sentinel powietrza, odrzucanie klas mieszanych oraz fazy
Floqueta pozostają zachowane. Zmiana nie zmienia fizyki ani tolerancji solvera.

Przygotowano trzy regresje Rust: kierunek/kolejność/duplikaty par, sentinel
powietrza i odrzucenie klas mieszanych, odrzucenie indeksu poza siatką.
Zgodnie z zakazem użytkownika **nie kompilowano ani nie uruchamiano natywnych
testów jednostkowych**. Parser Rust oraz niezależny replay przeszły; nie dowodzi
to jeszcze typowania Rust ani wykonania poprawionego solvera.

Wymagany następny dowód: nowy snapshot runtime-v2, terminalny receipt, pilot Γ,
a następnie DE/BV k25 L2/t3/t6/t9 z kompletem pól, residuali i provenance.
Nadal otwarte są zbieżność, COMSOL A1, Ku/material identity, wszystkie pozostałe
interakcje, waveguide, GPU, browser i integracja całego planu S00–S12.

Niezależne review potwierdziło przyczynę i poprawność minimum-root union bez P1/P2. Po uwadze review replay kontroluje także kolejność unikalnych par runtime, istotną dla odtwarzania starego algorytmu.
