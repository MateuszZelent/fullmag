# Wybór biblioteki FEM w managed buildzie - 2026-09-30

## Ustalenie

`install-cli-dev` wybierał `libfullmag_fem.so*` przez najnowszy mtime,
a błąd kopiowania ignorował przez `|| true`. Przy zachowywanych czasach
źródeł i wielu cache nie jest to dowód tożsamości biblioteki.

## Poprawka

Dla jawnego `FULLMAG_SOURCE_SNAPSHOT_SHA256` selektor wymaga zgodnego
`FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256` w CMakeCache z release Cargo target.
Nie przechodzi do starej ani debugowej biblioteki. Różne grupy bibliotek
z tym samym snapshotem są niejednoznaczne i kończą etap błędem; identyczne
grupy są wybierane deterministycznie według ścieżki. Cache i biblioteki
muszą pozostać w zadanym Cargo target. Błąd kopiowania nie jest pomijany.

Selektor korzysta z metadanych CMake, a nie z twierdzenia o aktualności
skompilowanego kodu. Osobna kontrola dependency query z biblioteki musi
potwierdzić native snapshot oraz wymagany profil. To nie jest bramka naukowa.
Buildy bez jawnego managed snapshotu zachowują dotychczasową ścieżkę.

## Dowody

9 testów Python PASS, w tym starszy mtime poprawnej biblioteki, nowszy
stary/unbound cache, niejednoznaczność, identyczne grupy, brak release,
brak biblioteki, malformed/duplicate stamp, przekierowanie poza root oraz
wykonywalny fragment Makefile zatrzymany po błędzie `cp` (exit 17).
Test shell wykonano w Git Bash, bez WSL i bez kompilacji.
Actual managed native build i walidacja wynikowej biblioteki: NOT VERIFIED.
Nie usunięto cache, execution ani wyników i nie zmieniono runnera.
