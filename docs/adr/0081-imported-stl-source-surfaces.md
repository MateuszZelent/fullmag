# ADR 0081: Import STL jako zachowana powierzchnia źródłowa

Status: wdrażane w zadaniu BuckyBall; brak kwalifikacji runtime.

## Problem i decyzja

STL opisuje trójkątną powierzchnię, bez jednostek i materiału. Upload pliku,
prostokątna obwiednia, powierzchnia podglądu oraz objętościowa siatka FEM to
różne zasoby. Import ma zachować oryginalne bajty i orientację trójkątów,
wyświetlić geometrię przed siatkowaniem i umożliwić zwykły Build Mesh/Compute.
Nie zastępujemy `ImportedGeometry` prymitywem ani gotową siatką solvera.

1. Wspólny, ograniczony rozmiarem parser binary/ASCII STL zwraca indeksowaną
   powierzchnię i bounds w surowych współrzędnych. Odrzuca puste, uszkodzone,
   niefinitywne i zdegenerowane trójkąty przed publikacją assetu. Powierzchnia
   otwarta może służyć do podglądu; nie jest przez to bryłą dopuszczoną do FEM.
2. `SceneGeometry.source_asset` jest opcjonalną, typowaną referencją zawierającą
   `asset_id`, `content_sha256` i znormalizowany `archive_path` pod
   `project/assets/`. Nie zastępuje trwałego `object_id` ani nazwy użytkownika.
   Scene/builder przechowują referencję. Zapis/otwarcie `.fms` obejmują oryginalny
   STL przez istniejący `OpaqueAsset`; otwarcie i materializacja ponownie
   weryfikują digest. Stare deklaracje `source` pozostają czytelne, ale wymagają
   odczytu i jawnego związania istniejącego pliku przed kwalifikowanym importem.
3. Jednostki i skala są jawne. Obowiązuje istniejące Pythonowe `ImportedGeometry`
   i normalizacja do SI; brak rozpoznawania jednostek z nazwy pliku. UI pokazuje
   wynikowe wymiary. BuckyBall zachowuje największy wymiar obwiedni 5 µm.
4. Powierzchnia źródłowa ma sesyjny zasób per obiekt: cienki deskryptor z rewizją
   sceny, tożsamością/hash assetu i bounds oraz osobny binarny zasób topologii.
   Wykorzystujemy istniejący kodek i jeden viewport/resource hooks, bez ciężkich
   tablic w scenie/statusie, bez publikowania `fem_mesh` i bez nowego renderera.
5. Mesher klasyfikuje zamknięte powłoki i ich zawieranie przed tworzeniem
   objętości. Powłoki zagnieżdżone wyznaczają materiał i wnęki naprzemiennie;
   nie są niezależnymi dodatnimi bryłami. Wspólny mesh obejmuje materiał,
   powietrze we wnękach oraz powietrze zewnętrzne, z konforemnymi interfejsami.
   Przecinanie, stykanie lub niejednoznaczność topologii nie mogą prowadzić do
   cichego wypełnienia ani naprawy wejścia. Komponenty zachowują właściciela z
   pochodzenia powierzchni; dopasowanie obwiedni nie stanowi dowodu tożsamości.
6. Import nie uruchamia study, meshera ani solvera. Materiał, magnetyzacja,
   universe i polityki siatki podlegają zwykłym walidatorom. Zmiana źródła,
   skali lub transformacji unieważnia pochodne powierzchnie/siatki. Wymuszone
   FEM GPU zachowuje requested intent, bez fallbacku CPU.

## Wdrożenie i weryfikacja

Parser i referencja należą do authoringu; zasoby/import/persistence do API v2;
obsługa powłok do istniejącego meshera Gmsh; UI do typowanego klienta i jednego
viewportu. Aktualizacja OpenAPI wymaga regeneracji klienta. Pythonowe i UI
ścieżki mają prowadzić do tej samej reprezentacji `ImportedGeometry` i MeshIR.
Nie wprowadzamy nowej fizyki ani kopii solvera.

Bramki: binary/ASCII i błędne pliki bez opublikowanych assetów; jednostki i
bounds SI; Save→Open bez oryginalnej ścieżki; zmieniony digest i stary scope;
podgląd bez FEM i bez meshera; analityczny pusty sześcian (materiał 7, wnęka 1,
powietrze zewnętrzne 56 w tych samych jednostkach sześciennych), wiele obiektów,
zagnieżdżenie i błędy topologii; BuckyBall z zachowaniem wnęki; rzeczywisty
browser/WebGL i managed FEM GPU. Zaliczenie parsera nie kwalifikuje solvera.

Rollback zachowuje oryginalne assety/projekty. Nie usuwa starych runów, ownerów,
ledgerów ani receiptów. Brakująca bramka pozostaje jawnie NOT VERIFIED.
