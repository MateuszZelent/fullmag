# P6-75 — trwały odczyt skalara przez API

## Cel i zakres

Domknięcie drogi od zapisanego `study_scalar.v1` do typowanego odczytu
wyniku bez aktywnej sesji. Producent zapisuje już energię jako Table w
SolutionSet. Katalog pokazywał tylko referencję CAS; nowa trasa `/scalar`
udostępnia wartość SI, jednostkę, quantity_id, krok i czas. Jest to przyrost
P6-C/D, nie zamknięcie całego P6 ani kwalifikacja fizyki.

## Kontrakt

- ProjectId jest związany z niezmiennym RunSpec; run i jego digest muszą
  zgadzać się z dokładną rewizją SolutionSet. Member i artifact są wyszukiwane
  w tym właścicielu, bez ścieżki FS podanej przez klienta.
- Resolver session sprawdza przypięcie, Table/codec schema `fullmag.study.scalar_json@v1`, CAS hash i dokładną
  długość. Budżet skalara wynosi 64 KiB; brak fallbacku do current session.
- API wykorzystuje istniejący `decode_study_artifact` aplikacji. Session
  nie zależy od application i nie tworzy drugiego dekodera naukowego.
  `SolutionArtifactRef.schema_id` jest istniejącym codec tuple;
  `study_scalar.v1` jest markerem w payloadzie. Producent pozostaje bez zmian,
  a reader nie myli tych dwóch kontraktów.
- Odpowiedź `fullmag.analysis.solution_scalar.v1` zawiera project/run/solution
  revision/member/artifact, manifest digest, task/attempt/epoch, CAS ref/length,
  provenance, stany wykonania i oceny naukowe solution/member.
- Krok, rewizja, długość i epoch są canonical decimal u64 strings.
  `integrity=verified` oznacza kontrolę CAS; accepted_state jest kopiowany
  z artefaktu, nigdy wyprowadzany z samego kroku/czasu.
- 400: błędna tożsamość/revision; 404: brak owner/member/artifact;
  409: obcy project/run lub niewłaściwy kind/schema; 500: uszkodzony
  zapis, przekroczony budżet lub odrzucony scalar.

## Weryfikacja i pozostałe bramki

Kontrole Rustfmt/parser, scoped diff i nowych linków checkpointu: PASS.
Przygotowano 12 regresji Rust (8 session + 4 API), obejmujących
exact counters, CAS corruption, niepoprawny schema/unit/time/nonfinite value
oraz rejestrację OpenAPI. Niezależny review producer→reader po korekcie codec/payload schema: PASS,
bez P0/P1 w źródłach; nie zastępuje wykonania.
Testów Rust nie kompilowano ani nie uruchamiano
zgodnie z aktualnym zakazem AGENTS.md.

Production build aktualnego źródła, realny eksport OpenAPI, generacja
transportu, facade/resource hook, Saved Results UI i browser smoke pozostają
NOT VERIFIED. Build 214 jest przypięty do wcześniejszego SHA i nie dowodzi
tej zmiany. Aktualizacja 03.10.2026: istniejący koordynator przyjmuje zadania;
nie wykonywano jego restartu ani wznowienia w tym przyroście. Build 215
(`901bf4779f5848ebaf9900311dd4b9bd`) czeka za żywym buildem 214 i obejmuje
źródła P6-75 oraz P8-37: commit `7b5248c515eeee788c62050073b05d3affe6ddcb`,
snapshot `d612ebfff5e40a7e190874348ef9af934bde37d9d9c1946552a3b61cfdf2981c`.
Przyjęcie zadania do kolejki nie stanowi dowodu kompilacji ani działania API.

Następny krok: odebrać build nowego źródła, importować raw OpenAPI przez
zweryfikowany importer, wygenerować typy/transport i podłączyć istniejący
SavedResultsBrowser przez centralny facade oraz hook. Nie tworzyć nowego
Results Explorer ani bezpośredniego fetch w komponencie.

Checklistę integracji i odbioru istniejącego panelu zawiera
[P6-76](76-scalar-frontend-integration-checklist.md).

### Aktualizacja środowiska buildu — 03.10.2026

Build 214 zakończył się `failed`, exit 2, przed kompilacją: brak nightly
w mapowanym `cache/windows/fdm-cpu/rustup`. Cache FEM CPU ma osobne istniejące
narzędzia i nie był zmieniany. Uzupełniono wyłącznie FDM CPU przez jawny
provisioning w przypiętym obrazie workera
`sha256:8a508319a68c4116da81b745fdd1b084015b665d92b36b2241e1e245b5febf89`,
z użytkownikiem `65532:65532`; nie uruchamiano ciężkiego buildu poza kolejką.
Instalacja minimalnego nightly zakończyła się exit 0. Osobny odczyt
`rustup run nightly rustc --version` z mountem cache readonly: exit 0,
`rustc 1.101.0-nightly (0abfedbc7 2026-10-02)`.

Build 215 został automatycznie uruchomiony przez istniejący koordynator;
ostatni odczyt: `running`, bez terminalnego exit code. Nie anulowano,
nie restartowano i nie powielano tego zadania. Kontrola toolchaina dowodzi
wyłącznie dostępności kompilatora, nie sukcesu builda ani Windows runtime.
