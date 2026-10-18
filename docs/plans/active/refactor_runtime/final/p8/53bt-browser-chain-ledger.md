# P8-53BT — immutable ledger cykli próby restartu

Data: 14.10.2026. Baza `0ee428fdf04bf1e31096266c1921ade1aa641ad9`,
autoryzowany współdzielony master. Status: **INTERPRETED PREREQUISITE PASS**;
podłączenie bridge/native v2 i runtime dwóch cykli nadal **IN PROGRESS**.

## Cel przyrostu

Wdrożyć prerequisite kontraktu [53BS](53bs-restart-remaining-gates.md):
oddzielny zapis before/restored/after dla maksymalnie dwóch kolejnych cykli
z bindingiem nonce, API/session scope, request/generation oraz source/target
build identity. Potwierdzonego cyklu nie wolno nadpisać, powtórnie zakończyć
ani wykorzystać ze starym pinem po zmianie ownera.

Ledger przyjmuje dowody już sprawdzone przez semantycznych właścicieli.
Nie czyta sceny/API/storage, nie kopiuje assetów ani nie steruje procesami.
Nie zastępuje walidacji sceny, dokumentu, kamery, intake i terminalnego wait.
Kolejny bridge v2 ma przekazać do niego wyniki tych istniejących walidacji,
zamiast tworzyć alternatywną semantykę modelu.

## Zakres plików

- `scripts/windows/development_browser_chain.py`: mały interpreter faz
  i immutable kopie dowodów per cykl.
- `scripts/test_windows_development_browser_chain.py`: wykonane przez
  istniejący managed discover regresje interpretowane phase/binding/copy.
- `scripts/verify_development_handoff.py`: oba nowe pliki przypięte do
  SOURCE_PATHS; source mutation w trakcie próby nadal unieważnia receipt.

## Odbiór i granice

### Znormalizowane metadane przyszłego bridge v2

To wewnętrzny kontrakt dowodu browser probe, nie szerszy binding helpera
`development_handoff.py`. `source_build.build_id` pochodzi z
`validate_bundle(...).source.manifest_sha256`, a target z
`verified_build_identity(...).ready_build_id`; są to hashe rzeczywistych
zweryfikowanych manifestów. Nie hashować opaque identyfikatora ani nie
przepisywać go do SHA jako konwersji. `source_sha256` pochodzi z przypiętego
backend source hash tych samych pakietów.

Generation pochodzi z `configure_fixture` (`uuid.hex`, 32 lowercase hex).
Nonce/request/API pins mają kanoniczny hyphenated UUID rzeczywistego
transportu. Owner zawiera api_instance_id, opaque session_id, session_epoch
i dokładne request_scope_epoch oraz session_resource_epoch odczytane przez
obecne walidatory bridge. Epoch 0 pozostaje legalny i jest zachowany jako 0;
nie wolno zamieniać go na 1 jako normalizacji. Bool/ujemny epoch odrzucane.
Przyszły konsument musi użyć tych adapterów; bez tego podłączenie jest
niezweryfikowane. Nie poszerzono publicznego handoffu ani formatu kapsuły.

Wymagane: legalny pojedynczy cykl i A→B→C danych, odmowa złego numeru cyklu,
obcego/noncanonical nonce/pina/request/hash, nadpisania before, pominiętego
hydrate, przedwczesnego Finish i kontynuacji ze starym A lub innym B.
Modyfikacja wejścia lub odczytanej kopii nie może zmienić zachowanych dowodów.

## Wynik wykonania

`just verify-windows-development-handoff`: terminalny receipt
`35b7439f41d241f5b5433e50dc449329`, state=completed, exit_code=0,
**201 kontroli, 0 pominiętych**. Discovery wykonało 12 nowych metod regresji
ledgeru, w tym dwa legalne cykle, brak nadpisania, source API custody,
rekurencyjny JSON, puste snapshoty oraz source epoch 0 i odmowę bool/ujemnego.
To interpretowane Python checks; nie uruchomiono Cargo, backendu ani
kompilacji jednostek testowych Rust/TS.

Profil: `development-handoff-checks`, namespace `fullmag-0950f4dca4ffe38f`.
Receipt i log są pod `checks/35b7439f41d241f5b5433e50dc449329` tego profilu.
Source identity przed/po:
`6123d3bc83db85b7973097536593b206b866961399638ce0d3598d2970ee8a45`.
Module SHA-256 w receipcie:
`d5cc40557b36f6847c42b9be8f395a83a7373e1a4b756d1c9dc09045a5b996aa`.
Po staged diff usunięto pustą linię EOF i znormalizowano końce linii.
Automatyczne porównanie pełnego AST przed/po wykazało identyczną strukturę;
scoped diff check PASS. Nie ponawiano niezmienionych testów zachowania
wyłącznie dla formatowania. Bieżący module SHA-256:
`45989ecb320262332af3c31dc5a5e6a8235013c863c5d3c3c020e41519218d3c`.
Regression SHA-256:
`12ccd3a130a4b1704a3bf5ef888dc3d8935b3ba8799ba1f6ad8c7c7c05be6f80`.

Pierwsza seria `d129cd70d89d43a8a97d353d04d8b776` przeszła 199/199.
Po review zachowano szerszy legalny epoch 0 bez relabelingu i dodano dwie
regresje; dlatego wykonano końcową serię dla zmienionych źródeł.
Kontrola source API wait dotyczy A po A→B i B po B→C; nie wymaga zamknięcia
B przed drugim cyklem. Finalna custody C nadal należy do native finishera.

## Nadal otwarte

Nie należy utożsamiać przejścia maszyny faz na danych kontrolnych z dwoma
rzeczywistymi restartami. Natywny reader/probe i Python ProofBridge v1 nadal
obsługują pojedynczy cykl; ich podłączenie v2 jest następnym zależnym
przyrostem. Publiczny `restart_available=false` pozostaje bez zmian.

Nie kwalifikuje to runtime asset preservation, pełnej macierzy Inspectora,
fizyki, wydania ani integracji PR #160. P8-53 i cały plan pozostają otwarte.
