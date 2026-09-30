# P6-A — adapter copy-on-write legacy manifestu rodziny

Data: 30.09.2026
Status: **SOURCE IMPLEMENTED / REVIEW PASS / MANAGED BUILD PASS / TESTS NOT RUN / RUNTIME QUALIFICATION NOT VERIFIED**.

## Zakres produkcyjnego kontraktu

ADR-0035 punkt 11 wymaga prawdziwego właściciela i migracji copy-on-write.
`SolutionSetCatalog::validate_successor` odrzuca rewizję zamkniętego SolutionSet;
referencji istniejących artefaktów nie można zmieniać. Migrator nie wykorzystuje
technicznej możliwości dopisania artefaktu do terminalnego membera przy nadal
otwartym SolutionSet. Nie zmieniono kontraktu immutability.

Nowy `eigen/artifacts/legacy_manifest.rs` przygotowuje osobne bajty rodzinnego
`frequency_domain_manifest.v1` oraz raport `frequency_domain_manifest_migration.v1`.
Przyjmuje oryginalne bajty, oczekiwany bare SHA256 i jawny
`FrequencyDomainArtifactIdentity` rozwiązany przez przyszłego callera z trwałych
rekordów wykonania. Sam adapter nie dowodzi pochodzenia supplied ownera i nie
zgaduje go ze ścieżki, aktywnej sesji, nazw ani solver lane.

- Sprawdza hash oryginalnych bajtów przed parsowaniem; nie modyfikuje wejścia.
- Odrzuca ambiguous duplicate keys, unknown schema/family/product, niespójny
  stage_kind, brak revision, niekompletny envelope i brak diagnostic reference.
- Uzupełnia brakujące owner fields, zamienia rozpoznane mutable aliases,
  odrzuca konflikt obecnego exact ID. Stały legacy label stage, np. eigenmodes,
  różny od rzeczywistego stage_id nie jest automatycznie reinterpretowany.
- Zeruje wyłącznie nazwane scalar/list transport fields w resources; unknown
  fields i błędne typy dają błąd. Zachowuje względne child references.
- Zachowuje untouched JSON subtrees jako raw bytes, także zapis liczb o dużej
  precyzji. Nie przelicza revision, operator/phase/numerical hashes ani pól nauki.
- Limit 1 MiB obejmuje wejście i wynik; owner ma osobny limit mieszczący się
  w tym budżecie. Nie materializuje child arrays ani danych pól.
- Raport zawiera oba content hashes, exact owner i usunięte transport fields.
  Status zawsze partial, scope zawsze family_manifest_only; validate odrzuca
  inną wersję/status/scope, niekanoniczne hashe i unknown/duplicate field names.

Adapter jest pure: nie zapisuje do SessionStore, CAS, starych plików ani
SolutionSet. Nie oznacza pełnej migracji child bundles, ich zależności i
self-digests. Manifesty self-hashed oraz starsze envelope bez wymaganych pól
są jawnie odrzucane i wymagają osobnego codec. To nie jest semantyczna
kwalifikacja naukowa manifestu ani dowód istnienia referenced child artifacts.

## Dowody i następne kroki

Parser/formatowanie nowego izolowanego modułu: PASS. Regresje authored obejmują
raw input hash mismatch, owner conflict/missing owner, duplicate scientific keys,
unknown resource codec, self-hashed envelope, wrong family/product/stage,
lossless high-precision numbers oraz report validation. Testy jednostkowe
**NOT RUN** — nie kompilowano ich zgodnie z aktualnym AGENTS.md.

Pierwszy review wykrył duplicate-key i envelope blockers oraz output/report
guards; poprawiono je i zlecono ponowny read-only review. Nowy moduł nie jest
objęty snapshotem `ffb5dd9294b24b6ab869266b99d95b49`; build pozostaje otwarty.

Następne etapy: review i managed build adaptera; jawny importer/publisher z
proved owner, osobnym migration root/sidecar lub logical fork; retention/GC
i FMS roundtrip obu obiektów; dependency rebinding pełnych bundles i pinned
API. Oryginalny zamknięty wynik pozostaje bez zmian. Nie publikować nowego
obiektu pod starym hashem ani nie podnosić scientific assessment.

