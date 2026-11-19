#!/usr/bin/env bash
# Prepare and verify the dedicated host-ledger-v1 ext4 filesystem.
# The maintenance container must run privileged with pid:host.  Every host
# namespace path is passed verbatim; Docker Desktop path translation belongs to
# the operator that renders Compose, not this helper.
set -Eeuo pipefail

readonly SCHEMA="fullmag.host-ledger-receipt.v1"
readonly PROFILE="host-ledger-v1"
readonly IMAGE_NAME="fullmag-host-ledger-v1.ext4"
readonly IMAGE_LABEL="fullmag-host-v1"
readonly IMAGE_SIZE_BYTES=134217728
readonly MOUNT_TARGET="/host-ledger"
readonly OWNER_MARKER_NAME=".fullmag-host-ledger-owner.json"
readonly LEDGER_CHILD_NAME="ledger"

PROFILE_VALUE="${FULLMAG_HOST_LEDGER_PROFILE:-}"
PROJECT_ID="${FULLMAG_HOST_LEDGER_PROJECT_ID:-}"
STORAGE_ROOT="${FULLMAG_HOST_LEDGER_STORAGE_ROOT:-}"
BACKING_IMAGE="${FULLMAG_HOST_LEDGER_BACKING_IMAGE:-}"
MOUNT_ROOT="${FULLMAG_HOST_LEDGER_MOUNT_ROOT:-}"
LOCK_PATH="${FULLMAG_HOST_LEDGER_LOCK_PATH:-}"
OWNER_MARKER_VALUE="${FULLMAG_HOST_LEDGER_OWNER_MARKER:-}"
IMAGE_SIZE_VALUE="${FULLMAG_HOST_LEDGER_SIZE_BYTES:-${IMAGE_SIZE_BYTES}}"
MOUNT_TARGET_VALUE="${FULLMAG_HOST_LEDGER_MOUNT_TARGET:-${MOUNT_TARGET}}"
HOST_PID="${FULLMAG_HOST_LEDGER_HOST_PID:-1}"
RUNTIME_UID="${FULLMAG_HOST_LEDGER_RUNTIME_UID:-65532}"
RUNTIME_GID="${FULLMAG_HOST_LEDGER_RUNTIME_GID:-65532}"
LOCK_WAIT="${FULLMAG_HOST_LEDGER_LOCK_WAIT_SECONDS:-120}"
PUBLISH_CAPACITY="${FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY:-0}"
DOCKER_HOST_ID="${FULLMAG_DOCKER_HOST_ID:-}"
DOCKER_CPU_COUNT="${FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT:-}"
DOCKER_MEMORY_TOTAL_BYTES="${FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES:-}"

OWNER_MARKER=""
LEDGER_ROOT=""
BACKING_DIR=""
LOCK_FD=""
LOOP_DEVICE=""
FILESYSTEM_UUID=""
MOUNT_SOURCE=""
MOUNT_ACTIVE=0
CREATED_IMAGE=0
ALLOCATED_LOOP=0
MOUNTED_BY_HELPER=0
OWNER_MARKER_WRITTEN=0
SUCCESS=0

host() {
  nsenter -t "${HOST_PID}" -m -- "$@"
}

host_root_path() {
  printf '/proc/%s/root%s' "${HOST_PID}" "$1"
}

fail() {
  echo "[docker_host_ledger] $*" >&2
  exit 2
}

require_command() {
  local command_name="$1"
  command -v "${command_name}" >/dev/null 2>&1 || fail "required container command is unavailable: ${command_name}"
}

require_host_command() {
  local command_name="$1"
  host sh -c 'command -v "$1" >/dev/null 2>&1' sh "${command_name}" || fail "required host command is unavailable: ${command_name}"
}

require_uint() {
  local name="$1" value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] || fail "${name} must be an unsigned decimal integer"
}

assert_safe_path() {
  local name="$1" path="$2" cursor
  [[ "${path}" == /* ]] || fail "${name} must be absolute: ${path}"
  [[ "${path}" != //* ]] || fail "${name} must not use a double-leading slash: ${path}"
  [[ "${path}" == "/" || "${path}" != */ ]] || fail "${name} must not have a trailing slash: ${path}"
  [[ "${path}" != *$'\n'* && "${path}" != *$'\r'* ]] || fail "${name} contains a newline"
  case "${path}" in
    */../*|*/..|*/./*|*/.) fail "${name} contains a dot path component: ${path}" ;;
  esac
  cursor="${path}"
  while [[ "${cursor}" != "/" ]]; do
    if host test -L "${cursor}"; then
      fail "${name} traverses a symlink: ${cursor}"
    fi
    cursor="$(dirname -- "${cursor}")"
  done
}

