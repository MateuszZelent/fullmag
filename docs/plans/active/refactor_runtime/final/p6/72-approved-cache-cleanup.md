# P6-72 — zatwierdzone usunięcie cache

Status: **wykonanie PASS**, 02.10.2026. Użytkownik zatwierdził usunięcie cache
z dokładnego manifestu P6-67. Operacja zakończyła się o 05:53:54 UTC z exit 0.

Usunięto wszystkie **44 fizyczne katalogi** `frontend/next/dev-3250`,
łącznie 11 441 688 600 bajtów logicznych (10,66 GiB). Ponowne kontrole przed
operacją potwierdziły containment ścieżek, brak reparse points w celach
i przodkach, zgodność rozmiarów i liczby plików z zatwierdzonym manifestem,
terminalne receipts, mapowanie source junctionów oraz brak aktywnych
procesów używających fixture. Kontrola procesów była ponawiana przed każdym
usunięciem. Zweryfikowano także mounty istniejącego koordynatora.

Hashami przed i po operacji potwierdzono zachowanie **349 plików dowodowych**:
receipts, logów i artefaktów browser. Snapshoty źródeł pozostały. Junctiony
`.next-control-room-3250` mogą wskazywać nieistniejący cache do jego odbudowy.

Dowód: [receipt wykonania](72-cache-cleanup-receipt.json). Niezmieniony
[zatwierdzony manifest](67a-terminal-frontend-cache-manifest.json) ma SHA-256
`425d7f8ee91a74243a45422c892d69bc348b9f11c08f06e3b008d29d62940eb2`.
Historyczne `proposal_only_no_deletion` i `pending` w manifeście opisują stan
propozycji; późniejsza autoryzacja i wykonanie są zapisane w nowym receipcie.

Odczyt runnera o 06:00:52 UTC: worker żywy, przyjmuje zadania, bez błędu;
17 839 595 520 B wolnego (16,61 GiB), powyżej progu 8 GiB. Przed usunięciem
odczyt wynosił 1 205 465 088 B. Różnica pomiarów nie jest dokładnym pomiarem
odzysku tej operacji, ponieważ storage jest współdzielony.

Wcześniej oczekujący build **196**, job `febe368724ec4e76a1da88ad24878a9b`,
profil `fem-cpu-slepc-runtime-v2`, jest aktywny. Nie zmieniano jego kolejki,
obrazu runnera ani siedmiu dopuszczonych profili. Historyczne
`last_result=waiting_for_disk` nadal występuje w health obok bieżącego joba;
nie oznacza jego terminalnego wyniku.

Usunięcie blokady pojemności nie kwalifikuje runtime. Integracja rozszerzonego
entrypointu z kontraktem P6-68–70, managed build aktualnych źródeł, natywny
roundtrip oraz walidacja nauki i wydania pozostają otwarte. P6 około 52%,
cały plan około 49%; procenty bez zmian.
