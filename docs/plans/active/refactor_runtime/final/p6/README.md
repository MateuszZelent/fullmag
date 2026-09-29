# Checkpoint P6 — trwałe wyniki i frontend analityczny

Status: **P6 IN PROGRESS**.

P6 rozwija minimalny katalog P3 i publikację P5 w trwałe, typowane wyniki,
bounded data plane oraz jeden frontend analityczny oparty o pinned source.

## Przyrosty

1. [Resource hooks trwałych ramek obserwacji](01-observation-frame-resources.md)
   — session-scoped katalog, descriptor i historyczne `m` z exact source oraz
   field generation identity.
2. [Explorer i pinned observation source](02-pinned-observation-source.md)
   — ramki w drzewie Results, typowana selekcja, dedykowany Inspector i mały
   session-fenced workspace descriptor bez kopiowania payloadu pola.

SolutionSet, DatasetDefinition, pozostałe quantities, partial reads, porównania,
podłączenie pinned source do render-modelu, plot/export recipes oraz produkcyjne
dowody pamięci i WebGL pozostają otwarte. P6 wynosi **4%**.
