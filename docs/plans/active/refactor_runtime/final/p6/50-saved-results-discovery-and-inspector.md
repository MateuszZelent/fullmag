# P6-50 — discovery zapisanych wyników i przypięty Inspector

Data: 01.10.2026. Status: **przyrost opublikowany; P6 IN PROGRESS, 52%**.
Cel P0–P8 pozostaje aktywny. Wskaźnik całego planu pozostaje około 49%.
Kod: `3268110e20ac62ffd6a51e7f07aea292dcedc0aa`, remote `master`.
Baza: `4357c86c41903f35a339e2286a6d796596b6700c`.

## Zakres i zachowanie

Nowy readonly GET `.../projects/{project_id}/runs/{run_id}/solution-sets`
udostępnia rzeczywiste referencje SolutionSet z dokładną rewizją i digestem.
Backend waliduje projekt, run i immutable RunSpec. Discovery nie otwiera
CAS ani solvera. Katalog przegląda nazwy w O(N), przechowuje najwyżej
limit+1 kandydatów i odczytuje ograniczoną liczbę manifestów sekwencyjnie.
Aktualny manifest musi zgadzać się z jego dokładną immutable rewizją.
Cursor jest wersjonowany i przypięty do projektu/runu; pusta strona z
next_cursor jest poprawna. Nie powstaje drugi indeks ani nowy writer.
[Kontrakt](../../../../../specs/solution-set-resources-v1.md) określa budżety
i brak atomowego snapshotu mutable katalogu.

Centralne OpenAPI, facade i resource hook prowadzą do zakładki Saved
w istniejącym Results Navigator. Użytkownik wybiera run, dokładny SolutionSet,
member i artefakt schematu `fullmag.materialized_dataset.v1` o rodzaju Other.
Kolejne strony są pobierane na żądanie. Tożsamość oraz digesty stron są
sprawdzane; błędny digest blokuje również dalszą paginację. Lista runów
odrzuca obcy projekt, duplikaty i zatrzymany lub niepoprawny cursor.

Otwarcie Inspectora jest jawną akcją po weryfikacji ID, hasha i długości
manifestu. Odpowiedź asynchroniczna nie przejmuje globalnej selekcji.
Przeglądanie innego runu zachowuje wcześniej przypięty wynik i jego prawdziwe
etykiety. Zmiana projektu blokuje pobieranie i wyświetlanie starego payloadu.
Containing revision, owner revision i dataset revision pozostają oddzielne.
Ready, Integrity verified, Execution running i Assessment unassessed nie
są zamieniane w jeden status sukcesu naukowego.

Inspector pokazuje semantykę pola, jednostki, frame, support, function space,
coverage i provenance. Nie udaje podglądu wartości ani nie uruchamia solve.
Listy mają semantykę ul/li; aktualne i zapisane źródło nie montują jednocześnie
dwóch modułów Results.

## Dowody weryfikacji

Receipty są pod `storage/builds/fullmag-0950f4dca4ffe38f`.
Poniższe przebiegi zakończyły się `passed`, exit 0 oraz niezmienionymi
źródłami podczas wykonania. Kontrole dotyczą źródeł współdzielonego checkoutu;
ich manifesty zapisują również zastany dirty stan. Nie dowodzą kwalifikacji
czystego wydania z samego SHA commita.

| Bramka | Profil / trasa | Run ID |
|---|---|---|
| API production source | windows-api-source-check / api-source-check | e1a2c7f8f1224178b541aee8e0d9588b |
| OpenAPI | windows-api-source-check / api-openapi-codegen | 80862b259025424882994301c785609b |
| Generated frontend client | windows-control-room-source-check / generate-client | 2ef7ebb7fa804cf79a67a7fe2625f939 |
| Frontend production source | windows-control-room-source-check / production-source | a434704e8db9425ea249f519f3c2f988 |
| API hygiene | windows-control-room-source-check / api-hygiene | fd2e28b91fda4822b4f111695aef4257 |
| Browser fixture | windows-control-room-browser-fixture / pinned-dataset-browser | 67518819a1a745a78d58f2436be3ceb4 |

Browser uruchomiono przez `just verify-pinned-dataset-browser` w istniejącym
Chrome, na osobnym widoku źródeł i wyjściach Next w kanonicznym storage.
Nie instalowano pakietów ani przeglądarki, nie migrowano istniejących junctionów.
Receipt potwierdza zakończenie własnego procesu serwera i zamknięcie portu.
Raport JSON oraz obrazy positive/forged są w podkatalogu `browser` tego runu.
Kontrolowane odpowiedzi `page.route` nie są dowodem wykonania HTTP backendu.

Scenariusz potwierdza pustą stronę discovery z następną stroną, rewizje
9007199254740993/9007199254740992, poprawny readonly Inspector, odrzucenie
fałszywego manifestu, zachowanie selekcji po zmianie runu oraz ukrycie starego
payloadu po zmianie projektu. Nie zaobserwowano mutacji modelu/runtime.
Raport jawnie zachowuje jeden wcześniejszy warning startowy Reacta o aktualizacji
niezamontowanego komponentu. Powtórzenie tego warningu lub inny błąd Reacta
powoduje porażkę. Nie jest to przebieg bez ostrzeżeń ani pełny smoke workspace.
Niedostępne zasoby runtime pozostają jawnie niedostępne.

Kontrola architektury, spójności repozytorium i staged diff przeszła.
Niezależne review nie znalazło P0/P1. React Doctor w katalogu aplikacji:
92/100, bez ostrzeżeń dostępności; pozostały pomocnicze eksporty testowanych
predykatów i wcześniejsze uwagi. Hook z rootu zgłasza dwa wcześniejsze
sekwencyjne odczyty zakresów topologii; przyrost ich nie zmienia.
Testy regresyjne dodano jako źródła, ale **nie kompilowano i nie uruchamiano
testów jednostkowych**, zgodnie z bieżącym zakazem AGENTS.md.

## Pozostała praca

- Pełna powłoka Results bez żadnej sesji: istniejący session-collection gate
  pokazuje wówczas EmptyWorkspace. Obecny smoke korzysta z kontrolowanego
  workspace z niedostępnym runtime. Nie przypisujemy mu dowodu no-session UX.
- Managed HTTP/process proof discovery i materialized dataset: NOT VERIFIED.
- Bounded binary slices, rzeczywisty podgląd pola, topologia i zgodność
  function space, porównania, derived values, plot/export: OPEN.
- Dalsza walidacja limitów i postępu cursorów stron members/artifacts: OPEN.
- Usunięcie wcześniejszego warningu startowego oraz pełny odbiór klawiaturą,
  browser/WebGL, fault/performance/soak: OPEN.
- FEM/FDM CPU/GPU, walidacja naukowa i release: osobne, niezamknięte bramki.

Współdzielone 107 obcych dirty ścieżek zachowano. W routerze i OpenAPI
commit obejmuje tylko minimalne dodatki; zastanej normalizacji nie stage'owano.
Artefakty diagnostyczne pozostają w storage. Rejestr zadania pozostaje WIP,
bez aktywnego własnego serwera przeglądarkowego; kolejny krok to udostępnienie
zapisanych wyników bez sesji oraz ograniczony transport pól binarnych.
