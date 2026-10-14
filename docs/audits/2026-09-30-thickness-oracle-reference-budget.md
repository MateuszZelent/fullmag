# Oracle grubości filmu — kontrola przybliżenia P00

Mały niezależny model cosinusowy uwzględnia sprzężenia profili, wymianę oraz
otwarte pole magnetostatyczne. Nie jest produkcyjnym FEM, nie zastępuje
Fullmaga, COMSOL ani kwalifikacji S00–S12. Równania i source-map w nocie 0831.

Parametry pochodzą z metadata rzeczywistego archiwalnego joba #173: film
10 nm, Ms 800 kA/m, A 13 pJ/m, B0 0.1 T, gamma0 221100 m/(A s).
Metadata/CSV/skrypt mają hashe zapisane w comparison.json. Oracle używa
mu0=4*pi*1e-7; metadata podaje nieznacznie inną stałą, zapisaną osobno w raporcie.
Różnica tego zaokrąglenia jest rzędu kilku Hz, nie dziesiątek MHz.

| k=25 rad/um | N=1 (P00), GHz | N=32, GHz |
|---|---:|---:|
| DE | 13.673868177295 | 13.641746349464 |
| BV | 9.760535490014 | 9.760534094510 |

Zmiana DE N=16→32: 4.212492 Hz; BV: 0.006380 Hz. Osobno sprawdzono kwadraturę 128→256.
Archiwalny DE FEM: 13.578981798832 GHz; różnica względem N=32: -0.460092%.
P00 względem N=32 różni się o 0.235467%. Sprzężenia profili wyjaśniają więc część
wcześniejszej różnicy DE, ale nie całość. Nie uznano tej obserwacji za naprawę FEM.

Pięć testów Python PASS: N=1/P00 i k→0, niezależne całkowanie dwóch trójkątnych
obszarów u-v dla demag, Hermitowskość, symetria ±k tylko dla tego symetrycznego
filmu, własny residual oracle, zbieżność N i kwadratury, odrzucanie złych danych.
Focused working oraz exact-staged docs/source-map validator exit0.
Nie kompilowano testów Rust/FEM. Przejrzano PNG; PDF i JSON zapisano obok.

Artefakty: scientific-batches/analytic-thickness-oracle-20260930 pod storage
tego worktree. Krzywe pokazują referencje, marker tylko archiwalny DE FEM #173.
Nie są wykresem nowej ścieżki FEM. Otwarte pole oracle nie odpowiada finite-airbox
Gamma, a model nie dotyczy antidotu A1.

Nowy managed build #179 succeeded/exit0. Seria rozpoczęta; pierwsza DE t3 została
odrzucona przed eigensolve przez certyfikat bijekcji/orientacji ścian periodycznych.
Dalsza diagnoza tej bramki jest konieczna; nie wolno jej wyłączyć ani nazwać
wyniku wrapper_exit1 zaakceptowaną częstotliwością.
