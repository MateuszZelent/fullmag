# Źródło entrypointu NVIDIA CUDA 12.4.1

Pliki w tym katalogu są przypiętą kopią oficjalnego entrypointu obrazu CUDA z repozytorium
`nvidia/container-images/cuda`, commit
`53a6a109a87bc28f63ab0e8a17a89113bd7ba4f4` (`CUDA 12.4.1 Update`).

Źródło: <https://gitlab.com/nvidia/container-images/cuda/-/tree/53a6a109a87bc28f63ab0e8a17a89113bd7ba4f4>

Kopia służy wyłącznie do deterministycznego odtworzenia plików, które w opublikowanej warstwie
`nvidia/cuda:12.4.1-devel-ubuntu22.04` mogą być wypełnione bajtami NUL. Skrypt normalizujący
kończy się błędem, jeżeli zestaw uszkodzonych plików różni się od znanego zestawu.
