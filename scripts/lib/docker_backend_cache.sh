#!/usr/bin/env bash
# Dedicated backend-build-cache-v1 ext4 maintenance helper.
# It is mounted read-only and performs only the short privileged mount step.
set -Eeuo pipefail

PROFILE="backend-build-cache-v1"
OWNER_SCHEMA="fullmag.backend-build-cache-owner.v1"
IMAGE_LABEL="fm-be-cache-v1"
LEGACY_IMAGE_SIZE_BYTES=12884901888
IMAGE_SIZE_BYTES=25769803776
EXTENDED_IMAGE_SIZE_BYTES=42949672960
MAX_IMAGE_SIZE_BYTES=53687091200
GROW_FROM_BYTES=12884901888
GROW_TO_BYTES=25769803776
MOUNT_TARGET="/fullmag-backend-cache"
RUNTIME_LOCK=""
PROFILE_VALUE="${FULLMAG_BACKEND_CACHE_PROFILE-}"
PROJECT_ID="${FULLMAG_BACKEND_CACHE_PROJECT_ID-}"
CACHE_KEY="${FULLMAG_BACKEND_CACHE_KEY-}"
STORAGE_ROOT="${FULLMAG_BACKEND_CACHE_STORAGE_ROOT-}"
BACKING_IMAGE="${FULLMAG_BACKEND_CACHE_BACKING_IMAGE-}"
MOUNT_ROOT="${FULLMAG_BACKEND_CACHE_MOUNT_ROOT-}"
PACKAGE_ROOT_VALUE="${FULLMAG_BACKEND_PACKAGE-}"
PACKAGE_ROOT=""
LOCK_PATH="${FULLMAG_BACKEND_CACHE_LOCK_PATH-}"
OWNER_MARKER_VALUE="${FULLMAG_BACKEND_CACHE_OWNER_MARKER-}"
RUNTIME_IMAGE_ID="${FULLMAG_BACKEND_CACHE_RUNTIME_IMAGE_ID-}"
TOOLCHAIN_IMAGE_ID="${FULLMAG_BACKEND_CACHE_TOOLCHAIN_IMAGE_ID-}"
RUNTIME_UID="${FULLMAG_BACKEND_CACHE_UID-65532}"
RUNTIME_GID="${FULLMAG_BACKEND_CACHE_GID-65532}"
HOST_PID="${FULLMAG_BACKEND_CACHE_HOST_PID-1}"
HOST_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
SIZE_VALUE="${FULLMAG_BACKEND_CACHE_SIZE_BYTES-$IMAGE_SIZE_BYTES}"
GROW_FROM_VALUE="${FULLMAG_BACKEND_CACHE_GROW_FROM_BYTES-$GROW_FROM_BYTES}"
GROW_TO_VALUE="${FULLMAG_BACKEND_CACHE_GROW_TO_BYTES-$GROW_TO_BYTES}"
GROWTH_RECEIPT_VALUE="${FULLMAG_BACKEND_CACHE_GROWTH_RECEIPT-}"
TARGET_VALUE="${FULLMAG_BACKEND_CACHE_MOUNT_TARGET-$MOUNT_TARGET}"
LOCK_WAIT="${FULLMAG_BACKEND_CACHE_LOCK_WAIT_SECONDS-120}"
MOUNT_ACTIVE=0 LOOP_DEVICE="" FILESYSTEM_UUID="" MOUNT_SOURCE=""
ALLOCATED=0 MOUNTED=0 SUCCESS=0 CREATED_IMAGE=0
GROWTH_RECEIPT=""
EXPECTED_IMAGE_SIZE_BYTES=""
EXPECTED_OWNER_SIZE_BYTES=""
ACTION=""

