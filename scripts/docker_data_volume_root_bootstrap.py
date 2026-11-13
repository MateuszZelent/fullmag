"""Build closed isolated root-client bootstraps for data-volume stages."""

COPY_COMPONENTS = (
    "linux_data_volume_copy.py",
    "fullmag_data_volume_fs.py",
    "fullmag_data_volume_manifest.py",
    "fullmag_data_volume_guard.py",
    "fullmag_data_volume.py",
    "fullmag_data_volume_journal.py",
    "fullmag_data_volume_linux_request.py",
    "linux_data_volume_provision.py",
    "linux_data_volume_format.py",
    "fullmag_data_volume_runtime_binding.py",
)
BIND_COMPONENTS = COPY_COMPONENTS + (
    "fullmag_data_volume_bind.py",
    "fullmag_data_volume_pending.py",
    "linux_data_volume_bind.py",
)
ADMISSION_COMPONENTS = BIND_COMPONENTS + (
    "linux_native_data_volume_migration.py",
    "linux_native_host.py",
    "docker_dev_host.py",
    "fullmag_storage.py",
    "fullmag_data_volume_admission.py",
    "linux_data_volume_admission.py",
)
RECOVERY_COMPONENTS = ('linux_data_volume_recover.py',) + tuple(
    name for name in COPY_COMPONENTS if name != 'linux_data_volume_copy.py')

_STAGES = {
    "recover-mounted": {
        "schema": "fullmag.data-volume-mounted-recovery-request.v1",
        "keys": (
            "schema", "volume_id", "storage_root", "token", "failed_journal_relative",
            "linux_request_sha256", "failed_journal_sha256", "format_inputs_sha256",
            "format_started_sha256", "format_failure_sha256", "selector_sha256",
            "recovery_journal_sha256", "components",
        ),
        "components": RECOVERY_COMPONENTS,
    },
    "copy": {
        "schema": "fullmag.data-volume-linux-copy-request.v1",
        "keys": (
            "schema", "volume_id", "storage_root", "token", "linux_request_sha256",
            "provision_result_sha256", "drain_sha256", "fence_ready_sha256", "components",
        ),
        "components": COPY_COMPONENTS,
    },
    "bind": {
        "schema": "fullmag.data-volume-linux-bind-request.v1",
        "keys": (
            "schema", "volume_id", "storage_root", "token", "copy_request_sha256",
            "copy_receipt_sha256", "fence_ready_sha256", "components",
        ),
        "components": BIND_COMPONENTS,
    },
    "admission": {
        "schema": "fullmag.data-volume-linux-admission-request.v1",
        "keys": (
            "schema", "volume_id", "storage_root", "token", "bind_request_sha256",
            "bind_receipt_sha256", "fence_ready_sha256", "components",
        ),
        "components": ADMISSION_COMPONENTS,
    },
}

