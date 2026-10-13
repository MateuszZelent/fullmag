# S04/S07 — rzeczywista tożsamość siatki potencjału

Deklaracje mesh hash mogły zgadzać się w manifestach, mimo zmiany topologii w metadata. Regresja pokazuje poprawny gradient po zmianie markera materiałowego: sama kontrola H=-grad(phi) akceptowała tę parę.

Pilot wymaga teraz przeliczenia source_mesh_topology_sha256 z metadata według istniejącego MeshData.topology_fingerprint_v3. Używa surowych kanonicznych tablic, bez konwersji indeksów i bez kopii algorytmu. Opcjonalny verify_source_mesh=False zachowuje algebraiczny tryb pomocniczy. Brak facets lub boolean global ordinal jest odrzucany. Raport zapisuje także hash metadata.

19 testów walidatora i 18 pilota PASS; 9/9 historycznych artefaktów #173 przechodzi pełne powiązanie modu, topologii i gradientu. Raport: storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/scientific-batches/physical-potential-mode-binding-20260930/historical-job-173-source-mesh.json; zawiera hashe źródeł postprocessingu i plików metadata.

Nie jest to dowód niezależnego Poissona, normalizacji względem magnetyzacji, zbieżności ani nowego solve. NOT VERIFIED. #182 zakończył się stanem blocked przed buildem na niezgodności membership kapsuły; naprawa obserwatora i nowe zgłoszenie są osobnym przyrostem. Nie zmieniono ani nie usunięto kapsuły #182.
