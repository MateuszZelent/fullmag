#!/usr/bin/env python3
"""Odczytowa weryfikacja HTTP przekrojów H względem zapisanych próbek Tet4.

Uruchamiaj w istniejącym kontenerze grupy zadania, po gotowości API.
Skrypt nie uruchamia sesji, Solve ani buildu. Raport nie kwalifikuje fizyki.
"""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

LIMIT = 64 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def close(actual, expected, label, absolute=1e-7):
    require(math.isfinite(actual) and math.isclose(actual, expected, rel_tol=2e-9, abs_tol=absolute),
            f"{label}: {actual!r} != {expected!r}")


class Client:
    def __init__(self, base, artifact, timeout):
        parsed = urlsplit(base)
        require(parsed.scheme in ("http", "https") and parsed.netloc and not parsed.query,
                "Nieprawidłowy adres API")
        require(artifact.startswith("/v2/persistence/projects/") and "/artifacts/" in artifact
                and not any(c in artifact for c in "?#"), "Wymagana pełna ścieżka artefaktu persistence")
        self.root = base.rstrip("/") + artifact.rstrip("/")
        self.timeout = timeout
        self.requests = 0

    def get(self, suffix, query=None, headers=None, expected=(200,)):
        url = self.root + suffix + (("?" + urlencode(query)) if query else "")
        self.requests += 1
        try:
            response = urlopen(Request(url, headers=headers or {}, method="GET"), timeout=self.timeout)
        except HTTPError as error:
            response = error
        with response:
            body = response.read(LIMIT + 1)
            require(len(body) <= LIMIT, "Przekroczony limit odczytu HTTP")
            require(response.code in expected,
                    f"HTTP {response.code} {suffix}: {body[:1000]!r}; oczekiwano {expected}")
            return body, response.headers, response.code

    def json(self, suffix, query=None):
        return json.loads(self.get(suffix, query)[0])


def decode_topology(body):
    # field_store::serialize_fem_mesh_topology_binary_v2; aligned section order.
    require(body[:8] == b"FMMT\x02\x01\x00\x00", "Nieobsługiwany FMMT")
    n, c, f, cn, fn, cm, fm, header, cg, fg = struct.unpack_from("<10I", body, 8)
    require(header == 64 and n > 0 and c > 0, "Nieprawidłowy nagłówek FMMT")
    offset = header

    def section(count, code):
        nonlocal offset
        offset = (offset + 7) & ~7
        result = struct.unpack_from("<" + str(count) + code, body, offset)
        offset += count * struct.calcsize(code)
        return result

    coordinates = section(n * 3, "d")
    types = section(c, "I")
    offsets = section(c + 1, "I")
    connectivity = section(cn, "I")
    for count in (f, f, f + 1, fn, cm, fm):
        section(count, "I")
    if cg:
        section(cg, "Q")
    if fg:
        section(fg, "Q")
    require(offset == len(body), "Długość FMMT nie odpowiada sekcjom")
    require(all(t == 1 for t in types), "Weryfikacja wymaga Tet4")
    require(offsets == tuple(range(0, 4 * c + 1, 4)) and cn == 4 * c,
            "Nieprawidłowa łączność Tet4")
    require(all(i < n for i in connectivity) and all(map(math.isfinite, coordinates)),
            "Nieprawidłowe współrzędne/indeksy")
    return [coordinates[i:i+3] for i in range(0, n*3, 3)], [connectivity[i:i+4] for i in range(0, cn, 4)]


