# Porównanie checkpointów signed14

Porównanie dotyczy 14 zapisanych próbek runu 78af971e, którego publikacja pól modów zakończyła się błędem. Nie zastępuje finalnego accepted wyniku ani kwalifikacji UI. Dane i hashe źródeł są w sąsiednich CSV/evidence JSON.

- Maksymalna bezwzględna różnica względem historycznego FEM: 0,058913%.
- Maksymalna różnica par +k/−k, podzielona przez średnią pary: 0,0014553% (k=5 rad/µm).
- Maksymalna bezwzględna różnica względem zachowanej referencji 1D open-air basis16: 0,593629% (k=−25 rad/µm).
- Wszystkie residuale pełnego deskryptora są poniżej 1e-8. To błąd algebraiczny, nie oszacowanie błędu dyskretyzacji.

Model to DE: M wzdłuż x, k wzdłuż y, film 10 nm, B=0,1 T; parametry i referencja są w examples/fem_eigen_mode_ui_de_signed14_nonzero.py oraz historycznym raporcie docs/raports/2026-10-04-de-signed15-runtime.md. Obecna siatka powietrza różni się od historycznej. Referencja basis16 jest odczytana z tabeli historycznej, nie obliczona ponownie; n=0 na wykresie jest odrębnym przybliżeniem continuum z scripts/finite_dirichlet_thin_film_oracle.py::finite_dirichlet_n0_frequency_hz.

Bliska symetria par jest zgodna z oczekiwaniem dla tego symetrycznego filmu, lecz nie dowodzi zbieżności. Ustalony próg 0,5% dotyczy COMSOL A1, a nie automatycznej kwalifikacji tego benchmarku DE. Nie oznaczamy tych wyników jako COMSOL PASS; wymagane są Gamma, finalna publikacja, zbieżność oraz osobne porównanie A1.
