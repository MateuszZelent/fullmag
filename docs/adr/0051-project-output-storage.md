# ADR 0051 — wspólna polityka zapisu obliczeń

Status: accepted jako decyzja użytkownika; implementacja i dowody w toku.
Data: 04.10.2026.

## Kontekst

Tworzenie projektu UI nie określało docelowego katalogu danych, prywatnego tmp ani formatu.
Publiczny Python, ordinary CLI i zaakceptowane workery miały odrębne konwencje katalogów.
Poprzednie ordinary CLI mogło usunąć istniejący wynik `skrypt.zarr` przed nowym uruchomieniem.

## Decyzja

Jedna `OutputStorage` opisuje requested output policy w publicznym Python DSL,
`SceneDocument.study.output_storage` i `ProblemIR.problem_meta.runtime_metadata.output_storage`.
Nie dodajemy modułu fizyki ani osobnych drzew FDM/FEM. Runtime publikuje osobne resolved
paths i provenance. Defaults UI należą do SQLite workspace i typowanego zasobu
`/v2/platform/output-storage`, konsumowanego przez facade i resource hook.

Zwykły skrypt domyślnie tworzy sąsiedni `skrypt.zarr`. UI wybiera konkretne katalogi,
przyjmując edytowalne podpowiedzi nazwy/czasu i zapamiętane defaults. Kolizja tworzy
nową nazwę albo odmawia; nigdy nie kasuje wyników. Format oznacza rzeczywisty writer pól/tabel.
Nieobsługiwany HDF5 odmawia bez fallbacku.

Właściciel runa rezerwuje katalog wyników i prywatny tmp. Cleanup usuwa wyłącznie
zweryfikowany tmp własnego wykonania po zakończeniu jego writerów/dzieci.
Worker UI publikuje kopię wyników poza immutable attempt; jego receipts, CAS i recovery
nie zmieniają właściciela. Publikacja kończy się przed zapisem durable completed receipt.

## Konsekwencje i migracja

Poprzednie dokumenty bez polityki pozostają czytelne i zachowują swój dotychczasowy
accepted artifact contract. Nowe projekty UI/Python przekazują politykę jawnie.
Nowe optional pola sceny/buildera nie zmieniają jednostek ani semantyki solvera.
W rollbacku można wyłączyć nowy formularz i zasób defaults; zachowane wyniki/tmp nie
są usuwane. Stare skrypty pozostają edytowalne; jawnie sprzeczne formaty wymagają korekty.

Szczegółowy kontrakt, mapa źródeł i wymagane bramki:
[project-output-storage](../specs/project-output-storage.md).
Wersjonowane OpenAPI i klient muszą być wygenerowane z tych samych źródeł Rust.
Stan runtime/bramki jest zapisywany w [planie zadania](../superpowers/plans/2026-10-04-project-output-storage.md).


## Doprecyzowanie 10.10.2026 — integralność metadanych zakończonego runa

Samo ponowne wyliczenie hash aktualnego `metadata.json` nie dowodzi, że jego
zawartość pochodzi z finalizacji runa. Dla prywatnej ścieżki porównań
managed runtime producent zapisuje wersjonowane poświadczenie wiążące
surowe bajty metadanych i terminalnego manifestu z identity wykonania.
Konsument wymaga zgodności obu hashy przed użyciem wyniku jako dowodu.
Nie jest to podpis kryptograficzny: zaufany finalizer jest granicą dowodu,
a podmiot mogący przepisać wszystkie pliki może przepisać również poświadczenie.

Kontrakt i wersja: [poświadczenie metadanych](../specs/project-output-storage.md#poświadczenie-metadanych-zakończonego-runa).
Producentem jest wspólny writer `fullmag-workspace-inspect::manifest`;
konsumentem prywatny resolver `scripts/managed_runtime_artifact_root.py`.
Nie zmienia to Python DSL, ProblemIR, publicznego OpenAPI, typów frontendowych
ani CAS/StudyOutput z ADR0035. Zgodnościowy sidecar należy do tej prywatnej
ścieżki i może zostać wycofany dopiero, gdy producent oraz konsument używają
jednego równoważnego immutable manifestu artefaktów.

Historia pozostaje czytelna; brak poświadczenia oznacza NOT VERIFIED dla
tej bramki. Nie dopisujemy poświadczeń do zakończonych historycznych runów,
nie usuwamy danych i nie rekwalifikujemy ich na podstawie obecnych bajtów.
Rollback może wyłączyć nowe wydawanie dowodu, ale konsument nie może
akceptować niepoświadczonych metadanych jako zweryfikowanych. Stan wdrożenia:
SOURCE review korekt: PASS; GitHub Actions oraz runtime NOT VERIFIED.


Potwierdzenie 10.10.2026: [GHA38061668386](https://github.com/MateuszZelent/fullmag/actions/runs/38061668386)
na SHA `2dd8d2187d964a13cf0f6f42c700db5d69557cf5` zakończyło trzy joby
SUCCESS. Producent: Ubuntu 44 i Windows 43 testy Rust bez błędów. Czytnik:
Ubuntu 16 testów; Windows 15 i jeden jawny POSIX-only skip. Named regresje
contention/retry, interrupted stamp, Windows replacement oraz FIFO na
Ubuntu przeszły. Kontrole konsumentów także przeszły. To zastępuje wcześniejszy
pending status tych bramek; pełny solver runtime i nauka pozostają NOT VERIFIED.
