# Lokalny magazyn managed FEM — specyfikacja

## Cel

Umożliwić uruchomienie managed FEM bez zapisu artefaktów builda na udziale CIFS
`/zfn2`, który zawiesza operacje `truncate`/`rename`. Lokalny obraz ext4 będzie
leżał na D: i będzie montowany pod istniejącym punktem
`/mnt/fullmag-zfn2-native`, aby nie zmieniać kontraktu kontenera Docker.

## Zakres zaakceptowany

Wprowadzony zostanie jawny profil środowiskowy:

```text
FULLMAG_NATIVE_STORAGE_PROFILE=local-d
```

Profile mają dokładnie dwa warianty:

| Profil | Katalog trwały | Obraz backing | Punkt montowania |
|---|---|---|---|
| `canonical` (domyślny) | `/zfn2/mateuszz/git/fullmag` | `/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4` | `/mnt/fullmag-zfn2-native` |
| `local-d` | `/mnt/d/git/fullmag` | `/mnt/d/git/fullmag/fullmag-native.ext4` | `/mnt/fullmag-zfn2-native` |

Nie będzie dowolnego override'u ścieżki. Dzięki temu profil lokalny jest
świadomym wyborem, a przypadkowa zmienna środowiskowa nie przekieruje builda do
niezweryfikowanego katalogu.

## Niezmienione gwarancje

- Obraz musi być zamontowany jako ext4 przez `/dev/loopN`.
- Walidator nadal porównuje `/sys/class/block/<loop>/loop/backing_file` z
  obrazem wybranego profilu.
- Docker nadal dostaje wyłącznie zamontowany katalog ext4 jako bind mount.
- Profil `canonical` zachowuje dotychczasowe zachowanie.
- Nie będzie fallbacku do zwykłego katalogu DrvFS/9p ani wyłączenia walidacji.

## Przepływ

1. `FULLMAG_NATIVE_STORAGE_PROFILE` jest rozwiązywany przez wspólny helper.
2. `export_fem_gpu_runtime.sh` i `restore_persistent_fem_runtime.sh` używają
   tego samego obrazu, katalogu trwałego i archiwum runtime.
3. Receptury raportów SP4 oraz macierz mixed-P1 przekazują ten sam backing image.
4. `just ensure-managed-fem-runtime` buduje przez istniejącą receptę
   kontenerową.
5. Dopiero po walidacji bundle uruchamiany jest przykład bimeronu.

## Walidacja i kryteria akceptacji

- Test jednostkowy helpera potwierdza oba profile i odrzuca nieznany profil.
- Testy eksportera i restore potwierdzają, że profil `local-d` wybiera lokalny
  obraz, ale nadal odrzuca xfs, urządzenie nie-loop i zły backing image.
- Testy receptur nie zawierają bezwarunkowego użycia starego obrazu w ścieżce
  wyboru profilu.
- Lokalny obraz przechodzi `e2fsck`, zapis testowy i walidację loop/ext4.
- Managed runtime przechodzi przez `just ensure-managed-fem-runtime`.
- Przykład
  `examples/permalloy_layer_bimeron_prism_single_layer_relax_300nm.py`
  wypisuje etap solver initialization zakończony powodzeniem oraz pierwszy
  postęp relaksacji.

## Poza zakresem

Nie zmieniamy równań FEM, planera, backendu CUDA ani semantyki przykładu.
Stary obraz na `/zfn2` pozostaje nietknięty jako kopia zapasowa.
