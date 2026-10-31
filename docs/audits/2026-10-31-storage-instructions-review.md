# Przegląd instrukcji storage i cache Docker DEV — 31.10.2026

## Zakres

Sprawdziłem obowiązujące instrukcje `AGENTS.md`, `.agents/instructions/backend.md`
i `frontend.md`, główny skill `fullmag-docker-build` oraz referencje
`procedure.md`, `artifact-policy.md` i `writer-inventory.md`. Porównałem je z ADR
0076 oraz właściwymi sekcjami dokumentów `fullmag-build-storage-governance.md`,
`shared-build-storage.md`, `docker-build-storage-lifecycle.md`,
`docker-development-architecture.md`, `docker-volume-development.md` i ADR 0061/0067.

## Sprzeczności rozstrzygnięte

- Starsze wzmianki o przechowywaniu prywatnego Cargo incremental po starcie, limicie
  8 GiB, przyrostowej kompilacji po zmianie źródeł lub retencji `.fullmag-build`
  były sprzeczne z nowym priorytetem odzysku miejsca. Zachowałem je jako historię,
  a szczegóły nowego cyklu wskazałem w ADR 0076.
- ADR 0061 i dawne inventory opisują wiele prywatnych volumes; ich fizyczna
  topologia jest superseded dla daily DEV przez ADR 0076. ADR 0067 nadal stanowi
  kontrakt izolacji group-ledger; zmienia się jego położenie, nie semantyka.
- Packages guide zachowuje regułę current + jeden verified rollback; nie wolno
  usuwać ostatniego dobrego pakietu przed udaną publikacją następcy.

## Obowiązujący kontrakt i granice

ADR 0076 jest źródłem reguły: przed każdą rzeczywistą kompilacją usuwane są
wyłącznie rozpoznane compiler outputs `.fullmag-build`; po atomowej publikacji
i ponownej walidacji samowystarczalnego pakietu są usuwane ponownie. Cache-hit
nie czyści ani nie kompiluje. Nieudany build może zostawić najwyżej jedną
generację w tej samej ścieżce do następnego prebuild; nowe volumes i katalogi
per-profile/attempt nie powstają. Runtime używa zweryfikowanego pakietu, a zmiana
źródeł może wymagać pełnej kompilacji.

Zachować źródła/workspace, logi i diagnostykę, current + jeden verified rollback,
control, ledger, shared dependencies, sesje i wyniki użytkownika. Te zasady są
kontraktem, nie dowodem działania: implementacja helpera, mounty, cleanup po
publikacji oraz runtime pozostają **NOT VERIFIED** do uzyskania receiptu i dowodu
z docelowej grupy. Nie uruchamiałem buildów ani Docker.

## Wymóg mountów subdirectory

Docker Engine opisuje montowanie podkatalogu named volume, a Compose long syntax
udostępnia wybór `volume.subpath`: [Docker Engine — mount a volume subdirectory](https://docs.docker.com/engine/storage/volumes/#mount-a-volume-subdirectory),
[Compose services — long syntax](https://docs.docker.com/reference/compose-file/services/#long-syntax).
Wymagany podkatalog musi istnieć przed mountem, więc adapter grupy inicjalizuje
role w wolumenie przed uruchomieniem Compose; frontend dostaje wyłącznie swój
subpath. To opisuje kontrakt podziału dostępu, nie dowodzi mountów runtime.