# Docker's development image intentionally omits /sbin and /usr/sbin from its
# PATH.  Keep the helper binary in the container, but expose the host utility
# directories after entering Docker Desktop's host mount namespace.
host() { nsenter -t "$HOST_PID" -m -- env "PATH=$HOST_PATH" "$@"; }
fail() { echo "[docker_backend_cache] $*" >&2; exit 2; }
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
  [[ "$TOOLCHAIN_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "toolchain image is not immutable"
  [[ "$HOST_PID" =~ ^[0-9]+$ && "$HOST_PID" -gt 0 ]] || fail "invalid host pid"
  [[ "$SIZE_VALUE" == "$LEGACY_IMAGE_SIZE_BYTES" || "$SIZE_VALUE" == "$IMAGE_SIZE_BYTES" || "$SIZE_VALUE" == "$EXTENDED_IMAGE_SIZE_BYTES" || "$SIZE_VALUE" == "$MAX_IMAGE_SIZE_BYTES" ]] || fail "unsupported cache capacity"
  case "$GROW_FROM_VALUE:$GROW_TO_VALUE" in
    "$LEGACY_IMAGE_SIZE_BYTES:$IMAGE_SIZE_BYTES") EXPECTED_GROWTH_RECEIPT_SUFFIX=".growth-v1.json" ;;
    "$IMAGE_SIZE_BYTES:$EXTENDED_IMAGE_SIZE_BYTES") EXPECTED_GROWTH_RECEIPT_SUFFIX=".growth-v2.json" ;;
    "$EXTENDED_IMAGE_SIZE_BYTES:$MAX_IMAGE_SIZE_BYTES") EXPECTED_GROWTH_RECEIPT_SUFFIX=".growth-v3.json" ;;
    *) fail "unsupported growth target" ;;
  esac
  [[ "$TARGET_VALUE" == "$MOUNT_TARGET" ]] || fail "fixed cache contract changed"
  safe_path storage "$STORAGE_ROOT"; [[ "$STORAGE_ROOT" != "/" ]] || fail "storage root cannot be /"
  local prefix image mount package lock marker
  prefix="$(printf %.16s "$CACHE_KEY")"
  image="$STORAGE_ROOT/build-volumes/fullmag-backend-build-cache-v1-$CACHE_KEY.ext4"
  mount="/mnt/fullmag-backend-cache-$PROJECT_ID-$prefix"
  package="$mount/package"
  lock="$image.lock"; marker="$mount/.fullmag-backend-cache-owner.json"
  [[ -z "$BACKING_IMAGE" || "$BACKING_IMAGE" == "$image" ]] || fail "backing image mismatch"
  [[ -z "$MOUNT_ROOT" || "$MOUNT_ROOT" == "$mount" ]] || fail "mount root mismatch"
  [[ -z "$PACKAGE_ROOT_VALUE" || "$PACKAGE_ROOT_VALUE" == "$package" ]] || fail "backend package root mismatch"
  [[ -z "$LOCK_PATH" || "$LOCK_PATH" == "$lock" ]] || fail "lock path mismatch"
  [[ -z "$OWNER_MARKER_VALUE" || "$OWNER_MARKER_VALUE" == "$marker" ]] || fail "owner marker mismatch"
  BACKING_IMAGE="$image"; MOUNT_ROOT="$mount"; PACKAGE_ROOT="$package"; LOCK_PATH="$lock"; OWNER_MARKER="$marker"
  GROWTH_RECEIPT="$BACKING_IMAGE$EXPECTED_GROWTH_RECEIPT_SUFFIX"
  [[ -z "$GROWTH_RECEIPT_VALUE" || "$GROWTH_RECEIPT_VALUE" == "$GROWTH_RECEIPT" ]] || fail "growth receipt mismatch"
  EXPECTED_IMAGE_SIZE_BYTES="$SIZE_VALUE"
  EXPECTED_OWNER_SIZE_BYTES="$SIZE_VALUE"
  RUNTIME_LOCK="$MOUNT_ROOT/.fullmag-backend-runtime.lock"
  BACKING_DIR="$(dirname -- "$BACKING_IMAGE")"
  safe_path image "$BACKING_IMAGE"; safe_path mount "$MOUNT_ROOT"; safe_path package "$PACKAGE_ROOT"; safe_path lock "$LOCK_PATH"; safe_path marker "$OWNER_MARKER"
  host test "$(host id -u)" = 0 || fail "host namespace is not root"
  local c
  for c in cat chmod chown find findmnt flock losetup mount mkfs.ext4 blkid mkdir rm stat test truncate umount; do
    host sh -c 'command -v "$1" >/dev/null 2>&1' sh "$c" || fail "missing host command: $c"
  done
  if [[ "$ACTION" == grow ]]; then
    host sh -c 'command -v "$1" >/dev/null 2>&1' sh resize2fs || fail "missing host command: resize2fs"
  fi
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
  [[ "$(host stat -c '%s' "$BACKING_IMAGE")" == "$EXPECTED_IMAGE_SIZE_BYTES" ]] || fail "image size invalid"
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
p,profile,project,key,image,mount,fs,size,target,uid,gid,toolchain=sys.argv[1:]
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o444 or s.st_size>16384: raise SystemExit("mode")
 raw=os.read(fd,16385)