validate_inputs() {
  [[ "$(id -u)" == "0" ]] || fail "maintenance helper must run as uid 0"
  require_command nsenter
  require_command flock
  require_command python3
  [[ "${PROFILE_VALUE}" == "${PROFILE}" ]] || fail "FULLMAG_HOST_LEDGER_PROFILE must be ${PROFILE}"
  [[ "${PROJECT_ID}" =~ ^[a-z0-9][a-z0-9._-]{0,79}$ ]] || fail "invalid host-ledger project id"
  require_uint FULLMAG_HOST_LEDGER_HOST_PID "${HOST_PID}"
  (( HOST_PID > 0 )) || fail "FULLMAG_HOST_LEDGER_HOST_PID must be positive"
  require_uint FULLMAG_HOST_LEDGER_RUNTIME_UID "${RUNTIME_UID}"
  require_uint FULLMAG_HOST_LEDGER_RUNTIME_GID "${RUNTIME_GID}"
  require_uint FULLMAG_HOST_LEDGER_SIZE_BYTES "${IMAGE_SIZE_VALUE}"
  require_uint FULLMAG_HOST_LEDGER_LOCK_WAIT_SECONDS "${LOCK_WAIT}"
  [[ "${PUBLISH_CAPACITY}" == "0" || "${PUBLISH_CAPACITY}" == "1" ]] || fail "FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY must be 0 or 1"
  if [[ "${PUBLISH_CAPACITY}" == "1" ]]; then
    require_command stat
    [[ "${HOST_PID}" == "1" ]] || fail "host capacity publication requires HOST_PID=1"
    require_uint FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT "${DOCKER_CPU_COUNT}"
    require_uint FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES "${DOCKER_MEMORY_TOTAL_BYTES}"
    (( DOCKER_CPU_COUNT > 0 && DOCKER_MEMORY_TOTAL_BYTES > 0 )) || fail "Docker capacity inputs must be positive"
    [[ "${DOCKER_HOST_ID}" =~ ^[0-9a-f]{64}$ ]] || fail "FULLMAG_DOCKER_HOST_ID must be the verified daemon SHA-256"
  elif [[ -n "${DOCKER_CPU_COUNT}" || -n "${DOCKER_MEMORY_TOTAL_BYTES}" ]]; then
    fail "legacy host-ledger maintenance must not receive Docker capacity inputs"
  fi
  [[ "${IMAGE_SIZE_VALUE}" == "${IMAGE_SIZE_BYTES}" ]] || fail "host ledger image size must be exactly ${IMAGE_SIZE_BYTES} bytes"
  assert_safe_path FULLMAG_HOST_LEDGER_STORAGE_ROOT "${STORAGE_ROOT}"
  [[ "${STORAGE_ROOT}" != "/" ]] || fail "host ledger storage root cannot be filesystem root"
  local expected_image="${STORAGE_ROOT}/build-volumes/${IMAGE_NAME}"
  local expected_mount="/mnt/fullmag-host-ledger-${PROJECT_ID}"
  local expected_lock="${expected_image}.lock"
  local expected_marker="${expected_mount}/${OWNER_MARKER_NAME}"
  local expected_ledger="${expected_mount}/${LEDGER_CHILD_NAME}"
  if [[ -n "${BACKING_IMAGE}" && "${BACKING_IMAGE}" != "${expected_image}" ]]; then
    fail "FULLMAG_HOST_LEDGER_BACKING_IMAGE is not the resolved canonical image"
  fi
  if [[ -n "${MOUNT_ROOT}" && "${MOUNT_ROOT}" != "${expected_mount}" ]]; then
    fail "FULLMAG_HOST_LEDGER_MOUNT_ROOT is not the project-scoped mount"
  fi
  if [[ -n "${LOCK_PATH}" && "${LOCK_PATH}" != "${expected_lock}" ]]; then
    fail "FULLMAG_HOST_LEDGER_LOCK_PATH is not the image lock"
  fi
  if [[ -n "${OWNER_MARKER_VALUE}" && "${OWNER_MARKER_VALUE}" != "${expected_marker}" ]]; then
    fail "FULLMAG_HOST_LEDGER_OWNER_MARKER is not the project owner marker"
  fi
  if [[ -n "${FULLMAG_HOST_LEDGER_LEDGER_ROOT:-}" && "${FULLMAG_HOST_LEDGER_LEDGER_ROOT}" != "${expected_ledger}" ]]; then
    fail "FULLMAG_HOST_LEDGER_LEDGER_ROOT is not the project ledger child"
  fi
  [[ "${MOUNT_TARGET_VALUE}" == "${MOUNT_TARGET}" ]] || fail "host-ledger mount target is fixed at ${MOUNT_TARGET}"
  BACKING_IMAGE="${expected_image}"
  MOUNT_ROOT="${expected_mount}"
  LOCK_PATH="${expected_lock}"
  BACKING_DIR="$(dirname -- "${BACKING_IMAGE}")"
  OWNER_MARKER="${MOUNT_ROOT}/${OWNER_MARKER_NAME}"
  LEDGER_ROOT="${MOUNT_ROOT}/${LEDGER_CHILD_NAME}"
  assert_safe_path FULLMAG_HOST_LEDGER_BACKING_IMAGE "${BACKING_IMAGE}"
  assert_safe_path FULLMAG_HOST_LEDGER_MOUNT_ROOT "${MOUNT_ROOT}"
  assert_safe_path FULLMAG_HOST_LEDGER_LOCK_PATH "${LOCK_PATH}"
  host test "$(host id -u)" = "0" || fail "host mount namespace is not controlled by uid 0"
  for command_name in cat chmod chown find findmnt flock losetup mount mkfs.ext4 blkid mkdir mv rm stat test truncate umount; do
    require_host_command "${command_name}"
  done
}

validate_storage_marker() {
  host test -d "${STORAGE_ROOT}" || fail "resolved storage root is not a host directory: ${STORAGE_ROOT}"
  host test ! -L "${STORAGE_ROOT}" || fail "resolved storage root is a symlink"
  local marker="${STORAGE_ROOT}/.fullmag-storage.json"
  host test -f "${marker}" || fail "resolved storage marker is missing: ${marker}"
  host test ! -L "${marker}" || fail "resolved storage marker is a symlink"
  python3 -c 'import json, os, stat, sys
path = sys.argv[1]
st = os.lstat(path)
if not stat.S_ISREG(st.st_mode) or st.st_size <= 0 or st.st_size > 16384:
    raise SystemExit("storage marker is not a bounded regular file")
with open(path, "rb") as stream:
    data = json.loads(stream.read().decode("utf-8"))
if set(data) != {"schema", "project_root"} or data.get("schema") != "fullmag_storage_v1":
    raise SystemExit("storage marker schema mismatch")
project_root = data.get("project_root")
if not isinstance(project_root, str) or not project_root or "\x00" in project_root:
    raise SystemExit("storage marker project_root is invalid")
normalized = project_root.replace("\\", "/")
if not (normalized.startswith("/") or (len(normalized) >= 3 and normalized[0].isalpha() and normalized[1:3] == ":/")):
    raise SystemExit("storage marker project_root is not absolute")
if any(part in {".", ".."} for part in normalized.split("/")):
    raise SystemExit("storage marker project_root contains traversal")
if normalized.startswith("//"):
    raise SystemExit("storage marker project_root must not be UNC")
' "$(host_root_path "${marker}")" || fail "resolved storage marker is invalid"
}

