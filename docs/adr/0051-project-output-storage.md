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