finally:
 os.close(fd)
if len(raw)>16384: raise SystemExit("bounded")
v=json.loads(raw.decode())
e={"schema","profile","project_id","cache_key","backing_image","mount_root","filesystem_uuid","image_size_bytes","mount_target","runtime_uid","runtime_gid","toolchain_image_id","owner_token"}
if set(v)!=e: raise SystemExit("schema")
c={"schema":"fullmag.backend-build-cache-owner.v1","profile":profile,"project_id":project,"cache_key":key,"backing_image":image,"mount_root":mount,"filesystem_uuid":fs,"image_size_bytes":int(size),"mount_target":target,"runtime_uid":int(uid),"runtime_gid":int(gid),"toolchain_image_id":toolchain}
if any(v.get(k)!=x for k,x in c.items()): raise SystemExit("identity")
t=uuid.UUID(v["owner_token"])
if not t.int or str(t)!=v["owner_token"]: raise SystemExit("token")
' "/proc/$HOST_PID/root$OWNER_MARKER" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$FILESYSTEM_UUID" "$EXPECTED_OWNER_SIZE_BYTES" "$MOUNT_TARGET" "$RUNTIME_UID" "$RUNTIME_GID" "$TOOLCHAIN_IMAGE_ID" || fail "owner marker invalid"
}

owner_token() {
  python3 -c 'import json,os,stat,sys
p=sys.argv[1]
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 raw=os.read(fd,16385)
finally:
 os.close(fd)
v=json.loads(raw.decode())
t=v.get("owner_token")
if not isinstance(t,str) or len(t)!=36: raise SystemExit("owner token")
print(t)' "/proc/$HOST_PID/root$OWNER_MARKER" || fail "cannot read owner token"
}

owner_marker_size() {
  python3 -c 'import json,os,stat,sys
p=sys.argv[1]
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o444 or s.st_size>16384: raise SystemExit("owner marker mode")
 raw=os.read(fd,16385)
finally: os.close(fd)
if len(raw)>16384: raise SystemExit("owner marker size")
v=json.loads(raw.decode())
if set(v)!={"schema","profile","project_id","cache_key","backing_image","mount_root","filesystem_uuid","image_size_bytes","mount_target","runtime_uid","runtime_gid","toolchain_image_id","owner_token"}: raise SystemExit("owner marker schema")
size=v.get("image_size_bytes")
if size not in {12884901888,25769803776,42949672960,53687091200}: raise SystemExit("owner marker capacity")
print(size)
' "/proc/$HOST_PID/root$OWNER_MARKER" || fail "cannot inspect owner marker capacity"
}

