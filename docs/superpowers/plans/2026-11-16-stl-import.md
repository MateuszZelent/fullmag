# Poprawny import STL — plan wdrożenia

Cel: połączyć import STL, przenośny projekt, rzeczywisty podgląd powierzchni i
wspólne siatkowanie FEM, zachowując puste wnętrze BuckyBalla.
Kontrakt: [ADR 0081](../../adr/0081-imported-stl-source-surfaces.md).

Właściciel: codex:01a1e067-64b2-7291-9742-63bdcf0c74ad. Bieżący worktree:
`/home/kkingstoun/git/fullmag/worktrees/buckyball-stl-20261116`,
branch `codex/buckyball-stl-20261116`, baza etapu
`6b479dc6047c97b86c5a765d9de904ccd896d89b`. Dane na istniejącym ext4 E,
nowa grupa Compose `fullmag-worktree-buckyball-stl-20261116-8a40e67a0ae82c49`, port 3349. Poprzednia grupa 3348 pozostaje zatrzymana z zachowaną przerwaną operacją; bez resetowania ownera lub replay.

- [ ] Parser STL w `fullmag-authoring::imported_surface`: test RED, dekoder,
      test GREEN. Istniejące podsumowanie API użyje tego parsera; publikacja
      dopiero po walidacji, bez osieroconych plików na błędzie.
- [ ] Referencja źródła w SceneGeometry/ScriptBuilder oraz assety `.fms`:
      test Save→Open po usunięciu pierwotnej ścieżki, odrzucenie zmienionych
      bajtów; eksport kanonicznego edytowalnego skryptu z towarzyszącym assetem.
- [ ] Deskryptor i binarna powierzchnia źródłowa per obiekt w API v2,
      scope/revision/hash/ETag, bez FEM mesh. Regeneracja OpenAPI i klienta.
- [ ] Formularz importu z jawnymi jednostkami/skalą; podłączenie rzeczywistych
      trójkątów do wspólnego viewportu/resource hooks. Testy klienta/UI oraz
      dowód WebGL; żadnej zastępczej obwiedni jako geometrii STL.
- [ ] Wspólna klasyfikacja powłok w mesherze: zamknięcie, orientacja,
      zawieranie i jednoznaczne pochodzenie komponentu. Notę naukową uzupełnić
      przed implementacją algorytmu. Regresja generycznego importera na pustym
      sześcianie, wielu komponentach i niepoprawnej topologii. Zachować fizyczne
      grupy materiału, powietrza wnętrza/zewnętrza i wspólne interfejsy.
- [ ] Połączyć `ImportedGeometry` z walidacją i loweringiem Build Mesh/Compute;
      nie pomijać ogólnej bramki, materiałów, universe, dirty mesh ani urządzenia.
- [ ] Managed build tej samej grupy i rzeczywisty import BuckyBalla w UI;
      ocena siatki 32 nm. Dopiero po poprawnym imporcie wrócić do relaksacji
      GPU B=0 i zapisu/readback końcowego stanu.

Każdy ukończony, zweryfikowany fragment: review diff → commit. Integracja w
istniejącym PR #433 wymaga właściwych bramek. Otwarte zasoby starej grupy
pozostają osobnym, zablokowanym cleanup; nie usuwać ich jako skutku importu.

Checkpoint 16.11.2026 po restarcie WSL/Docker: oba kontenery grupy 3348 są zatrzymane, exit255; mount danych E jest dostępny. Zachowano owner/process-tree `ready` i przerwaną operację `4b91d69e84c34687923ce8e3ee726a74`; nie resetowano metadanych ani nie powtarzano operacji. Testy Rust/managed/UI wymagają nadal bezpiecznej ścieżki uruchomienia.

Dowody źródłowe: 51 lekkich testów Python adapterów i klasyfikatora przeszło; pełny `test_stl_shell_domains.py` daje 9 passed i 2 subtests z istniejącym lokalnym Gmsh (diagnostyka źródeł, bez backendu/solvera Fullmag). Faktyczny BuckyBall: 362516 trójkątów, 181138 wierzchołków, powłoki 172480/190036, głębokości 0/1, materiał 2.6007237847284727e-18 m³, największy wymiar 5 µm; klasyfikacja 50 s. Raport i skrypt analizy zachowane w danych case na E. SHA256 klasyfikatora `01a554a5b50d2efc9553471950dad334b8d9b220462f9986e40b7b5f97b47bc1`.

