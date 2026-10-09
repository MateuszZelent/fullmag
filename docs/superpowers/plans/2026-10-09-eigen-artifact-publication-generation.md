# Spójna generacja publikacji artefaktów eigensolve — #4225198873

Stan: plan naprawy, implementacja i wykonanie **NOT VERIFIED**. Zakres jest częścią pełnego review PR97; sama kontrola jednego pliku ani hash katalogu nie zamyka usterki.

## Potwierdzony problem

`crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs::canonical_frequency_domain_artifact_root` oblicza `artifact_set_id` ze ścieżki. `validate_current_frequency_domain_artifact_set` sprawdza owner/root, lecz nie wykrywa zmiany plików w tym samym katalogu. `crates/fullmag-runner/src/eigen/artifacts.rs` publikuje branches i CSV kolejnymi zapisami. `frequencyDomainChartModels.ts::eigenArtifactsShareOwnership` dopuszcza join po identycznym ID. Stąd branches z publikacji A i CSV z B mogą zostać uznane za jeden zestaw.

Obecny frontend już wymaga niepustego artifact_set_id zgodnego po obu stronach. Nie wolno zastąpić tego guardu porównaniem samych session/run IDs.

## Obowiązujący kontrakt

Dokładny dokument to [0035-typed-study-artifact-manifest-and-worker-boundary.md](../../adr/0035-typed-study-artifact-manifest-and-worker-boundary.md), status accepted for implementation. Drugi plik o numerze0035 opisuje reprezentację przestrzenną; nie należy mylić tych decyzji. ADR wymaga niezmiennego manifestu, allow-listy deklarowanych outputów, hashów bajtów, jawnego ownera/attemptu/epoch, CAS oraz publikacji przed terminalnym sukcesem. Bezpośredni legacy writer nie może wprowadzić konkurencyjnego publicznego kontraktu obok tej granicy.

## Wymagane kroki

1. Ustalić wszystkie bezpośrednie callsites `write_path_artifacts` i dostępny rzeczywisty owner. Wykorzystać istniejący typowany study manifest/CAS tam, gdzie jest już podłączony. Dla bezpośredniej historycznej trasy określić jawny adapter zgodny z tą samą allow-listą i provenance; nie dopisywać ownera z aktywnej sesji API. Brak ownera nie oznacza zaufanego zestawu.
2. Producent publikuje niezmienne bajty zadanych artefaktów i jeden manifest generacji jako końcową granicę commit. Manifest zawiera dokładne ścieżki względne, rozmiary i SHA-256 oraz rzeczywiste identity/attempt. Lista pochodzi z zadanych outputs, nigdy z rekursywnego skanu katalogu. Objąć members używane przez branches/dispersion/path, family metadata oraz rzeczywisty handoff pól 3D. Obsłużyć konfiguracje tylko spectrum, tylko branches, tylko field/diagnostics zgodnie z ich kontraktem.
3. Publikacja nie może nadpisywać bajtów zatwierdzonej starej generacji. Wykorzystać istniejące atomic/no-replace publication helpers oraz kanoniczny storage. Przy zmianie terminalnej semantyki direct writera uzupełnić scoped rozwinięcie ADR i dowody trwałości; nie twierdzić, że sam rename dowodzi przetrwania awarii zasilania.
4. Capture API wiąże bajty/digest zatwierdzonego manifestu z istniejącym owner/root fence. Odczyt sprawdza membership i hash dokładnie tych bajtów, które następnie parsuje. Po odczycie sprawdza ten sam marker/manifest i owner/root ponownie. Mutation lub uszkodzenie daje conflict/not-ready, nie fallback historyczny.
5. `artifact_set_id` wyprowadzić z zatwierdzonej generacji, nie z path. Dwa GET-y różnych generacji muszą mieć różne ID, więc istniejący join guard je odrzuca. Sprawdzić także mode field overlay i Inspector — sam chart join nie wyczerpuje zakresu.
6. Historyczne pliki bez manifestu pozostają czytelne z per-file revision/content digest, lecz bez zaufanego artifact_set_id i bez cross-file enrichment/handoff. Jawnie opisać legacy-unqualified binding w istniejącym lub addytywnym metadata contract. Uszkodzony lub częściowy obecny manifest nigdy nie jest traktowany jako brak historycznego manifestu. Nie usuwać historii i nie migrować bajtów po cichu.
7. Zaktualizować tylko potrzebne resource DTO/OpenAPI/generated types/resource hooks/UI gates i fixture'y. Jeżeli wystarczy aktualny nullable artifact_set_id, nie dodawać zbędnego pola; jawne rozróżnienie stanu legacy i corrupt pozostaje wymagane. Przed implementacją sprecyzować tę decyzję w scoped record.

## Odbiór i regresje

- Przerwanie między branches i CSV nie zatwierdza nowego zestawu; poprzednia generacja pozostaje czytelna.
- Zmiana membera w tym samym root/run/stage jest odrzucana na hash mismatch.
- Zmiana manifestu podczas GET daje konflikt. Oddzielne odczyty A/B nie łączą się; A/A łączą się i zachowują handoff.
- Brak manifestu pozwala czytać historię bez deklaracji spójnego zestawu. Corrupt marker/manifest nie daje historycznego fallbacku.
- Tylko jeden zadany output nie wymaga niezamówionych members. Missing member, duplicate path, escape/reparse/symlink i błędny owner/attempt/epoch są fail-closed.
- Source/contract tests, producer fault injection, pełne resource gates/generated API, browser handoff i kwalifikacja naukowa są osobnymi dowodami. Zmiana publikacji nie kwalifikuje solvera.

## Granice obecnego checkpointu

Diagnoza źródłowa potwierdzona. Plan nie jest zgłoszeniem działającego manifestowego runtime. Usterka pozostaje valid_unfixed aż do kompletnej korekty producent–API–UI i właściwych bramek. Pozostałe poprawki review wykonujemy niezależnie.