def decode_slice(body, geometry):
    require(body[:8] == b"FMDS\x01\x00\x00\x00", "Nieobsługiwany FMDS")
    length = struct.unpack_from("<I", body, 8)[0]
    require(length <= 1024 * 1024, "Nadmierna koperta FMDS")
    envelope = json.loads(body[12:12+length])
    payload = body[12+length:]
    manifest = envelope["slice"]
    require(envelope["manifest_object_ref"] == geometry["dataset_manifest"]["object_ref"], "Dryf manifestu")
    require(envelope["source"]["tensor_object_ref"] == geometry["source"]["tensor_object_ref"], "Dryf tensora")
    require(manifest["byte_order"] == "little_endian" and int(manifest["component_count"]) == 3,
            "Nieobsługiwany układ FMDS")
    require(int(manifest["element_offset"]) == 0 and int(manifest["element_count"]) == int(geometry["node_count"]),
            "Niepełne próbki")
    require(len(payload) == int(manifest["payload_bytes"]), "Długość FMDS")
    offset = 0
    for part in manifest["parts"]:
        count = int(part["byte_length"])
        require(part["plane"] == "values" and int(part["plane_offset_bytes"]) == offset, "Układ części FMDS")
        require("sha256:" + hashlib.sha256(payload[offset:offset+count]).hexdigest() == part["range_sha256"], "Hash części FMDS")
        offset += count
    require(offset == len(payload), "Niepełne części FMDS")
    code = {"f64": "d", "f32": "f"}[manifest["precision"]]
    count = int(geometry["node_count"]) * 3
    require(len(payload) == count * struct.calcsize(code), "Rozmiar próbek")
    values = struct.unpack("<" + str(count) + code, payload)
    require(all(map(math.isfinite, values)), "Niefinitywne próbki")
    return [values[i:i+3] for i in range(0, count, 3)], hashlib.sha256(payload).hexdigest()


def decode_vector(body, components, resolution):
    # FMVP v2 always serializes f64, even if the stored input was f32.
    require(body[:8] == b"FMVP" + bytes((2, 1, components, 0)), "Nieobsługiwany FMVP")
    metadata, count, nx, ny, nz = struct.unpack_from("<5I", body, 8)
    require(metadata == 0 and [nx, ny] == resolution and nz == 1, "Siatka FMVP")
    require(body[28:44].split(b"\0")[0] == b"H_ant", "Błędna quantity FMVP")
    require(count == nx * ny * components and len(body) == 48 + count * 8, "Długość FMVP")
    values = struct.unpack_from("<" + str(count) + "d", body, 48)
    require(all(map(math.isfinite, values)), "Niefinitywne wartości transportu")
    return values


def subtract(a, b):
    return tuple(x-y for x, y in zip(a, b))


def determinant(a, b, c):
    return (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0])
            + a[2]*(b[0]*c[1]-b[1]*c[0]))


def carriers(nodes, cells):
    result = []
    for ordinal, ids in enumerate(cells):
        vertices = [nodes[i] for i in ids]
        a, b, c = [subtract(v, vertices[0]) for v in vertices[1:]]
        divisor = determinant(a, b, c)
        require(divisor != 0, "Zdegenerowany Tet4")
        bounds = [(min(v[j] for v in vertices), max(v[j] for v in vertices)) for j in range(3)]
        result.append((ordinal, ids, vertices[0], a, b, c, divisor, bounds))
    return result


def interpolate(point, mesh, values):
    # Independent Cramer's rule, no Fullmag sampling implementation imported.
    for ordinal, ids, origin, a, b, c, divisor, bounds in mesh:
        if any(p < lo-1e-18 or p > hi+1e-18 for p, (lo, hi) in zip(point, bounds)):
            continue
        d = subtract(point, origin)
        w1, w2, w3 = determinant(d,b,c)/divisor, determinant(a,d,c)/divisor, determinant(a,b,d)/divisor
        weights = (1-w1-w2-w3, w1, w2, w3)
        if min(weights) < -1e-10 or max(weights) > 1+1e-10:
            continue
        vector = tuple(sum(w*values[i][j] for w, i in zip(weights, ids)) for j in range(3))
        norm_interpolated = sum(w*math.sqrt(sum(x*x for x in values[i])) for w, i in zip(weights, ids))
        return vector, norm_interpolated, ordinal
    return None