_BOOTSTRAP_BODY = r'''import hashlib, importlib.abc, importlib.util, json, os, stat, sys

def need(value, message):
    if not value:
        raise SystemExit(message)

need(len(sys.argv) == 5, 'exact root bootstrap arguments required')
source, request_path, request_sha256, expected_json = sys.argv[1:]

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK

def open_directory(path):
    need(type(path) is str and path.startswith('/') and not path.startswith('//') and
         os.path.normpath(path) == path, 'noncanonical root bootstrap directory')
    descriptor = os.open('/', directory_flags)
    try:
        for component in path.split('/')[1:]:
            need(component not in ('', '.', '..'), 'unsafe root bootstrap path component')
            child = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

def read_regular(descriptor, maximum, label):
    before = os.fstat(descriptor)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
         'unsafe or oversized ' + label)
    chunks = []
    total = 0
    while True:
        chunk = os.read(descriptor, min(1024 * 1024, maximum + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        need(total <= maximum, 'oversized ' + label)
        chunks.append(chunk)
    after = os.fstat(descriptor)
    need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
         (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
         label + ' changed while reading')
    return b''.join(chunks)

def read_path(path, maximum, label):
    need(type(path) is str and path.startswith('/') and not path.startswith('//') and
         os.path.normpath(path) == path, 'noncanonical ' + label + ' path')
    parent_path, name = os.path.split(path)
    need(name not in ('', '.', '..'), 'invalid ' + label + ' filename')
    parent = open_directory(parent_path)
    try:
        descriptor = os.open(name, file_flags, dir_fd=parent)
        try:
            return read_regular(descriptor, maximum, label)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, 'duplicate JSON key in root request')
        value[key] = item
    return value

def reject_constant(_value):
    raise ValueError('nonfinite JSON value in root request')

need(type(request_sha256) is str and len(request_sha256) == 64 and
     all(character in '0123456789abcdef' for character in request_sha256),
     'invalid root request SHA')
request_raw = read_path(request_path, 256 * 1024, 'root request')
need(hashlib.sha256(request_raw).hexdigest() == request_sha256, 'root request SHA changed')
request = json.loads(request_raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
need(type(request) is dict and set(request) == REQUEST_KEYS and request.get('schema') == REQUEST_SCHEMA,
     'closed stage-specific root request required')
request_components = request.get('components')
need(type(request_components) is dict and set(request_components) == EXPECTED_COMPONENTS,
     'exact stage-specific root component map required')
need(type(expected_json) is str and len(expected_json) <= 256 * 1024,
     'bounded root component argv required')
expected = json.loads(expected_json, object_pairs_hook=unique_object, parse_constant=reject_constant)
need(type(expected) is dict and expected == request_components and set(expected) == EXPECTED_COMPONENTS,
     'root component argv pin differs from request')
need(all(type(value) is str and len(value) == 64 and
         all(character in '0123456789abcdef' for character in value) for value in expected.values()),
     'invalid root component digest')

source_fd = open_directory(source)
scripts_fd = None
verified_sources = {}
try:
    scripts_fd = os.open('scripts', directory_flags, dir_fd=source_fd)
    for name in sorted(EXPECTED_COMPONENTS):
        descriptor = os.open(name, file_flags, dir_fd=scripts_fd)
        try:
            raw = read_regular(descriptor, 4 * 1024 * 1024, 'root component')
        finally:
            os.close(descriptor)
        need(hashlib.sha256(raw).hexdigest() == expected[name], 'root component source changed: ' + name)
        verified_sources[name[:-3]] = (source + '/scripts/' + name, raw)
finally:
    if scripts_fd is not None:
        os.close(scripts_fd)
    os.close(source_fd)

need(set(verified_sources) == {name[:-3] for name in EXPECTED_COMPONENTS},
     'root verified module set changed')
need(not (set(verified_sources) & set(sys.modules)), 'pinned root module was already imported')

class VerifiedLoader(importlib.abc.Loader):
    def __init__(self, fullname, path, raw):
        self.fullname = fullname
        self.path = path
        self.raw = raw
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        module.__file__ = self.path
        module.__cached__ = None
        code = compile(self.raw, self.path, 'exec', dont_inherit=True)
        exec(code, module.__dict__)

class VerifiedFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        pinned = verified_sources.get(fullname)
        if pinned is None:
            return None
        if fullname in sys.modules:
            raise ImportError('pinned root module was already imported: ' + fullname)
        module_path, raw = pinned
        loader = VerifiedLoader(fullname, module_path, raw)
        return importlib.util.spec_from_loader(fullname, loader, origin=module_path)

os.environ.clear()
os.environ.update({'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C'})
sys.meta_path.insert(0, VerifiedFinder())
import importlib
if STAGE == 'recover-mounted':
    importlib.import_module('linux_data_volume_recover').recover_mounted(request_path, request_sha256)
elif STAGE == 'copy':
    importlib.import_module('linux_data_volume_copy').copy_verified(request_path, request_sha256)
elif STAGE == 'bind':
    importlib.import_module('linux_data_volume_bind').bind_verified(request_path, request_sha256)
elif STAGE == 'admission':
    importlib.import_module('linux_data_volume_admission').admission_verified(request_path, request_sha256)
else:
    raise SystemExit('unsupported root bootstrap stage')
'''


def bootstrap(stage):
    """Return a fixed stage-specific program for ``python -I -B -c`` only."""
    if type(stage) is not str or stage not in _STAGES:
        raise ValueError("Root bootstrap stage must be exactly 'recover-mounted', 'copy', 'bind' or 'admission'")
    config = _STAGES[stage]
    prefix = "\n".join((
        "STAGE = " + repr(stage),
        "REQUEST_SCHEMA = " + repr(config["schema"]),
        "REQUEST_KEYS = frozenset(" + repr(config["keys"]) + ")",
        "EXPECTED_COMPONENTS = frozenset(" + repr(config["components"]) + ")",
    ))
    return prefix + "\n" + _BOOTSTRAP_BODY
