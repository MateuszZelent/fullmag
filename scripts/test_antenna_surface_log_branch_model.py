"""Independent exact-geometry work oracle; no field solve or runtime qualification."""
import argparse
from fractions import Fraction
import ctypes
import ctypes.util
import math
import sys
import hashlib
import json
import struct
from pathlib import Path


def read_bundle(path, expected_sha256):
    assert len(expected_sha256) == 64 and all(c in "0123456789abcdef" for c in expected_sha256)
    assert 20 <= path.stat().st_size <= 512 * 1024 * 1024
    raw = path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == expected_sha256 and raw[:8] == b"FMACLB01"
    size, count = struct.unpack_from("<QI", raw, 8)
    assert 0 < size <= 1024 * 1024 and count == 22 and 20 + size <= len(raw)
    manifest = json.loads(raw[20:20 + size])
    payloads, cursor = {}, 20 + size
    for _ in range(count):
        name_size = struct.unpack_from("<H", raw, cursor)[0]
        cursor += 2
        assert 0 < name_size <= 1024 and cursor + name_size + 8 <= len(raw)
        name = raw[cursor:cursor + name_size].decode()
        cursor += name_size
        byte_count = struct.unpack_from("<Q", raw, cursor)[0]
        cursor += 8
        assert name not in payloads and cursor + byte_count <= len(raw)
        payloads[name] = raw[cursor:cursor + byte_count]
        cursor += byte_count
    assert cursor == len(raw)
    return manifest, payloads


def subtract(a, b):
    return tuple(x - y for x, y in zip(a, b))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0])



class MpfrValue(ctypes.Structure):
    _fields_ = [("precision", ctypes.c_long), ("sign", ctypes.c_int),
                ("exponent", ctypes.c_long), ("limbs", ctypes.c_void_p)]


class MpfrLogBranches:
    # Only rounded projections are evaluated; no logarithm, field or native FEM call.
    def __init__(self, bits):
        self.bits = bits
        self.lib = ctypes.CDLL(ctypes.util.find_library("mpfr"))
        ptr, integer = ctypes.POINTER(MpfrValue), ctypes.c_int
        signatures = {"mpfr_init2": ([ptr, ctypes.c_long], None), "mpfr_clear": ([ptr], None),
                      "mpfr_set_str": ([ptr, ctypes.c_char_p, integer, integer], integer),
                      "mpfr_set_ui": ([ptr, ctypes.c_ulong, integer], integer),
                      "mpfr_cmp_si": ([ptr, ctypes.c_long], integer),
                      "mpfr_get_version": ([], ctypes.c_char_p)}
        for name in ["mpfr_mul", "mpfr_add", "mpfr_div"]:
            signatures[name] = ([ptr, ptr, ptr, integer], integer)
        for name in ["mpfr_neg", "mpfr_sqrt"]:
            signatures[name] = ([ptr, ptr, integer], integer)
        for name, (arguments, result) in signatures.items():
            function = getattr(self.lib, name); function.argtypes = arguments; function.restype = result
        self.values = [MpfrValue() for _ in range(14)]
        for value in self.values:
            self.lib.mpfr_init2(ctypes.byref(value), bits)
        self.refs = [ctypes.byref(value) for value in self.values]
        paths = {line.split()[-1] for line in Path("/proc/self/maps").read_text().splitlines()
                 if "libmpfr.so" in line and line.split()[-1].startswith("/")}
        assert len(paths) == 1
        path = Path(paths.pop()).resolve(strict=True)
        self.identity = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                         "version": self.lib.mpfr_get_version().decode(), "precision_bits": bits, "rounding": "MPFR_RNDN"}

    def close(self):
        for value in self.values:
            self.lib.mpfr_clear(ctypes.byref(value))
        self.values = []

    def count(self, vector, edge):
        lib, v = self.lib, self.refs
        for target, value in zip(v[:6], (*vector, *edge)):
            assert lib.mpfr_set_str(v[6], str(value.numerator).encode(), 10, 0) == 0
            assert lib.mpfr_set_str(v[7], str(value.denominator).encode(), 10, 0) == 0
            lib.mpfr_div(target, v[6], v[7], 0)
        lib.mpfr_set_ui(v[8], 0, 0); lib.mpfr_set_ui(v[9], 0, 0)
        for i in range(3):
            lib.mpfr_mul(v[10], v[i], v[i+3], 0); lib.mpfr_add(v[8], v[8], v[10], 0)
            lib.mpfr_mul(v[10], v[i+3], v[i+3], 0); lib.mpfr_add(v[9], v[9], v[10], 0)
        lib.mpfr_sqrt(v[11], v[9], 0)
        assert lib.mpfr_cmp_si(v[11], 0) > 0
        lib.mpfr_neg(v[12], v[8], 0); lib.mpfr_div(v[12], v[12], v[11], 0)
        lib.mpfr_add(v[13], v[12], v[11], 0)
        return int(lib.mpfr_cmp_si(v[12], 0) < 0) + int(lib.mpfr_cmp_si(v[13], 0) > 0)


def rounded_dot(left, right):
    value = 0.0
    for x, y in zip(left, right):
        value += x * y
    return value


