import gmsh
gmsh.initialize()
gmsh.model.add("test")
fid = gmsh.model.mesh.field.add("Constant")
print("Constant field options:")
for opt in ["VIn", "VOut", "IncludeBoundary", "IncludeEmbedded"]:
    try:
        val = gmsh.model.mesh.field.getNumber(fid, opt)
        print(f"  {opt} = {val} (Number)")
    except Exception as e:
        print(f"  {opt} = NOT A NUMBER ({e})")
for opt in ["VolumesList", "SurfacesList", "CurvesList", "PointsList"]:
    try:
        val = gmsh.model.mesh.field.getNumbers(fid, opt)
        print(f"  {opt} = {val} (Numbers)")
    except Exception as e:
        print(f"  {opt} = NOT A LIST ({e})")
gmsh.finalize()
