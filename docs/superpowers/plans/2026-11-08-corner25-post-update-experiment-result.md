# Corner25 po aktualizacji — odmowa przygotowania przed Solve

## Wynik operacyjny

Użytkownik zatwierdził dokładnie jedno przygotowanie corner25 i, wyłącznie po
poprawnym odbiorze, jedno V/J/H według
[przypiętej propozycji](2026-11-08-corner25-post-update-experiment-proposal.md).
SHA256 zatwierdzonego dokumentu:
527a4d77d68838dcf28523ccca1a747bb669c5c5116ec510a8e54545c25fb584.

Jedna istniejąca recepta docker-dev-gsg-mesh-prepare została wykonana w WSL,
w dotychczasowym worktree i grupie Docker. Próba:
e3103f240fcc49559ff0032e2d91e536. Końcowy stan failed-confirmed, exit2.
Child publicznego CLI został zebrany, exit1. Nie powstał compact request.
Nie wykonano Submit ani Solve, ponowienia, buildu, restartu, H-only lub LLG.

Poprzedni wniosek, że aktualizacja pakietu usunęła całą niezgodność flag,
był za szeroki. Publiczny eksport sceny działa, lecz nie dowodzi odbioru
drugiej reprezentacji etapów podczas przygotowania accepted requestu.

## Wejścia i preflight

Wszystkie 10 FIXED_FILES zachowało zatwierdzone SHA256. Odczytowy
qualified_backend potwierdził pakiet, inkarnację, archiwum i źródła.
Opublikowany exec:default@1 miał SHA256
419204a3ebb26a08b0e75f834c8f2a2bd6056c3804876cfff8067ec10347554e.
Przed wykonaniem kolejka była pusta, active_workers=0, draining=false,
bez aktywnej operacji control. Kontrola po odmowie również potwierdziła
pustą kolejkę, active_workers=0, brak blokad i dostępność API.

| Właściciel | Tożsamość |
|---|---|
| Worktree | /home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011 |
| Grupa | fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1 |
| Development attempt | 894d4efb43eb483eb6179d8d49fd449e |
| Config SHA256 | 1c0a74f52438f272836dd5c248dd06559cf19774c2c92b8394efd23a4ec10bd4 |
| Backend | 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced |
| Pakiet receipt SHA256 | 571513d2972cab78f3e355d0171fde51f3915b2955d875ed6c5664108b7f7578 |
| CLI SHA256 | fe24c5b588067bdc9633a9abadceb43a3f679f417acd2ab5be9801e6c0af257f |
| Snapshot pakietu | 08b4e431e3fefee766ff997dc73ca65de7ed9f1dbd945bf2b7524dcd6bab810c |
| Controller SHA256 | e721b84fd2be2b6fae34c35fbedbd058656164bf9fb98b94d31570fce0eac3b8 |
| Request operacji prepare SHA256 | ac31a54bc1a00aa925f4e20b51516044ecea8d5f60d7b62febfc21cafdaaa14d |
| Result SHA256 | f2ea4eb9915c1addb0360a93dc39811237c277f11e34f411c4efba4f2e5f5c02 |

Request operacji przygotowania nie jest gotowym requestem V/J/H.

## Siatka utworzona, accepted request nieodebrany

Producent wytworzył 40 703 dodatnio zorientowane Tet4, 14 184 węzły po cięciu,
pięć części przewodnika i 18 par powierzchni źródła. Pozostały te same
materiały, potencjał źródła, nośnik 20 punktów / 24 Tet4 oraz zadane
25 nm przy narożach, 50 nm w pozostałych połączeniach i 75 nm na paskach.
Kontrole przekroczenia 72 911 komórek i 4 mln par są false.
To raport producenta, nie odebrany wynik solvera.

Source mesh SHA256:
8906250f3d24891d2037c9671ed325d4a57c2fd54baa97bb0faf6b97c436803e.
Producer report SHA256:
0caf4fa727e39a4e68c6ee45b260d01e7f4cf893e353f483a6194d7f8488b884.
Cache NPZ ma 1 896 055 B, SHA256:
f53a6b875fafecc66001d6832d97bb8970c36eca6cc008b61c5ec70ef3e613b7.
Nie jest bitowo identyczny z poprzednim cache corner25; nie twierdzimy,
że nastąpił cache hit lub że nowy mesh jest tożsamy z poprzednim.

## Przyczyna odmowy i zakres poprawki źródłowej

Pełny stderr publicznego CLI wskazuje:
unsupported payload keys: interactive_session_requested, wait_for_solve.

