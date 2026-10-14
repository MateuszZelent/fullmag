# Eksport sceny: pełny inwentarz anten bez aktywacji magnetyzmu

## Przyczyna i wdrożony zakres

`crates/fullmag-api/src/script.rs::sync_current_live_script` rozdziela eksport
sceny generowanej od zera od przepisywania istniejącego skryptu. Druga ścieżka
korzysta z `scene_document_overrides`, a następnie
`crates/fullmag-authoring/src/adapters.rs::scene_document_to_script_builder_overrides`.
Dotychczas lista geometrii pochodziła wyłącznie z magnetycznej projekcji
`scene_document_to_script_builder`. Antena z `role = antenna` nie trafiała
do override, mimo zachowania kolekcji portów i transportu.

Naprawiono właściciela override, nie selektor solvera:

- `scene_solve_objects` nadal wybiera wyłącznie magnesy, także niewidoczne.
- Geometrie magnetyczne eksportują teraz jawne `object_id` i `role` ze sceny,
  niezależnie od nazwy użytkownika.
- Do eksportu dodawane są wszystkie niemagnetyczne obiekty sceny: ich ID,
  nazwa, rola, parametry geometrii, bounds i konfiguracja siatki.
- Antenie nie dopisuje się materiału magnetycznego, magnetyzacji ani
  `physics_stack`. Wybór typu prezentacyjnego nie włącza solvera LLG.
- Translacja właściciela jest przenoszona tak jak w istniejącym authoringu
  magnetycznym. Wewnętrzny `geometry_params.transform` layoutu pozostaje
  oddzielny. Nieobsługiwane obroty/skale właściciela są jawnie odrzucane
  zamiast pomijane. Nie dodano nowej obsługi tych transformacji.

Podstawa semantyczna:
`docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
+ sekcja `antenna-round-trip-and-failure-semantics` i tabela
`geometry_object/antenna_object/conductor.object_id`.
Nie zmieniono równań, wersji writer IR, tras HTTP ani publicznych konstruktorów.
Magnetyczny `ScriptBuilderState` pozostaje projekcją solvera, a nie nowym
pełnym modelem obiektów. Migracja wspólnego inventory/ProblemIR jest osobną
otwartą bramką, nie wynikiem tej poprawki.

## Wykonana weryfikacja

`packages/fullmag-py/tests/test_script_builder_roundtrip.py`
+ `AuxiliaryScriptOverrideRoundTripTests`:
wykonany round-trip istniejącego skryptu przez override adaptera Python,
renderer i ponowny capture. Dwa przypadki: CPW asymetryczne oraz microstrip,
trzy stacje z przewężeniem, niestandardowe ID przewodników, zmieniona nazwa,
wewnętrzna translacja layoutu i osobna translacja właściciela o 50 nm.
Sprawdzono dokładną zgodność parametrów, ID, roli i nazwy; brak magnetycznych
przypisań anteny; dokładnie jeden właściwy magnes w problemie.
Nie uruchomiono żadnego solvera ani etapu czasowego.

Cały interpretowany plik regresji: **51 testów i 35 podprzypadków PASS**.
Ta weryfikacja dowodzi działania konsumenta Python i jego adaptera, nie
wykonania nowego adaptera Rust ani endpointu eksportu.

`just check-api-source`: **passed**, exit 0. Receipt
`fcbc0112e0bf4fbdb179a0deaf52b8c6`, profil
`windows-api-source-check/api-source-check` w storage tego worktree.
Digest source przed/po:
`7cc277f20b683d196356e5ae83fd66792375b70f3e13e6667b52d9b95a8b09fc`.
`source_changed_during_run = false`; SHA-256 adaptera:
`2fb792e9e4942968f4c7219a3f8bb2190cc49ef113e6973a15154028a914cb2a`.
Kontrola obejmuje produkcyjne typy API/authoringu, bez `cfg(test)` i bez
native FEM. Nie jest to kompilacja ani wykonanie testów Rust.

Zapisane, **niewykonane i niekompilowane** regresje Rust w
`crates/fullmag-authoring/src/adapters.rs`:

- `solve_object_projection_includes_hidden_magnets_and_excludes_non_magnets`:
  projekcja nadal magnetic-only, eksport zachowuje carrier bez magnetyzmu.
- `antenna_export_preserves_owner_identity_and_translation_without_magnetism`:
  niezależne ID/nazwa, położenie, brak przypisań i odmowa nieobsługiwanej skali.

## Otwarte bramki i następny krok

FDM CPU/GPU, FEM CPU/GPU: wspólny kontrakt eksportu, bez nowej kwalifikacji
solverów w żadnej realizacji. Endpointy Rust i UI/browser **NOT VERIFIED**.
Nie restartowano aktywnej sesji. Build 38 używa wcześniejszego commita
`86810f37e21e95b3f8e24d967fdb2bad9511eff1`, nie obejmuje tej poprawki.
Przy ostatnim odczycie etap native zakończył się exit 0, a cały job nadal
budował frontend; nie oznacza to terminalnego sukcesu pakietu.

Następne wymagania: wykonanie backendowego eksportu z istniejącego skryptu
po przebudowie, kwalifikacja konfiguracji siatki obiektu pomocniczego w
rendererze (sama obecność `mesh` w override nie dowodzi jej użycia), kreator
CPW, pięciowymiarowy edytor stacji, geometria wszystkich trzech przewodników
w viewport, Inspector i stabilność interakcji, eksport/import rzeczywistej
sceny UI, zgodność inventory/current-source oraz scientific runtime gates.
T00–T18 i pełny moduł pozostają otwarte; PR #147 pozostaje Draft.