read_mount_state() {
  local line="" findmnt_status=0
  MOUNT_ACTIVE=0
  MOUNT_SOURCE=""
  LOOP_DEVICE=""
  FILESYSTEM_UUID=""
  if line="$(host findmnt -rn --mountpoint "${MOUNT_ROOT}" -o SOURCE,FSTYPE,UUID 2>/dev/null)"; then
    :
  else
    findmnt_status=$?
    [[ "${findmnt_status}" == "1" ]] || fail "cannot inspect host-ledger mount state (findmnt exit ${findmnt_status})"
    line=""
  fi
  [[ -z "${line}" ]] && return 0
  [[ "${line}" != *$'\n'* ]] || fail "host-ledger mount state returned multiple records"
  local source="" filesystem="" uuid="" extra=""
  read -r source filesystem uuid extra < <(printf '%s\n' "${line}")
  [[ -n "${source}" && -n "${filesystem}" && -n "${uuid}" && -z "${extra}" ]] || fail "mount record for ${MOUNT_ROOT} is malformed"
  MOUNT_ACTIVE=1
  MOUNT_SOURCE="${source}"
  [[ "${filesystem}" == "ext4" ]] || fail "host ledger mount is not ext4: ${filesystem}"
  [[ "${source}" =~ ^/dev/loop[0-9]+$ ]] || fail "host ledger mount is not a loop device: ${source}"
  [[ "${uuid}" =~ ^[0-9A-Fa-f-]{36}$ ]] || fail "host ledger mount has no filesystem UUID"
  LOOP_DEVICE="${source}"
  FILESYSTEM_UUID="${uuid}"
}

verify_image_file() {
  host test -f "${BACKING_IMAGE}" || fail "host ledger backing image is missing: ${BACKING_IMAGE}"
  host test ! -L "${BACKING_IMAGE}" || fail "host ledger backing image is a symlink"
  local size
  size="$(host stat -c '%s' "${BACKING_IMAGE}")" || fail "cannot stat host ledger backing image"
  [[ "${size}" == "${IMAGE_SIZE_BYTES}" ]] || fail "existing host ledger image has wrong size: ${size}"
}

verify_loop_identity() {
  [[ "${MOUNT_ACTIVE}" == "1" ]] || fail "host ledger is not mounted at ${MOUNT_ROOT}"
  local backing observed_uuid observed_label sysfs_path loop_name
  loop_name="${LOOP_DEVICE#/dev/}"
  backing="$(host cat "/sys/block/${loop_name}/loop/backing_file" 2>/dev/null || true)"
  [[ "${backing}" == "${BACKING_IMAGE}" ]] || fail "loop backing mismatch: expected ${BACKING_IMAGE}, observed ${backing:-missing}"
  sysfs_path="/sys/block/${loop_name}/loop/backing_file"
  host test -f "${sysfs_path}" || fail "loop backing sysfs evidence is missing: ${sysfs_path}"
  observed_uuid="$(host blkid -s UUID -o value "${MOUNT_SOURCE}" 2>/dev/null || true)"
  [[ "${observed_uuid}" == "${FILESYSTEM_UUID}" ]] || fail "loop filesystem UUID changed during verification"
  observed_label="$(host blkid -s LABEL -o value "${MOUNT_SOURCE}" 2>/dev/null || true)"
  [[ "${observed_label}" == "${IMAGE_LABEL}" ]] || fail "host ledger filesystem label mismatch"
}

verify_owner_marker() {
  host test -f "${OWNER_MARKER}" || fail "host-ledger owner marker is missing"
  host test ! -L "${OWNER_MARKER}" || fail "host-ledger owner marker is a symlink"
  python3 -c 'import json, os, re, stat, sys, uuid
path, profile, project, image, mount, fs_uuid, size, target, uid, gid = sys.argv[1:]
st = os.lstat(path)
if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_gid != 0 or stat.S_IMODE(st.st_mode) != 0o444:
    raise SystemExit("owner marker ownership or mode mismatch")
if st.st_size <= 0 or st.st_size > 16384:
    raise SystemExit("owner marker is not bounded")
with open(path, "rb") as stream:
    value = json.loads(stream.read().decode("utf-8"))
expected = {"schema", "profile", "project_id", "backing_image", "mount_root", "filesystem_uuid", "image_size_bytes", "mount_target", "runtime_uid", "runtime_gid", "owner_token"}
if set(value) != expected:
    raise SystemExit("owner marker schema mismatch")
checks = {
    "schema": "fullmag.host-ledger-owner.v1", "profile": profile,
    "project_id": project, "backing_image": image, "mount_root": mount,
    "filesystem_uuid": fs_uuid, "image_size_bytes": int(size),
    "mount_target": target, "runtime_uid": int(uid), "runtime_gid": int(gid),
}
for key, expected_value in checks.items():
    if value.get(key) != expected_value:
        raise SystemExit("owner marker identity mismatch: " + key)
try:
    token = uuid.UUID(value["owner_token"])
except (ValueError, TypeError, AttributeError):
    raise SystemExit("owner marker token is invalid")
if str(token) != value["owner_token"] or token.int == 0:
    raise SystemExit("owner marker token is not canonical")
' "$(host_root_path "${OWNER_MARKER}")" "${PROFILE}" "${PROJECT_ID}" "${BACKING_IMAGE}" "${MOUNT_ROOT}" "${FILESYSTEM_UUID}" "${IMAGE_SIZE_BYTES}" "${MOUNT_TARGET}" "${RUNTIME_UID}" "${RUNTIME_GID}" || fail "host-ledger owner marker is invalid"
}

