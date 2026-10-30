"""PM-N17 A/B: raster and mask hashes of FEM default sections on several planes."""
import hashlib, json, sys, time, urllib.parse, urllib.request
B = sys.argv[1]
FRACTIONS = [float(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else [0.2, 0.37, 0.5, 0.81]
RESOLUTION = int(sys.argv[3]) if len(sys.argv) > 3 else 384
def req(path, raw=False):
    t = time.perf_counter()
    with urllib.request.urlopen(B + path) as r:
        body = r.read()
    return (body if raw else json.loads(body)), time.perf_counter() - t
def patch(body):
    r = urllib.request.Request(B + "/v2/sessions/current/visualization/state", data=json.dumps(body).encode(), method="PATCH", headers={"content-type": "application/json"})
    urllib.request.urlopen(r).read()
patch({"planar": {"source": {"kind": "default"}, "default_slice": {"plane": "xy", "position_fraction": 0.5, "operator": {"kind": "plane_sample"}}}})
out = {}
for plane in ["xy", "xz", "yz"]:
    patch({"planar": {"default_slice": {"plane": plane, "position_fraction": 0.5, "operator": {"kind": "plane_sample"}}}})
    for f in FRACTIONS:
        q = {"component": "magnitude", "resolution_x": RESOLUTION, "resolution_y": RESOLUTION, "scope_kind": "monitor_target", "quality": "interactive", "position_fraction": f}
        meta, dt = req("/v2/sessions/current/data/fields/m/planar-default/meta?" + urllib.parse.urlencode(q))
        scalar, _ = req(meta["links"]["scalar"], raw=True)
        mask, _ = req(meta["links"]["empty_mask"], raw=True)
        out[f"{plane}@{f}"] = {
            "coord_nm": round(meta["section"]["resolved_coordinate_m"] * 1e9, 6),
            "scalar": hashlib.sha256(scalar).hexdigest()[:16],
            "mask": hashlib.sha256(mask).hexdigest()[:16],
            "meta_ms": round(dt * 1000),
        }
print(json.dumps(out, indent=1))
