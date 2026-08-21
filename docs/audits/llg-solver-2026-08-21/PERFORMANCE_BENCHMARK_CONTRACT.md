# Kontrakt benchmarków wydajności LLG

Każdy benchmark musi raportować jednocześnie poprawność i czas:

- requested/resolved/executed backend, device, driver i precision;
- rozmiar siatki/DOF, `h_min`, order, aktywne komórki oraz użyte interakcje;
- accepted/rejected steps i liczbę ocen każdego pola;
- setup/assembly versus steady-state step;
- czas exchange, demag/Poisson, pól lokalnych, RHS, stage update, redukcji i outputu;
- alokacje, peak/steady memory, H2D/D2H bytes i synchronizations;
- iteracje solverów liniowych oraz rebuildy preconditionera;
- normę, energię, torque i błąd względem oracle;
- wall-clock do osiągnięcia zadanej dokładności.

Wymagane są przypadki mały, średni i duży oraz wyznaczenie break-even CPU/GPU. Wynik `steps/s` bez kontroli błędu nie jest kwalifikacją wydajności solvera.
