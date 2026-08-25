# FEM Airbox z pustej sceny — projekt ścieżki authoringu

## Cel

Użytkownik zaczynający od pustej sesji FEM musi mieć widoczną i kanoniczną
ścieżkę do zapisania polityki Airbox, a następnie do uruchomienia budowy
shared-domain mesh. Sama obecność panelu Airbox po materializacji siatki nie
wystarcza, ponieważ przed pierwszym zapisem polityki Explorer celowo nie
fabrykuje węzła Airbox.

## Dowód luki

- `buildFemAirboxNode` zwraca `null`, dopóki nie ma autorskiej polityki,
  zrealizowanego carriera, resolved targetu albo legacy carriera.
- `UniverseRootInspectorPanel` był wyłącznie kontekstowym nawigatorem i nie
  oferował żadnej transakcji authoringu.
- `AirboxMeshParametersPanel` już posiada właściwy resource hook,
  `replaceUniversePolicy`, invalidację zasobów i komendę
  `mesh.build-shared-domain`, ale nie był osiągalny z pustego FEM.
- W pustej sesji `domain.discretization` może pozostać domyślnym `fdm`, mimo że
  `capabilities.active_lane.resolved.discretization` jest `fem`.

## Wybrany wariant

Universe pozostaje węzłem semantycznym i nie pokazuje nieautoryzowanego Airboxa.
Jego Inspector, gdy aktywna rozstrzygnięta linia jest FEM, renderuje sekcję
`FEM Airbox setup` z istniejącym `AirboxMeshParametersPanel`. Formularz:

1. zapisuje politykę przez `ControlRoomApi.meshing.replaceUniversePolicy`;
2. unieważnia policy/build resources przez istniejący resource cache;
3. pokazuje komunikat o nieaktualnym shared-domain mesh;
4. udostępnia istniejącą komendę `mesh.build-shared-domain`;
5. po odświeżeniu zasobów pozwala Explorerowi pokazać kanoniczne drzewo Airbox.

Dla jawnej linii FDM sekcja FEM nie jest renderowana; FDM pozostaje przy
`StudyGlobalAuthoringModel` i polityce structured-grid. Przy braku statusu
Inspector najpierw czeka na rozstrzygnięcie lane, zamiast wybierać backend na
podstawie domysłu.

## Własność stanu i kontrakt API

Polityka pozostaje serwerowym zasobem
`/v2/sessions/current/meshing/policies/universe`; formularz jest wyłącznie
lokalnym draftem Inspectora. Nie dodajemy endpointu, pól statusu ani drugiej
reprezentacji sceny. `capabilities.active_lane` jest źródłem gatingu lane,
`domain` pozostaje źródłem danych o zrealizowanej domenie, a WebSocket tylko
unieważnia zasoby.

## Weryfikacja

- test runtime statusu dowodzi, że resolved FEM wygrywa z pustym/defaultowym
  `domain.discretization=fdm`;
- test `UniverseRootInspectorPanel` dowodzi widoczności formularza FEM i jego
  braku na jawnej linii FDM;
- UI smoke FEM zaczyna od pustej sceny, zapisuje politykę `manual` z rozmiarem
  Airbox i sprawdza pojawienie się węzła `model:airbox`;
- istniejący test `AirboxMeshParametersPanel` nadal pokrywa serializację,
  walidację i boundary `replaceUniversePolicy`.

## Poza zakresem

Ta zmiana nie kwalifikuje solvera FEM, nie zastępuje managed runtime, nie
zmienia modelu ProblemIR ani nie udaje sukcesu `mesh_build`/`relax` bez
kanonicznego środowiska wykonawczego.