def normalized_face(points, edges, target):
    vectors = [subtract(target, point) for point in points]
    maximum = max(abs(x) for vector in vectors + edges for x in vector)
    exponent = maximum.numerator.bit_length() - maximum.denominator.bit_length()
    if maximum < Fraction(2) ** exponent:
        exponent -= 1
    scale = Fraction(2) ** max(-1074, min(1023, exponent))
    return [tuple(x / scale for x in vector) for vector in vectors], [tuple(x / scale for x in edge) for edge in edges]


def canonical_division_counts(manifest, payloads, high_arithmetic):
    def payload(name):
        matches = [value for key, value in payloads.items() if key.endswith("/" + name + ".bin")]
        assert len(matches) == 1, "Ambiguous or absent input payload"
        return matches[0]

    cells, samples = payload("cells"), payload("sample_xyz")
    assert len(cells) == manifest["cell_count"] * 280
    assert len(samples) == manifest["target_count"] * 24
    assert 0 < manifest["cell_count"] * manifest["target_count"] <= 4_000_000
    faces, element_ids = [], set()
    orders = ((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1))
    for offset in range(0, len(cells), 280):
        element_id = struct.unpack_from("<Q", cells, offset)[0]
        assert element_id not in element_ids
        element_ids.add(element_id)
        xyz = struct.unpack_from("<12d", cells, offset + 40)
        vertices = [tuple(Fraction.from_float(v) for v in xyz[i:i+3]) for i in range(0, 12, 3)]
        determinant = dot(subtract(vertices[1], vertices[0]), cross(subtract(vertices[2], vertices[0]), subtract(vertices[3], vertices[0])))
        assert determinant != 0
        for opposite, order in enumerate(orders):
            order = list(order)
            if determinant < 0:
                order[1], order[2] = order[2], order[1]
            points = [vertices[i] for i in order]
            normal = cross(subtract(points[1], points[0]), subtract(points[2], points[0]))
            assert dot(normal, subtract(vertices[opposite], points[0])) < 0
            edges = [subtract(points[(i+1) % 3], points[i]) for i in range(3)]
            faces.append((points, edges, normal, [cross(edge, normal) for edge in edges]))
    predictions = []
    for index in range(manifest["target_count"]):
        target = tuple(Fraction.from_float(v) for v in struct.unpack_from("<3d", samples, index * 24))
        divisions, active, zero_endpoints = [2, 1, 2], 0, [0, 0]
        branch_deltas = [0, 0, 0]
        for points, edges, normal, edge_normals in faces:
            fans, branches, rounded_branches = 0, 0, [0, 0, 0]
            vectors, normalized_edges = normalized_face(points, edges, target)
            off_plane = dot(normal, subtract(target, points[0])) != 0
            for i, edge in enumerate(edges):
                if dot(subtract(points[i], target), edge_normals[i]) == 0:
                    continue
                fans += 1
                left = dot(subtract(target, points[i]), edge)
                right = dot(subtract(target, points[(i+1) % 3]), edge)
                exact_branches = int(left > 0) + int(right < 0)
                branches += exact_branches
                rounded_vector = tuple(float(x) for x in vectors[i])
                rounded_edge = tuple(float(x) for x in normalized_edges[i])
                length = math.sqrt(rounded_dot(rounded_edge, rounded_edge))
                xi = -rounded_dot(rounded_vector, rounded_edge) / length
                eta = xi + length
                rounded_branches[0] += int(xi < 0) + int(eta > 0)
                for precision, arithmetic in enumerate(high_arithmetic, 1):
                    rounded_branches[precision] += arithmetic.count(vectors[i], normalized_edges[i])
                zero_endpoints[0] += left == 0
                zero_endpoints[1] += right == 0
            assert fans >= 1
            base = 11 + 2 * fans
            converted = 29 + (fans + 4 if off_plane else 0)
            divisions[0] += base + rounded_branches[0]
            divisions[1] += base + rounded_branches[1] + converted + 1
            divisions[2] += base + rounded_branches[2] + converted + 2
            for precision in range(3):
                branch_deltas[precision] += rounded_branches[precision] - branches
            active += fans
        predictions.append({"target": index, "active_fans": active, "exact_zero_endpoints": zero_endpoints,
                            "rounded_branch_delta_from_exact": branch_deltas,
                            "real_divisions_by_precision": divisions, "total_real_divisions": sum(divisions)})
    return predictions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest, payloads = read_bundle(args.bundle, args.sha256)
    assert sys.float_info.mant_dig == 53 and sys.float_info.max_exp == 1024
    high_arithmetic = [MpfrLogBranches(427), MpfrLogBranches(533)]
    try:
        predictions = canonical_division_counts(manifest, payloads, high_arithmetic)
    finally:
        for arithmetic in high_arithmetic:
            arithmetic.close()
    report = {"schema": "fullmag.antenna.canonical_log_work_oracle.v2", "source_bundle": args.sha256,
              "model_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "targets": predictions,
              "global_by_precision": [sum(t["real_divisions_by_precision"][p] for t in predictions) for p in range(3)],
              "requires_all_binary64_passes_completed": True, "native_fem_execution": False,
              "arithmetic_dependencies": [arithmetic.identity for arithmetic in high_arithmetic],
              "binary64_semantics": "sequential binary64; round-to-nearest ties-to-even; no FMA",
              "observed_target_precision_matrix": False, "scientific_qualification": False}
    with args.output.open("x") as output:
        json.dump(report, output, indent=2)
    print(json.dumps({"targets": len(predictions), "global_by_precision": report["global_by_precision"], "native_fem_execution": False}))


if __name__ == "__main__":
    main()
