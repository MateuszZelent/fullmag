# T06 — odczyt dokładnej rewizji artefaktu anteny

Stan: 2026-10-05. Przyrost techniczny czytnika, nie odbiór naukowy T06
ani zakończenie modułu T00–T18. Nie zmieniono równań, SI, Python API,
`ProblemIR`, solwerów, UI ani tolerancji porównania pola.

(reader-problem-statement)=
(reader-discrete-realization)=
(reader-implementation-mapping)=
## Przyczyna i kontrakt

Publisher `crates/fullmag-runner/src/antenna_stage.rs::publish_antenna_field_solution_atomically`
zapisuje manifest w `antenna/field_solutions/<solution_id>/<asset_id>/manifest.v1.json`.
Referencje payloadów pozostają logiczne:
`antenna/field_solutions/<solution_id>/<payload>` — bez segmentu `asset_id`.
Dotychczasowe `parents[3]` w czytniku wskazywało poprawny korzeń tylko dla
starszego płaskiego układu; dla rewizji prowadziło do błędnej ścieżki.

`tests/antenna/verify_field_convergence.py::read_solution` rozpoznaje teraz
dwa jawne układy: legacy flat oraz rewizjonowany. Wymaga nazwy
`manifest.v1.json`, poprawnych `solution_id` i `asset_id`; identyfikatory muszą
zgadzać się z właściwymi katalogami. Legacy nie ma katalogu assetu, więc
jego `asset_id` jest walidowany, lecz nie może być porównany z nazwą katalogu.
Manifest bez tych wymaganych identyfikatorów nie jest akceptowany przez zgadywanie.

`read_vectors` zdejmuje dokładny logiczny prefix rozwiązania i czyta suffix
wyłącznie pod katalogiem wskazanego manifestu. Nie wyszukuje payloadów,
nie wybiera najnowszej rewizji i nie ma fallbacku do legacy lub rodzeństwa.
Brak payloadu pozostaje błędem także wtedy, gdy inna rewizja zawiera
identyczne dane. Odrzucane są obce prefixy, ścieżki absolutne/drive/UNC,
backslash, colon, puste segmenty, `.` i `..`, symlinki oraz junctiony.

Zachowano kontrole SHA-256, długości, float64 little-endian, układu XYZ,
jednostek, skończoności wartości, normalizacji do 1 A, zgodności liczby próbek
i certyfikatu kwadratury. Analityczny model drutu, wykluczenie obszaru przy osi,
normy błędu oraz reguły porównania trzech poziomów pozostały bez zmian.
Czytnik nie zastępuje pełnej walidacji aktualności geometrii, materiału,
siatki i targetu wykonywanej przez produkcyjny loader.

(reader-governing-equations)=
(reader-symbols-and-si-units)=
## Niezmieniona fizyka

Ten przyrost nie definiuje nowych równań ani symboli fizycznych.
Właścicielem modelu pozostaje
[nota antenowa 0950](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md).
Czytnik nadal oczekuje pozycji w metrach i pola na amper w A/m/A;
nie przelicza pola na tesle i nie zmienia normalizacji prądowej.

(reader-python-api)=
(reader-problem-ir)=
(reader-round-trip-and-failure-semantics)=
## Granica authoringu i wykonania

Publiczny Python DSL i `ProblemIR` nie są zmieniane. Requested intent
pozostaje w modelu problemu, a resolved execution w istniejącym manifeście;
czytnik nie replanuje żadnego z nich. Validation errors opisane powyżej
odrzucają wadliwy artefakt bez naprawiania jego danych. Unsupported combinations:
nieznany layout, brak tożsamości lub niegotowy manifest nie są importowane.
Nie zmieniono round-trip ani dostępności backendów.

(reader-validation)=
## Wykonana weryfikacja

Stała trasa `scripts/verify_antenna_field_reader.py::run` używa repozytoryjnego
resolvera storage, blokady worktree i unikalnego katalogu dowodów. Uruchamia
wyłącznie interpretowany Python z `-B`; nie kompiluje testów ani natywnych
targetów i nie instalowała zależności. Zapisuje HEAD, digesty przed/po, log,
liczbę testów/pominięć oraz terminalny wynik, również przy awarii obserwacji.
Nie dodano obejścia kolejki ciężkich buildów: to osobna, lekka kontrola czytnika.

Powtórzenie z korzenia tego worktree, istniejącym Pythonem:

