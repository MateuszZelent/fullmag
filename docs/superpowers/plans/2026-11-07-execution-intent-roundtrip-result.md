# Naprawa intencji wykonania — odbiór lekki 07.11.2026

## Zakres i status

Użytkownik zatwierdził plan, implementację i lekkie testy. Wdrożono źródła Python, Rust authoring/shared pipeline oraz regresje API/frontendu. Nowy pakiet nie został zbudowany ani wdrożony. Wyizolowana naprawa eksportu (20 plików) została zapisana w commicie 5b19f00e4bf8dcc88ef8789d7c251c8e5ad5bb21 i wypchnięta na branch zadania. Poprawki fixture’ów zapisano w commitach dec3ab642e6abe3a85459690fd908e10920858eb i 7f798b881d43dbdad1cf98ca62b40f37e3280795, także wypchniętych na branch zadania. Wcześniejsza lokalna implementacja retained/H-only oraz recovery pozostaje w worktree.

Scalony master: eeb1e1fcf6070021ac902ee8ecb01268e2cea9b9.
Commit integracji: 7448ca17f5e5ad01a6bf1a3ecfe6ceb790a5cf39.
Zaakceptowany oryginał planu: e5c94c31a5899b5b8a16e32869012470429de0e2,
SHA256 b79c14a7a520cdeca04fcb2ce64c7a22930b19393c148959f198ae914d193b9f.
Bieżący plan ma zaktualizowany status; oryginał pozostaje odtwarzalny w Git.

## Zmienione zachowanie

Capture i live nie wymuszają już interaktywności. Eksport zachowuje flagi każdego etapu oraz końcowy workspace. Brak ustawienia, False i True są odrębne na granicy override. Jawne wartości dziedziczą się przez aktywne etapy, także action→Run, bez nadpisania False przez auto-wait.

Generic export kopiuje surowe metadata bez zmiany typów; typowana scena, renderer i wykonanie primitive odrzucają obecny nieboolean. Adaptery Rust zachowują obecność pól i stage extras. Shared primitive waliduje oba klucze przed zapisem, usuwa tylko te klucze przed parserem rodzaju i przy odmowie odtwarza poprzednie wartości/brak. Nie dodano ciężkiego klonu ProblemIR dla rollbacku.

Fizyczny guard nadal odrzuca rzeczywistą zmianę Ms między etapami. Zachowano wybór flag przez CLI, priorytet surowych metadanych i dotychczasowe pomijanie domyślnego wait=False. Bramka niezakwalifikowanego źródła LLG nie jest zmieniana.

## Dowody

