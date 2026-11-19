"""Read archived activation evidence through its original logical paths.

The generated probe is intentionally self-contained: image helpers can execute
it with bash and coreutils even when Python is unavailable in the base image.
"""
from __future__ import annotations

import re

from docker_activation_history_policy import (
    MAX_ATTEMPT_BYTES,
    MAX_DOCUMENT_BYTES,
    MAX_FILES,
    MAX_LOG_BYTES,
    SCHEMA,
)


ARCHIVE_SCHEMA = SCHEMA
MAX_ARCHIVE_FILES = MAX_FILES  # indexed files, including .history.json
MAX_ARCHIVE_BYTES = MAX_ATTEMPT_BYTES  # includes the index
INDEX_MAX_BYTES = 16 * 1024
MAX_READ_BYTES = MAX_DOCUMENT_BYTES
REQUIRED_ARCHIVE_FILES = (
    "receipt.json",
    "terminal.json",
    "result.json",
    "startup-provenance.json",
    "authorization.json",
    "build.log",
    ".history.json",
)

_LOGICAL_PATH = re.compile(
    r"/control/activation/attempts/([0-9a-f]{32})/([A-Za-z0-9_.-]+)\Z"
)


def activation_history_read_script(path: str, maximum: int = MAX_DOCUMENT_BYTES) -> str | None:
    """Return a bounded shell probe for one activation-attempt file.

    ``None`` means the path is outside the exact direct-file route handled by
    this resolver, so callers should retain their ordinary control read. A
    missing logical file exits 44. Integrity failures exit non-44.
    """

    if not isinstance(path, str):
        return None
    match = _LOGICAL_PATH.fullmatch(path)
    if match is None:
        return None
    if type(maximum) is not int or not 1 <= maximum <= MAX_READ_BYTES:
        raise ValueError("Invalid activation-history read byte budget")

    attempt, requested_name = match.groups()
    shell = r'''set -euo pipefail
export LC_ALL=C

fail() { printf '%s\n' "$1" >&2; exit 2; }

# Existing directories must be real canonical directories. A dangling symlink
# is corruption too, even though test -e reports it as absent.
check_dir() {
    local path="$1"
    test ! -L "$path" || fail "Activation control path is a symlink"
    if test -e "$path"; then
        test -d "$path" || fail "Activation control parent is not a directory"
        test "$(readlink -f -- "$path")" = "$path" || fail "Activation control parent is not canonical"
        test -d "$path" || fail "Activation control directory disappeared during validation"
        return 0
    fi
    return 1
}

check_regular() {
    local path="$1" maximum="$2" outvar="$3" size
    test ! -L "$path" || fail "Activation control file is a symlink"
    test -e "$path" || fail "Activation control file disappeared during validation"
    test -f "$path" || fail "Activation control file is not regular"
    test "$(stat -c %h -- "$path")" = 1 || fail "Activation control file has multiple links"
    test "$(readlink -f -- "$path")" = "$path" || fail "Activation control file is not canonical"
    size="$(stat -c %s -- "$path")"
    [[ "$size" =~ ^(0|[1-9][0-9]*)$ ]] || fail "Activation control file size is malformed"
    ((${#size} <= 8)) || fail "Activation control file exceeds its byte budget"
    local size_number=$((10#$size))
    if [[ "$maximum" != none ]]; then
        ((size_number <= maximum)) || fail "Activation control file exceeds its byte budget"
    fi
    printf -v "$outvar" '%s' "$size_number"
}

validate_archive() {
    local dir="$1" index_path="$1/.history.sha256"
    local index_size index_bytes_without_nul final_newlines line line_number=0
    local digest declared_size name previous_name= size_limit declared_number total_bytes=0
    local actual_digest actual_size entry basename entry_count=0 required
    local -A indexed_digest=() indexed_size=()

    check_dir "$dir" || fail "Activation history directory disappeared during validation"
    check_regular "$index_path" @INDEX_MAX_BYTES@ index_size
    index_bytes_without_nul="$(tr -d '\000' < "$index_path" | wc -c)"
    index_bytes_without_nul="${index_bytes_without_nul//[[:space:]]/}"
    [[ "$index_bytes_without_nul" == "$index_size" ]] || fail "Activation history index is not ASCII text"
    final_newlines="$(tail -c 1 -- "$index_path" | wc -l)"
    final_newlines="${final_newlines//[[:space:]]/}"
    [[ "$final_newlines" == 1 ]] || fail "Activation history index has no final newline"

    while IFS= read -r line; do
        if ((line_number == 0)); then
            [[ "$line" == "@SCHEMA@ @ATTEMPT@" ]] || fail "Activation history index header differs"
        else
            [[ "$line" =~ ^([0-9a-f]{64})\ (0|[1-9][0-9]*)\ ([A-Za-z0-9_.-]+)$ ]] || fail "Activation history index row is malformed"
            digest="${BASH_REMATCH[1]}"
            declared_size="${BASH_REMATCH[2]}"
            name="${BASH_REMATCH[3]}"
            [[ "$name" != . && "$name" != .. && "$name" != .history.sha256 ]] || fail "Activation history index has a reserved name"
            if ((entry_count > 0)); then
                [[ "$name" > "$previous_name" ]] || fail "Activation history index is not sorted and unique"
            fi
            previous_name="$name"
            ((${#declared_size} <= 8)) || fail "Activation history indexed file exceeds its byte budget"
            declared_number=$((10#$declared_size))
            if [[ "$name" == build.log ]]; then
                size_limit=@MAX_LOG_BYTES@
            else
                size_limit=@MAX_DOCUMENT_BYTES@
            fi
            ((declared_number <= size_limit)) || fail "Activation history indexed file exceeds its byte budget"
            entry_count=$((entry_count + 1))
            ((entry_count <= @MAX_FILES@)) || fail "Activation history has too many indexed files"
            total_bytes=$((total_bytes + declared_number))
            ((total_bytes + index_size <= @MAX_ARCHIVE_BYTES@)) || fail "Activation history exceeds its total byte budget"
            indexed_digest["$name"]="$digest"
            indexed_size["$name"]="$declared_size"
        fi
        line_number=$((line_number + 1))
    done < "$index_path"

    ((line_number >= 1)) || fail "Activation history index is empty"
    for required in @REQUIRED_NAMES@; do
        [[ -n "${indexed_digest["$required"]+present}" ]] || fail "Activation history is missing a required file"
    done

    shopt -s nullglob dotglob
    local entries=("$dir"/*)
    shopt -u nullglob dotglob
    entry_count=${#indexed_digest[@]}
    ((${#entries[@]} == entry_count + 1)) || fail "Activation history contains an unlisted entry"
    for entry in "${entries[@]}"; do
        basename="${entry##*/}"
        if [[ "$basename" == .history.sha256 ]]; then
            check_regular "$entry" @INDEX_MAX_BYTES@ actual_size
            continue
        fi
        [[ -n "${indexed_digest["$basename"]+present}" ]] || fail "Activation history contains an unlisted entry"
    done

    for name in "${!indexed_digest[@]}"; do
        if [[ "$name" == build.log ]]; then
            size_limit=@MAX_LOG_BYTES@
        else
            size_limit=@MAX_DOCUMENT_BYTES@
        fi
        local target="$dir/$name"
        check_regular "$target" "$size_limit" actual_size
        [[ "$actual_size" == "${indexed_size["$name"]}" ]] || fail "Activation history file size differs from its index"
        actual_digest="$(sha256sum -- "$target")"
        actual_digest="${actual_digest%% *}"
        [[ "$actual_digest" == "${indexed_digest["$name"]}" ]] || fail "Activation history file hash differs from its index"
    done

    archive_requested_path="$dir/@NAME@"
    if [[ -n "${indexed_digest["@NAME@"]+present}" && "@NAME@" != .history.json ]]; then
        archive_requested_present=1
    else
        archive_requested_present=0
    fi
}

control_root=/control
activation_dir="$control_root/activation"
attempts_dir="$activation_dir/attempts"
history_dir="$activation_dir/history-v1"
live_dir="$attempts_dir/@ATTEMPT@"
archive_dir="$history_dir/@ATTEMPT@"
live_file="$live_dir/@NAME@"
archive_requested_path=""
archive_requested_present=0

check_dir "$control_root" || exit 44
if check_dir "$activation_dir"; then activation_exists=1; else activation_exists=0; fi
if check_dir "$attempts_dir"; then attempts_exists=1; else attempts_exists=0; fi
if check_dir "$history_dir"; then history_exists=1; else history_exists=0; fi
if check_dir "$live_dir"; then live_exists=1; else live_exists=0; fi
if check_dir "$archive_dir"; then archive_exists=1; else archive_exists=0; fi

if ((live_exists == 1 && archive_exists == 1)); then
    fail "Activation exists in both live and history locations"
fi

if ((live_exists == 1)); then
    test ! -L "$live_file" || fail "Activation control file is a symlink"
    if ! test -e "$live_file"; then
        check_dir "$live_dir" || fail "Live activation disappeared during validation"
        if check_dir "$archive_dir"; then fail "Activation moved while its live path was being read"; fi
        exit 44
    fi
    check_regular "$live_file" none live_size
    head -c @READ_LIMIT_PLUS_ONE@ -- "$live_file"
    check_dir "$live_dir" || fail "Live activation disappeared during validation"
    if check_dir "$archive_dir"; then fail "Activation moved while its live path was being read"; fi
    exit 0
fi

if ((archive_exists == 1)); then
    validate_archive "$archive_dir"
    if check_dir "$live_dir"; then fail "Activation appeared in both live and history locations"; fi
    check_dir "$archive_dir" || fail "Activation history disappeared during validation"
    if ((archive_requested_present == 0)); then
        exit 44
    fi
    check_regular "$archive_requested_path" @MAX_ARCHIVE_REQUEST_BYTES@ archive_requested_size
    head -c @READ_LIMIT_PLUS_ONE@ -- "$archive_requested_path"
    if check_dir "$live_dir"; then fail "Activation appeared while its history was being read"; fi
    check_dir "$archive_dir" || fail "Activation history disappeared while it was being read"
    exit 0
fi

# Recheck both possible locations before returning optional absence. This is
# what keeps a live-to-history rename racing validation from becoming code 44.
if check_dir "$live_dir"; then fail "Live activation appeared during absence validation"; fi
if check_dir "$archive_dir"; then fail "Activation history appeared during absence validation"; fi
exit 44
'''

    required_names = " ".join("'" + name + "'" for name in REQUIRED_ARCHIVE_FILES)
    replacements = {
        "@ATTEMPT@": attempt,
        "@NAME@": requested_name,
        "@SCHEMA@": ARCHIVE_SCHEMA,
        "@INDEX_MAX_BYTES@": str(INDEX_MAX_BYTES),
        "@MAX_LOG_BYTES@": str(MAX_LOG_BYTES),
        "@MAX_DOCUMENT_BYTES@": str(MAX_DOCUMENT_BYTES),
        "@MAX_FILES@": str(MAX_ARCHIVE_FILES),
        "@MAX_ARCHIVE_BYTES@": str(MAX_ARCHIVE_BYTES),
        "@MAX_ARCHIVE_REQUEST_BYTES@": str(MAX_LOG_BYTES),
        "@READ_LIMIT_PLUS_ONE@": str(maximum + 1),
        "@REQUIRED_NAMES@": required_names,
    }
    for marker, value in replacements.items():
        shell = shell.replace(marker, value)
    return shell


__all__ = [
    "ARCHIVE_SCHEMA",
    "INDEX_MAX_BYTES",
    "MAX_ARCHIVE_BYTES",
    "MAX_ARCHIVE_FILES",
    "MAX_DOCUMENT_BYTES",
    "MAX_LOG_BYTES",
    "MAX_READ_BYTES",
    "REQUIRED_ARCHIVE_FILES",
    "activation_history_read_script",
]
