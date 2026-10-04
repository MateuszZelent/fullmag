# Izolacja recovery bieżącej sesji — 24.09.2026

## Zakres poprawki

Endpointy `GET` i `DELETE /v2/sessions/current/persistence/recovery` walidowały
kontekst aktywnej sesji, ale następnie odczytywały lub usuwały wszystkie snapshoty
wspólnego magazynu. Blokada zmiany sesji nie ograniczała zakresu danych.

Dodano `SessionStore::read_session_recovery` i `clear_session_recovery`.
Odczyt wskazuje dokładny plik sesji i sprawdza zgodność tożsamości oraz schematu.
Usunięcie odbywa się pod blokadą pisarza; niezgodny dokument pozostaje na dysku.
Ścieżka przechodzi istniejącą walidację containment i odrzucania linków.
API korzysta z tych metod dla przechwyconego kontekstu. Globalne operacje CLI
i wewnętrzne wywołania bez kontekstu pozostają osobną ścieżką migracyjną.
Nie zmieniono kształtu JSON ani typów OpenAPI; regeneracja klienta nie była potrzebna.

## Dowody

- `just verify-session-persistence`: **78/78 PASS** (58 biblioteki, 20 integracyjnych,
  0 doctestów). Run `0487199183db4723a0cfb536e735e73d`, exit 0,
  `source_changed_during_run=false`, source SHA-256
  `44c6026c2448b8a561394c63d46fc2bc381ceac5cd9ad3f9b32c83f28a55f4ea`.
  Regresja obejmuje dwie sesje, idempotentne usunięcie, zachowanie obcego snapshotu,
  niezgodność tożsamości i odrzucenie niebezpiecznego identyfikatora.
- `just check-api-source`: **PASS**, run `2094a7c5b5f5487ba828d49297a7d62a`,
  exit 0, `source_changed_during_run=false`, source SHA-256
  `e22e965c07f4347ed29dfdfdeac61de85601952f4d92275556d48f0e2b2ca96d`.
- `python -m pytest scripts/test_verify_session_persistence.py -q`: **14/14 PASS**.
  Dodano wykonywalny test odmowy nieznanej trasy. Nowa trasa
  `just verify-api-recovery` wymaga jawnego mapowania w wrapperze;
  nierozpoznany `--route` nie może przejść do domyślnych testów session.
- Pierwsza próba nowej trasy, run `86c0a529622d4a9d88e8de5a1ce53f59`,
  uruchomiła testy session przed poprawką wrappera. **Nie jest dowodem HTTP**.
- `just verify-api-recovery`: **2/2 PASS** (pusta lista oraz izolacja dwóch sesji przez GET/DELETE). Run `a85c926305d44beeb4c30cbb49fd8ee3`, exit 0, `source_changed_during_run=false`, source SHA-256 `e5d83cba63184c80e27822b79907b14af9156c2d2f6d87542a52e1b11883da44`. Receipt i log znajdują się w profilu `windows-api-source-check/api-recovery-tests`.

Receipty są pod zarządzanym storage w `builds/fullmag-0950f4dca4ffe38f/`,
w profilach `windows-session-check/session-persistence` oraz
`windows-api-source-check/api-source-check`. Dowody dotyczą dirty lokalnego
`master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, z dokładniejszą identyfikacją
źródeł w receiptach.

## Pozostały zakres

Ta poprawka zabezpiecza zakres odczytu i usuwania. Automatyczne wytwarzanie
snapshotów, odtwarzanie sesji/runtime po awarii, power-loss, fizyczny Tauri
i kwalifikacja solverów pozostają **NOT VERIFIED**. P0 85%, P1 98%, cały plan
około 27% — bez podnoszenia procentów na podstawie tej ograniczonej regresji.
