# Zachowanie geometrii i jawnego źródła domeny — wynik wdrożenia

Data: 7 listopada 2026. Zakres zatwierdzony przez użytkownika: T1–T3 planu
[wdrożenia](2026-11-07-explicit-domain-source-preservation-implementation.md),
lekkie kontrole i GitHub CI. Status odbioru źródłowego: **PASS, T1/T2/T3: 3/3**.

## Co zostało naprawione

| Zadanie | Wynik źródłowy | Odbiór |
|---|---|---|
| T1 — tożsamość geometrii | Trwały geometry_name jest oddzielony od etykiety i object_id; nazwy dzieci CSG i zagnieżdżone translacje są zachowane; kolizje globalne odmawiają | Python oraz końcowy Rust/API CI PASS |
| T2 — źródło domeny i właściciele | Typowany wybór generated/explicit, literalne źródło i obie mapy, raz utrwalone asercje RegionRef; ID przed aliasem; walidacja przed lowering | Python, Rust i API persistence/projection PASS |
| T3 — rzeczywiste źródła | Dokładne zamrożone GSG 50 nm i corner25; pełny IR, etapy i flagi; ciągły most Python → Rust → Python | Oba rzeczywiste adaptery Rust i dwie trasy Python PASS |

Zmiana etykiety nie zmienia klucza geometrii. Jawna deklaracja źródła nie
przyznaje możliwości wykonania nowej fizyki. Usunięcie/recreate właściciela,
wyłączony ID lub alias wskazujący inną tożsamość powodują odmowę; mapa nie
jest automatycznie przepisywana. Reset generated różni się od braku override.
Odrzucone publiczne domain_mesh zachowuje cały poprzedni stan i utrwalone
asercje. Jawna pusta tabela object_region_markers pozostaje odróżnialna od
braku. Nieobsługiwana geometria powoduje błąd, także wewnątrz CSG/Translate.

## Weryfikacja i granice dowodu

- 110 testów unittest Pythona: zero błędów, porażek i pominięć.
  Wcześniejsze 109 testów przeszło także na odczytowej kopii commitowanych
  źródeł 326430055921d1dab74bbfc8e531052d69a9be1c. Kopia zawiera również
  przykład wymagany przez starszy test mikrostripu.
  Nie jest to deklaracja uruchomienia całej kolekcji pytest.
- Cztery kombinacje żądanego FEM/FDM i CPU/GPU zachowują backend, urządzenie,
  double i geometrię. To authoring, bez uruchomienia czterech solverów.
- Walidator noty 0105 i jej pełnych tabel parametrów: PASS. Kontrola zmienionych
  dokumentów między 608810559fb265acf6b747679864eb3b0c3dc0a6 a 326430055921d1dab74bbfc8e531052d69a9be1c:
  brak błędów. Rzeczywiste wyjścia Git z WSL przekazano bez zmian walidatorowi
  Python w istniejącym kontenerze; zachowano listę wywołań i hashe blobów.
  Wcześniej 41 regresji walidatora przeszło.
- Oba źródła GSG przechodzą dwie trasy eksportu Pythona z pełną równością IR
  przy rtol=5e-12, atol=0; mapy, ID i całkowite wartości są dokładne.
  Porównanie z liczbą całkowitą wymaga dokładnej wartości, także przy innym
  zapisie liczby JSON (np. 0 oraz 0.0). Tolerancja dotyczy tylko float–float;
  bool nie jest liczbą całkowitą. Typowanie markerów sprawdza osobny kontrakt.
  Jedynymi znormalizowanymi dodatkami są cztery jawne pola starego pipeline,
  równe konkretnemu wynikowi export_study_pipeline_document(before).
- Odczyt istniejącego nośnika .fullmag-mesh po zmianie etykiet: niezmienione
  bajty, mapy i topology fingerprint. Jest to mały nośnik all-air z pustymi
  mapami właścicieli i pustym authoring_document; nie dowodzi integralności
  pełnej siatki magnetycznej po edycji. Asercje właścicieli sprawdza osobny fixture.
