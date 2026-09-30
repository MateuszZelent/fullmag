# Przypięty zasób datasetu historycznego — API v1

Status: wdrażany wycinek P6. Kontrakt magazynu:
[materialized dataset manifest](materialized-dataset-manifest-v1.md).

## Tożsamość i odczyt

`GET /v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/materialized-dataset`
jest odczytem pojedynczego, trwałego manifestu datasetu. Pełna tożsamość
obejmuje projekt, run, SolutionSet, jego dokładną dodatnią rewizję, member
i artifact. Rewizje są kanonicznymi dziesiętnymi stringami u64, również
w odpowiedzi. Odczyt nie zależy od aktywnej sesji ani od CURRENT.

RunIntent i jego RunSpecification muszą należeć do żądanego projektu/runu,
a provenance SolutionSet musi odpowiadać dokładnemu digestowi RunSpec.
Odczyt i zapis RunIntent stosują istniejący limit control document 16 MiB;
przekroczenie daje błąd przed pełnym wczytaniem pliku lub jego publikacją.
Member i artifact mają limit 1024 bajtów UTF-8, sprawdzany także przez facade.
Reader magazynu sprawdza manifest CAS, hash, długość, typowany tensor i
pełne pokrycie jego chunków. Sprawdza także zgodność membera, niezmiennego
artefaktu tensora i dokładnego właściciela. Historyczny owner jest odczytywany
z przypiętej rewizji tego samego SolutionSet. Nie ma fallbacku do live Results.

Brak runu, rewizji, membera lub artefaktu daje 404. Błędna tożsamość wejściowa
daje 400, a niezgodność projektu/runu daje 409. Uszkodzony lub niezgodny
trwały artefakt daje jawny błąd; nie wolno zwracać częściowego sukcesu.

## Odpowiedź

Typowany zasób `fullmag.analysis.materialized_dataset.v1` zawiera pełną
tożsamość żądania, root manifestu i jego długość, identyfikatory i rewizje
datasetu oraz definicji, opis pola, coverage, producenta i dokładne źródło.
Pole `integrity=verified` oznacza kontrolę integralności wybranego grafu CAS.
Nie oznacza kwalifikacji solvera, poprawności fizyki ani zbieżności.

`containing_solution_revision` wskazuje rewizję zawierającą artefakt,
a `owner_solution_revision` wskazuje pierwotnego przypiętego właściciela
pola. Odpowiedź zachowuje status wykonania i ocenę naukową ownera; nie
zastępuje ich późniejszym statusem runu. Dataset Ready może mieć ownera
Running/Unassessed. UI musi pokazywać tę różnicę jawnie.

JSON nie zawiera wartości pola, chunk payloadów ani topologii. Obowiązuje
istniejący limit odpowiedzi 1 MiB. Przekroczenie limitu daje błąd, bez
ucięcia opisów lub zmiany tożsamości. Opis pola zachowuje jednostki,
reprezentację, frame, support, przestrzeń funkcji i kolejność, topology,
carrier, layout, osie i normalizację. Wersja magazynu obsługuje jedno
rzeczywiste pole Values; zasób nie dopisuje możliwości modalnych ani
harmonicznych, których manifest nie obsługuje.

## Frontend i dowody

Backend OpenAPI jest źródłem wygenerowanych typów i transportu. Centralny
facade udostępnia odczyt, a resource hook sprawdza tożsamość odpowiedzi,
integralność i dopuszczalne rewizje. Klucz cache zawiera wszystkie sześć
składników przypiętej tożsamości. Rewizją zasobu jest root CAS manifestu.
Zmiana żądanej rewizji, membera lub artefaktu anuluje poprzedni odczyt;
błąd nie jest zastępowany danymi bieżącej sesji.

Wymagane regresje obejmują bieżącego i historycznego ownera, niezgodną
tożsamość, brak rewizji, konflikt i uszkodzenie CAS, rewizję powyżej zakresu
bezpiecznej liczby JavaScript, kodowanie URI oraz oddzielenie kluczy cache.
Kompilacja produkcyjna, generator OpenAPI i typecheck są odrębnymi dowodami
od wykonanych regresji, managed runtime, browsera, nauki i release.