verify_runtime_directory() {
  local record="" uid="" gid="" mode=""
  record="$(host stat -Lc '%u %g %a' "${MOUNT_ROOT}")" || fail "cannot stat host-ledger mount root"
  read -r uid gid mode < <(printf '%s\n' "${record}")
  [[ "${uid}" == "0" && "${gid}" == "0" && "${mode}" == "755" ]] || fail "host-ledger mount root ownership/mode mismatch"
  host test -d "${LEDGER_ROOT}" || fail "host-ledger runtime child is missing"
  host test ! -L "${LEDGER_ROOT}" || fail "host-ledger runtime child is a symlink"
  record="$(host stat -Lc '%u %g %a' "${LEDGER_ROOT}")" || fail "cannot stat host-ledger runtime child"
  read -r uid gid mode < <(printf '%s\n' "${record}")
  [[ "${uid}" == "${RUNTIME_UID}" && "${gid}" == "${RUNTIME_GID}" && "${mode}" == "770" ]] || fail "host-ledger runtime child ownership/mode mismatch"
}

inspect_unmounted_mount_root() {
  if host test -e "${MOUNT_ROOT}" || host test -L "${MOUNT_ROOT}"; then
    host test -d "${MOUNT_ROOT}" || fail "unmounted host-ledger target is not a directory"
    host test ! -L "${MOUNT_ROOT}" || fail "unmounted host-ledger target is a symlink"
    local entries entry
    if ! entries="$(host find "${MOUNT_ROOT}" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null)"; then
      fail "cannot inspect unmounted host-ledger target"
    fi
    while IFS= read -r entry; do
      [[ -z "${entry}" || "${entry}" == "lost+found" ]] || fail "unmounted host-ledger target is not empty: ${entry}"
    done < <(printf '%s\n' "${entries}")
  fi
  if host test -e "${OWNER_MARKER}" || host test -L "${OWNER_MARKER}"; then
    fail "unmounted host-ledger target has a stale owner marker"
  fi
}

inspect_recovery_mount_root() {
  host test -d "${MOUNT_ROOT}" || fail "mounted host-ledger target is not a directory"
  host test ! -L "${MOUNT_ROOT}" || fail "mounted host-ledger target is a symlink"
  local unexpected
  if ! unexpected="$(host find "${MOUNT_ROOT}" -mindepth 1 -maxdepth 1 \
      ! -name 'lost+found' ! -name "${LEDGER_CHILD_NAME}" -printf x -quit 2>/dev/null)"; then
    fail "cannot inspect mounted host-ledger target for recovery"
  fi
  [[ -z "${unexpected}" ]] || fail "mounted host-ledger target contains an unexpected entry"

  local child nested
  for child in "${MOUNT_ROOT}/lost+found" "${LEDGER_ROOT}"; do
    host test -d "${child}" || fail "mounted host-ledger recovery child is missing: ${child}"
    host test ! -L "${child}" || fail "mounted host-ledger recovery child is a symlink: ${child}"
    if ! nested="$(host find "${child}" -mindepth 1 -maxdepth 1 -printf x -quit 2>/dev/null)"; then
      fail "cannot inspect mounted host-ledger recovery child: ${child}"
    fi
    [[ -z "${nested}" ]] || fail "mounted host-ledger recovery child is not empty: ${child}"
  done
}

admit_existing_mount() {
  # These identity checks must precede any attempt to adopt a mount without an
  # owner marker.  They bind the recovery decision to the expected image,
  # loop device, filesystem UUID, and label.
  verify_image_file
  read_mount_state
  verify_loop_identity
  if host test -e "${OWNER_MARKER}" || host test -L "${OWNER_MARKER}"; then
    # An existing marker is never replaced.  Invalid or foreign markers fail
    # through the normal attestation path.
    verify_owner_marker
    verify_runtime_directory
    return 0
  fi
  inspect_recovery_mount_root
  write_owner_marker
  set_runtime_ownership
  verify_current_mount
}

acquire_lock() {
  local mode="$1"
  if [[ "${mode}" == "exclusive" ]]; then
    host mkdir -p "${BACKING_DIR}" || fail "cannot create host-ledger backing directory"
  else
    host test -e "${LOCK_PATH}" || fail "host-ledger lock is missing"
  fi
  host test ! -L "${LOCK_PATH}" || fail "host-ledger lock is a symlink"
  # The storage root is bind-mounted at the same absolute path in the helper;
  # locking this inode coordinates all maintenance containers on this host.
  exec {LOCK_FD}>"$(host_root_path "${LOCK_PATH}")" || fail "cannot open host-ledger lock"
  if [[ "${mode}" == "exclusive" ]]; then
    flock -x -w "${LOCK_WAIT}" "${LOCK_FD}" || fail "timed out waiting for host-ledger lock"
  else
    flock -s -w "${LOCK_WAIT}" "${LOCK_FD}" || fail "timed out waiting for host-ledger read lock"
  fi
}

create_backing_image_if_needed() {
  if host test -e "${BACKING_IMAGE}" || host test -L "${BACKING_IMAGE}"; then
    verify_image_file
    return 0
  fi
  host mkdir -p "${BACKING_DIR}" || fail "cannot create host-ledger backing directory"
  host test ! -L "${BACKING_DIR}" || fail "host-ledger backing directory is a symlink"
  host truncate -s "${IMAGE_SIZE_BYTES}" "${BACKING_IMAGE}" || fail "cannot create host-ledger image"
  CREATED_IMAGE=1
  host chmod 0600 "${BACKING_IMAGE}" || fail "cannot protect newly created host-ledger image"
  # Formatting is allowed only for the file created above. Existing bytes are
  # never reformatted, even when their filesystem identity is wrong.
  host mkfs.ext4 -F -L "${IMAGE_LABEL}" "${BACKING_IMAGE}" >/dev/null || fail "cannot format newly created host-ledger image"
  verify_image_file
}

