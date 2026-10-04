# P8-53AK — odtworzenie dokumentu projektu

Data: 04.10.2026. Kontrakt kontrolera dokumentu w ramach istniejącego P8-53.
Nie zmienia publicznego OpenAPI ani własności zaakceptowanych obliczeń.

## Kontrakt

SceneDocument i dokument projektu pozostają odrębnymi zasobami. Kontroler
projektu posiada otwarte archiwum oraz lokalny kontekst pliku; nie przechowujemy
ich w Zustand, React context ani localStorage.

Prywatny payload `fullmag.project-document-development-handoff.v1` zawiera
odłączony snapshot `empty` lub `ready`. Zapis `loading` albo `error` blokuje
przejęcie. Dirty wymaga jawnej decyzji carryUnsaved; nie następuje automatyczny
save ani discard. Zachowujemy pełny resource, nazwę pliku i hostPath. Ścieżka
pliku pozostaje metadanymi prywatnej kapsuły, nie jest wejściem wykonania.

Restore działa tylko w nowym pustym kontrolerze. Waliduje kształt payloadu,
rewizje, tryb, raport migracji, kanoniczne base64 i limit 64 MiB całego JSON.
Otwiera archiwum przez istniejącą typed facade, wymaga zgodności tożsamości,
schematu, rewizji, trybu i bajtów. Dopiero wtedy publikuje stan z oryginalnym
dirty, persisted_revision, source_hash i raportem migracji. Ponowne otwarcie
nie stanowi dowodu zapisu na dysku. Błąd pozostawia nowy kontroler pusty.
Brama operacji zapobiega równoległemu create/open/save/close lub capture.

Dokument nie może być uznany za aktualny model jedynie dlatego, że przeszedł
restore. Synchronizacja SceneDocument z archiwum projektu pozostaje odrębną
bramką przed udostępnieniem restartu. Limit kapsuły obejmuje również scenę i UI;
limit samego projektu nie gwarantuje, że suma danych zmieści się w kapsule.

## Dowody i status

`just verify-windows-project-document`: **11 kontroli, exit 0**.
Receipt względem storage resolvera:
`builds/fullmag-0950f4dca4ffe38f/development-backend-api-checks/checks/6697e5e45c104f63accc64918f123733/receipt.json`.
Rzeczywisty natywny API zachował identyfikator, rewizję i bajty canonical
archiwum przy dwóch ponownych otwarciach. Create daje dirty z brakiem
persisted_revision; open daje dirty=false i persisted_revision=revision.
Ta normalizacja wymaga jawnego przywrócenia wcześniejszego stanu kontrolera.

Proces fixture PID 246668 został zakończony i odebrany przez verifier;
exit 1 pochodzi z jawnego zakończenia testowego Child, nie z graceful shutdown.
Backend source przed/po:
`f93f87200efd605d78cd63417343c76c05056d484a863e442de787b3a6b96009`.
Snapshot użytego buildu:
`e45a6519105a93d6b91ee12daa0aea9c061d3b0f7a989be069756b354a8ee16f`.

Review wykrył i zamknął gałąź fałszywego clean state bez persisted_revision.
Clean wymaga zapisanej rewizji równej bieżącej; dirty nie może mieć zapisanej
rewizji z przyszłości. Walidacja base64 używa liniowego skanowania zamiast
zagnieżdżonego wyrażenia regularnego dla dużych archiwów.

`ProjectDocumentController.captureDevelopmentHandoff` oraz
`restoreDevelopmentHandoff` są zaimplementowane. Helper waliduje kopię JSON
z limitem głębokości 32 i 200 000 węzłów; pola nieznane, accessors i cykle
są odrzucane. Typowane API pozostaje jedyną trasą otwierania archiwum.

`just check-control-room-production-source`: PASS, receipt
`windows-control-room-source-check/production-source/d198d85cc66746aab9e6e660ae506174/receipt.json`.
Pierwsza kontrola wykryła trzy błędy typów helpera/fixture; poprawiono je przed
ponowną próbą. Test targets pozostają wyłączone.

`just verify-project-document-handoff-browser`: **9 grup scenariuszy PASS**,
receipt `windows-control-room-browser-fixture/project-document-handoff-browser/1d5e4a2c75ea4642a3738a6c93f6148e/receipt.json`.
Production controller wykonano w Chrome z jawnym typed mock API. Sprawdzono
empty i dirty, niezależność kopii danych, pełne metadane, archiwum 8 MiB,
błędne rewizje/base64/pola, niezgodną tożsamość i bajty, busy gate oraz jawny
retry po błędzie. Brak page/console errors, źródła stabilne, serwer fixture
zakończony i port zamknięty. Obejrzano screenshot raportu fixture.
Frontend source przed/po:
`4b64229c000b93ebdffd82f604f3825aa3bb2e2b356a870935d5d34be09b779d`.

Review helpera, kontrolera, fixed recipes oraz browser smoke zakończono bez
pozostałych findings. Nie kompilujemy testów jednostkowych. Browser fixture
nie zastępuje pełnego restartu Tauri. Pełny architecture hygiene gate pozostaje
niezaliczony: istniejący `shellCommands.ts` importuje
`@/modules/start/model/startScreenState`; ten plik nie został zmieniony w AK.
`just lint-control-room-source`: PASS bez ostrzeżeń, receipt
`windows-control-room-source-check/lint/1e89dee2f4e8475794700ef97cb3e3b8/receipt.json`.
`just doctor-control-room-source`: PASS, brak issues w skanowanym zmienionym
pliku; receipt `windows-control-room-source-check/react-doctor/243130b06eb44fbdbaed324171f619bf/receipt.json`.
Pełny zestaw testów jednostkowych pozostaje **NOT VERIFIED** z powodu
obowiązującego zakazu ich kompilacji; nie zastępujemy go source checkiem.

UI trigger, transport kapsuły, zgodność archiwum z aktualną sceną, PendingForms,
undo/redo, hydration całego workspace, drugi restart i Compute pozostają
otwarte. `restart_available=false`; procenty całego planu bez awansu.
