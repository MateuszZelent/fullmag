"""PM-N17 in one process: plane-operator raster pixels vs direct-scan probes at pixel centres."""
import json, random, struct, sys, urllib.parse, urllib.request
B = sys.argv[1]
def get(path, raw=False):
    with urllib.request.urlopen(B + path) as r:
        body = r.read()
    return body if raw else json.loads(body)
def patch(body):
    r = urllib.request.Request(B + "/v2/sessions/current/visualization/state", data=json.dumps(body).encode(), method="PATCH", headers={"content-type": "application/json"})
    urllib.request.urlopen(r).read()
rng = random.Random(17)
report = {}
for plane, f in [("xy", 0.5), ("xy", 0.31), ("xz", 0.62), ("yz", 0.44)]:
    patch({"planar": {"source": {"kind": "default"}, "default_slice": {"plane": plane, "position_fraction": f, "operator": {"kind": "plane_sample"}}}})
    W = H = 256
    q = {"component": "magnitude", "resolution_x": W, "resolution_y": H, "scope_kind": "monitor_target", "quality": "interactive"}
    meta = get("/v2/sessions/current/data/fields/m/planar-default/meta?" + urllib.parse.urlencode(q))
    raw = get(meta["links"]["scalar"], raw=True)
    assert raw[:4] == b"FMVP"
    meta_len = struct.unpack_from("<I", raw, 8)[0] if raw[4] >= 3 else 0
    values = struct.unpack_from(f"<{W*H}d", raw, 48 + meta_len)
    b = meta["frame"]["bounds_uv_m"]; du = (b[1]-b[0])/W; dv = (b[3]-b[2])/H
    canon = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(meta["links"]["scalar"]).query))
    equal = differ = empty_both = mismatch_occ = 0
    examples = []
    for _ in range(75):
        x, y = rng.randrange(W), rng.randrange(H)
        u = b[0] + (x + 0.5) * du; v = b[2] + (y + 0.5) * dv
        pr = get("/v2/sessions/current/data/fields/m/planar-default/probe?" + urllib.parse.urlencode({**canon, "u_m": u, "v_m": v}))
        rv = values[y * W + x]
        if pr["occupancy"] == "occupied":
            if pr["scalar"] == rv: equal += 1
            else:
                differ += 1
                if len(examples) < 3: examples.append((x, y, rv, pr["scalar"]))
        else:
            if rv != rv or rv == 0.0: empty_both += 1
            else: mismatch_occ += 1
    report[f"{plane}@{f}"] = {"cut_elements": meta["section"]["cut_element_count"], "equal": equal, "differ": differ, "empty_both": empty_both, "occupancy_mismatch": mismatch_occ, "examples": examples}
print(json.dumps(report, indent=1))