- Blokady Popen/Gmsh: brak nowych procesów natywnych, meshingu i Solve.
  Corner25 pozostał wyłącznie nieuruchomionym wejściem testu źródłowego.
- Poprzednie 63 wpisy indeksu pozostają identyczne. Kontrola surowego indeksu:
  f8c8d727f21451b25db1d2050015b469ad6bdb00b07fdba84136095367eb6fd3.

Przypięte wejścia:

| Plik | SHA256 |
|---|---|
| 50nm.py | 6da40fc7342d7c3b78223c7ae21b14111a3172be3adcea697ccef1d37f734050 |
| corner25nm.py | d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148 |
| Zachowany nośnik siatki | c0db256c8bf0d5c545123ac9d4154388c74081a74304f02912151ea8d9a52178 |

Topology fingerprint nośnika:
sha256:def57508a16e3554c1816a83536bd15079277a856754348d39fc0a2acd0c9891.

Pełne logi i niezmienne receipts są w prywatnym wolumenie kontrolnym grupy:
verification/explicit-domain-preservation-20261107/. Nie zmieniano zapisanych
wyników naukowych, rezerwacji, działających usług ani historii wykonania.

## Przegląd całości i poprawki

Jeden niezależny przegląd zakresu 608810559…5eabac606 wykazał trzy Important,
bez Critical i Minor: nieatomową odmowę domain_mesh, fallback nieznanej
geometrii do Box oraz utratę jawnej pustej tabeli. Zostały naprawione jednym
łącznym przejściem; zachowano RED i GREEN. Nie wykonywano ponownego przeglądu
przez tego samego recenzenta. Brak odroczonych uwag Minor.

CI ujawnił także rzeczywiste luki dostarczania: dodatkowe pola wariantu
generated, pominięte inicjalizatory Option w testach API oraz wcześniejszy,
niecommitowany authoring zamkniętego GSG. Pierwszy problem naprawia pusty
wariant struct serde, drugi jawne Some. Dla trzeciego dołączono minimalne
istniejące zależności Python i Rust oraz ich regresje: parametry połączeń,
pięć części, centralny przekrój źródła, bounds i eksport. Nie skopiowano
niezwiązanych zmian retained-current, runtime lub native. Pierwsza kompilacja
dawnych testów GSG ujawniła składnię tablic w makrze json; fixture używa teraz
jawnie obliczonych tablic.

Ciągły most ujawnił następnie utratę transportu w Rust rewrite_overrides:
osobna lista current_transports nie trafiała do listy current_modules czytanej
przez renderer Pythona. Adapter Rust łączy teraz legacy moduły z typowanymi
transportami dokładnie jak istniejący adapter Python. Test sprawdza obecność
pełnego transportu w eksporcie; pełne porównanie IR nadal nie pomija fizyki.

## Decyzje implementacyjne — Rulings

| Decyzja | Powód i koszt |
|---|---|
| Implementacja inline; agent pomocniczy tylko read-only | Zachowano metodę executing-plans; koszt: tylko jeden niezależny przegląd całości, bez oddzielnych reviewerów etapów |
| Legacy alias recepty per_geometry przy dotychczasowym name_geom pozostaje | Sam import starego modelu nie przepisuje recepty; dwa dotychczasowe równoważne lookupy nadal istnieją |
| JSON Merge Patch reset wymaga generated oraz null dla starych pól wariantu | Zachowano zwykły merge; sam częściowy patch kind nie jest ukrytym resetem |
| Dołączenie istniejącej walidacji all-air | Potrzebna do rzeczywistych wejść T2; koszt: niepełny model może zostać odrzucony wcześniej; nie przyznaje transportu FDM |
| Cztery istniejące pola mesh authoringu są opcjonalne | Brak jest dziedziczeniem, nie dopisanym defaultem; wykonanie zachowuje 6/1/true/true, jawne wartości pozostają jawne, present null odmawia |
| Minimalne wcześniejsze zależności zamkniętego GSG weszły do zakresu dostarczenia | Przypięte źródła muszą działać z czystego checkoutu; zwiększa zakres kodu authoringu, bez nowej realizacji lub kwalifikacji solvera |