Review źródeł znalazł rozjazd pinned hash między preview i mesherem oraz różny katalog względnego źródła. Poprawiono wspólny capture/digest fence i prywatne snapshoty dla Build Mesh oraz Compute, a katalog bazowy pochodzi z logicznego skryptu. Wymagane pozostają: testy Rust, pakowanie/odtworzenie assetów `.fms`, wygenerowane API, konsument viewportu/formularz STL, browser i managed FEM GPU. Nie traktować tej implementacji częściowej jako zakończonego importu lub relaksacji.

Etap siatkowania zapisany w commicie `e25a9d3361aedb7f017125c38cb5bdaec2502a6f`: klasyfikacja powłok, wnęki/wyspy, grupy komponentów i powietrza oraz regresje. Wykorzystano aktualne dowody 23 testów klasyfikatora i 9 testów domen Gmsh (+2 subtests), bez ponawiania niezmienionych zielonych kontroli. Launcher source-check: 46 testów `test_docker_volume_checks.py` PASS; to dowód testów źródeł, nie runtime. Toolchain grupy 3349: attempt `7830df50a90e4d79a083abf428f909da`, receipt succeeded, image `sha256:ba1cd87816b3852d460e05a55b0fd957cbd7387063af9462999172aacb0f2de4`.


Checkpoint managed 16.11: grupa 3349 ma zdrowe backend/frontend; development
attempt `be378fbb7435457a8f6cac765c7eb6ee`, config SHA
`14e14dbf3260f1af9a3c7e86282a443fa6924a70dd82b830c5ca8caf93e495fa`.
Backend image `sha256:bd4a1955bfff6ac91334c7e35c3f5bdf3128dc551dc07c9e12d0076299d22521`;
pełna kompilacja aplikacji przebiegła w stałym backendzie tej grupy.
Codegen OpenAPI/klienta succeeded, receipt
`/opt/fullmag/control/backend/codegen/openapi-v2/b89024b0aa30be8a957b623005a447b37a496fb02d2ea3397cfe2576a73ea826.json`.
Rust authoring: 212/212 PASS, receipt
`verification/attempts/bfe2693b303549629a6fff0f2a8bf777/receipt.json`.
Pierwszy przebieg 211/212 wykrył tylko błędne wymaganie bitowej równości
`3e-9` i `3 * 1e-9`; porównanie przeliczenia jednostek ma teraz tolerancję
2 epsilon względnych, bez zmiany normalizatora.

Review naprawił brak bundlowania nowego uploadu przy Save, dwie własności
Rust i regresję legacy STEP/NPZ. We frontendzie usunięto domyślne dziedziczenie
materiału/magnetyzacji i zapisano skalę UI w SI. Podgląd współdzieli istniejącą
warstwę geometrii; brak/nieaktualny STL nie daje fikcyjnej obwiedni, a błąd
jednego źródła nie usuwa pozostałych. Dla obu rozwiązań P2 reviewer potwierdził
zamknięcie na poziomie źródeł. Browser i pełne testy frontendowe są nadal otwarte.

Dodatkowe 2 testy RED wykazały utratę legacy `units` w dwóch rendererach Python;
po przekazaniu argumentu do istniejącego DSL: 30 testów adapterów i round-trip
PASS. Ta poprawka Python i zmiana testu Rust powstały po publikacji pakietu,
więc przed symulacją wymagany jest zarządzany restart bez aktywnej sesji.
Przykład `relax.py` korzysta już ze wspólnego importera STL bez `domain_mesh`
z poprzedniej ręcznie zbudowanej siatki. Lekki eksport SceneDocument PASS.
Nowy case na E zawiera oryginalny STL, params i `relax_32nm.py` (waiting for
Compute); nie kopiowano runów ani starych intents/receiptów. Solve nie wykonano.

Checkpoint import/API/UI: managed `stl-api-contracts` 18/18 PASS, receipt
`verification/attempts/587766cfc2724840908730e4679b94fd/receipt.json`.
Pełna bramka frontend-stl (typecheck, API hygiene, 9780 testów/941 plików, lint
bez ostrzeżeń) PASS, receipt
`verification/frontend-stl-checks/attempts/96121a68ab6f452e92b285bcc2ec58c1/receipt.json`.
Driver zachowuje teraz każdą próbę i logi; 47 lekkich testów drivera PASS.

