# Optymalizacja lokalnego buildu managed FEM — specyfikacja

## Cel

Skrócić przebudowę Fullmaga podczas aktywnego rozwoju FEM/GPU bez publikowania
runtime z binariami starszymi niż deklarowana tożsamość źródła. Zmiana ma
równocześnie ograniczyć transfer kontekstu Docker i zachować czysty,
reprodukowalny build kwalifikacyjny.

## Potwierdzone przyczyny

1. `compose.yaml` buduje obrazy z kontekstu głównego repozytorium, który zajmuje
   około 35 GB, a repo nie ma `.dockerignore`.
2. Dockerfile używane przez usługi z kontekstem `.` nie kopiują plików z
   lokalnego kontekstu; jedyne instrukcje `COPY` kopiują artefakty z wcześniejszego
   etapu obrazu.
3. `just ensure-managed-fem-runtime` wymusza
   `FULLMAG_FEM_RUNTIME_REUSE_BUILD=0`, więc każda istotna zmiana źródła usuwa
   cały release workspace.
4. Proste ponowne włączenie reuse jest niebezpieczne. Commit `34aafce9d` wymusił
   czysty build po tym, jak Cargo uznało starszy kod runnera za aktualny dla
   materializowanego snapshotu z historycznymi czasami modyfikacji.
5. Lokalny Cargo nightly udostępnia `-Z checksum-freshness`, który sprawdza
   źródła Rust po treści. Wejścia odczytywane przez build script nadal wymagają
   osobnej invalidacji.

## Decyzja

### 1. Minimalny kontekst Docker

Root `.dockerignore` domyślnie wykluczy cały checkout i dopuści wyłącznie
`docker/**`. Test kontraktowy sprawdzi wszystkie Dockerfile używane z
`build.context: .` i odrzuci lokalne instrukcje `COPY` lub `ADD` bez
`--from=...`. Dzięki temu przyszłe użycie pliku z checkoutu nie zostanie cicho
ukryte przez regułę ignore.

### 2. Dwa tryby buildu

Istniejąca zmienna `FULLMAG_FEM_RUNTIME_REUSE_BUILD=0|1` pozostaje publicznym
przełącznikiem i nie powstaje trzeci alias.

- jawna wartość użytkownika zawsze wygrywa;
- profil `canonical` bez jawnej wartości wybiera `0` i zachowuje czysty build;
- profil `local-d` bez jawnej wartości wybiera `1` i zapewnia szybki build
  developerski;
- nieznana wartość lub profil kończy się błędem przed budową.

Wspólny helper Bash rozwiąże tę politykę zarówno dla `just ensure`, jak i dla
bezpośredniego `just rebuild-fem-runtime`.

### 3. Bezpieczna świeżość Rust

Tryb reuse uruchomi release build przez Cargo nightly z
`-Z checksum-freshness`. Dzięki temu zmiana pliku Rust jest rozpoznawana po
treści, nawet gdy snapshot ma czas modyfikacji starszy od istniejącego targetu.
Tryb clean może używać tej samej opcji; zachowanie czyszczenia pozostaje
niezmienione.

### 4. Selektywna invalidacja natywnego backendu

Nowy manifest wejść natywnych obejmie:

- `Cargo.toml` i `Cargo.lock`;
- `native`;
- `backends/fem` i `backends/fdm`;
- `crates/fullmag-fem-sys` i `crates/fullmag-fdm-sys`.

Eksporter obliczy skrót tych wejść przed materializacją snapshotu. Fingerprint
builda natywnego uwzględni również ID obrazu Docker, architektury CUDA i NVTX.
W trybie reuse zmiana fingerprintu wykona wyłącznie:

```text
cargo +nightly clean -p fullmag-fem-sys -p fullmag-fdm-sys
```

Niezmieniony fingerprint pozostawi natywne artefakty CMake/CUDA. Stamp zostanie
zapisany atomowo dopiero po udanym release buildzie. Nieudany build nie może
ogłosić cache jako aktualnego.

### 5. Niezmienione gwarancje

- Build FEM nadal przechodzi wyłącznie przez kontenerowe recepty `just`.
- Tożsamość snapshotu, źródeł, obrazu i manifestu runtime pozostaje walidowana.
- Profil `canonical` pozostaje czysty domyślnie.
- Jawne `FULLMAG_FEM_RUNTIME_REUSE_BUILD=0` wymusza pełne czyszczenie także dla
  `local-d`.
- Nie zmieniamy fizyki, ABI, capability ani wyboru solvera.
- Nie usuwamy istniejących cache, wolumenów, runtime ani artefaktów naukowych.

## Testy i kryteria akceptacji

1. Test `.dockerignore` potwierdza minimalny kontekst i brak lokalnych
   `COPY`/`ADD` w Dockerfile z rootowym kontekstem.
2. Test helpera polityki potwierdza domyślne `canonical=0`, `local-d=1`, jawne
   override’y oraz fail-closed dla błędnych wartości.
3. Test eksportera potwierdza `-Z checksum-freshness`, selektywne czyszczenie
   crate’ów sys, fingerprint obrazu/źródeł/architektur i atomowy zapis stempla
   po udanym buildzie.
4. Mały test Cargo zmienia treść źródła przy zachowaniu starego `mtime` i
   potwierdza, że build checksumowy tworzy nową binarkę.
5. Dotychczasowe testy storage, snapshot identity, exporter i runtime source
   policy pozostają zielone.
6. Pełna próba managed FEM zostanie wykonana dopiero po zakończeniu aktywnej
   symulacji, aby nie naruszyć używanego targetu i runtime.

## Poza zakresem

- cache wspólnego mesha FEM;
- czyszczenie Docker volumes, build cache i starych targetów;
- zmniejszenie obrazu ext4;
- automatyczne wykrywanie GPU i zmiana przenośnego profilu architektur CUDA.