reject_associated_loop() {
  local associated="" losetup_status=0
  if associated="$(host losetup --associated "${BACKING_IMAGE}" 2>/dev/null)"; then
    :
  else
    losetup_status=$?
    [[ "${losetup_status}" == "1" ]] || fail "cannot inspect existing host-ledger loop associations (losetup exit ${losetup_status})"
    associated=""
  fi
  [[ -z "${associated}" ]] || fail "backing image already has an unattached-to-mount loop; refusing takeover: ${associated}"
}

allocate_and_mount() {
  reject_associated_loop
  host mkdir -p "${MOUNT_ROOT}" || fail "cannot create host-ledger mount root"
  inspect_unmounted_mount_root
  LOOP_DEVICE="$(host losetup --find --show "${BACKING_IMAGE}")" || fail "cannot allocate a loop device for host ledger"
  [[ "${LOOP_DEVICE}" =~ ^/dev/loop[0-9]+$ ]] || fail "losetup returned an invalid loop device: ${LOOP_DEVICE}"
  ALLOCATED_LOOP=1
  local loop_name="${LOOP_DEVICE#/dev/}"
  local observed
  observed="$(host cat "/sys/block/${loop_name}/loop/backing_file" 2>/dev/null || true)"
  [[ "${observed}" == "${BACKING_IMAGE}" ]] || fail "new loop backing evidence does not match host-ledger image"
  # Mark the attempt before invoking mount so a partial host mount is never
  # mistaken for an unowned loop during failure cleanup.
  MOUNTED_BY_HELPER=1
  if host mount -t ext4 -o rw "${LOOP_DEVICE}" "${MOUNT_ROOT}"; then
    :
  else
    if read_mount_state && [[ "${MOUNT_ACTIVE}" == "0" ]]; then
      MOUNTED_BY_HELPER=0
    fi
    fail "cannot mount host-ledger ext4 image"
  fi
  read_mount_state
  verify_image_file
  verify_loop_identity
  host mkdir -p "${LEDGER_ROOT}" || fail "cannot create host-ledger runtime child"
  host test ! -L "${LEDGER_ROOT}" || fail "host-ledger runtime child is a symlink"
}

write_owner_marker() {
  OWNER_TOKEN="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  [[ "${OWNER_TOKEN}" =~ ^[0-9a-f-]{36}$ ]] || fail "cannot generate owner token"
  local payload temporary
  payload="$(python3 -c 'import json, sys
profile, project, image, mount, fs_uuid, size, target, uid, gid, token = sys.argv[1:]
print(json.dumps({
    "schema": "fullmag.host-ledger-owner.v1", "profile": profile,
    "project_id": project, "backing_image": image, "mount_root": mount,
    "filesystem_uuid": fs_uuid, "image_size_bytes": int(size),
    "mount_target": target, "runtime_uid": int(uid), "runtime_gid": int(gid),
    "owner_token": token,
}, separators=(",", ":")))
' "${PROFILE}" "${PROJECT_ID}" "${BACKING_IMAGE}" "${MOUNT_ROOT}" "${FILESYSTEM_UUID}" "${IMAGE_SIZE_BYTES}" "${MOUNT_TARGET}" "${RUNTIME_UID}" "${RUNTIME_GID}" "${OWNER_TOKEN}")"
  temporary="${OWNER_MARKER}.tmp.$$.${RANDOM}"
  python3 -c 'import os, sys
path, temporary, payload = sys.argv[1:]
if os.path.lexists(path):
    raise SystemExit("owner marker already exists")
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
try:
    os.write(fd, (payload + "\n").encode("utf-8"))
    os.fsync(fd)
finally:
    os.close(fd)
os.chown(temporary, 0, 0)
os.chmod(temporary, 0o444)
try:
    os.link(temporary, path, follow_symlinks=False)
    os.unlink(temporary)
except BaseException:
    try:
        os.unlink(temporary)
    except OSError:
        pass
    raise
' "$(host_root_path "${OWNER_MARKER}")" "$(host_root_path "${temporary}")" "${payload}" || fail "cannot publish host-ledger owner marker"
  OWNER_MARKER_WRITTEN=1
}

set_runtime_ownership() {
  host chown 0:0 "${MOUNT_ROOT}" || fail "cannot set host-ledger mount root owner"
  host chmod 0755 "${MOUNT_ROOT}" || fail "cannot set host-ledger mount root mode"
  host chown "${RUNTIME_UID}:${RUNTIME_GID}" "${LEDGER_ROOT}" || fail "cannot set host-ledger runtime child owner"
  host chmod 0770 "${LEDGER_ROOT}" || fail "cannot set host-ledger runtime child mode"
}

verify_current_mount() {
  verify_image_file
  read_mount_state
  verify_loop_identity
  verify_owner_marker
  verify_runtime_directory
}

emit_receipt() {
  local state="$1" created="$2"
  python3 -c 'import json, sys
state, created, active, loop, fs_uuid, profile, project, image, mount, target, size = sys.argv[1:]
print(json.dumps({
    "schema": "fullmag.host-ledger-receipt.v1", "profile": profile,
    "project_id": project, "backing_image": image, "mount_root": mount,
    "ledger_root": mount + "/ledger",
    "mount_target": target, "filesystem": "ext4", "filesystem_uuid": fs_uuid or None,
    "image_size_bytes": int(size), "loop_device": loop or None,
    "mount_active": active == "1", "state": state, "created_image": created == "1",
    "qualification": "storage-admission-only",
}, sort_keys=True))
  ' "${state}" "${created}" "${MOUNT_ACTIVE}" "${LOOP_DEVICE}" "${FILESYSTEM_UUID}" "${PROFILE}" "${PROJECT_ID}" "${BACKING_IMAGE}" "${MOUNT_ROOT}" "${MOUNT_TARGET}" "${IMAGE_SIZE_BYTES}"
}