```powershell
Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
python -B scripts/verify_antenna_field_reader.py
```

Resolver wyznacza ścieżki z konfiguracji hosta; poniższy katalog jest dowodem
wykonania na tym Windows, nie uniwersalnym domyślnym storage:
`D:/git/fullmag/storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/antenna-field-reader/`.

Równoważny driver Python uruchamiany z korzenia repo, bez LLG:

```python
# %% Stała interpretowana bramka czytnika; outputs wyznacza resolver
import runpy
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "scripts"))
sys.argv = ["verify_antenna_field_reader.py"]
runpy.run_path("scripts/verify_antenna_field_reader.py", run_name="__main__")
```

Driver wykonano: `a97b457c972e47a3bab006d975a59f9b/receipt.json`, exit 0,
13 testów/1 skip, identyczny digest jak w GREEN poniżej. Przykład nie jest
skryptem publicznego authoringu; jego wynikiem jest log i terminalny receipt.

- RED `47eb8693676e4358a761e95a91246110/receipt.json`: exit 1;
  10 testów, 7 failures i 5 errors w podprzypadkach, 1 skip.
  Odtworzono błędną ścieżkę rewizji i akceptowanie niepoprawnych identyfikatorów/refs.
- GREEN `5e4386aad0824670a7cbc231817159e0/receipt.json`: exit 0;
  13 testów, 12 PASS, 1 SKIP. Digest przed/po:
  `5c5dd7c35815a5393057757a89d999db3e9c6f97b922d6dd53b53305214937be`.
  HEAD podczas wykonania: `989c332d6b45319cc5910d6653387257b58571e8` z tym przyrostem WIP.
- Dwie kontrolowane awarie observera potwierdziły terminalne `failed`, exit 1:
  `38e5c5b72c4a4e8581c933d3de76b0bd/receipt.json` (dekodowanie logu)
  i `22e0fc2086d64bcb90802400d0dd88cf/receipt.json` (końcowy digest).
  To fault injection wrappera, nie awarie ani wykonanie solwera.

Review wszystkich zmienionych wierszy czytnika/testów/helpera nie pozostawił
blockerów; poprawiono dwa wykryte przypadki nieprawidłowego terminalnego receipt.
Focused validator checkpointu i głównego planu przeszedł; 33 interpretowane
testy kontraktu dokumentacji zakończyły się PASS. To dowód struktury dokumentacji,
nie poprawności fizycznej. Nie wykonano publikacji Sphinx ani buildu native.

(reader-assumptions-and-validity)=
(reader-limitations)=
## Granice i dalsza praca

Windows odmówił utworzenia rzeczywistego symlinka (`WinError 1314`), więc
ten test został jawnie pominięty. Rzeczywiste junctiony nie mają dowodu
regresji na tym hoście; obecność kontroli w źródle nie zastępuje wykonania.
Fixture trzech poziomów zawiera syntetyczne pola wzorcowe, a nie wyniki FEM.

FDM CPU, FDM GPU, FEM CPU i FEM GPU nie otrzymują z tego przyrostu żadnej
nowej kwalifikacji runtime, parytetu, precompute ani fizycznej zbieżności.
Nie wykonano LLG, Relax, FFT ani solve przewodnika.
Następne kroki: rzeczywiste trzy poziomy solve z publishera; kwalifikacja
linków na wspierającym hoście; bramka import → statyczne `compute_fields`
→ sinusoidalny Run z tą samą bazą bez ponownego source solve.

(reader-scientific-bibliography)=
## Podstawa kontraktu

Zmiana jest korektą kontraktu przechowywania, nie nową metodą fizyczną.
Źródłami pierwotnymi są publisher i deklaracje manifestu w repo;
literaturę fizyczną i założenia quasistatic zawiera wskazana nota 0950.

(reader-source-code-index)=
## Indeks źródeł

- `crates/fullmag-runner/src/antenna_stage.rs::publish_antenna_field_solution_atomically` — publisher.
- `tests/antenna/verify_field_convergence.py::read_solution` — układ i tożsamość.
- `tests/antenna/verify_field_convergence.py::read_vectors` — dokładna rewizja i integralność.
- `tests/antenna/test_verify_field_convergence.py::FieldConvergenceTests` — regresje interpretowane.
- `scripts/verify_antenna_field_reader.py::run` — managed evidence, nie bramka fizyki.
