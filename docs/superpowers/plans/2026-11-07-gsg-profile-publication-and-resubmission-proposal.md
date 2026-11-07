# GSG: opublikowanie zachowanego profilu i jedno nowe zgłoszenie

## Przyczyna i potwierdzony stan

Zatwierdzony Submit requestu58dc1e… wykonano dokładnie raz przez
just docker-dev-submit-accepted. CLI exit1, HTTP409,
code execution_profile_reference_conflict:
Publish execution profile exec:default@1 before submitting this study.

GET katalogu profili zwraca revision0,total0,entries[].
GET żądanego runu zwraca404 accepted run intent is missing.
GET listy runów tego projektu nie zawiera tego runu. Solver nie wystartował.
Nie jest to nieudany wynik naukowy V/J/H; nowy wynik nie powstał.
Błąd przygotowania operacyjnego: przed pierwszym Submit nie sprawdzono
dostępności wersji profilu wymaganej przez przygotowane wejście.

Stary fencef010325ee6e10a441ddaf0ca2e579a73b72366e99e1a76dfd6681883e0594a2d,
request, pełny stderr781B i result zachowano. Nie wykonano retry.
Nie usuwamy lub resetujemy tego fence ani nie zmieniamy kontrolera.

## Konkretny zakres do decyzji

1. Opublikować istniejącą, wcześniej zachowaną definicję exec:default@1
   przez publiczne POST /v2/platform/compute/profiles. Nie zmieniać jej
   defaults lub znaczenia i nie zastępować istniejącej wersji.
2. Wykonać dokładnie jedno nowe zgłoszenie tej samej fizyki i siatki,
   z nowym run_id i kluczem idempotencji, przez istniejącą receptę just.
   To nowa jawnie zatwierdzana próba po znanej odmowie409,
   nie automatyczne ponowienie starego zgłoszenia.
3. Obserwować zwrócony run/task do końca, zachować i odczytać V/J/H,
   jeśli powstaną. Każda odmowa kończy tę serię bez dalszego retry.

Bez nowego meshingu, prepare-only, buildu, restartu, zmiany kontraktu
lub polityki limitów, H-only,35/25nm lub LLG. Bez nowego tokenu,
osłabienia autoryzacji operatora lub usunięcia danych.

## Publikacja profilu — gotowy body

Plik w istniejącym control volume:
verification/gsg-junction-solve-20261107/profile-ready-candidate/publish-profile.json

SHA256:d89e3d0068c1e0b4d7b5a700d88b0538e5cb8f9e861b077dbdae2c089e948a22.

Body obejmuje expected_revision0, client_intent_id
antenna-default-profile-20261107 oraz dokładnie zachowany profil:
schema_version execution_profile.v1, profile_id exec:default,
version1, description pusty tekst, defaults pusty obiekt.
Oryginalny plik profilu ma SHA256
6c88e13526ec18ba0ba2b8f11d200e83ab21f6cea94194af250cf567c298b786.
Puste defaults nie zmieniają jawnego FEM CPU/double/strict i zasobów runu.

To zapis do katalogu skonfigurowanego accepted-run store, nie zmiana
źródeł lub nowa wersja protokołu. Katalog może być współdzielony przez
klientów korzystających z tego store. Nie kasować innych wpisów.
Przed zapisem ponownie GET: przy identycznym już opublikowanym profilu
użyć go bez ponownego POST; przy innym profilu lub nieoczekiwanej
rewizji zatrzymać operację. Nie nadpisywać wersji.

API wymaga lokalnej capability operatora. Obraz posiada istniejący
entrypoint.read_operator_capability, z kontrolą właściciela,0600,
braku symlinków i pojedynczego linku. Potwierdzono włączenie mechanizmu
i obecność prywatnego pliku; wartości tokenu nie odczytano.
Po decyzji użyć wyłącznie tej istniejącej capability w nagłówku Bearer
dla tego POST; nie wypisywać jej ani zapisywać w logach.
Nie przyjmować ambient host credentials, nie tworzyć tokenu lub
nowej ścieżki uwierzytelnienia. Brak poprawnej capability oznacza stop.