publish_capacity() {
  [[ "${PUBLISH_CAPACITY}" == "1" ]] || return 0
  local cgroup_fs_type
  cgroup_fs_type="$(stat -f -c %T "/proc/${HOST_PID}/root/sys/fs/cgroup" 2>/dev/null)" \
    || fail "cannot inspect host PID 1 cgroup filesystem"
  [[ "${cgroup_fs_type}" == "cgroup2fs" ]] || fail "host capacity publication requires unified cgroup v2"

  python3 - "${HOST_PID}" "${PROJECT_ID}" "${DOCKER_HOST_ID}" \
    "${DOCKER_CPU_COUNT}" "${DOCKER_MEMORY_TOTAL_BYTES}" "${MOUNT_ROOT}" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

pid, project_id, daemon_sha, docker_cpu, docker_memory, mount_root = sys.argv[1:]
if pid != "1" or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", project_id):
    raise SystemExit("[docker_host_ledger] host capacity identity is invalid")
if not re.fullmatch(r"[0-9a-f]{64}", daemon_sha):
    raise SystemExit("[docker_host_ledger] Docker daemon identity is invalid")

def positive_decimal(value, label):
    if not re.fullmatch(r"[0-9]+", value) or not 0 < int(value) <= 2**64 - 1:
        raise SystemExit(f"[docker_host_ledger] {label} is not a positive integer")
    return int(value)

docker_cpu_count = positive_decimal(docker_cpu, "Docker CPU count")
docker_memory_total_bytes = positive_decimal(docker_memory, "Docker memory total")
proc_root = Path("/proc") / pid / "root"
try:
    cgroup_lines = (Path("/proc") / pid / "cgroup").read_text(encoding="ascii").splitlines()
except OSError as error:
    raise SystemExit("[docker_host_ledger] cannot read host PID 1 cgroup identity") from error
if len(cgroup_lines) != 1 or not re.fullmatch(r"0::/[^\r\n]*", cgroup_lines[0]):
    raise SystemExit("[docker_host_ledger] host PID 1 has no unified cgroup v2 membership")

if os.readlink("/proc/self/ns/cgroup") != os.readlink("/proc/1/ns/cgroup"):
    raise SystemExit("[docker_host_ledger] capacity helper is outside the host cgroup namespace")

# PID 1 may legitimately be in /init.scope. Prove the mounted hierarchy root
# rather than confusing the init process's own membership with that root.
# Docker Desktop on WSL2 runs its init in a nested cgroup namespace: the mount
# root is then reported relative to that namespace as "/.." segments, and the
# distribution adds a second cgroup2 mount under /parent-distro.  Select the
# single /sys/fs/cgroup mount and prove the root by its content instead.
mount_lines = (Path("/proc") / pid / "mountinfo").read_text(encoding="ascii").splitlines()
cgroup_mounts = []
for line in mount_lines:
    before, separator, after = line.partition(" - ")
    fields, filesystem = before.split(), after.split()
    if (separator and filesystem and filesystem[0] == "cgroup2"
            and len(fields) >= 6 and fields[4] == "/sys/fs/cgroup"):
        cgroup_mounts.append(fields)
if (len(cgroup_mounts) != 1
        or not re.fullmatch(r"/(?:\.\.(?:/\.\.)*)?", cgroup_mounts[0][3])):
    raise SystemExit("[docker_host_ledger] host cgroup mount does not expose the hierarchy root")

cgroup_root = proc_root / "sys/fs/cgroup"
# Every non-root cgroup v2 directory has cgroup.type; only the true hierarchy
# root lacks it.  This holds whatever depth the namespace-relative path hides.
try:
    (cgroup_root / "cgroup.controllers").read_text(encoding="ascii")
except OSError as error:
    raise SystemExit("[docker_host_ledger] host cgroup root is not readable") from error
if (cgroup_root / "cgroup.type").exists():
    raise SystemExit("[docker_host_ledger] host cgroup mount does not expose the hierarchy root")
# The true cgroup v2 root is exempt from cpu.max and memory.max.
# Only ENOENT after proving the host root has that meaning; other errors fail.
def root_limit(name):
    try:
        return (cgroup_root / name).read_text(encoding="ascii").strip()
    except FileNotFoundError:
        return None

try:
    cpu_max_text = root_limit("cpu.max")
    cpu_max_fields = cpu_max_text.split() if cpu_max_text is not None else None
    cpuset_text = (cgroup_root / "cpuset.cpus.effective").read_text(encoding="ascii").strip()
    memory_max_text = root_limit("memory.max")
    meminfo = (proc_root / "proc/meminfo").read_text(encoding="ascii").splitlines()
    boot_id = (proc_root / "proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
except OSError as error:
    raise SystemExit("[docker_host_ledger] host root capacity probe is incomplete") from error

if cpu_max_fields is None:
    quota_micros = period_micros = None
else:
    if len(cpu_max_fields) != 2 or not re.fullmatch(r"[0-9]+", cpu_max_fields[1]):
        raise SystemExit("[docker_host_ledger] host cpu.max is malformed")
    period_micros = positive_decimal(cpu_max_fields[1], "host CPU period")
    if cpu_max_fields[0] == "max":
        quota_micros = None
    else:
        quota_micros = positive_decimal(cpu_max_fields[0], "host CPU quota")

cpu_ids = set()
if not cpuset_text:
    raise SystemExit("[docker_host_ledger] host cpuset.cpus.effective is empty")
for item in cpuset_text.split(","):
    match = re.fullmatch(r"([0-9]+)(?:-([0-9]+))?", item)
    if not match:
        raise SystemExit("[docker_host_ledger] host cpuset.cpus.effective is malformed")
    first, last = int(match.group(1)), int(match.group(2) or match.group(1))
    if last < first or last > 2**32 - 1 or last - first + 1 > docker_cpu_count:
        raise SystemExit("[docker_host_ledger] host cpuset range exceeds Docker capacity")
    values = set(range(first, last + 1))
    if cpu_ids & values:
        raise SystemExit("[docker_host_ledger] host cpuset contains duplicate CPU IDs")
    cpu_ids.update(values)
if not cpu_ids or len(cpu_ids) > docker_cpu_count:
    raise SystemExit("[docker_host_ledger] host cpuset exceeds Docker CPU capacity")

if memory_max_text is None or memory_max_text == "max":
    memory_max_bytes = None
elif re.fullmatch(r"[0-9]+", memory_max_text):
    memory_max_bytes = positive_decimal(memory_max_text, "host memory maximum")
else:
    raise SystemExit("[docker_host_ledger] host memory.max is invalid")
mem_total_values = []
for line in meminfo:
    match = re.fullmatch(r"MemTotal:\s+([0-9]+)\s+kB\s*", line)
    if match:
        mem_total_values.append(int(match.group(1)) * 1024)
if len(mem_total_values) != 1 or not 0 < mem_total_values[0] <= 2**64 - 1:
    raise SystemExit("[docker_host_ledger] host MemTotal is missing or invalid")
if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", boot_id):
    raise SystemExit("[docker_host_ledger] host boot ID is invalid")

descriptor = {
    "schema": "fullmag.docker-host-capacity.v1",
    "scope": "docker_vm_root",
    "project_id": project_id,
    "daemon_id_sha256": daemon_sha,
    "boot_id": boot_id,
    "allowed_cpu_ids": sorted(cpu_ids),
    "cpu_max": {"quota_micros": quota_micros, "period_micros": period_micros},
    "memory_max_bytes": memory_max_bytes,
    "kernel_memory_total_bytes": mem_total_values[0],
    "docker_cpu_count": docker_cpu_count,
    "docker_memory_total_bytes": docker_memory_total_bytes,
}
payload = (json.dumps(descriptor, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
descriptor_sha = hashlib.sha256(payload).hexdigest()
requested_mount = Path(mount_root)
if not requested_mount.is_absolute() or ".." in requested_mount.parts:
    raise SystemExit("[docker_host_ledger] host-ledger mount root is unsafe")
# The ledger image is mounted in the host mount namespace (nsenter). This
# helper's own bind of the mount root predates a first mount and would show
# the shadowed directory, so publish through the host's view of the path.
mount = proc_root / requested_mount.relative_to("/")
if (mount.is_symlink() or not mount.is_dir() or not os.path.ismount(mount)
        or mount.lstat().st_uid != 0 or mount.lstat().st_mode & 0o022):
    raise SystemExit("[docker_host_ledger] host-ledger mount root is unsafe or not mounted")
capacity_dir = mount / "capacity"
created_dir = False
try:
    os.mkdir(capacity_dir, 0o755)
    created_dir = True
except FileExistsError:
    pass
directory_stat = capacity_dir.lstat()
if not stat.S_ISDIR(directory_stat.st_mode) or stat.S_ISLNK(directory_stat.st_mode):
    raise SystemExit("[docker_host_ledger] capacity descriptor path is not a real directory")
if created_dir:
    os.chown(capacity_dir, 0, 0)
    os.chmod(capacity_dir, 0o755)
    directory_stat = capacity_dir.lstat()
if (directory_stat.st_uid != 0 or directory_stat.st_gid != 0
        or stat.S_IMODE(directory_stat.st_mode) != 0o755):
    raise SystemExit("[docker_host_ledger] capacity directory owner/mode differs from root:root 0755")

descriptor_path = capacity_dir / f"{descriptor_sha}.json"
# Publish only complete, fsynced bytes. A killed writer can leave an owned
# temporary file, never a partial immutable CAS descriptor.
fd, temporary = tempfile.mkstemp(prefix=".capacity-", dir=capacity_dir)
try:
    os.fchown(fd, 0, 0)
    os.fchmod(fd, 0o444)
    remaining = memoryview(payload)
    while remaining:
        written = os.write(fd, remaining)
        if written <= 0:
            raise OSError("short write")
        remaining = remaining[written:]
    os.fsync(fd)
finally:
    os.close(fd)
try:
    try:
        os.link(temporary, descriptor_path, follow_symlinks=False)
    except FileExistsError:
        existing_stat = descriptor_path.lstat()
        if (not stat.S_ISREG(existing_stat.st_mode) or stat.S_ISLNK(existing_stat.st_mode)
            or existing_stat.st_uid != 0 or existing_stat.st_gid != 0 or existing_stat.st_nlink != 1
            or stat.S_IMODE(existing_stat.st_mode) != 0o444):
            raise SystemExit("[docker_host_ledger] existing capacity descriptor metadata differs")
        read_fd = os.open(descriptor_path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened_stat = os.fstat(read_fd)
            if (opened_stat.st_dev, opened_stat.st_ino) != (existing_stat.st_dev, existing_stat.st_ino):
                raise SystemExit("[docker_host_ledger] capacity descriptor changed while being opened")
            chunks, remaining = [], len(payload) + 1
            while remaining:
                chunk = os.read(read_fd, min(remaining, 65536))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            if b"".join(chunks) != payload:
                raise SystemExit("[docker_host_ledger] existing capacity descriptor bytes differ")
        finally:
            os.close(read_fd)
finally:
    os.unlink(temporary)
directory_fd = os.open(capacity_dir, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)

if created_dir:
    mount_fd = os.open(mount, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(mount_fd)
    finally:
        os.close(mount_fd)

publication = {
    "schema": "fullmag.docker-host-capacity-publication.v1",
    "descriptor_sha256": descriptor_sha,
    "descriptor_path": f"/host-ledger/capacity/{descriptor_sha}.json",
    "descriptor": descriptor,
    "project_id": project_id,
    "daemon_id_sha256": daemon_sha,
}
print(json.dumps(publication, sort_keys=True))
PY
}

cleanup() {
  local status=$?
  set +e
  [[ "${SUCCESS}" == "1" ]] && return "${status}"
  local cleanup_failed=0 owner_safe=1 unmounted=0
  if [[ "${OWNER_MARKER_WRITTEN}" == "1" ]]; then
    python3 -c 'import json, os, sys
path, token, profile, project, image, mount, fs_uuid, size, target, uid, gid = sys.argv[1:]
try:
    with open(path, "rb") as stream:
        value = json.loads(stream.read().decode("utf-8"))
except (OSError, ValueError, UnicodeError):
    raise SystemExit(2)
expected = {"schema", "profile", "project_id", "backing_image", "mount_root", "filesystem_uuid", "image_size_bytes", "mount_target", "runtime_uid", "runtime_gid", "owner_token"}
if set(value) != expected or value.get("schema") != "fullmag.host-ledger-owner.v1":
    raise SystemExit(3)
checks = {
    "profile": profile, "project_id": project, "backing_image": image,
    "mount_root": mount, "filesystem_uuid": fs_uuid, "image_size_bytes": int(size),
    "mount_target": target, "runtime_uid": int(uid), "runtime_gid": int(gid),
    "owner_token": token,
}
if any(value.get(key) != expected_value for key, expected_value in checks.items()):
    raise SystemExit(4)
os.unlink(path)
' "$(host_root_path "${OWNER_MARKER}")" "${OWNER_TOKEN:-}" "${PROFILE}" "${PROJECT_ID}" "${BACKING_IMAGE}" "${MOUNT_ROOT}" "${FILESYSTEM_UUID}" "${IMAGE_SIZE_BYTES}" "${MOUNT_TARGET}" "${RUNTIME_UID}" "${RUNTIME_GID}" || { cleanup_failed=1; owner_safe=0; }
  fi
  if [[ "${MOUNTED_BY_HELPER}" == "1" && -n "${LOOP_DEVICE}" && "${owner_safe}" == "1" ]]; then
    local current_source
    current_source="$(host findmnt -rn --mountpoint "${MOUNT_ROOT}" -o SOURCE 2>/dev/null || true)"
    if [[ "${current_source}" == "${LOOP_DEVICE}" ]]; then
      if host umount "${MOUNT_ROOT}"; then
        unmounted=1
      else
        cleanup_failed=1
      fi
    else
      cleanup_failed=1
    fi
  fi
  if [[ "${ALLOCATED_LOOP}" == "1" && -n "${LOOP_DEVICE}" && "${owner_safe}" == "1" && ( "${MOUNTED_BY_HELPER}" != "1" || "${unmounted}" == "1" ) ]]; then
    local current_backing loop_name
    loop_name="${LOOP_DEVICE#/dev/}"
    current_backing="$(host cat "/sys/block/${loop_name}/loop/backing_file" 2>/dev/null || true)"
    if [[ -z "${current_backing}" || "${current_backing}" == "${BACKING_IMAGE}" ]]; then
      if [[ -n "${current_backing}" ]]; then
        host losetup --detach "${LOOP_DEVICE}" || cleanup_failed=1
      fi
      local detached=0
      for _ in $(seq 1 30); do
        if ! host test -e "/sys/block/${loop_name}/loop/backing_file" || [[ -z "$(host cat "/sys/block/${loop_name}/loop/backing_file" 2>/dev/null || true)" ]]; then
          detached=1
          break
        fi
        sleep 0.1
      done
      [[ "${detached}" == "1" ]] || cleanup_failed=1
    else
      cleanup_failed=1
    fi
  fi
  if [[ "${CREATED_IMAGE}" == "1" && "${cleanup_failed}" == "0" ]]; then
    host rm -f -- "${BACKING_IMAGE}" || cleanup_failed=1
  fi
  if [[ "${cleanup_failed}" != "0" ]]; then
    echo "[docker_host_ledger] failure cleanup was incomplete; owned mount/loop was not assumed safe to remove" >&2
    return 1
  fi
  return "${status}"
}
trap cleanup EXIT

main() {
  local action="${1:-}"
  case "${action}" in prepare|ensure|verify) ;; *) fail "usage: $0 {prepare|ensure|verify}" ;; esac
  validate_inputs
  validate_storage_marker
  read_mount_state
  case "${action}" in
    prepare)
      if [[ "${MOUNT_ACTIVE}" == "1" ]]; then
        verify_current_mount
        emit_receipt validated 0
      else
        if host test -e "${BACKING_IMAGE}" || host test -L "${BACKING_IMAGE}"; then
          verify_image_file
          reject_associated_loop
        fi
        inspect_unmounted_mount_root
        emit_receipt configuration-valid 0
      fi
      ;;
    verify)
      acquire_lock shared
      verify_current_mount
      emit_receipt validated 0
      ;;
    ensure)
      acquire_lock exclusive
      create_backing_image_if_needed
      read_mount_state
      if [[ "${MOUNT_ACTIVE}" == "1" ]]; then
        admit_existing_mount
      else
        allocate_and_mount
        # A remounted persistent image already owns its marker. Reuse the
        # complete attestation path instead of attempting to replace it.
        admit_existing_mount
      fi
      emit_receipt ready "${CREATED_IMAGE}"
      SUCCESS=1
      publish_capacity
      ;;
  esac
}
main "$@"