Naprawiony wcześniej materialize_pipeline_primitive waliduje flagi i usuwa
je z payloadu przekazywanego parserom rodzaju. Jednak
validate_physical_snapshot_coverage wywołuje parse_antenna_solve_selection
bezpośrednio na oryginalnym payloadzie. Ten sam parser ma bezpośredniego
konsumenta w validate_script_source dla H-only. Jego allowlist nadal
odrzucała obie znane flagi. To błąd kompatybilności kompilatora etapów,
nie dowód błędu geometrii, MFEM lub całkowania H.

Rozważono cztery warianty: usunięcie flag z eksportu traci intencję;
filtrowanie osobno w każdym konsumencie duplikuje regułę;
dopuszczenie wyłącznie dwóch poprawnych booleanów we wspólnym parserze
zachowuje selektory i dotychczasowe odmowy; nowy typ payloadu nie jest
potrzebny dla tego defektu. Wybrano trzeci wariant, w ramach wcześniej
zatwierdzonej naprawy przenoszenia intencji wykonania.

Poprawka nie usuwa flag z authoringu ani provenance, nie zmienia metadanych
w parserze selekcji i nie dopuszcza dowolnych pól. Materializer nadal
odpowiada za zastosowanie flag. Brak pola zachowuje dotychczasowe zachowanie.
Nie zmieniono formatu, wersji, fizyki, limitów ani routingu wykonania.

Dodano regresje bezpośrednio w istniejącym module testów bramki migawek:

- primitive_execution_intent_antenna_snapshots_accept_boolean_flags —
  cztery kombinacje obu flag, dwie migawki anteny, brak mutacji danych;
- primitive_execution_intent_antenna_snapshots_reject_non_boolean_flags —
  null, string, liczba, tablica i obiekt dla każdego klucza.

Istniejące testy niezgodnych selektorów, nieznanych pól i kolejności pozostają.

Rzeczywista odmowa CLI jest dowodem RED. Nowe testy Rust nie były lokalnie
kompilowane. Kontrola diff --check przeszła; host nie ma rustfmt, a backend
nie ma parsera tree-sitter. Nie uznajemy tych braków ani przeglądu za
wynik testów. Odbiór Rust w dozwolonym CI i odbiór managed nowego pakietu
pozostają oddzielnymi bramkami. Działającego pakietu nie podmieniono.

## Zachowanie dowodów

Cała próba pozostaje w control volume:
verification/gsg-junction-preparation-20261106/attempts/e3103f240fcc49559ff0032e2d91e536.

20 plików dowodowych, wejść i cache (3 360 660 B) skopiowano na ext4 WSL:
examples/sushruth_2020_closed_gsg/corner25_preparation_20261108_e3103f24.
Manifest-integrity SHA256:
2c7c2f0d83ae45aa4606438e5d43b91c60f112d64100cc79bdfec79e881432dc.
Wszystkie pliki odczytano i porównano hashami jako UID1000; nowy katalog
ma tryb0700. Oryginały, stare wyniki i cache pozostają zachowane.
Nie jest to gotowy wynik Zarr ani odebrany V/J/H.

## Mapa źródeł i ograniczenia

- scripts/docker_gsg_mesh_preparation.py::run, guest, mesh_report —
  przypięte przygotowanie, odbiór procesu i kontrola siatki.
- crates/fullmag-application/src/script_stage_materialization.rs::
  materialize_pipeline_primitive oraz parse_antenna_solve_selection —
  dotychczasowa obsługa flag i pominięty parser współdzielony.
- crates/fullmag-application/src/script_pipeline_compilation.rs::
  validate_physical_snapshot_coverage — bezpośredni konsument i bramka RED.
- crates/fullmag-application/src/script_pipeline_acceptance.rs::
  validate_script_source — drugi bezpośredni konsument tego parsera.
- crates/fullmag-application/src/script_pipeline_compilation_tests.rs::
  primitive_execution_intent_antenna_snapshots_accept_boolean_flags oraz
  primitive_execution_intent_antenna_snapshots_reject_non_boolean_flags — regresje.
- [Zatwierdzony plan flag](2026-11-07-execution-intent-roundtrip-implementation.md).
- [Właściciel fizyki](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md).

Nie zmierzono nowej eta, I lub H. Poprzednie local50 pozostaje osobnym
wynikiem. Dziewięć zaliczonych kontroli referencyjnych dotyczy wcześniejszych
globalnych 100/75/50 nm, nie tej próby. Źródło nadal inspection-only,
reprodukcja Fig.3 i cały E0–E12 nie są ukończone. Ta odmowa zamyka
zatwierdzoną serię bez automatycznego retry i warunkowego Solve.
