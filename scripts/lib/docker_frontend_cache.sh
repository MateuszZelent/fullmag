#!/usr/bin/env bash
# Dedicated frontend-cache-v1 ext4 maintenance helper; it does not use host ledger code.
set -Eeuo pipefail
PROFILE="fullmag-frontend-cache-v1"
OWNER_SCHEMA="fullmag.frontend-cache-owner.v1"
IMAGE_LABEL="fm-fe-cache-v1"
IMAGE_SIZE_BYTES=8589934592
MOUNT_TARGET="/fullmag-frontend-cache"
RUNTIME_LOCK=""
PROFILE_VALUE="${FULLMAG_FRONTEND_CACHE_PROFILE-}"
PROJECT_ID="${FULLMAG_FRONTEND_CACHE_PROJECT_ID-}"
CACHE_KEY="${FULLMAG_FRONTEND_CACHE_KEY-}"
STORAGE_ROOT="${FULLMAG_FRONTEND_CACHE_STORAGE_ROOT-}"
BACKING_IMAGE="${FULLMAG_FRONTEND_CACHE_BACKING_IMAGE-}"
MOUNT_ROOT="${FULLMAG_FRONTEND_CACHE_MOUNT_ROOT-}"
LOCK_PATH="${FULLMAG_FRONTEND_CACHE_LOCK_PATH-}"
OWNER_MARKER_VALUE="${FULLMAG_FRONTEND_CACHE_OWNER_MARKER-}"
RUNTIME_IMAGE_ID="${FULLMAG_FRONTEND_CACHE_RUNTIME_IMAGE_ID-}"
RUNTIME_UID="${FULLMAG_FRONTEND_CACHE_UID-65532}"
RUNTIME_GID="${FULLMAG_FRONTEND_CACHE_GID-65532}"
HOST_PID="${FULLMAG_FRONTEND_CACHE_HOST_PID-1}"
SIZE_VALUE="${FULLMAG_FRONTEND_CACHE_SIZE_BYTES-$IMAGE_SIZE_BYTES}"
TARGET_VALUE="${FULLMAG_FRONTEND_CACHE_MOUNT_TARGET-$MOUNT_TARGET}"
LOCK_WAIT="${FULLMAG_FRONTEND_CACHE_LOCK_WAIT_SECONDS-120}"
MOUNT_ACTIVE=0 LOOP_DEVICE="" FILESYSTEM_UUID="" MOUNT_SOURCE="" ALLOCATED=0 MOUNTED=0 SUCCESS=0 CREATED_IMAGE=0
host() { nsenter -t "$HOST_PID" -m -- "$@"; }
fail() { echo "[docker_frontend_cache] $*" >&2; exit 2; }
require() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
safe_path() {
  local name="$1" path="$2" cursor="$2"
  [[ "$path" == /* && "$path" != //* && "$path" != */ ]] || fail "$name is not canonical absolute"
  case "$path" in */../*|*/..|*/./*|*/.) fail "$name has traversal" ;; esac
  while [[ "$cursor" != "/" ]]; do
    host test ! -L "$cursor" || fail "$name traverses symlink: $cursor"
    cursor="$(dirname -- "$cursor")"
  done
}
validate() {
  [[ "$(id -u)" == 0 ]] || fail "must run as uid 0"
  require nsenter; require flock; require python3
  [[ "$PROFILE_VALUE" == "$PROFILE" ]] || fail "profile mismatch"
  [[ "$PROJECT_ID" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || fail "unsafe project id"
  [[ "$CACHE_KEY" =~ ^[0-9a-f]{64}$ ]] || fail "cache key is not SHA-256"
  [[ "$RUNTIME_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "runtime image is not immutable"
  [[ "$HOST_PID" =~ ^[0-9]+$ && "$HOST_PID" -gt 0 ]] || fail "invalid host pid"
  [[ "$SIZE_VALUE" == "$IMAGE_SIZE_BYTES" && "$TARGET_VALUE" == "$MOUNT_TARGET" ]] || fail "fixed cache contract changed"
  safe_path storage "$STORAGE_ROOT"; [[ "$STORAGE_ROOT" != "/" ]] || fail "storage root cannot be /"
  local prefix image mount lock marker
  prefix="$(printf %.16s "$CACHE_KEY")"
  image="$STORAGE_ROOT/build-volumes/fullmag-frontend-cache-v1-$CACHE_KEY.ext4"
  mount="/mnt/fullmag-frontend-cache-$PROJECT_ID-$prefix"
  lock="$image.lock"; marker="$mount/.fullmag-frontend-cache-owner.json"
  [[ -z "$BACKING_IMAGE" || "$BACKING_IMAGE" == "$image" ]] || fail "backing image mismatch"
  [[ -z "$MOUNT_ROOT" || "$MOUNT_ROOT" == "$mount" ]] || fail "mount root mismatch"
  [[ -z "$LOCK_PATH" || "$LOCK_PATH" == "$lock" ]] || fail "lock path mismatch"
  [[ -z "$OWNER_MARKER_VALUE" || "$OWNER_MARKER_VALUE" == "$marker" ]] || fail "owner marker mismatch"
  BACKING_IMAGE="$image"; MOUNT_ROOT="$mount"; LOCK_PATH="$lock"; OWNER_MARKER="$marker"
  RUNTIME_LOCK="$MOUNT_ROOT/cache/.fullmag-frontend-runtime.lock"
  BACKING_DIR="$(dirname -- "$BACKING_IMAGE")"
  safe_path image "$BACKING_IMAGE"; safe_path mount "$MOUNT_ROOT"; safe_path lock "$LOCK_PATH"; safe_path marker "$OWNER_MARKER"
  host test "$(host id -u)" = 0 || fail "host namespace is not root"
  local c
  for c in cat chmod chown find findmnt flock losetup mount mkfs.ext4 blkid mkdir rm stat test truncate umount; do
    host sh -c 'command -v "$1" >/dev/null 2>&1' sh "$c" || fail "missing host command: $c"
  done
}
storage_marker() {
  local marker="$STORAGE_ROOT/.fullmag-storage.json"
  host test -d "$STORAGE_ROOT" && host test ! -L "$STORAGE_ROOT" || fail "storage root invalid"
  host test -f "$marker" && host test ! -L "$marker" || fail "storage marker invalid"
  python3 -c 'import json,os,stat,sys
p=sys.argv[1]; s=os.lstat(p)
if not stat.S_ISREG(s.st_mode) or s.st_size>16384: raise SystemExit("bounded regular file required")
with open(p,"rb") as f: v=json.loads(f.read().decode())
if set(v)!={"schema","project_root"} or v["schema"]!="fullmag_storage_v1": raise SystemExit("schema")
r=v["project_root"].replace("\\","/")
if not r.startswith("/") and not (len(r)>=3 and r[0].isalpha() and r[1:3]==":/"): raise SystemExit("absolute root")
if any(x in {".",".."} for x in r.split("/")): raise SystemExit("traversal")
' "/proc/$HOST_PID/root$marker" || fail "storage marker schema invalid"
}
mount_state() {
  local line="" status=0 source="" fs="" uuid="" extra=""
  MOUNT_ACTIVE=0; MOUNT_SOURCE=""; LOOP_DEVICE=""; FILESYSTEM_UUID=""
  if line="$(host findmnt -rn --mountpoint "$MOUNT_ROOT" -o SOURCE,FSTYPE,UUID 2>/dev/null)"; then :; else
    status=$?; [[ "$status" == 1 ]] || fail "findmnt failed"; line=""
  fi
  [[ -z "$line" ]] && return
  [[ "$line" != *$'\n'* ]] || fail "multiple mount records"
  read -r source fs uuid extra < <(printf '%s\n' "$line")
  [[ "$source" =~ ^/dev/loop[0-9]+$ && "$fs" == ext4 && "$uuid" =~ ^[0-9A-Fa-f-]{36}$ && -z "$extra" ]] || fail "mount identity invalid"
  MOUNT_ACTIVE=1; MOUNT_SOURCE="$source"; LOOP_DEVICE="$source"; FILESYSTEM_UUID="$uuid"
}
verify_mount() {
  [[ "$MOUNT_ACTIVE" == 1 ]] || fail "cache is not mounted"
  host test -f "$BACKING_IMAGE" && host test ! -L "$BACKING_IMAGE" || fail "image invalid"
  [[ "$(host stat -c '%s' "$BACKING_IMAGE")" == "$IMAGE_SIZE_BYTES" ]] || fail "image size invalid"
  local loop; loop="$(printf '%s' "$LOOP_DEVICE" | sed 's#^/dev/##')"
  local backing uuid label
  backing="$(host cat "/sys/block/$loop/loop/backing_file" 2>/dev/null || true)"
  [[ "$backing" == "$BACKING_IMAGE" ]] || fail "loop backing mismatch"
  uuid="$(host blkid -s UUID -o value "$MOUNT_SOURCE" 2>/dev/null || true)"
  label="$(host blkid -s LABEL -o value "$MOUNT_SOURCE" 2>/dev/null || true)"
  [[ "$uuid" == "$FILESYSTEM_UUID" && "$label" == "$IMAGE_LABEL" ]] || fail "filesystem attestation failed"
}
verify_owner() {
  host test -f "$OWNER_MARKER" && host test ! -L "$OWNER_MARKER" || fail "owner marker missing/symlink"
  python3 -c 'import json,os,stat,sys,uuid
p,profile,project,key,image,mount,fs,size,target,uid,gid=sys.argv[1:]
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o444 or s.st_size>16384: raise SystemExit("mode")
 raw=os.read(fd,16385)
finally:
 os.close(fd)
if len(raw)>16384: raise SystemExit("bounded")
v=json.loads(raw.decode())
e={"schema","profile","project_id","cache_key","backing_image","mount_root","filesystem_uuid","image_size_bytes","mount_target","runtime_uid","runtime_gid","owner_token"}
if set(v)!=e: raise SystemExit("schema")
c={"schema":"fullmag.frontend-cache-owner.v1","profile":profile,"project_id":project,"cache_key":key,"backing_image":image,"mount_root":mount,"filesystem_uuid":fs,"image_size_bytes":int(size),"mount_target":target,"runtime_uid":int(uid),"runtime_gid":int(gid)}
if any(v.get(k)!=x for k,x in c.items()): raise SystemExit("identity")
t=uuid.UUID(v["owner_token"])
if not t.int or str(t)!=v["owner_token"]: raise SystemExit("token")
' "/proc/$HOST_PID/root$OWNER_MARKER" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$FILESYSTEM_UUID" "$IMAGE_SIZE_BYTES" "$MOUNT_TARGET" "$RUNTIME_UID" "$RUNTIME_GID" || fail "owner marker invalid"
}
verify_children() {
  local rec uid gid mode child path
  rec="$(host stat -Lc '%u %g %a' "$MOUNT_ROOT")"; read -r uid gid mode < <(printf '%s\n' "$rec")
  [[ "$uid" == 0 && "$gid" == 0 && "$mode" == 755 ]] || fail "cache root ownership/mode invalid"
  for child in cache pnpm-store workspace-node_modules control-room-node_modules; do
    path="$MOUNT_ROOT/$child"; host test -d "$path" && host test ! -L "$path" || fail "cache child invalid"
    rec="$(host stat -Lc '%u %g %a' "$path")"; read -r uid gid mode < <(printf '%s\n' "$rec")
    [[ "$uid" == "$RUNTIME_UID" && "$gid" == "$RUNTIME_GID" && "$mode" == 770 ]] || fail "cache child ownership/mode invalid"
  done
}
verify_current() { mount_state; verify_mount; verify_owner; verify_children; }

write_owner_marker() {
  python3 -c 'import json,os,sys,uuid
p,profile,project,key,image,mount,fs,size,target,uid,gid=sys.argv[1:]
v={"schema":"fullmag.frontend-cache-owner.v1","profile":profile,"project_id":project,"cache_key":key,"backing_image":image,"mount_root":mount,"filesystem_uuid":fs,"image_size_bytes":int(size),"mount_target":target,"runtime_uid":int(uid),"runtime_gid":int(gid),"owner_token":str(uuid.uuid4())}
t=p+".tmp."+str(os.getpid())
if os.path.lexists(p): raise SystemExit("owner marker exists")
fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
os.write(fd,(json.dumps(v,separators=(",",":"))+"\n").encode()); os.fsync(fd); os.close(fd)
os.chown(t,0,0); os.chmod(t,0o444); os.link(t,p,follow_symlinks=False); os.unlink(t)
' "/proc/$HOST_PID/root$OWNER_MARKER" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$FILESYSTEM_UUID" "$IMAGE_SIZE_BYTES" "$MOUNT_TARGET" "$RUNTIME_UID" "$RUNTIME_GID" || fail "cannot create owner marker"
}

admit_mounted_cache() {
  if host test -e "$OWNER_MARKER" || host test -L "$OWNER_MARKER"; then
    verify_current
    lock_runtime
    return
  fi
  # A previous admission may have mounted the attested image and then exited
  # before publishing its owner marker. Adopt that mount without reformatting
  # or replacing any filesystem contents.
  host chown 0:0 "$MOUNT_ROOT"; host chmod 0755 "$MOUNT_ROOT"
  local child path
  for child in cache pnpm-store workspace-node_modules control-room-node_modules; do
    path="$MOUNT_ROOT/$child"; host mkdir -p "$path"; host test ! -L "$path" || fail "cache child symlink"
    host chown "$RUNTIME_UID:$RUNTIME_GID" "$path"; host chmod 0770 "$path"
  done
  lock_runtime
  write_owner_marker
  verify_current
}

lock_runtime() {
  host test ! -L "$RUNTIME_LOCK" || fail "runtime lock is a symlink"
  if ! host test -e "$RUNTIME_LOCK"; then
    python3 -c 'import os,sys; p,u,g=sys.argv[1:]; fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o660); os.fchown(fd,int(u),int(g)); os.fchmod(fd,0o660); os.close(fd)' "/proc/$HOST_PID/root$RUNTIME_LOCK" "$RUNTIME_UID" "$RUNTIME_GID" || fail "cannot create runtime lock"
  fi
  host test -f "$RUNTIME_LOCK" && host test ! -L "$RUNTIME_LOCK" || fail "runtime lock is not a regular file"
  local rec uid gid mode
  rec="$(host stat -Lc '%u %g %a' "$RUNTIME_LOCK")"; read -r uid gid mode < <(printf '%s\n' "$rec")
  [[ "$uid" == "$RUNTIME_UID" && "$gid" == "$RUNTIME_GID" && "$mode" == 660 ]] || fail "runtime lock ownership/mode invalid"
  exec 8>>"/proc/$HOST_PID/root$RUNTIME_LOCK"
  flock -x -w "$LOCK_WAIT" 8 || fail "frontend cache is held by an active consumer"
}
inspect_unmounted() {
  if host test -e "$MOUNT_ROOT" || host test -L "$MOUNT_ROOT"; then
    host test -d "$MOUNT_ROOT" && host test ! -L "$MOUNT_ROOT" || fail "unmounted cache root invalid"
    local entry
    entry="$(host find "$MOUNT_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" || fail "cannot inspect cache root"
    [[ -z "$entry" ]] || fail "unmounted cache mountpoint is not empty: $entry"
  fi
  host test ! -e "$OWNER_MARKER" && host test ! -L "$OWNER_MARKER" || fail "stale owner marker"
}
lock_cache() {
  local mode="$1"
  if [[ "$mode" == exclusive ]]; then host mkdir -p "$BACKING_DIR"; else host test -e "$LOCK_PATH" || fail "cache lock missing"; fi
  host test ! -L "$LOCK_PATH" || fail "cache lock symlink"
  exec 9>"/proc/$HOST_PID/root$LOCK_PATH"
  if [[ "$mode" == exclusive ]]; then flock -x -w "$LOCK_WAIT" 9; else flock -s -w "$LOCK_WAIT" 9; fi || fail "cache lock timeout"
}
ensure_cache() {
  local fresh_image=0
  if host test -e "$BACKING_IMAGE" || host test -L "$BACKING_IMAGE"; then
    host test ! -L "$BACKING_IMAGE" || fail "cache image symlink"
    [[ "$(host stat -c '%s' "$BACKING_IMAGE")" == "$IMAGE_SIZE_BYTES" ]] || fail "cache image size mismatch"
    local image_fs image_label
    image_fs="$(host blkid -s TYPE -o value "$BACKING_IMAGE" 2>/dev/null || true)"
    image_label="$(host blkid -s LABEL -o value "$BACKING_IMAGE" 2>/dev/null || true)"
    [[ "$image_fs" == ext4 && "$image_label" == "$IMAGE_LABEL" ]] || fail "cache image filesystem attestation failed"
  else
    host mkdir -p "$BACKING_DIR"; host test ! -L "$BACKING_DIR" || fail "backing directory symlink"
    host truncate -s "$IMAGE_SIZE_BYTES" "$BACKING_IMAGE"; host chmod 0600 "$BACKING_IMAGE"
    host mkfs.ext4 -F -L "$IMAGE_LABEL" "$BACKING_IMAGE" >/dev/null
    fresh_image=1
  fi
  CREATED_IMAGE="$fresh_image"
  local associated="" status=0
  if associated="$(host losetup --associated "$BACKING_IMAGE" 2>/dev/null)"; then :; else status=$?; [[ "$status" == 1 ]] || fail "losetup inspect failed"; associated=""; fi
  [[ -z "$associated" ]] || fail "unrelated loop association"
  host mkdir -p "$MOUNT_ROOT"
  inspect_unmounted
  LOOP_DEVICE="$(host losetup --find --show "$BACKING_IMAGE")"; ALLOCATED=1
  [[ "$LOOP_DEVICE" =~ ^/dev/loop[0-9]+$ ]] || fail "invalid loop device"
  host mount -t ext4 -o rw "$LOOP_DEVICE" "$MOUNT_ROOT"; MOUNTED=1
  mount_state; verify_mount
  admit_mounted_cache
}
emit() {
  local state="$1" created="$2"
  python3 -c 'import json,sys
s,c,a,l,u,p,pr,k,i,m,t,z,r=sys.argv[1:]
print(json.dumps({"schema":"fullmag.frontend-cache.v1","profile":p,"project_id":pr,"cache_key":k,"backing_image":i,"mount_root":m,"mount_target":t,"filesystem":"ext4","filesystem_label":"fm-fe-cache-v1","filesystem_uuid":u or None,"size_bytes":int(z),"loop_device":l or None,"mount_active":a=="1","state":s,"created_image":c=="1","runtime_image_id":r,"qualification":"frontend-cache-admission-only"},sort_keys=True))' "$state" "$created" "$MOUNT_ACTIVE" "$LOOP_DEVICE" "$FILESYSTEM_UUID" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$MOUNT_TARGET" "$IMAGE_SIZE_BYTES" "$RUNTIME_IMAGE_ID"
}
cleanup() {
  local status="$?" current=""
  set +e
  exec 8>&- 2>/dev/null || true
  [[ "$SUCCESS" == 1 ]] && return "$status"
  if [[ "$MOUNTED" == 1 && -n "$LOOP_DEVICE" ]]; then
    current="$(host findmnt -rn --mountpoint "$MOUNT_ROOT" -o SOURCE 2>/dev/null || true)"
    [[ "$current" == "$LOOP_DEVICE" ]] && host umount "$MOUNT_ROOT"
  fi
  if [[ "$ALLOCATED" == 1 && -n "$LOOP_DEVICE" ]]; then
    host losetup --detach "$LOOP_DEVICE" >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap cleanup EXIT
main() {
  local action="$1"
  [[ "$action" == ensure || "$action" == verify ]] || fail "usage: $0 {ensure|verify}"
  validate; storage_marker
  if [[ "$action" == ensure ]]; then lock_cache exclusive; else lock_cache shared; fi
  mount_state
  if [[ "$action" == verify ]]; then verify_current; emit validated 0
  elif [[ "$MOUNT_ACTIVE" == 1 ]]; then verify_mount; admit_mounted_cache; emit ready 0
  else ensure_cache; emit ready "$CREATED_IMAGE"
  fi
  SUCCESS=1
}
main "$@"
