import json, sys, hashlib, urllib.request, urllib.parse
B = sys.argv[1]
def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(B + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
def patch(p): 
    s, b = req("PATCH", "/v2/sessions/current/visualization/state", {"planar": p}); assert s == 200, (s, b[:300])
base = "/v2/sessions/current/data/fields/m/planar-default"
q = {"component": "magnitude", "resolution_x": 128, "resolution_y": 128, "scope_kind": "monitor_target", "quality": "interactive"}
def meta(extra):
    s, b = req("GET", base + "/meta?" + urllib.parse.urlencode({**q, **extra})); assert s == 200, (s, b[:400]); return json.loads(b)
def scalar(m):
    link = m["links"]["scalar"]; s, b = req("GET", link); assert s == 200, (s, b[:300]); return hashlib.sha256(b).hexdigest()
out = {}
for plane in ["xy", "xz"]:
    patch({"source": {"kind": "default"}, "default_slice": {"plane": plane, "position_fraction": 0.5, "operator": {"kind": "plane_sample"}}})
    tokens = []
    for f in [0.25, 0.5, 0.75]:
        panel = meta({"position_fraction": f})
        assert "position_fraction=" in panel["links"]["scalar"], panel["links"]["scalar"]
        patch({"default_slice": {"plane": plane, "position_fraction": f, "operator": {"kind": "plane_sample"}}})
        single = meta({})
        single_hash = scalar(single)
        patch({"default_slice": {"plane": plane, "position_fraction": 0.5, "operator": {"kind": "plane_sample"}}})
        same_coord = panel["section"]["resolved_coordinate_m"] == single["section"]["resolved_coordinate_m"]
        same_raster = scalar(panel) == single_hash
        tokens.append(panel["sample_token"])
        out[f"{plane}@{f}"] = {"coord_nm": round(panel["section"]["resolved_coordinate_m"] * 1e9, 4), "same_coord": same_coord, "same_raster": same_raster}
    out[f"{plane}:distinct_tokens"] = len(set(tokens)) == len(tokens)
s, b = req("GET", "/v2/sessions/current/data/fields/m/planar-monitors/any/meta?position_fraction=0.5")
out["monitor_rejects"] = (s, json.loads(b).get("code") if b.startswith(b"{") else b[:80].decode())
s, b = req("PATCH", "/v2/sessions/current/visualization/state", {"planar": {"multislice": {"enabled": True, "position_fractions": [0.5]}}})
out["one_panel_rejected"] = s
print(json.dumps(out, indent=1))
