# Odbiór poprawki wspólnej skali q/phi — 2026-09-30

Deduplikacja zachowuje cały oryginalny mod SLEPc oraz jego certyfikaty.
Znormalizowane kopie służą tylko do wyboru przez overlap. Usunięto podmianę
samego mode_vector, która rozdzielała skalę magnetyzacji i potencjału.

## Dowody

Managed build #173, 1b7399298fe9453eba0c432eef1a2f62:
succeeded, exit 0, fem-cpu-slepc-runtime-v2. Snapshot
 ddf56cfe3b8f1db7b23c0026f7018803c734c07d866cdcdaa4140ab0f39b86b7.
Wrapper zweryfikował receipt, hashe wymaganych artefaktów, kapsułę źródeł
oraz attestations przed wykonaniem. Nie kompilowano testów jednostkowych.
Model examples/fem_de_smoke_numeric.py, commit
12f90bd08be257116ed2797cf3e62c42d8f06202; CPU, double, strict, L0.

| Punkt k=7 rad/µm | f [GHz] | eps_full | Różnica wobec analityki n=0 [%] |
|---|---:|---:|---:|
| DE | 10.669228396 | 2.3725337822942527e-10 | -0.228450876 |
| BV | 9.235504955 | 2.2707577127760293e-10 | -0.085740241 |

Oba piloci completed_unqualified, exit 0, demag aktywny, próg 1e-8 zachowany.
Parametry diagnostyki związano z hash-bound rzeczywistym metadata.json.
Niezależne składanie słabej postaci Poissona P1 z redukcją Floqueta C^H
na opublikowanych polach: max residual 7.618853491504398e-15.
Zły znak źródła daje residual >=0.9999999999999998.
Historyczne błędy wynosiły 0.166366837 DE i 0.159629329 BV.
Nie dopasowano skali ani nie zmieniano historycznych plików.
Częstotliwości zachowane: poprawka publikacji nie zmienia operatora.

## Artefakty

Katalog nowych runów:
C:/git/fullmag/storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/1b7399298fe9453eba0c432eef1a2f62/comsol-dispersion/.
Podkatalogi de-k7-l0-coupled-scale i bv-k7-l0-coupled-scale.
Porównanie i niezależny audyt:
C:/Users/Mateusz/.codex/visualizations/2026/09/14/01a09ee1-29e6-7d51-98f0-082c5539a0d6/de-bv-ten-20260930/coupled-scale-k7-comparison.json
oraz coupled-scale-k7-poisson.json w tym samym katalogu.

## Pozostałe bramki

Odbiór dotyczy dwóch punktów i wspólnej skali q/phi. Nie zamyka Γ,
pozostałych czterech niespójnych archiwalnych punktów, zbieżności siatki
lub airboxu, kompletności widma, COMSOL A1, GPU ani całego S00–S12.
Uruchomiono kolejny pomiar DE/BV k25 na L0/L1/L2; kwalifikacja NOT VERIFIED.