Decyzje dotyczące zachowań odłożonych przez recenzenta:

| Decyzja | Powód i koszt |
|---|---|
| Solve, zbieżność i zgodność publikacji pozostają niezakwalifikowane | Wykraczają poza zatwierdzony etap; koszt błędnej interpretacji: nieuprawniony wniosek naukowy |
| Działające API/UI nie otrzymuje tu nowego pakietu | Zakres jawnie wyklucza managed build/restart; koszt: stary eksport może nadal działać w starej instancji |
| Historyczna ochrona dowolnej edycji IR V03 pozostaje odroczona | Nowa asercja dotyczy bieżącego authoringu; koszt: brak ochrony historycznej poza tą ścieżką |
| Końcowy CI odebrano samodzielnie przez statusy i logi przypiętego head | Recenzent nie oceniał trwającego przebiegu; koszt: brak dodatkowej oceny poza zakresem uruchomionych kontroli |

## Zgodność i prace pozostałe

Nowy spójny pakiet odczytuje stare buildery i sceny. Stare czytniki mogą
odrzucać nowe pola lub keywordy; nie deklarujemy zgodności mieszanego pakietu.
Nie zmieniono publicznej wersji IR 0.3.0. Asercje są ochroną bieżącego
authoringu, nie historycznym zabezpieczeniem dowolnie edytowanego IR.
Kontrakt V04 i jego pełna migracja pozostają osobnym zadaniem.

E12 całego przedsięwzięcia nadal **otwarty**. Ten zakres nie obejmuje
managed native buildu, wdrożenia importu/eksportu do działającego API/UI,
cold-load w runtime, nowego przygotowania lub Solve. Nie potwierdza zbieżności
H, odpowiedzi LLG ani zgodności z pracą Sushruth i in. (2020).
Wcześniejsze wyniki V/J/H pozostają zachowane i naukowo niezakwalifikowane.

## Końcowe potwierdzenie CI

- [Końcowy CI 42402270407](https://github.com/MateuszZelent/fullmag/actions/runs/42402270407),
  kod d8d35943caca6d894562077828ea077555bdbf21: completed/success.
  Rust job 128492422065 i browser job 128492422284: success.
- [Pełny wcześniejszy CI 42400481377](https://github.com/MateuszZelent/fullmag/actions/runs/42400481377),
  kod produkcyjny 96013ce4bcbc23de7566c23ea61db5dadcdb96ec: success.
  Ostatnia różnica kodu źródłowego dotyczyła wyłącznie ścisłości testowego
  komparatora i jego regresji.
- Rzeczywisty log końcowego mostu: 50nm.py i corner25nm.py, obie trasy
  full_ir_equal=true; process_guard_calls=0, mesh_guard_calls=0,
  meshes_generated=0, solves_submitted=0. Ścisła lista dodatków pipeline
  pozostała bez rozszerzania.
- Task-done T1–T3 sprawdził ukończony przypięty CI; rzeczywiste polecenia
  Python/Rust/API wykonano w tym CI, bez lokalnej kompilacji Rust.
- Trzy Important z review zamknięto przez regresje RED→GREEN;
  odroczonych uwag Minor brak. Przegląd nie kwalifikował fizyki ani deploymentu.
- Raport i status planu są osobnym commitem dokumentacji po odebraniu CI;
  nie zmieniają przetestowanego kodu. Wyniki naukowe i działająca grupa pozostają.

Pełny końcowy log Rust: ci-success-42402270407-rust-raw-v2.log, 26 127 173 bajty,
SHA256 e07bf8c87e0a9f67491470e9e392245889a410e3abf88749eb626260f6c54ddd.
Odczytane wyniki obu wejść i liczniki blokad zapisano osobno jako
ci-success-42402270407-gsg-proof.json. Wszystkie te pliki są w podanym wyżej
prywatnym wolumenie kontrolnym, bez nadpisania wcześniejszych nieudanych prób.