def run(args, report):
    client = Client(args.base_url, args.artifact_route, args.timeout)
    geometry = client.json("/saved-field-geometry")
    require(geometry["dataset"]["descriptor"]["quantity_id"] == "H_ant", "Wymagane H_ant")
    require(geometry["coordinate_unit"] == "m", "Wymagane współrzędne SI")
    require(int(geometry["node_count"]) == args.expected_nodes, "Nieoczekiwana liczba próbek")
    hashes = {"expected_dataset_manifest_object_ref": geometry["dataset_manifest"]["object_ref"],
              "expected_geometry_manifest_object_ref": geometry["geometry_manifest"]["object_ref"],
              "expected_geometry_object_ref": geometry["geometry_payload"]["object_ref"]}
    topology = client.get("/saved-field-geometry/topology", dict(hashes, max_response_bytes=33554432))[0]
    require(hashlib.sha256(topology).hexdigest() == geometry["topology_binary_sha256"], "Hash topologii")
    nodes, cells = decode_topology(topology)
    require(len(nodes) == int(geometry["node_count"]) and len(cells) == int(geometry["cell_count"]), "Liczniki topologii")
    dataset = geometry["dataset"]
    slice_query = dict(schema_version="1.0.0", dataset_id=dataset["dataset_id"], dataset_revision=dataset["revision"],
                       sample_id=dataset["sample_id"], item_id=dataset["item_id"], field_id=dataset["field_id"],
                       expected_manifest_object_ref=hashes["expected_dataset_manifest_object_ref"],
                       element_offset=0, element_count=len(nodes), max_response_bytes=LIMIT)
    raw, raw_hash = decode_slice(client.get("/materialized-dataset/slice", slice_query)[0], geometry)
    mesh = carriers(nodes, cells)
    bounds = [(min(v[j] for v in nodes), max(v[j] for v in nodes)) for j in range(3)]
    report.update(source=geometry, raw_values_sha256=raw_hash, planes=[])
    discriminator = 0.0
    for plane, axis_u, axis_v, axis_n, normal_sign in (("xy",0,1,2,1), ("xz",0,2,1,-1), ("yz",1,2,0,1)):
        # Non-symmetric position avoids accidentally sampling mesh faces only.
        lo, hi = bounds[axis_n]
        query = dict(hashes, plane=plane, position_m=lo+0.473*(hi-lo),
                     u_min_m=bounds[axis_u][0], u_max_m=bounds[axis_u][1],
                     v_min_m=bounds[axis_v][0], v_max_m=bounds[axis_v][1],
                     width=17, height=13, component="magnitude", max_response_bytes=1048576)
        meta = client.json("/saved-planar/meta", query)
        require(meta["qualification"] == "not_verified" and meta["reconstruction"] == "tet4_linear_inspection_v1",
                "Nieuprawniona zmiana kwalifikacji/metody")
        require(meta["source"] == geometry and meta["resolution"] == [17,13], "Dryf źródła/rastra")
        occupancy = client.get("/saved-planar/occupancy", query)[0]
        require(len(occupancy) == 221 and set(occupancy) <= {0,1}, "Nieoczekiwana maska")
        require(occupancy.count(0) == meta["occupied_count"] and occupancy.count(1) == meta["empty_count"], "Liczniki maski")
        body, headers, _ = client.get("/saved-planar/vectors", query)
        vectors = decode_vector(body, 3, meta["resolution"])
        require(headers.get("x-fullmag-planar-identity") == meta["request_identity"], "Tożsamość transportu")
        require(headers.get("ETag"), "Brak ETag")
        client.get("/saved-planar/vectors", query, {"If-None-Match": headers["ETag"]}, expected=(304,))
        references = []
        for index, occupied in enumerate(occupancy):
            x, y = index % 17, index // 17
            point = [0.0]*3
            point[axis_n] = query["position_m"]
            point[axis_u] = bounds[axis_u][0]+(x+0.5)*(bounds[axis_u][1]-bounds[axis_u][0])/17
            point[axis_v] = bounds[axis_v][0]+(y+0.5)*(bounds[axis_v][1]-bounds[axis_v][0])/13
            reference = interpolate(point, mesh, raw)
            require((occupied == 0) == (reference is not None), f"Maska {plane} piksel {index}")
            if reference:
                for j in range(3):
                    close(vectors[index*3+j], reference[0][j], f"Wektor {plane}/{index}/{j}")
                discriminator = max(discriminator, abs(math.sqrt(sum(v*v for v in reference[0]))-reference[1]))
            else:
                require(vectors[index*3:index*3+3] == (0.,0.,0.), "Placeholder poza domeną")
            references.append((point, reference))
        require(meta["occupied_count"] > 0, f"Brak zajętych pikseli {plane}")
        for component in ("magnitude", "x", "y", "z", "u", "v", "normal"):
            q = dict(query, component=component)
            scalars = decode_vector(client.get("/saved-planar/scalar", q)[0], 1, meta["resolution"])
            if component == "magnitude":
                occupied_values = [value for value, mask in zip(scalars, occupancy) if mask == 0]
                close(meta["scalar_min"], min(occupied_values), "Minimum rastra")
                close(meta["scalar_max"], max(occupied_values), "Maksimum rastra")
            for i, (_, reference) in enumerate(references):
                if reference is None:
                    require(scalars[i] == 0., "Placeholder skalara poza domeną")
                    continue
                vector = reference[0]
                expected = {"magnitude": math.sqrt(sum(v*v for v in vector)), "x":vector[0], "y":vector[1], "z":vector[2],
                            "u":vector[axis_u], "v":vector[axis_v], "normal":normal_sign*vector[axis_n]}[component]
                close(scalars[i], expected, f"Skalar {plane}/{component}/{i}")
        occupied_indices = [i for i, value in enumerate(occupancy) if value == 0]
        for index in (occupied_indices[0], occupied_indices[len(occupied_indices)//2], occupied_indices[-1]):
            probe = client.json("/saved-planar/probe", dict(query, pixel_x=index%17, pixel_y=index//17))
            point, reference = references[index]
            require(probe["request_identity"] == meta["request_identity"] and probe["occupancy"] == 0, "Tożsamość probe")
            for j in range(3):
                close(probe["point_m"][j], point[j], "Pozycja probe", 1e-18)
                close(probe["vector"][j], reference[0][j], "Wektor probe")
            close(probe["scalar"], math.sqrt(sum(v*v for v in reference[0])), "Norma probe")
            require(probe["source_entity_ordinal"] is not None, "Brak komórki probe")
        outside = dict(query, position_m=hi+2*(hi-lo))
        outside_meta = client.json("/saved-planar/meta", outside)
        require(outside_meta["occupied_count"] == 0 and outside_meta["scalar_min"] is None, "Ekstrapolacja poza domenę")
        require(client.get("/saved-planar/occupancy", outside)[0] == bytes([1])*221, "Maska zewnętrzna")
        outside_probe = client.json("/saved-planar/probe", dict(outside, pixel_x=8, pixel_y=6))
        require(outside_probe["occupancy"] == 1 and all(outside_probe[k] is None for k in ("scalar","vector","source_entity_ordinal")), "Zewnętrzny probe")
        report["planes"].append(dict(plane=plane, request=query, occupied=meta["occupied_count"], empty=meta["empty_count"], identity=meta["request_identity"]))
    require(discriminator > 1e-5, "Próbki nie odróżniają normy interpolowanego wektora od interpolacji norm")
    for key in hashes:
        wrong = ("0" if query[key][0] != "0" else "1") + query[key][1:]
        client.get("/saved-planar/meta", dict(query, **{key:wrong}), expected=(409,))
    for override in ({"width":0}, {"width":1048577}, {"u_max_m":query["u_min_m"]},
                     {"max_response_bytes":"010"}, {"max_response_bytes":33554433}, {"component":"m"}, {"stage_id":"live"}):
        client.get("/saved-planar/meta", dict(query, **override), expected=(400,422))
    client.get("/saved-planar/vectors", dict(query, max_response_bytes=48), expected=(422,))
    client.get("/saved-planar/probe", dict(query, pixel_x=17, pixel_y=0), expected=(400,))
    report.update(request_count=client.requests, norm_order_discriminator_A_per_m=discriminator,
                  result="PASS", limitation="Zgodność rekonstrukcji inspekcyjnej z zapisanymi próbkami; bez kwalifikacji fizyki ani porównania z publikacją.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Adres API, np. http://127.0.0.1:8081")
    parser.add_argument("--artifact-route", required=True, help="Pełna ścieżka /v2/persistence/.../artifacts/<id> bez sufiksu")
    parser.add_argument("--output", required=True, type=Path, help="Jawna ścieżka raportu JSON w wolumenie weryfikacji")
    parser.add_argument("--expected-nodes", type=int, default=1145)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    report = dict(timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  artifact_route=args.artifact_route, result="FAIL")
    try:
        run(args, report)
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({k:report[k] for k in ("result","error","request_count") if k in report}, ensure_ascii=False))
    return 0 if report["result"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