Rzeczywisty stateless From Script utworzył na E `BuckyBall_STL_32nm.fms`
(8370981 bajtów), project `project-8301c0912cf24364875634e1b707f934`,
z osadzonym oryginalnym STL SHA256
`c1a4ad8221b5ac39fe879a2a5f30256479dc10f993576006cc13de09ee7d5f2a`.
Archiwum i readback bajtów sprawdzone. Fidelity round_trip pozostaje `failed`:
reprezentacja initial m zmienia uniform na preset_texture/uniform; nie uznano
tego za kwalifikowany round-trip fizyki. From Script nie tworzy sesji ani Solve.

Rzeczywiste Open tego archiwum wykryło obcięcie JSON/base64 przez domyślny
limit proxy Next 10 MB (timeout, brak nowej sesji). Poprawka ustawia limit
proxy równy limitowi API 128 MiB; limit surowego uploadu uwzględnia base64 i
16 KiB otoczki. Regresja porównuje oba limity i maksymalny binary STL parsera.
Context7 odrzucił zapytanie z powodu miesięcznego limitu; sprawdzono oficjalną
dokumentację Next proxyClientMaxBodySize i deklaracje zainstalowanego Next.
Ponowna bramka po tej poprawce zatrzymała się przed testami: frozen metadata
frontendu nieaktualne. Refresh odmówił przed zmianą usług, ponieważ pakiet
backendu nie zawierał jeszcze ostatniej poprawki Python. Trwa kanoniczny
restart pustego backendu tej grupy; po nim refresh i nowa bramka, bez replay
Solve i bez modyfikowania starych grup. Browser, nowy mesh i relaksacja GPU
pozostają NOT VERIFIED.

Checkpoint transport/aktywacja: restart-idle succeeded
`a1d1400e337b4c4798cb728a2471ac6c`, backend snapshot
`b84228bcc4d2828fa559e8b10c37e86eb0f4e9d7b660a015d0724f816bbb8389`.
Refresh frontend succeeded: development attempt
`f7ed72be06db40319cb6812546cfd49c`, config
`6154730b0572b4f9baa87b7bff845a19288cd0d415621bc8c3abc3237eba5c63`.
Nowa pełna bramka frontend-stl PASS: typecheck, API hygiene, 9781 testów
w 941 plikach, lint; receipt
`verification/frontend-stl-checks/attempts/38ef96bbb64c480f9990e49981da3bfd/receipt.json`.
Real Open przez port 3349: HTTP 200 w 1.065 s, JSON 11161372 bajty, archiwum
SHA256 bez zmiany `a8840791cf39428132b0846873047c29bc388c6da980dc73235cd50d024892aa`,
STL SHA256 zgodny z pinem. Dowód na E: `stl_project_open_3308c54e378146bc8644958015d4fcd5.response.json`.
Open ujawniło brak projekcji aktywacyjnej, niezależny od fidelity: strict
projection nie rozpoznawał 19 kanonicznych placeholderów/reprezentacji liczb
Pythona (magnetyzacja, DMI, params fizyki, order i skalary etapu). Wąska poprawka
rozpoznaje tylko dokładne owner-path/null lub pusty tekst i zgodne parsowane
wartości max_steps/torque_tolerance. Oryginał archiwum/sceny pozostaje bez zmian.
Regresja RED: `verification/attempts/26f7431152734076ad94b114dfeee6a0/receipt.json`.
Review znalazł błędny negatywny test zachowanego stage extra; poprawiono test
na zachowanie rozszerzenia i odrzucenie jego utraty. Końcowy GREEN: 9+1+9+10
wykonań testów (28 unikalnych), w tym 10 authoring_open_tests, receipt
`verification/attempts/3eea168d84cd4a41ab9b16c6a02d2d2f/receipt.json`.
Runtime tej ostatniej poprawki wymaga publikacji nowego pakietu. Kontener
widzi RTX 4080 SUPER 16376 MiB, ok. 11688 MiB wolne; hostowe NVML zablokowane
przez OS nie jest dowodem braku GPU kontenera. Native Solve nadal nie wykonano.
