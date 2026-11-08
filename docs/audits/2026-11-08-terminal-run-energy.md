# P22 — brak końcowej energii w podsumowaniu Study

## Potwierdzona diagnoza

Na binarce DEV `1dd24b9d7f154589bcfbce453fe16b66`, w runie
`run-live-80341a3d441dbbd46cc6e5b7ea93ab3186d3620fbc60e8cf4c8472af0aad911f`,
wszystkie trzy etapy Relax mają status Completed. Katalog publikuje po jednym
`accepted_terminal_scalar_stats` i stanie końcowym dla każdego etapu. Nie ma
osobnych autorskich artefaktów typu `scalar` / `E_total`.

| Etap | Algorytm | Krok | Czas (s) | Energia (J) |
| --- | --- | --- | --- | --- |
| A | llg_overdamped | 10 | 1e-12 | -3.8091117500317753e-23 |
| B | projected_gradient_bb | 1 | 0 | -4.441013650519438e-22 |
| C | nonlinear_cg | 1 | 0 | -8.45818845777564e-22 |

Hashe CAS wszystkich trzech rekordów statystyk oraz ich stanów są zgodne.
Katalog tasku przypina właściwy artefakt, próbę i epokę. Bieżąca seria skalarów
wskazuje C i tę samą energię, ale `simulation/runs/current` pomija energię końcową.
Zapisane publiczne zasoby i piny są w [JSON](2026-11-08-terminal-run-energy.json).

`live_accepted_projection::load_durable_projection_with_journal` odzyskuje
kwalifikowane `terminal_stats`, lecz `apply_projection` zapisuje energię do
RunManifest wyłącznie z opcjonalnego `latest_total_energy`. To rozdzielenie
pozostawia podsumowanie niepełne, mimo poprawnej publikacji statystyk.

Przejście od 10 / 1 ps do 1 / 0 w tym konkretnym Study wynika z przejścia z A
do C. Nie stanowi dowodu błędu zegara LLG. Nie wolno zastępować końcowego zegara
maksimum liczników lub czasu wszystkich etapów.

## Kontrakt poprawki i odbioru

Podsumowanie końcowe ma czerpać energię całkowitą i jej składowe z tego samego
kwalifikowanego rekordu, z którego projektowana jest końcowa seria skalarów.
Źródłem pozostaje najpóźniejszy etap w kolejności Study. Walidacja tasku,
próby, epoki, stanu i zegara nie może zostać osłabiona. Starsze/obce/niejednoznaczne
piny nie mogą udawać bieżącej energii. Ścieżka historycznych autorskich skalarów
pozostaje obsługiwana w jej dotychczasowym legalnym zakresie.

Wymagane: regresja przed poprawką, testy projektora i API, zarządzany build,
porównanie bieżącego runu ze skalarem i CAS oraz odbiór telemetrii po reloadzie.
Na tym checkpointcie poprawka i jej odbiór są **NOT VERIFIED**. Ten raport nie
zamyka pozostałej macierzy S01–S46, FEM, FDM GPU ani multilayer.