## Nowy request — dokładnie ten sam problem

Plik w tym samym istniejącym control volume:
verification/gsg-junction-solve-20261107/profile-ready-candidate/request.compact.json

SHA256:50b1accd824a7e1fec5e64bea44ad347de5b088f282a2f7c542a21c9cfb051eb.
Rozmiar46529594B. Zmiany wartości względem odrzuconego58dc1e…:
- /run_intent/idempotency_key:
  gsg-junction-profile-ready-155483362d284e87a8113daddc76119b
- /run_intent/specification/run_id:
  run-40c6990b8231f8fd7194d8b634e780aab9af3a559dbd21b27f8b7bcb8425be5e

Wszystkie pozostałe wartości są dokładnie identyczne. Porównano cały
zdeserializowany request po przywróceniu tylko tych dwóch pól.
Archive, immutable assets, study plan i study catalog są bez zmian.
To dopuszczone pola tożsamości RunIntent/RunSpecification, nie przepisanie
geometrii, source digestu lub scientific provenance.

Zachowano34243Tet4/12589węzłów źródła,18par sourcecut i nośnik20punktów H.
Source mesh9dd1a99d7862f5c9ce630c42747d35ec4071c9d79cb784e909bc0603b6a3ff63,
sourceafbaaaef1140e6f5c2ebadf31f3cf8068e6f399247f7500741ec50695bff3f6b.
Nadal1CPU,4GiB RAM,512MiB storage, CPU FEM/double/strict,
dokładnie jeden closed_loop_inspection i profil volume_inspection_v1.
Nie ma ponownego generowania siatki.

Przed Submit sprawdzić request poprzez istniejące _validated_request,
dostępność i zgodność opublikowanego profilu, brak runu w API oraz brak
fence nowego run_id. Użyć tej samej recepty docker-dev-submit-accepted,
tej samej grupy i pakietu, jedynie z nową ścieżką/SHA requestu.
Nie wywoływać starego requestu i nie modyfikować jego historii.

## Odbiór i dowody

Sukces wymaga terminalnego Succeeded i publicznego odczytu rzeczywistych,
skończonych V/J/H z poprawnymi jednostkami, carrierami i wspólną
tożsamością zaakceptowanego rozwiązania. HTTP202 i step0 nie wystarczają.
Dotychczasowa naukowa eta pozostaje FAIL do odrębnej kwalifikacji;
jedna lokalnie zagęszczona siatka nie dowodzi reprodukcji Fig.3 lub LLG.

Dowody dotychczasowej odmowy i przygotowanego następcy:
verification/gsg-junction-solve-20261107/
(preflight.json,managed-submit-recipe.json,current-status.json,
project-runs.json,requested-run.json,profiles-before.json,
operator-mechanism-metadata.json,profile-ready-candidate/comparison.json).
Wszystko w prywatnym control volume obecnej grupy3203.
Żadnego POST profilu lub nowego Submit jeszcze nie wykonano.

## Źródła kontraktów

- crates/fullmag-api/src/router_v2/handlers/platform/compute_profiles.rs:
  post_compute_profile, configured_root — publikacja, rewizja i owner store.
- crates/fullmag-api/src/router_v2/handlers/persistence/execution_profile_submission.rs:
  validate_published_profiles — przyczyna409 przed przyjęciem runu.
- crates/fullmag-application/src/run_spec.rs:
  RunIntent::validate, RunSpecification::validate — pola tożsamości.
- scripts/docker_dev_submit_accepted.py:
  _validated_request, submit_once — piny i trwały jednorazowy fence.
- /opt/fullmag/entrypoint.py::read_operator_capability — istniejący mechanizm obrazu.
