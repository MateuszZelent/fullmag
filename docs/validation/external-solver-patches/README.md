# Zachowane lokalne zmiany MuMax3 SP4

`mumax3-sp4-local.diff` zachowuje trzy zastane edycje w podmodule
`external_solvers/3`, bez zmiany wskazania upstream w repozytorium Fullmaga.
Bazą jest commit `f656494b29516bead825b444b1f0b38c6e6c7dbf`.
SHA-256 pliku łatki:
`28f54beeabd3b540803dabf6ec63a2b5a36f6cf7520b7e5168d94abe49f00398`.

Zakres: dodatkowe lokalne wpisy `.gitignore`, zapisy stanu i tabel w scenariuszach
`test/standardproblem4.mx3` oraz `test/standardproblem4b.mx3`. Zastane edycje
usuwają sprawdzenia stanu po relaksacji i w wariancie pierwszym zwiększają
tolerancję końcowego sprawdzenia z `1e-5` do `1e-3`. To archiwum zmian roboczych,
nie zatwierdzenie poluzowania testów ani dowód kwalifikacji SP4.

W bieżącym podmodule zmiany pozostają zastosowane. Łatki nie należy nakładać
ponownie. W świeżym checkoutcie sprawdź najpierw bazowy commit i czystość podmodułu:

```powershell
git -C external_solvers/3 rev-parse HEAD
git -C external_solvers/3 status --short
git -C external_solvers/3 apply --check ../../docs/validation/external-solver-patches/mumax3-sp4-local.diff
```

Po potwierdzeniu bazy i braku kolidujących zmian można odtworzyć edycje:

```powershell
git -C external_solvers/3 apply ../../docs/validation/external-solver-patches/mumax3-sp4-local.diff
```

Weryfikacja archiwum obejmuje sprawdzenie nałożenia na indeks bazowy oraz
odwrotnego nałożenia na bieżące pliki. Nie uruchamiano scenariuszy solvera.