growth_journal() {
  local state="$1" old_size="$2" new_size="$3" token="$4"
  python3 -c 'import json,os,stat,sys
p,state,profile,project,key,image,mount,fs,old_size,new_size,target,token,toolchain=sys.argv[1:]
if "\x00" in p or "\n" in p or "\r" in p: raise SystemExit("journal path")
def read_existing(path):
 if not os.path.lexists(path): return None
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o444 or s.st_size>16384: raise SystemExit("journal mode")
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 try: raw=os.read(fd,16385)
 finally: os.close(fd)
 if len(raw)>16384: raise SystemExit("journal size")
 value=json.loads(raw.decode())
 expected={"schema","operation","state","profile","project_id","cache_key","backing_image","mount_root","filesystem_uuid","previous_size_bytes","size_bytes","mount_target","owner_token","toolchain_image_id"}
 if set(value)!=expected: raise SystemExit("journal schema")
 identity={"schema":"fullmag.backend-build-cache-growth.v1","operation":"grow","profile":profile,"project_id":project,"cache_key":key,"backing_image":image,"mount_root":mount,"filesystem_uuid":fs,"previous_size_bytes":int(old_size),"size_bytes":int(new_size),"mount_target":target,"owner_token":token,"toolchain_image_id":toolchain}
 if any(value.get(k)!=v for k,v in identity.items() if k not in {"state"}): raise SystemExit("journal identity")
 if value.get("state") not in {"started","succeeded"}: raise SystemExit("journal state")
 return value
existing=read_existing(p)
if state=="started":
 if existing is not None:
  # A retry after a process/host interruption may have already published the
  # same transition. The identity above is still checked before accepting
  # the idempotent retry.
  if existing.get("state") not in {"started","succeeded"}: raise SystemExit("growth journal state")
  raise SystemExit(0)
elif state=="succeeded":
 if existing is None or existing.get("state") not in {"started","succeeded"}: raise SystemExit("growth journal is not pending")
 if existing.get("state")=="succeeded": raise SystemExit(0)
else: raise SystemExit("growth state")
value={"schema":"fullmag.backend-build-cache-growth.v1","operation":"grow","state":state,"profile":profile,"project_id":project,"cache_key":key,"backing_image":image,"mount_root":mount,"filesystem_uuid":fs,"previous_size_bytes":int(old_size),"size_bytes":int(new_size),"mount_target":target,"owner_token":token,"toolchain_image_id":toolchain}
parent=os.path.dirname(p)
tmp=p+".tmp."+str(os.getpid())
if os.path.lexists(tmp): raise SystemExit("journal temporary exists")
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
try:
 os.write(fd,(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()); os.fsync(fd)
finally: os.close(fd)
os.chown(tmp,0,0); os.chmod(tmp,0o444)
if state=="started": os.link(tmp,p,follow_symlinks=False)
else: os.replace(tmp,p)
if os.path.lexists(tmp): os.unlink(tmp)
dirfd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
try: os.fsync(dirfd)
finally: os.close(dirfd)
' "/proc/$HOST_PID/root$GROWTH_RECEIPT" "$state" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$FILESYSTEM_UUID" "$old_size" "$new_size" "$MOUNT_TARGET" "$token" "$TOOLCHAIN_IMAGE_ID" || fail "growth journal update failed"
}

growth_journal_state() {
  # Read and attest the recovery journal without changing it. The owner
  # marker is checked separately because it is authoritative on the mounted
  # filesystem; the journal token is compared before a retry is admitted.
  python3 -c 'import json,os,stat,sys,uuid
p,profile,project,key,image,mount,fs,old_size,new_size,target,toolchain=sys.argv[1:]
if not os.path.lexists(p):
 print("none -")
 raise SystemExit(0)
s=os.lstat(p)
if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o444 or s.st_size>16384: raise SystemExit("journal mode")
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
try: raw=os.read(fd,16385)
finally: os.close(fd)
if len(raw)>16384: raise SystemExit("journal size")
v=json.loads(raw.decode())
expected={"schema","operation","state","profile","project_id","cache_key","backing_image","mount_root","filesystem_uuid","previous_size_bytes","size_bytes","mount_target","owner_token","toolchain_image_id"}
if set(v)!=expected: raise SystemExit("journal schema")
identity={"schema":"fullmag.backend-build-cache-growth.v1","operation":"grow","profile":profile,"project_id":project,"cache_key":key,"backing_image":image,"mount_root":mount,"filesystem_uuid":fs,"previous_size_bytes":int(old_size),"size_bytes":int(new_size),"mount_target":target,"toolchain_image_id":toolchain}
if any(v.get(k)!=value for k,value in identity.items()): raise SystemExit("journal identity")
if v.get("state") not in {"started","succeeded"}: raise SystemExit("journal state")
token=v.get("owner_token")
try: parsed=uuid.UUID(token)
except (ValueError,TypeError,AttributeError): raise SystemExit("journal token")
if not parsed.int or str(parsed)!=token: raise SystemExit("journal token")
print(v["state"],token)
' "/proc/$HOST_PID/root$GROWTH_RECEIPT" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$FILESYSTEM_UUID" "$GROW_FROM_VALUE" "$GROW_TO_VALUE" "$MOUNT_TARGET" "$TOOLCHAIN_IMAGE_ID" || fail "growth journal invalid"
}

verify_root() {
  local rec uid gid mode
  rec="$(host stat -Lc '%u %g %a' "$MOUNT_ROOT")"; read -r uid gid mode < <(printf '%s\n' "$rec")
  [[ "$uid" == "$RUNTIME_UID" && "$gid" == "$RUNTIME_GID" && "$mode" == 1770 ]] || fail "backend cache root ownership/mode invalid"
}

verify_package() {
  local rec uid gid mode
  host test -d "$PACKAGE_ROOT" && host test ! -L "$PACKAGE_ROOT" || fail "backend package root is not a regular directory"
  rec="$(host stat -Lc '%u %g %a' "$PACKAGE_ROOT")"; read -r uid gid mode < <(printf '%s\n' "$rec")
  [[ "$uid" == "$RUNTIME_UID" && "$gid" == "$RUNTIME_GID" && "$mode" == 770 ]] || fail "backend package root ownership/mode invalid"
}

ensure_package() {
  if host test -e "$PACKAGE_ROOT" || host test -L "$PACKAGE_ROOT"; then
    host test -d "$PACKAGE_ROOT" && host test ! -L "$PACKAGE_ROOT" || fail "backend package root is not a directory"
    local rec uid gid mode
    rec="$(host stat -Lc '%u %g %a' "$PACKAGE_ROOT")"; read -r uid gid mode < <(printf '%s\n' "$rec")
    [[ "$uid" == "$RUNTIME_UID" && "$gid" == "$RUNTIME_GID" ]] || fail "backend package root ownership changed"
    [[ "$mode" == 770 ]] || host chmod 0770 "$PACKAGE_ROOT"
  else
    # The owner marker and runtime lock have already admitted this mounted
    # filesystem. Create only this fixed child; never adopt an arbitrary host
    # directory as a writable package root.
    host mkdir "$PACKAGE_ROOT"
    host chown "$RUNTIME_UID:$RUNTIME_GID" "$PACKAGE_ROOT"
    host chmod 0770 "$PACKAGE_ROOT"
  fi
  verify_package
}

verify_current() { mount_state; verify_mount; verify_owner; verify_root; verify_package; }

write_owner_marker() {
  python3 -c 'import json,os,sys,uuid
p,profile,project,key,image,mount,fs,size,target,uid,gid,toolchain=sys.argv[1:]
v={"schema":"fullmag.backend-build-cache-owner.v1","profile":profile,"project_id":project,"cache_key":key,"backing_image":image,"mount_root":mount,"filesystem_uuid":fs,"image_size_bytes":int(size),"mount_target":target,"runtime_uid":int(uid),"runtime_gid":int(gid),"toolchain_image_id":toolchain,"owner_token":str(uuid.uuid4())}
t=p+".tmp."+str(os.getpid())
if os.path.lexists(p): raise SystemExit("owner marker exists")
fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
os.write(fd,(json.dumps(v,separators=(",",":"))+"\n").encode()); os.fsync(fd); os.close(fd)
os.chown(t,0,0); os.chmod(t,0o444); os.link(t,p,follow_symlinks=False); os.unlink(t)
' "/proc/$HOST_PID/root$OWNER_MARKER" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$FILESYSTEM_UUID" "$EXPECTED_OWNER_SIZE_BYTES" "$MOUNT_TARGET" "$RUNTIME_UID" "$RUNTIME_GID" "$TOOLCHAIN_IMAGE_ID" || fail "cannot create owner marker"
}

update_owner_marker_size() {
  local old_size="$1" new_size="$2"
  python3 -c 'import json,os,stat,sys
p,profile,project,key,image,mount,fs,old_size,new_size,target,uid,gid,toolchain=sys.argv[1:]
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
try:
 s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or stat.S_IMODE(s.st_mode)!=0o444 or s.st_size>16384: raise SystemExit("owner marker mode")
 raw=os.read(fd,16385)
finally: os.close(fd)
if len(raw)>16384: raise SystemExit("owner marker size")
v=json.loads(raw.decode())
expected={"schema","profile","project_id","cache_key","backing_image","mount_root","filesystem_uuid","image_size_bytes","mount_target","runtime_uid","runtime_gid","toolchain_image_id","owner_token"}
if set(v)!=expected: raise SystemExit("owner marker schema")
identity={"schema":"fullmag.backend-build-cache-owner.v1","profile":profile,"project_id":project,"cache_key":key,"backing_image":image,"mount_root":mount,"filesystem_uuid":fs,"mount_target":target,"runtime_uid":int(uid),"runtime_gid":int(gid),"toolchain_image_id":toolchain}
if any(v.get(k)!=value for k,value in identity.items()): raise SystemExit("owner marker identity")
if v.get("image_size_bytes")!=int(old_size): raise SystemExit("owner marker old size")
token=v.get("owner_token")
if not isinstance(token,str) or len(token)!=36: raise SystemExit("owner marker token")
v["image_size_bytes"]=int(new_size)
tmp=p+".resize."+str(os.getpid())
if os.path.lexists(tmp): raise SystemExit("owner marker temporary exists")
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
try: os.write(fd,(json.dumps(v,sort_keys=True,separators=(",",":"))+"\n").encode()); os.fsync(fd)
finally: os.close(fd)
os.chown(tmp,0,0); os.chmod(tmp,0o444); os.replace(tmp,p)
dirfd=os.open(os.path.dirname(p),os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
try: os.fsync(dirfd)
finally: os.close(dirfd)
' "/proc/$HOST_PID/root$OWNER_MARKER" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$FILESYSTEM_UUID" "$old_size" "$new_size" "$MOUNT_TARGET" "$RUNTIME_UID" "$RUNTIME_GID" "$TOOLCHAIN_IMAGE_ID" || fail "cannot update owner marker capacity"
}

admit_mounted_cache() {
  if host test -e "$OWNER_MARKER" || host test -L "$OWNER_MARKER"; then
    mount_state; verify_mount; verify_owner; verify_root
    lock_runtime
    ensure_package
  else
    # Only a filesystem created by this invocation may receive its first
    # owner marker. An existing unmarked image is unidentified and must fail
    # closed rather than being silently adopted.
    [[ "$CREATED_IMAGE" == 1 ]] || fail "existing backend cache has no owner marker; explicit recovery is required"
    host chown "$RUNTIME_UID:$RUNTIME_GID" "$MOUNT_ROOT"; host chmod 1770 "$MOUNT_ROOT"
    lock_runtime
    write_owner_marker
    ensure_package
    verify_current
  fi
}

lock_runtime() {
  host test ! -L "$RUNTIME_LOCK" || fail "runtime lock is a symlink"
  if ! host test -e "$RUNTIME_LOCK"; then
    python3 -c 'import os,sys
p,u,g=sys.argv[1:]
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o660)
os.fchown(fd,int(u),int(g)); os.fchmod(fd,0o660); os.close(fd)
' "/proc/$HOST_PID/root$RUNTIME_LOCK" "$RUNTIME_UID" "$RUNTIME_GID" || fail "cannot create runtime lock"
  fi
  host test -f "$RUNTIME_LOCK" && host test ! -L "$RUNTIME_LOCK" || fail "runtime lock is not a regular file"
  local rec uid gid mode
  rec="$(host stat -Lc '%u %g %a' "$RUNTIME_LOCK")"; read -r uid gid mode < <(printf '%s\n' "$rec")
  [[ "$uid" == "$RUNTIME_UID" && "$gid" == "$RUNTIME_GID" && "$mode" == 660 ]] || fail "runtime lock ownership/mode invalid"
  exec 8<>"/proc/$HOST_PID/root$RUNTIME_LOCK"
  flock -x -w "$LOCK_WAIT" 8 || fail "backend cache is held by an active consumer"
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
    [[ "$(host stat -c '%s' "$BACKING_IMAGE")" == "$SIZE_VALUE" ]] || fail "cache image size mismatch"
    local image_fs image_label
    image_fs="$(host blkid -s TYPE -o value "$BACKING_IMAGE" 2>/dev/null || true)"
    image_label="$(host blkid -s LABEL -o value "$BACKING_IMAGE" 2>/dev/null || true)"
    [[ "$image_fs" == ext4 && "$image_label" == "$IMAGE_LABEL" ]] || fail "cache image filesystem attestation failed"
  else
    host mkdir -p "$BACKING_DIR"; host test ! -L "$BACKING_DIR" || fail "backing directory symlink"
    host truncate -s "$SIZE_VALUE" "$BACKING_IMAGE"; host chmod 0600 "$BACKING_IMAGE"
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

grow_cache() {
  [[ "$SIZE_VALUE" == "$GROW_TO_VALUE" ]] || fail "growth target capacity does not match its transition"
  case "$GROW_FROM_VALUE:$GROW_TO_VALUE" in
    "$LEGACY_IMAGE_SIZE_BYTES:$IMAGE_SIZE_BYTES"|"$IMAGE_SIZE_BYTES:$EXTENDED_IMAGE_SIZE_BYTES"|"$EXTENDED_IMAGE_SIZE_BYTES:$MAX_IMAGE_SIZE_BYTES") ;;
    *) fail "growth source and target are not an adjacent supported transition" ;;
  esac
  host test -e "$BACKING_IMAGE" && host test ! -L "$BACKING_IMAGE" || fail "growth backing image is missing or a symlink"
  local image_fs image_label associated status token after_token uuid_before
  local journal_state="none" journal_token="-" marker_size backing_size journal_line
  image_fs="$(host blkid -s TYPE -o value "$BACKING_IMAGE" 2>/dev/null || true)"
  image_label="$(host blkid -s LABEL -o value "$BACKING_IMAGE" 2>/dev/null || true)"
  [[ "$image_fs" == ext4 && "$image_label" == "$IMAGE_LABEL" ]] || fail "growth backing filesystem attestation failed"

  # A failed grow deliberately leaves its mount in place with a durable
  # journal. Reuse that exact loop mount after taking the cache/runtime locks;
  # do not detach it while the filesystem may still be mid-transition.
  if [[ "$MOUNT_ACTIVE" == 1 ]]; then
    journal_line="$(growth_journal_state)"
    read -r journal_state journal_token < <(printf '%s\n' "$journal_line")
  else
    if associated="$(host losetup --associated "$BACKING_IMAGE" 2>/dev/null)"; then :; else
      status=$?; [[ "$status" == 1 ]] || fail "losetup inspect failed"; associated=""
    fi
    [[ -z "$associated" ]] || fail "growth found an unrelated loop association"
    host mkdir -p "$MOUNT_ROOT"
    inspect_unmounted
    LOOP_DEVICE="$(host losetup --find --show "$BACKING_IMAGE")"; ALLOCATED=1
    [[ "$LOOP_DEVICE" =~ ^/dev/loop[0-9]+$ ]] || fail "invalid loop device"
    host mount -t ext4 -o rw "$LOOP_DEVICE" "$MOUNT_ROOT"; MOUNTED=1
    mount_state
    journal_line="$(growth_journal_state)"
    read -r journal_state journal_token < <(printf '%s\n' "$journal_line")
  fi

  [[ "$MOUNT_ACTIVE" == 1 ]] || fail "growth mount admission failed"
  backing_size="$(host stat -c '%s' "$BACKING_IMAGE")"
  [[ "$backing_size" == "$GROW_FROM_VALUE" || "$backing_size" == "$GROW_TO_VALUE" ]] || fail "growth backing has an unsupported capacity"
  EXPECTED_IMAGE_SIZE_BYTES="$backing_size"
  marker_size="$(owner_marker_size)"
  [[ "$journal_state" == none || "$journal_state" == started || "$journal_state" == succeeded ]] || fail "growth journal state invalid"
  if [[ "$journal_state" == none || "$journal_state" == started ]]; then
    [[ "$backing_size" == "$GROW_FROM_VALUE" || "$journal_state" == started ]] || fail "unjournaled growth backing is not admissible"
    [[ "$marker_size" == "$GROW_FROM_VALUE" ]] || fail "growth owner marker is not at the legacy capacity"
  else
    [[ "$backing_size" == "$GROW_TO_VALUE" ]] || fail "succeeded growth journal has a short backing"
    [[ "$marker_size" == "$GROW_FROM_VALUE" || "$marker_size" == "$GROW_TO_VALUE" ]] || fail "growth owner marker capacity invalid"
    [[ "$marker_size" != "$GROW_TO_VALUE" || "$backing_size" == "$GROW_TO_VALUE" ]] || fail "growth owner marker has a short backing"
  fi
  verify_mount; EXPECTED_OWNER_SIZE_BYTES="$marker_size"; verify_owner; verify_root
  token="$(owner_token)"
  if [[ "$journal_state" != none ]]; then
    [[ "$token" == "$journal_token" ]] || fail "growth owner token does not match its journal"
  fi
  lock_runtime
  ensure_package
  uuid_before="$FILESYSTEM_UUID"

  if [[ "$journal_state" == none ]]; then
    growth_journal started "$GROW_FROM_VALUE" "$GROW_TO_VALUE" "$token"
    journal_state=started
  fi
  if [[ "$backing_size" == "$GROW_FROM_VALUE" ]]; then
    host truncate -s "$GROW_TO_VALUE" "$BACKING_IMAGE"
  fi
  host losetup --set-capacity "$LOOP_DEVICE"
  host resize2fs "$LOOP_DEVICE" >/dev/null

  # Publish the durable growth result before changing the marker's capacity
  # field. If marker publication then fails, the old marker still rejects the
  # target-sized admission and the journal identifies the repair required.
  growth_journal succeeded "$GROW_FROM_VALUE" "$GROW_TO_VALUE" "$token"
  EXPECTED_IMAGE_SIZE_BYTES="$GROW_TO_VALUE"
  if [[ "$marker_size" == "$GROW_FROM_VALUE" ]]; then
    update_owner_marker_size "$GROW_FROM_VALUE" "$GROW_TO_VALUE"
  fi
  EXPECTED_OWNER_SIZE_BYTES="$GROW_TO_VALUE"
  mount_state; verify_mount; verify_owner; verify_root
  after_token="$(owner_token)"
  [[ "$token" == "$after_token" ]] || fail "owner token changed during growth"
  [[ "$FILESYSTEM_UUID" == "$uuid_before" && "$FILESYSTEM_UUID" =~ ^[0-9A-Fa-f-]{36}$ ]] || fail "filesystem UUID changed during growth"
  emit_growth grown "$GROW_FROM_VALUE" "$GROW_TO_VALUE" "$token"
}

