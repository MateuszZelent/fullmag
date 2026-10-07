"""Exact P1 counterexample: scalar continuity crosses magnetic/air interfaces.

This is an independent algebra check, not an executed Fullmag solver.
"""
from fractions import Fraction as F
import json

N = 6
nodes = [(F(i), F(j)) for j in range(N+1) for i in range(N+1)]
triangles = []
roles = []
for j in range(N):
    for i in range(N):
        a = j*(N+1)+i
        b,c,d = a+1,a+(N+1),a+(N+1)+1
        triangles.extend(((a,b,d), (a,d,c)))
        role = "air" if i in (0,N-1) or j in (0,N-1) or (i,j)==(2,2) else "magnetic"
        roles.extend((role,role))

P = [[F(0) for _ in nodes] for _ in nodes]
for ids in triangles:
    p0,p1,p2 = [nodes[index] for index in ids]
    twice_area = (p1[0]-p0[0])*(p2[1]-p0[1])-(p2[0]-p0[0])*(p1[1]-p0[1])
    assert twice_area > 0
    area = twice_area/2
    gradients = [( (p1[1]-p2[1])/twice_area, (p2[0]-p1[0])/twice_area ),
                 ( (p2[1]-p0[1])/twice_area, (p0[0]-p2[0])/twice_area ),
                 ( (p0[1]-p1[1])/twice_area, (p1[0]-p0[0])/twice_area )]
    for i, ni in enumerate(ids):
        for j, nj in enumerate(ids):
            P[ni][nj] += area*sum(x*y for x,y in zip(gradients[i],gradients[j]))

free = [index for index,(x,y) in enumerate(nodes) if x not in (0,N) and y not in (0,N)]
matrix = [[P[i][j] for j in free] for i in free]
pivots = []
for col in range(len(free)):
    pivot = matrix[col][col]
    assert pivot > 0, "full scalar domain with outer Dirichlet must be SPD"
    pivots.append(pivot)
    for i in range(col+1,len(free)):
        for j in range(col+1,len(free)):
            matrix[i][j] -= matrix[i][col]*matrix[col][j]/pivot

edges = {}
for index, triangle in enumerate(triangles):
    for n0,n1 in zip(triangle,triangle[1:]+triangle[:1]):
        edges.setdefault(tuple(sorted((n0,n1))), []).append(index)
adjacency = {index:set() for index in range(len(triangles))}
for incident in edges.values():
    if len(incident)==2:
        a,b = incident
        if roles[a]==roles[b]=="air":
            adjacency[a].add(b); adjacency[b].add(a)
unvisited = {i for i,role in enumerate(roles) if role=="air"}
air_components=[]
while unvisited:
    seed = unvisited.pop(); pending=[seed]; component={seed}
    while pending:
        current=pending.pop()
        for neighbor in adjacency[current] & unvisited:
            unvisited.remove(neighbor); component.add(neighbor); pending.append(neighbor)
    air_components.append(component)
air_components.sort(key=len)
assert len(air_components)==2 and len(air_components[0])==2
island_nodes = {node for triangle in air_components[0] for node in triangles[triangle]}
assert all(nodes[node][0] not in (0,N) and nodes[node][1] not in (0,N) for node in island_nodes)
v = [F(int(i in island_nodes)) for i in range(len(nodes))]
energy = sum(v[i]*P[i][j]*v[j] for i in range(len(nodes)) for j in range(len(nodes)))
assert energy > 0
record = {"scope":"independent_exact_P1_algebra_only", "k_rad_per_m":0,
          "nodes":len(nodes), "triangles":len(triangles), "free_scalar_dofs":len(free),
          "air_component_triangle_counts":[len(c) for c in air_components],
          "island_has_outer_dirichlet":False,
          "full_scalar_stiffness_positive_definite":True,
          "exact_positive_ldl_pivots":[str(x) for x in pivots],
          "air_island_indicator_quadratic_form":str(energy),
          "Fullmag_runtime":"NOT VERIFIED"}
print(json.dumps({key:value for key,value in record.items() if key!="exact_positive_ldl_pivots"}))