P6 nadal **52%**; ten przyrost nie zamyka migracji P6-A ani release qualification.

## Ponowny review

Po korektach nie wykryto nowego blokera ani statycznego compile risk.
Znany legacy writer `fem/eigen_output.rs` bez top-level revision i pełnego
execution envelope jest **poza zakresem tego codec**. Wymaga następnego,
jawnie wersjonowanego codec; nie wolno syntetyzować brakujących danych.
Adapter pozostaje bounded COW, a nie pełnym walidatorem fizycznego envelope.
Przyszły importer musi wywołać report.validate po deserializacji i sprawdzić
referenced child artifacts przed publikacją.

## Snapshot buildu

Job `04112e6cb0fd42058b952f5e284d6fb6`, profile `fem-cpu-release`,
request key `p6-legacy-family-manifest-cow-20260930-v1`, source=snapshot.
Digest: `17ad3d671d289309c7cd69afba0faa415472bf51dfa574f5586aaef9968fee76`.
Bazowy HEAD: `e889e6e2ed72494d71b33db24d137ed6796d1b7c`.
Nowy `legacy_manifest.rs` jawnie dołączono przez `--include-untracked`;
podczas capture nie zmieniano źródeł. Submission exit 0, stan queued.
Ten snapshot obejmuje również późniejsze poprawki walidatora Python z
przyrostu 29, pominięte w starszym snapshotcie pakietów modalnych.
Queued nie oznacza kompilacji, testów ani PASS. Następny krok: terminalny
status, receipt/inventory i zgodność aktualnych źródeł, przed scoped commitem.

Checkpoint 30.09.2026: stan kolejki **running**, exit code jeszcze nie ma.
Capture ID `36c80ad6b41e4db5837443ee61ab75f5`.
Aktualne `legacy_manifest.rs`, `artifacts/mod.rs` oraz główny walidator
i jego regresje `verify_fem_frequency_domain_eigen_artifacts` zachowują
zgodność SHA-256 ze źródłami tej kapsuły. Jest to dowód tożsamości źródeł,
nie sukces buildu ani wykonanie regresji.

Następna granica publikacji została rozpisana w
[kontrakcie integracji](32-migration-publication-integration-contract.md).
W szczególności przyszły importer musi otrzymać trwały dowód rzeczywistego
session/runtime producenta; obecny katalog task/attempt sam go nie zawiera.

## Terminalny wynik i tożsamość — 30.09.2026

Job `04112e6cb0fd42058b952f5e284d6fb6` zakończył się `succeeded`, exit 0.
Receipt `fullmag.local-runner.build-receipt.v1` przypina powyższy digest i
profil `fem-cpu-release`. Etapy native-build, frontend-dependencies i
frontend-build zakończyły się exit 0. Zweryfikowano rozmiar oraz SHA-256
wszystkich **112 artefaktów** z inventory; nie znaleziono rozbieżności.
Receipt: `storage/runs/fullmag-0950f4dca4ffe38f/04112e6cb0fd42058b952f5e284d6fb6/artifacts/build-receipt.json`
(w lokalnym storage, poza Git).

Źródła adaptera `legacy_manifest.rs`, jego exportów `artifacts/mod.rs`,
walidatora `scripts/verify_fem_frequency_domain_eigen_artifacts.py` i regresji
`scripts/test_verify_fem_frequency_domain_eigen_artifacts.py` są byte-for-byte
zgodne z kapsułą `36c80ad6b41e4db5837443ee61ab75f5/source/tree`.
Wcześniejsze checkpointy queued/running opisują historię tego samego joba.
Snapshot nie obejmuje późniejszych przyrostów 31, 33 i 34.

Toolchain probe rustc/cargo zgłosił problem tworzenia pliku tymczasowego;
to nie jest przemilczane: właściwy etap native-build zakończył się exit 0,
a inventory potwierdza zbudowane binaria. Regresji nie wykonano i nie
kompilowano jednostkowych. Pole receipt `qualification` pozostaje
`NOT VERIFIED`; sukces buildu nie dowodzi FMR, GPU ani semantyki migracji.
Następne kroki wyznacza dokument 32: durable owner attestation, osobna
publikacja COW, traversal/GC/FMS i runtime roundtrip. P6 nadal **52%**.
