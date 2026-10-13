# FMR — checkpoint integracji tożsamości cache

Data: 12.10.2026. Zakres: API danych częstotliwościowych wspierających przyszłą
ścieżkę anten T17. To zapis integracji i dowodów źródłowych, nie kwalifikacja
naukowa, publikacja fizyki ani zamknięcie modułu anten.

## Właściciel i stan

Integracja produkcyjna należy do równoległego wątku
`01a12a56-002e-7660-8424-c7e07fb0907a`, checkout
`D:/git/fullmag/worktrees/antenna-transport-e2e-20261011`.
Ten wątek przygotował patche w storage; nie edytował checkoutu integratora.
Integrator zastosował patch produkcyjny. Niezależny odczyt obu plików potwierdził
zgodność SHA256 z kandydatami. Nie oznacza to integracji na masterze ani
przeniesienia produkcyjnego diffu do niniejszego starszego worktree.

## Poprawka i rozdzielenie tożsamości

- `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`:
  istniejący `frequency_domain_field_content_digest` deleguje obliczenie do
  helpera przyjmującego bajty. `response_field_content_digest_from_bytes`
  używa tego samego `FrequencyDomainFieldMetadata`, serializacji serde i domeny
  digestu co endpoint metadanych. Nie powstał drugi model metadanych.
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`:
  `analysis_frequency_response_vector_response` przekazuje już odczytany payload.
  Numeryczna rewizja pochodzi z istniejącego `sha256_hex_revision`; pełny digest
  źródła pozostaje w ETag. `analysis_response_field_etag` dodaje widok, komponent,
  fazę oraz SHA256 dokładnych bajtów gotowej odpowiedzi binarnej.
- Digest reprezentacji obejmuje serializowane dane domeny, topologii i
  indeksowania. Zmiana siatki nie może być utożsamiana wyłącznie ze zmianą
  źródłowego pola. Skrócona rewizja u64 nie jest pełnym certyfikatem integralności.
- Schemat JSON i ścieżki API nie zmieniły się; klienta OpenAPI nie regenerowano.
  Ścieżka Eigen pozostaje poza patchem i nadal wymaga osobnej naprawy.

## Przypięte pliki produkcyjne

| Plik | SHA256 przed | SHA256 po |
|---|---|---|
| `handlers/data/fields.rs` | `edc53832912c434ab0b99ddb0245796ad529032b33c2be2de092f960ac8b8bfb` | `a02faf398f6c4d5a18ff953a377fe4b5d929b2b3beebb2924f1a89c59a1820f4` |
| `handlers/analysis/frequency_domain.rs` | `3f463bacf550afce46f857a91e04d65a244bbbddfa4037e736a4d19ef73f67b9` | `e61e2b5b94285b0a7dcbc907b7c0143336c7c2379f96c05b5612395a4d490a31` |

Ścieżki tabeli są względem `crates/fullmag-api/src/router_v2/`.
Patch produkcyjny `fmr-content-identity-v2.patch`:
`2fb0299eada92419fa7311483f7c034c2c63c08782e76eca97febd68c63f942a`.
Wersja bez suffixu v2 jest historyczna i nie należy jej stosować.

## Regresja istniejącego routera

Test `frequency_response_binary_cache_tracks_content_and_representation`
korzysta z istniejącej fixture sesji i czterowęzłowej siatki FEM. Przygotowane
assertions obejmują niezmieniony payload → pusty 304, podmianę bajtów o tej
samej długości → 200 z nowym ETag i body, powiązanie z digestem metadanych,
zmiany widoku/komponentu/fazy przy niezmienionym źródle oraz tożsamość siatki.

Pierwotny test zmieniał geometrię, generację i rewizję siatki razem.
Odrębny wariant izolowany odtwarza bazę przed każdym przypadkiem i potwierdza
identyczne body/ETag. Następnie zmienia wyłącznie generację, wyłącznie rewizję
lub wyłącznie współrzędną węzła. Każdy przypadek wymaga nowego 200 i pustego
304 po ponowieniu z własnym ETag, przy niezmienionym digestcie źródłowym.

| Artefakt izolowanego testu | SHA256 |
|---|---|
| Źródło `fmr-http-regression-isolated.rs` | `9fcbc6e6d2079c96be8d4d3b437ca54b3aaa06f4feace13580ebadca014305b9` |
| Pełny patch `fmr-http-regression-isolated.patch` | `f9ae9fd31e3f55bce32dff88e475415785ba8b635dfcd128f0220950d56f9610` |
| Bazowy `router_v2/tests.rs` | `5c5a74daf0a664503b18504c07301b18ae0c422ea63fc6705d77c5a0ef459b2b` |
| Wynikowy kandydat `router_v2/tests.rs` | `1091ef8c759edfeae99bcc7dbd2cb64248bd604f1a1a1c53cea25de0a20f41dc` |
| Follow-up względem pierwotnego testu | `cd5d3bfbf946ff82f58bfc0f505a2b374238eeb5d010b2b4a19352b11e494fea` |

Stosować pełny patch do oryginalnej bazy ALBO follow-up do kandydata z
pierwotnym testem (SHA256 `ad9a55eb44758480eaf55238144d6d50555d0c406dfcea24808caa0a3fdb0bb5`).
Nie stosować obu dróg. Zastosowanie testu przez integratora nie jest tutaj potwierdzone.

## Dowody i otwarte bramki

Potwierdzono `git apply --check` produkcyjnego patcha i pełnych patchy testu
na ich aktualnych bazach (exit 0). Parser rustfmt w trybie emit stdout,
bez zmiany źródeł i bez kompilacji, zaakceptował izolowany test.
Pierwotny test miał również niezależny przegląd źródłowy: zgodność czterech
węzłów z 12 parami complex, metadata/path precedence i symptom starego ETag.
Nie rozszerzamy tego przeglądu na wykonanie wariantu izolowanego.

NIE kompilowano ani nie uruchamiano testów Rust. Nie wykonano rzeczywistych
żądań endpointu, Range, testu przeglądarki ani managed buildu tej poprawki.
Nie wykorzystano rzeczywistego artefaktu anteny. Koszt pełnych odczytów,
dodatkowego hashowania binary O(N) i powtórnego odczytu JSON nie został
zmierzony. Nie ma gwarancji atomic snapshot dla mutable archive; współbieżna
zmiana metadanych między odczytami nadal wymaga osobnej bramki association.

T17 pozostaje otwarte: publiczna aktywacja rzeczywistej harmonicznej bazy
anteny, zgodny torque RHS, faza i wynik solvera muszą przejść wymagane
porównania z niezależnym oracle. Zielony parser lub fixture nie zastępuje
tego odbioru.

Storage dowodów i preimage:
`D:/git/fullmag/storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/reviews/antenna-harmonic-cache-20261012`.
Receipt integratora znajduje się w
`D:/git/fullmag/storage/builds/antenna-transport-e2e-20261011-5e7f0d529ca256ef/reviews/fmr-content-identity-root-20261012/root-applied-review.json`
(SHA256 `0f7a372d4e6659858a1fbcb9557252c4c2bbb8bf41a4e2ace2b941ee345c4637`).