emit() {
  local state="$1" created="$2"
  python3 -c 'import json,sys
s,c,a,l,u,p,pr,k,i,m,package,t,z,r,tc=sys.argv[1:]
print(json.dumps({"schema":"fullmag.backend-build-cache.v1","profile":p,"project_id":pr,"cache_key":k,"backing_image":i,"mount_root":m,"package_root":package,"mount_target":t,"filesystem":"ext4","filesystem_label":"fm-be-cache-v1","filesystem_uuid":u or None,"size_bytes":int(z),"loop_device":l or None,"mount_active":a=="1","state":s,"created_image":c=="1","runtime_image_id":r,"toolchain_image_id":tc,"qualification":"backend-cache-admission-only"},sort_keys=True))' "$state" "$created" "$MOUNT_ACTIVE" "$LOOP_DEVICE" "$FILESYSTEM_UUID" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$PACKAGE_ROOT" "$MOUNT_TARGET" "$SIZE_VALUE" "$RUNTIME_IMAGE_ID" "$TOOLCHAIN_IMAGE_ID"
}

emit_growth() {
  local state="$1" old_size="$2" new_size="$3" token="$4"
  python3 -c 'import json,sys
s,o,n,l,u,p,pr,k,i,m,package,t,r,tc,token,j=sys.argv[1:]
print(json.dumps({"schema":"fullmag.backend-build-cache.v1","profile":p,"project_id":pr,"cache_key":k,"backing_image":i,"mount_root":m,"package_root":package,"mount_target":t,"filesystem":"ext4","filesystem_label":"fm-be-cache-v1","filesystem_uuid":u,"previous_size_bytes":int(o),"size_bytes":int(n),"loop_device":l,"mount_active":True,"state":s,"runtime_image_id":r,"toolchain_image_id":tc,"owner_token":token,"growth_receipt":j,"qualification":"backend-cache-growth-admission-only"},sort_keys=True))' "$state" "$old_size" "$new_size" "$LOOP_DEVICE" "$FILESYSTEM_UUID" "$PROFILE" "$PROJECT_ID" "$CACHE_KEY" "$BACKING_IMAGE" "$MOUNT_ROOT" "$PACKAGE_ROOT" "$MOUNT_TARGET" "$RUNTIME_IMAGE_ID" "$TOOLCHAIN_IMAGE_ID" "$token" "$GROWTH_RECEIPT"
}

cleanup() {
  local status="$?" current=""
  set +e
  exec 8>&- 2>/dev/null || true
  exec 9>&- 2>/dev/null || true
  [[ "$SUCCESS" == 1 ]] && return "$status"
  # A failed grow is left mounted and journaled for explicit operator
  # recovery. Detaching here would release the runtime lock before an
  # unmount and could race a new consumer against a partially grown image.
  [[ "$ACTION" == grow ]] && return "$status"
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
  local action="${1-}"
  ACTION="$action"
  [[ "$action" == ensure || "$action" == verify || "$action" == grow ]] || fail "usage: $0 {ensure|verify|grow}"
  validate; storage_marker
  if [[ "$action" == ensure || "$action" == grow ]]; then lock_cache exclusive; else lock_cache shared; fi
  mount_state
  if [[ "$action" == verify ]]; then verify_current; emit validated 0
  elif [[ "$action" == grow ]]; then grow_cache
  elif [[ "$MOUNT_ACTIVE" == 1 ]]; then verify_mount; admit_mounted_cache; emit ready 0
  else ensure_cache; emit ready "$CREATED_IMAGE"
  fi
  SUCCESS=1
}

main "$@"
