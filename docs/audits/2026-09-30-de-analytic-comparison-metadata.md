# Porównanie DE z analityką — parametry modelu i sampling

Naprawiono odrzucanie obsługiwanych punktów k25 i k-25. Klucze próbek
pochodzą z SAMPLING; BV i nieznane klucze są odrzucane. Postprocessor
odczytuje rzeczywiste parametry SI, sprawdza zgodność receiptów, orientację
DE i mapowanie próbek; nie podstawia grubości 100 nm na podstawie nazwy.

Regresja RED: k25/k-25 odrzucone. GREEN: 10 testów porównania i 6 testów
receiptów PASS. Render testowy jest syntetyczny, nie jest wynikiem FEM.
Odczyt rzeczywistych archiwalnych artefaktów joba
1b7399298fe9453eba0c432eef1a2f62, de-k25-l2-eps10-ksp12-coupled-scale:
10 nm, 25 rad/µm, FEM 13.57898179883188 GHz, analityka n=0
13.673868175350407 GHz, różnica -0.6939249033391826%.
Residual scope: full_projected_weak_form_and_periodic_seams.

To wynik starej siatki. Nie dowodzi zbieżności poprawionych warstw.
Nowy build #179 nadal oczekuje; procesy 66068 i 28993 zostały sprawdzone
przez żywe uchwyty. Nie usunięto żadnych danych bez oczekującej zgody.
S00–S12 i porównanie A1/COMSOL pozostają nieukończone.
