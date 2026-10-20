#pragma once

#include "cpu/mfem/transport/periodic_charge_potential.hpp"
#include <mfem.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <map>
#include <set>
#include <stdexcept>
#include <vector>

namespace fullmag::fem::transport::coincident_cut_v2 {

inline void require(bool condition, const char *message)
{
    if (!condition) throw std::invalid_argument(message);
}

using Point = std::array<long double, 3>;
inline Point difference(const double *a, const double *b)
{
    return {static_cast<long double>(a[0])-b[0], static_cast<long double>(a[1])-b[1],
        static_cast<long double>(a[2])-b[2]};
}
inline Point cross(const Point &a, const Point &b)
{
    return {a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]};
}
inline long double dot(const Point &a, const Point &b)
{
    return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
}

// Scale-free Tet4 quality and actual face connectivity, before any native solve.
inline void validate_mesh(const mfem::Mesh &mesh)
{
    require(mesh.Dimension()==3 && mesh.SpaceDimension()==3 && mesh.GetNodes()==nullptr &&
        mesh.GetNE()>0 && mesh.GetNV()>0 && mesh.GetNBE()>0,
        "coincident cut v2 requires a nonempty serial straight Tet4 mesh");
    std::vector<int> parent(mesh.GetNE());
    for (int i=0; i<mesh.GetNE(); ++i) parent[i]=i;
    const auto root = [&](int cell) {
        int result=cell;
        while(parent[result]!=result) result=parent[result];
        while(parent[cell]!=cell) { const int next=parent[cell]; parent[cell]=result; cell=next; }
        return result;
    };
    std::map<std::array<int,3>,int> faces;
    std::set<std::array<int,4>> cells;
    std::map<std::array<int,3>,int> incidence;
    for (int cell=0; cell<mesh.GetNE(); ++cell) {
        require(mesh.GetElementBaseGeometry(cell)==mfem::Geometry::TETRAHEDRON,
            "coincident cut v2 accepts Tet4 only");
        mfem::Array<int> vertices;
        mesh.GetElementVertices(cell,vertices);
        require(vertices.Size()==4,"coincident cut v2 requires four cell vertices");
        std::array<int,4> key{vertices[0],vertices[1],vertices[2],vertices[3]};
        std::sort(key.begin(),key.end());
        require(std::adjacent_find(key.begin(),key.end())==key.end() && cells.insert(key).second,
            "coincident cut v2 rejects repeated vertices or cells");
        long double edge_scale=0.0L;
        for(int a=0;a<4;++a) {
            const auto *point=mesh.GetVertex(vertices[a]);
            for(int c=0;c<3;++c) require(std::isfinite(point[c]),"coincident cut v2 coordinates must be finite");
            for(int b=0;b<a;++b) {
                const auto edge=difference(point,mesh.GetVertex(vertices[b]));
                edge_scale=std::max(edge_scale,std::sqrt(dot(edge,edge)));
            }
        }
        require(std::isfinite(edge_scale) && edge_scale>0.0L,"coincident cut v2 cell scale is invalid");
        auto a=difference(mesh.GetVertex(vertices[1]),mesh.GetVertex(vertices[0]));
        auto b=difference(mesh.GetVertex(vertices[2]),mesh.GetVertex(vertices[0]));
        auto c=difference(mesh.GetVertex(vertices[3]),mesh.GetVertex(vertices[0]));
        for(int axis=0;axis<3;++axis) { a[axis]/=edge_scale; b[axis]/=edge_scale; c[axis]/=edge_scale; }
        require(dot(a,cross(b,c))>1.0e-12L,"coincident cut v2 rejects nonpositive or degenerate Tet4");
        for(int omitted=0;omitted<4;++omitted) {
            std::array<int,3> face{};
            int index=0;
            for(int i=0;i<4;++i) if(i!=omitted) face[index++]=vertices[i];
            std::sort(face.begin(),face.end());
            require(++incidence[face]<=2,"coincident cut v2 rejects nonmanifold Tet4 faces");
            auto [found,inserted]=faces.emplace(face,cell);
            if(!inserted) parent[root(cell)]=root(found->second);
        }
    }
    const int component=root(0);
    for(int cell=1;cell<mesh.GetNE();++cell) require(root(cell)==component,
        "coincident cut v2 requires exactly one face-connected conductive loop");
}

struct FaceGeometry { Point unit_normal; long double area; };
inline FaceGeometry face_geometry(const mfem::Mesh &mesh,int boundary)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary,vertices);
    require(vertices.Size()==3,"coincident cut v2 requires triangular source faces");
    const auto *origin=mesh.GetVertex(vertices[0]);
    auto normal=cross(difference(mesh.GetVertex(vertices[1]),origin),
        difference(mesh.GetVertex(vertices[2]),origin));
    const auto magnitude=std::sqrt(dot(normal,normal));
    require(std::isfinite(magnitude) && magnitude>0.0L,"coincident cut v2 face area is invalid");
    int element=-1,info=0;
    mesh.GetBdrElementAdjacentElement(boundary,element,info);
    require(element>=0,"coincident cut v2 face has no cell owner");
    mfem::Array<int> cell;
    mesh.GetElementVertices(element,cell);
    int opposite=-1;
    for(int v:cell) if(std::find(vertices.begin(),vertices.end(),v)==vertices.end()) opposite=v;
    require(opposite>=0,"coincident cut v2 face does not bind its cell");
    if(dot(normal,difference(mesh.GetVertex(opposite),origin))>0.0L)
        for(auto &value:normal) value=-value;
    for(auto &value:normal) value/=magnitude;
    return {normal,magnitude/2.0L};
}

inline std::vector<std::pair<int,int>> match_vertices(const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,int minus,int plus)
{
    mfem::Array<int> left,right;
    mesh.GetBdrElementVertices(minus,left); mesh.GetBdrElementVertices(plus,right);
    require(left.Size()==3 && right.Size()==3,"coincident cut v2 requires triangular pairs");
    std::set<int> used;
    std::vector<std::pair<int,int>> pairs;
    for(int a:left) {
        int match=-1;
        for(int b:right) if(std::memcmp(mesh.GetVertex(a),mesh.GetVertex(b),3*sizeof(double))==0) {
            require(match<0,"coincident cut v2 vertex bijection is ambiguous"); match=b;
        }
        require(match>=0 && a!=match && ids.local_to_stable.at(a)!=ids.local_to_stable.at(match) &&
            used.insert(match).second,"coincident cut v2 requires distinct IDs and bit-identical paired xyz");
        pairs.emplace_back(a,match);
    }
    const auto first=face_geometry(mesh,minus), second=face_geometry(mesh,plus);
    require(std::abs(first.area-second.area)<=1.0e-12L*std::max(first.area,second.area),
        "coincident cut v2 paired face areas differ");
    Point normal_sum{};
    for(int c=0;c<3;++c) normal_sum[c]=first.unit_normal[c]+second.unit_normal[c];
    require(std::sqrt(dot(normal_sum,normal_sum))<=1.0e-10L,
        "coincident cut v2 paired outward normals are not opposite");
    return pairs;
}

} // namespace fullmag::fem::transport::coincident_cut_v2
