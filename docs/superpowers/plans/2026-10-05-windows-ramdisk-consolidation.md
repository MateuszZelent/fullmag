# RAM-dysk â€” wspĂłlna konfiguracja natywnych buildĂłw Windows

## Zakres ustalony z uĹĽytkownikiem

R: sĹ‚uĹĽy wyĹ‚Ä…cznie Windows. Runner Linux/Docker/FEM zachowuje dotychczasowy
storage i profile. Nie dodajemy mountu RAM ani drugiego koordynatora.

Po zatwierdzonej koordynacji z wÄ…tkiem â€žScal audyty i plan refaktoryzacjiâ€ť
autorytatywnÄ… realizacjÄ… jest P8-57, commit
`25379fe8084bfa58481326b6ccc095430f2a1537`.
Jeden lokalny klucz: `FULLMAG_WINDOWS_VOLATILE_ROOT=R:/fullmag/volatile`.
Worktree korzystajÄ… z `.env` gĹ‚Ăłwnego checkoutu. Dodatkowy klucz
`FULLMAG_PROJECT_SCRATCH_ROOT` usuniÄ™to wyĹ‚Ä…cznie z naszego zakresu po backupie;
katalogi i markery dawnej prĂłby zachowano, bez usuwania danych.

## Dane i granice

| Dane | Lokalizacja |
|---|---|
| TEMP/TMP/TMPDIR procesĂłw kompilatora i dzieci | R:, osobno wedĹ‚ug worktree/profilu |
| Cargo target/cache przyrostowy, pobrane zaleĹĽnoĹ›ci | TrwaĹ‚y storage na C: |
| ĹąrĂłdĹ‚a kompilatora w tym starszym worktree | C: |
| Python, frontend, EXE, manifesty, receipty i wyniki | TrwaĹ‚y storage na C: |

DokĹ‚adny helper Windows z P8-57 adoptowano bez zmian. Starszy launcher
nie ma jeszcze `build_snapshot`/`compiler_inputs`; port obejmuje preflight,
owner markers oraz osĹ‚onÄ™ TEMP wokĂłĹ‚ Cargo z odtworzeniem Ĺ›rodowiska w
`finally`. Nie przenosi ĹşrĂłdeĹ‚ ani nie zmienia istniejÄ…cej toĹĽsamoĹ›ci ĹşrĂłdeĹ‚.
Sterownik R: zwraca bĹ‚Ä…d 1 dla `GetFinalPathNameByHandleW`, wiÄ™c takĹĽe helper
P8-57 wskazuje `compiler_inputs_enabled=false`. Brak R blokuje nowy build;
uruchomienie istniejÄ…cego pakietu nie przygotowuje ulotnego katalogu.

## Dowody i stan

- 8/8 interpretowanych regresji PASS, w tym wykonanie rzeczywistego bloku
  Cargo ze sztucznym bĹ‚Ä™dem i potwierdzonym przywrĂłceniem TEMP/TMP/TMPDIR.
- Parser PowerShell PASS; preflight rzeczywistego R PASS, wĹ‚asny namespace
  tego worktree i trwaĹ‚y build root zgodne.
- WczeĹ›niejsza niezaleĹĽna realizacja przeszĹ‚a native managed build, exit0,
  lecz zostaĹ‚a wycofana zwykĹ‚ym revertem, aby uniknÄ…Ä‡ dwĂłch mechanizmĂłw.
  Jej dowĂłd nie kwalifikuje automatycznie koĹ„cowego portu.
- KoĹ„cowy managed build wspĂłlnej konfiguracji: PENDING.

Recepty pozostajÄ… bez zmian. Nie podano przyspieszenia bez pomiaru.
Ten krok nie zamyka planu eigensolve S00â€“S12 ani walidacji naukowej/GUI.
