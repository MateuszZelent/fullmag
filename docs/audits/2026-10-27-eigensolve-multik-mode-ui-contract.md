# Multi-k: solver i publikacja działają, kontrakt UI wymaga uzupełnienia

27.10.2026. Runtime `38a6e398784745e2eb196ee7ed9f3e3e6b2f9e32`, run `run-live-33b5d9b1eabd05d1c5fbf7723682521b6755ffd3a46c57eb61f21e27bc24026b`.

Po jawnym retry nieudanej preparacji (chwilowa zajętość host ledger, decyzja `prep-retry-1-84250a410caf63f9a182bb48c7319310`) oba etapy zakończyły się i API opublikowało pola modów:

| k_y rad/µm | f GHz | eps_full |
|---|---|---|
| -10 | 11.2118497916512 | 2.414522889528399e-11 |
| +10 | 11.211886649578224 | 1.255135717070378e-11 |

Oba residuale certyfikowane przy progu 1e-8. Nie jest to dowód zbieżności siatki ani kompletności widma. Generacja `sha256:d20a109399cd19ced92d2edcd94390e83931c9d796337cad9f577b5c6291b8d8`.

Test przeglądarkowy wykazał brak rodziny modów w Results, mimo gotowego katalogu i pól. Manifest multi-k nie publikował `boundary_context`, strukturalnego `k_sampling` i `mesh_identity`, które istnieją w producencie single-k i są wymagane przez adapter UI. Zachowujemy kontrolę tożsamości i poprawiamy producenta: oba warianty używają tych samych funkcji opisujących rzeczywisty plan. Nie zmieniamy istniejących artefaktów ani liczb solvera. Dodano asercje regresji; skompilowane testy wyłącznie w GitHub Actions zgodnie z polityką projektu.

Stan odbioru UI: NOT VERIFIED — potrzebny nowy build, wynik i renderowanie obu modów po poprawce.