CI bieżącego commita: [run 42365723712](https://github.com/MateuszZelent/fullmag/actions/runs/42365723712), head 7f798b881d43dbdad1cf98ca62b40f37e3280795, contract_scope=rust — krok „Run execution-intent roundtrip contracts” PASS; browser inspector-actions PASS; szerszy job Rust nadal w toku. Poniższy zestaw 203 testów Python dotyczy pełnych dirty źródeł i nie zastępuje odbioru selektywnego commita.

W poprzednim CI [42364949531](https://github.com/MateuszZelent/fullmag/actions/runs/42364949531), head dec3ab642e6abe3a85459690fd908e10920858eb, przeszło 75 testów Python (11+5+59), cztery nowe testy authoring oraz trzy testy application. API skompilowało się, lecz pierwszy test API odmówił deserializacji niekompletnego fixture’a: brak wymaganego entrypoint_kind. Poprawka 7f798b881… uzupełnia trzy fixture’y API, nie zmienia produkcyjnej deserializacji. Test browser inspector-actions przeszedł w obu poprzednich CI. Pierwszy run 42364164605 ujawnił analogiczny brak w dwóch fixture’ach authoring i niekanoniczny zapis liczby w trzecim; commit dec3ab642… naprawił te dane.

Rozważone warianty: uzupełnienie jawnego pola w fixture’ach, tworzenie ich przez typowane struktury, klonowanie poprawnego fixture’a oraz zmiana domyślnej deserializacji. Wybrano najmniejszą zmianę danych testowych, zachowując pełne asercje. Nie dodano globalnego defaultu. [Serde: pola i wartości domyślne](https://serde.rs/field-attrs.html), [serde_json: błędy from_value](https://docs.rs/serde_json/latest/serde_json/fn.from_value.html).


| Sprawdzenie | Wynik | Ograniczenie |
|---|---|---|
| Python, końcowy lekki zestaw | 203 PASS, 71 subtestów PASS | 1 test wymagający realnego FEM meshingu wyłączony z zakresu; 2 istniejące DeprecationWarning |
| Nowe regresje Python | 11 | Ślady RED→GREEN, blokady Popen i gmsh.generate |
| Frontend resource regression | 33/33 PASS | w tym 4 nowe kombinacje bool; poprawna ścieżka istniejąca już wcześniej |
| ESLint pliku frontend | PASS | bez kontroli nowego backendu w UI |
| Parser Rust | 8/8 PASS | rustfmt --emit stdout, diagnostyka składni; nie kompilacja |
| Regresje Rust serde/compiler/API | 7 nowych testów authoring/application PASS w CI dec3ab642…; API skompilowane | poprawka 7f798b881…: cały krok kontraktu z testami API PASS; szerszy CI w toku |
| Walidator dokumentu i source-map | PASS | kontrola struktury i symboli |
| Testy kontraktu dokumentacji | 41/41 PASS | nie kwalifikacja fizyki |
| Przykład dokumentacji i publiczny export-run-config | PASS | lightweight assets, bez solvera |
| Niezależny końcowy review źródeł | brak otwartych findings | bez kompilacji Rust i odbioru managed |
| Oryginalny indeks Git | 63 wpisy odtworzone dokładnie | SHA surowego diff indeksu f8c8d727f21451b25db1d2050015b469ad6bdb00b07fdba84136095367eb6fd3 |
| Dawne untracked | 128/128 identycznych | niczego nie utracono |

Podczas review naprawiono dziedziczenie jawnego wait=False do kolejnego etapu bez własnej flagi. Regresje obejmują run→run, action→run i domyślne study=False.

Dowody w prywatnym control volume grupy3203:
- verification/antenna-authoring-roundtrip-20261107/approved-implementation-python-v1/verification.json
- verification/antenna-authoring-roundtrip-20261107/approved-implementation-python-v1/pytest-final-reviewed.log
- verification/antenna-authoring-roundtrip-20261107/documentation-v2/run-config.json
- verification/antenna-authoring-roundtrip-20261107/documentation-v2/canonical-flags.json (SHA256 ff0e6723733ae1c0805feb5c8efc0a817d5372498bbf6db15ec4d317f1f17d39)
- private/frontend/verification/execution-intent-20261107/frontend-resource-regression.log

## Niewykonane bramki i ryzyka

1. Zakończenie szerszego CI42365723712 dla dokładnego commita 7f798b881d43dbdad1cf98ca62b40f37e3280795. Krok nowego kontraktu wykonania i browser PASS; to nie oznacza jeszcze sukcesu całego workflow. Lokalny zakaz kompilacji testów jest zachowany. CI42360365698 dla wcześniejszego commita zakończyło się jednym błędem testu stale authorization; nie jest dowodem dla nowych źródeł.
2. Managed build spójnego pakietu oraz publiczny roundtrip API/UI. Wcześniejszy runtime odrzuci nową scenę z dodatkowymi polami. Rollback wymaga zachowanej wersji sceny sprzed tych pól.
3. Pełny test FEM scratch z rzeczywistym meshem i browser odbiór nowego pakietu. Nie wyłączono guardów tylko po to, aby uzyskać zielony wynik.
4. Reprodukcja wyników publikacji i kwalifikacja GSG pozostają odrębnymi, nieukończonymi zadaniami. Ta zmiana nie poprawia ani nie kwalifikuje numerycznych V/J/H.

Nie wykonano nowego Solve, prepare-only, restartu ani zwalniania rezerwacji. Stare wyniki, cache i historia pozostają zachowane.

## Decyzje wykonawcze

Pracę rozdzielono według właścicieli plików; ryzyko błędu na styku ograniczają wspólne regresje i końcowy review.
Zaktualizowano bieżący status planu, zachowując przypięty zatwierdzony oryginał; koszt błędnej interpretacji statusu ogranicza niezmieniona wersja w Git.
Brak odłożonych drobnych uwag końcowego review.

## Indeks źródeł lekkiego odbioru przed wydzieleniem commita

Poniższe SHA dotyczą stanu pełnego worktree podczas lekkiego odbioru, nie selektywnych commitów. Aktualne poprawki fixture’ów oraz ścisłe drzewa commitów identyfikuje Git i osobne dowody CI.

| Plik | SHA256 |
|---|---|
| packages/fullmag-py/src/fullmag/world.py | b8634f79e4edfb723a2582bba5a6446dc009be723fc8dfb126f4817f909cab3f |
| packages/fullmag-py/src/fullmag/runtime/execution_intent.py | 68fb7508679b62f3870f3d5ad41c54f59330e73cca003feeac85cb5d0f95847a |
| packages/fullmag-py/src/fullmag/runtime/script_builder.py | 2aa6bce9d9d7d46168ca36a43b1fe0a313dba1d15733e8157007b564e39df078 |
| packages/fullmag-py/src/fullmag/runtime/scene_document.py | 7e7ec066d470c0f46d8384f285d473b13777af80d57de8948bfc108fddced7c1 |
| packages/fullmag-py/src/fullmag/runtime/scene_document_ir.py | dc1f8f7786b07ac5c15efd01485c3ceb03cb1eb7904b53a8f672615ab7ad85c1 |
| packages/fullmag-py/src/fullmag/live/_scene.py | da624b577dcf2a11deb90de57526c83e0c0a3cfedd751483d130bfd631aa8b57 |
| packages/fullmag-py/tests/test_execution_intent_roundtrip.py | 6331f6febb629c53268c021e77493fb402e4641994ef33f8f4dd337cda9802d8 |
| packages/fullmag-py/tests/test_live_dsl_mode.py | 0178aae449d60a413c3261d327cb30ca266747eb4aa27c916ecc8efa7b1b9266 |
| packages/fullmag-py/tests/test_script_builder_roundtrip.py | f16c569d78d8b9809acf0f2e2bb577d8ce4ac82f6493967806b4c4a0b75fc69e |
| crates/fullmag-authoring/src/builder.rs | 48336fa0cfcce6c64e1471cbea2e03fa36c07c5778a5c79478a65e0a94af5db9 |
| crates/fullmag-authoring/src/scene.rs | 98e8fe975b469c83ec50289487c6420c4033cac198c97d72131601e51700160b |
| crates/fullmag-authoring/src/adapters.rs | d2e7ca73506e5aff60835137811396cfcfae1eca1fe1d39a395c1c04786ad5a4 |
| crates/fullmag-authoring/src/validation.rs | 96461a0eea68091087d10f86f42985801b3d74b6839778e174697380ded4e141 |
| crates/fullmag-api/src/types.rs | 9379f1272696e64370aba9277e8212e158018143d9090135d673ddb9b158393c |
| crates/fullmag-api/src/schemas/authoring.rs | 5706d11548e808735b27725a68c0dbc13adc2752fda4ce3e2b4846c0c426bbbd |
| crates/fullmag-api/src/router_v2/tests.rs | 33cb6a749e170ed1de40eb10fe67cf1dabb07edfe5a44f97bc813365d4c160cf |
| crates/fullmag-application/src/script_stage_materialization.rs | 875cfe2da32c1d4cf9801c05238de724936d0853a97af59a34fa08c6a4cd8b5a |
| apps/control-room/src/kernel/resources/geometryLifecycleResources.test.ts | 6d017fcbc1164ab09ea2e0bf87ef1f1d50b1b3ebd9189a98a203cb75d3e1b71c |
| docs/specs/execution-intent-roundtrip.md | 6f70d44a05131d64aa097dbd2608a91b38011ca4af7e0c9ee94a234bf637d402 |
| docs/specs/execution-intent-roundtrip.source-map.json | dd0c3fd8b017f6693e4bf8700b750a95e805616d2fa6309df72409147c9b6f17 |

Standardowe wydzielenie commita korzysta z [udokumentowanego alternatywnego indeksu Git](https://git-scm.com/docs/git). Przecięcie20ścieżekz63chronionymi było puste; po commicie odświeżono tylko te20wpisów przez git restore --staged, bez zmiany plików roboczych.
