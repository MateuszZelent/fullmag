#pragma once
#include "fullmag_fem.h"
#include "frequency_domain/canonical_digest.hpp"
#include "cpu/mfem/transport/coincident_cut_v2.hpp"
#include <cstring>
#include <limits>

namespace fullmag::fem::transport::prepared_closed_loop_v2 {
using Digest = frequency_domain::CanonicalDigestBuilder;
using coincident_cut_v2::require;
inline std::uint64_t bits(double value) {
    require(std::isfinite(value), "prepared digest refuses nonfinite binary64");
    std::uint64_t result; std::memcpy(&result,&value,sizeof(result)); return result;
}
inline std::string text(const char *value, bool empty=false) {
    require(value!=nullptr,"prepared descriptor string is null");
    std::size_t length=0; while(length<256 && value[length]!=0) ++length;
    require(length<256 && (empty || length>0),"prepared descriptor string length is invalid");
    // Reject malformed UTF-8 before encoding exact authored bytes.
    for(std::size_t i=0;i<length;) {
        const auto first=static_cast<unsigned char>(value[i++]);
        if(first<128) continue;
        const unsigned count=first>=0xc2 && first<=0xdf?1:first>=0xe0 && first<=0xef?2:first>=0xf0 && first<=0xf4?3:0;
        require(count!=0 && count<=length-i,"prepared descriptor UTF-8 is invalid");
        const auto second=static_cast<unsigned char>(value[i]);
        require(!(first==0xe0 && second<0xa0) && !(first==0xed && second>=0xa0) && !(first==0xf0 && second<0x90) && !(first==0xf4 && second>=0x90),"prepared descriptor UTF-8 scalar is invalid");
        for(unsigned j=0;j<count;++j) require((static_cast<unsigned char>(value[i++])&0xc0)==0x80,"prepared descriptor UTF-8 continuation is invalid");
    }
    return {value,length};
}
inline std::array<std::uint8_t,32> digest_bytes(std::string value) {
    if(value.rfind("sha256:",0)==0) value.erase(0,7);
    require(value.size()==64,"prepared digest length is invalid");
    std::array<std::uint8_t,32> result{};
    for(std::size_t i=0;i<64;++i) {
        const char c=value[i]; require((c>='0' && c<='9') || (c>='a' && c<='f'),"prepared digest is not lowercase SHA-256");
        result[i/2]=static_cast<std::uint8_t>((result[i/2]<<4)|(c<='9'?c-'0':c-'a'+10));
    }
    return result;
}
inline void nested(Digest &digest, const char *name, const std::string &value) {
    const auto decoded=digest_bytes(value); digest.add_bytes(name,decoded.data(),decoded.size());
}
inline void vertices(Digest &d,const mfem::Mesh &mesh,const StableMeshVertexIdentities &ids,const std::vector<double> *potential=nullptr) {
    d.add_u64("vertex_count",mesh.GetNV());
    for(int i=0;i<mesh.GetNV();++i) {
        d.add_u64("vertex_id",ids.local_to_stable.at(i)); const auto *xyz=mesh.GetVertex(i);
        d.add_u64("vertex_x_bits",bits(xyz[0])); d.add_u64("vertex_y_bits",bits(xyz[1])); d.add_u64("vertex_z_bits",bits(xyz[2]));
        if(potential) d.add_u64("potential_v_bits",bits(potential->at(i)));
    }
}
inline void elements(Digest &d,const mfem::Mesh &mesh,const StableMeshVertexIdentities &ids,const std::vector<double> &sigma) {
    require(sigma.size()==static_cast<std::size_t>(mesh.GetNE()),"prepared conductivity count is invalid");
    d.add_u64("element_count",mesh.GetNE()); mfem::Array<int> v;
    const char *names[]={"cell_vertex_0_id","cell_vertex_1_id","cell_vertex_2_id","cell_vertex_3_id"};
    for(int i=0;i<mesh.GetNE();++i) {
        mesh.GetElementVertices(i,v); require(v.Size()==4,"prepared digest requires Tet4");
        for(int k=0;k<4;++k) d.add_u64(names[k],ids.local_to_stable.at(v[k]));
        require(std::isfinite(sigma[i]) && sigma[i]>0.0,"prepared conductivity is invalid"); d.add_u64("conductivity_spm_bits",bits(sigma[i]));
    }
}
inline std::string charge_digest(const std::string &prepared,const mfem::Mesh &mesh,const StableMeshVertexIdentities &ids,const std::vector<double> &potential,const std::vector<double> &sigma,double drop,double measured,double gauge,double residual) {
    Digest d("accepted_closed_loop_charge_field.v2"); nested(d,"prepared_execution_digest",prepared);
    d.add_string("periodic_operator_version","fem_charge_h1_periodic_jump.v2"); d.add_string("stable_vertex_id_version",ids.version);
    vertices(d,mesh,ids,&potential); elements(d,mesh,ids,sigma);
    d.add_u64("potential_drop_v_bits",bits(drop)); d.add_u64("measured_potential_jump_v_bits",bits(measured)); d.add_u64("gauge_mean_v_bits",bits(gauge)); d.add_u64("charge_relative_residual_bits",bits(residual));
    return d.sha256_hex();
}
inline std::string execution_digest(const fullmag_fem_prepared_closed_loop_request_v2 &r,const mfem::Mesh &mesh,const StableMeshVertexIdentities &ids,const std::vector<double> &sigma) {
    const auto &b=r.binding; const auto &c=*r.closed_geometry;
    Digest d("prepared_closed_loop_execution_input.v2");
    d.add_string("source_revision",text(b.source_revision));
    d.add_string("object_id",text(b.object_id));
    d.add_string("geometry_id",text(b.geometry_id));
    d.add_string("source_module_id",text(b.source_module_id));
    d.add_string("mesh_revision",text(b.mesh_revision));
    d.add_string("topology_revision",text(b.topology_revision));
    d.add_string("mesh_digest",text(b.mesh_digest));
    d.add_string("authored_input_digest",text(b.authored_input_digest));
    d.add_string("materials_digest",text(b.materials_digest));
    d.add_string("closure_revision",text(c.revision));
    d.add_string("closure_digest",text(c.digest));
    d.add_string("envelope_revision",text(b.envelope_revision));
    d.add_string("envelope_digest",text(b.envelope_digest));
    d.add_u64("stage_identity",b.stage_identity); d.add_u64("evaluation_time_s_bits",bits(b.evaluation_time_s)); d.add_u64("evaluated_envelope_multiplier_bits",bits(b.evaluated_envelope_multiplier));
    d.add_string("stable_vertex_id_version",ids.version); d.add_string("periodic_operator_version","fem_charge_h1_periodic_jump.v2"); d.add_string("closure_operator_version",text(c.operator_version));
    d.add_u64("execution_lane",r.base.execution_lane); d.add_u64("charge_gauge",r.base.charge_gauge); d.add_u64("maximum_iterations",r.base.maximum_iterations);
    d.add_u64("charge_relative_tolerance_bits",bits(r.base.relative_tolerance)); d.add_u64("charge_absolute_tolerance_bits",bits(r.base.absolute_tolerance)); d.add_u64("rt0_algebraic_tolerance_bits",bits(r.algebraic_relative_tolerance)); d.add_u64("physical_relative_gate_bits",bits(r.physical_relative_gate)); d.add_u64("physical_absolute_gate_a_bits",bits(r.physical_absolute_gate_a));
    vertices(d,mesh,ids); elements(d,mesh,ids,sigma);
    require(r.material_assignment_count>0 && r.material_parts && r.material_part_count>0 && r.material_part_count<=static_cast<std::uint64_t>(mesh.GetNE()),"prepared material map count is invalid");
    d.add_u64("material_assignment_count",r.material_assignment_count); d.add_u64("material_part_count",r.material_part_count);
    std::vector<int> owners(mesh.GetNE(),-1); std::string previous;
    for(std::uint64_t part=0;part<r.material_part_count;++part) {
        const auto &p=r.material_parts[part]; const auto id=text(p.part_id);
        require((part==0 || previous<id) && p.reserved==0 && p.material_assignment_index<r.material_assignment_count && p.element_ordinals && p.element_count>0 && p.element_count<=static_cast<std::uint64_t>(mesh.GetNE()),"prepared material part is invalid"); previous=id;
        d.add_string("part_id",id); d.add_u64("material_assignment_index",p.material_assignment_index); d.add_u64("part_element_count",p.element_count);
        for(std::uint64_t i=0;i<p.element_count;++i) {
            const auto ordinal=p.element_ordinals[i]; require(ordinal<static_cast<std::uint64_t>(mesh.GetNE()) && (i==0 || p.element_ordinals[i-1]<ordinal) && owners[ordinal]==-1,"prepared parts do not uniquely cover cells"); owners[ordinal]=static_cast<int>(part); d.add_u64("part_element_ordinal",ordinal);
        }
    }
    require(std::find(owners.begin(),owners.end(),-1)==owners.end(),"prepared material map has missing cells");
    require(r.boundary_faces && r.boundary_face_count==static_cast<std::uint64_t>(mesh.GetNBE()),"prepared boundary count is invalid");
    d.add_u64("boundary_face_count",r.boundary_face_count);
    std::array<std::uint64_t,3> previous_face{};
    const char *bn[]={"boundary_vertex_0_id","boundary_vertex_1_id","boundary_vertex_2_id"};
    for(std::uint64_t i=0;i<r.boundary_face_count;++i) {
        const auto &f=r.boundary_faces[i]; std::array<std::uint64_t,3> key{f.face_vertex_ids[0],f.face_vertex_ids[1],f.face_vertex_ids[2]};
        require(key[0]<key[1] && key[1]<key[2] && (i==0 || previous_face<key),"prepared boundary keys are not canonical"); previous_face=key;
        for(int k=0;k<3;++k) d.add_u64(bn[k],key[k]); d.add_u64("boundary_role",f.role); d.add_string("boundary_circuit_id",text(f.circuit_id,true));
    }
    require(c.source_cuts && c.source_cut_count==1,"prepared closure requires one cut"); const auto &cut=c.source_cuts[0];
    d.add_u64("source_cut_count",1); d.add_string("source_cut_id",text(cut.id));
    d.add_u64("translation_x_bits",bits(cut.translation_m[0])); d.add_u64("translation_y_bits",bits(cut.translation_m[1])); d.add_u64("translation_z_bits",bits(cut.translation_m[2])); d.add_u64("potential_drop_v_bits",bits(cut.potential_drop_v));
    require(cut.face_pairs && cut.face_pair_count>0 && cut.face_pair_count<=r.boundary_face_count/2,"prepared cut pair count is invalid"); d.add_u64("source_pair_count",cut.face_pair_count);
    std::array<std::uint64_t,6> previous_pair{};
    const char *pn[]={"minus_vertex_0_id","minus_vertex_1_id","minus_vertex_2_id","plus_vertex_0_id","plus_vertex_1_id","plus_vertex_2_id"};
    for(std::uint64_t i=0;i<cut.face_pair_count;++i) {
        const auto &p=cut.face_pairs[i]; std::array<std::uint64_t,6> key{p.minus_face_vertex_ids[0],p.minus_face_vertex_ids[1],p.minus_face_vertex_ids[2],p.plus_face_vertex_ids[0],p.plus_face_vertex_ids[1],p.plus_face_vertex_ids[2]};
        require(key[0]<key[1] && key[1]<key[2] && key[3]<key[4] && key[4]<key[5] && (i==0 || previous_pair<key),"prepared cut pairs are not canonical"); previous_pair=key; for(int k=0;k<6;++k) d.add_u64(pn[k],key[k]);
    }
    require(r.observations && r.observation_count>0 && r.observation_count<=static_cast<std::uint64_t>(mesh.GetNE())*4,"prepared observation count is invalid");
    d.add_u64("observation_count",r.observation_count); previous.clear();
    std::map<std::uint64_t,int> local; for(int i=0;i<mesh.GetNV();++i) local.emplace(ids.local_to_stable.at(i),i);
    std::set<std::array<std::uint64_t,3>> seen_observation_faces;
    const char *on[]={"observation_vertex_0_id","observation_vertex_1_id","observation_vertex_2_id"};
    for(std::uint64_t i=0;i<r.observation_count;++i) {
        const auto &o=r.observations[i]; const auto id=text(o.id),part=text(o.part_id),selector=text(o.selector);
        require((i==0 || previous<id) && (selector=="local_u_min" || selector=="local_u_max") && text(o.normal_convention)=="outward_from_part" && o.faces && o.face_count>0 && o.face_count<=static_cast<std::uint64_t>(mesh.GetNE())*4,"prepared observation is invalid"); previous=id;
        d.add_string("observation_id",id); d.add_string("observation_part_id",part); d.add_string("observation_selector",selector); d.add_string("normal_convention","outward_from_part"); d.add_u64("observation_face_count",o.face_count);
        std::array<std::uint64_t,5> previous_observation{};
        for(std::uint64_t j=0;j<o.face_count;++j) {
            const auto &f=o.faces[j]; std::array<std::uint64_t,5> key{f.face_vertex_ids[0],f.face_vertex_ids[1],f.face_vertex_ids[2],f.part_cell_ordinal,f.bridge_cell_ordinal};
            require(key[0]<key[1] && key[0]<key[2] && key[1]!=key[2] && (j==0 || previous_observation<key) && f.part_cell_ordinal<static_cast<std::uint64_t>(mesh.GetNE()) && f.bridge_cell_ordinal<static_cast<std::uint64_t>(mesh.GetNE()) && f.part_cell_ordinal!=f.bridge_cell_ordinal,"prepared observation ownership is invalid"); previous_observation=key;
            std::array<std::uint64_t,3> sorted{key[0],key[1],key[2]}; std::sort(sorted.begin(),sorted.end()); require(seen_observation_faces.insert(sorted).second,"prepared observation faces overlap");
            require(text(r.material_parts[owners[f.part_cell_ordinal]].part_id)==part && owners[f.part_cell_ordinal]!=owners[f.bridge_cell_ordinal],"prepared observation does not belong to its part/bridge");
            int opposite=-1; mfem::Array<int> v;
            for(const auto cell:{f.part_cell_ordinal,f.bridge_cell_ordinal}) {
                mesh.GetElementVertices(static_cast<int>(cell),v); int matched=0;
                for(int k=0;k<4;++k) { const auto sid=ids.local_to_stable.at(v[k]); if(std::find(sorted.begin(),sorted.end(),sid)!=sorted.end()) ++matched; else if(cell==f.part_cell_ordinal) opposite=v[k]; }
                require(matched==3,"prepared observation face is not shared by declared Tet4 owners");
            }
            const auto *a=mesh.GetVertex(local.at(key[0])); const auto normal=coincident_cut_v2::cross(coincident_cut_v2::difference(mesh.GetVertex(local.at(key[1])),a),coincident_cut_v2::difference(mesh.GetVertex(local.at(key[2])),a));
            require(opposite>=0 && coincident_cut_v2::dot(normal,coincident_cut_v2::difference(mesh.GetVertex(opposite),a))<0.0L,"prepared observation normal is not outward from part");
            for(int k=0;k<3;++k) d.add_u64(on[k],key[k]); d.add_u64("part_cell_ordinal",key[3]); d.add_u64("bridge_cell_ordinal",key[4]);
        }
    }
    return d.sha256_hex();
}
} // namespace fullmag::fem::transport::prepared_closed_loop_v2
