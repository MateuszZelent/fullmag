# µMAG Standard Problem 4

Problem jest zdefiniowany przez oficjalną specyfikację NIST. Dane pod
`references/` są niezmienne, kontrolowane SHA-256 i używane bez dostępu do
sieci. `common/` posiada kontrakt, parsery, metryki i fail-closed validator;
`fem/` materializuje ten kontrakt przez publiczne API Fullmag.

Kwalifikacja wymaga strict FEM CPU oraz strict FEM GPU w `double`, bez
fallbacku. GPU musi raportować `device_hypre_poisson`; tryb
`hybrid_cpu_poisson` jest niedozwolony. Oba lane'y wykonują dwa przypadki
pola, three-mesh matrix (`3.0`, `2.0`, `1.5 nm`) i oba airboxy. Końcowa bramka
sprawdza też parytet CPU/GPU.

Uruchomienie pełnej kwalifikacji:

```text
just verify-fem-standard-problem-4
```

Wynik może otrzymać status `passed` wyłącznie po przejściu wszystkich bramek
NIST, zbieżności, proweniencji i parytetu.
