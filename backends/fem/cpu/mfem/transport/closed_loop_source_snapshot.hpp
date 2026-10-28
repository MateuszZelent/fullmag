#pragma once
#include "fullmag_fem.h"
#include "cpu/mfem/transport/conservative_current_view.hpp"
#include "cpu/mfem/transport/coincident_cut_v2.hpp"
#include "cpu/mfem/transport/affine_rt0_element.hpp"
#include "cpu/mfem/transport/prepared_closed_loop_digest_v2.hpp"
#include <cstdio>
#include <tuple>

namespace fullmag::fem::transport {

inline void export_closed_loop_source_snapshot(const ConservativeCurrentView &view,
    const ClosedGeometryCurrentClosure &closure, const PeriodicChargePotentialSnapshot &potential,
    fullmag_fem_closed_loop_source_snapshot_result_v2 &output,
    fullmag_fem_prepared_closed_loop_source_snapshot_result_v2 *prepared_output=nullptr)
{
    using coincident_cut_v2::require;
    const auto &field=view.field();
    const auto &mesh=*view.space().GetMesh();
    const auto &ids=view.stable_vertex_identities();
    std::vector<fullmag_fem_closed_loop_current_cell_v2> sampled(mesh.GetNE());
    mfem::Array<int> vertices;
    for(int element=0;element<mesh.GetNE();++element) {
        auto &cell=sampled[element];
        cell.source_element_index=static_cast<std::uint64_t>(element);
        mesh.GetElementVertices(element,vertices);
        const AffineRt0Element evaluator(field,element);
        std::array<double,3> center{};
        for(int axis=0;axis<3;++axis) {
            long double value=0.0L;
            for(int local=0;local<4;++local) value+=static_cast<long double>(mesh.GetVertex(vertices[local])[axis])/4.0L;
            center[axis]=static_cast<double>(value);
            require(std::isfinite(value) && std::isfinite(center[axis]) && (value==0.0L || center[axis]!=0.0),
                "closed-loop J center is not representable");
            cell.center_xyz_m[axis]=center[axis];
        }
        for(int local=0;local<4;++local) {
            cell.vertex_ids[local]=ids.local_to_stable.at(vertices[local]);
            const auto *point=mesh.GetVertex(vertices[local]);
            const auto current=evaluator.retained_current_at({point[0],point[1],point[2]});
            for(int axis=0;axis<3;++axis) {
                require(std::isfinite(current[axis]),"closed-loop J trace is nonfinite");
                cell.vertex_xyz_m[3*local+axis]=point[axis];
                cell.vertex_current_xyz_apm2[3*local+axis]=current[axis];
            }
        }
        const auto current=evaluator.retained_current_at(center);
        for(int axis=0;axis<3;++axis) {
            require(std::isfinite(current[axis]),"closed-loop center J is nonfinite");
            cell.center_current_xyz_apm2[axis]=current[axis];
        }
    }
    std::map<std::array<std::uint64_t,3>,int> boundaries;
    for(int boundary=0;boundary<mesh.GetNBE();++boundary) {
        mesh.GetBdrElementVertices(boundary,vertices);
        std::array<std::uint64_t,3> key{ids.local_to_stable.at(vertices[0]),ids.local_to_stable.at(vertices[1]),ids.local_to_stable.at(vertices[2])};
        std::sort(key.begin(),key.end()); boundaries.emplace(key,boundary);
    }
    const auto &records=view.canonical_face_flux_records();
    long double source_current=0.0L,absolute_flux=0.0L;
    for(const auto &pair:closure.source_cuts.front().face_pairs) {
        const int boundary=boundaries.at(pair.minus_face_vertex_ids);
        mesh.GetBdrElementVertices(boundary,vertices);
        const auto normal=coincident_cut_v2::face_geometry(mesh,boundary).unit_normal;
        std::array<std::pair<std::uint64_t,int>,3> ordered;
        for(int local=0;local<3;++local) ordered[local]={ids.local_to_stable.at(vertices[local]),vertices[local]};
        std::sort(ordered.begin(),ordered.end());
        const auto cross=coincident_cut_v2::cross(
            coincident_cut_v2::difference(mesh.GetVertex(ordered[1].second),mesh.GetVertex(ordered[0].second)),
            coincident_cut_v2::difference(mesh.GetVertex(ordered[2].second),mesh.GetVertex(ordered[0].second)));
        const auto found=std::lower_bound(records.begin(),records.end(),pair.minus_face_vertex_ids,
            [](const auto &record,const auto &key) { return record.face_vertex_ids<key; });
        require(found!=records.end() && found->face_vertex_ids==pair.minus_face_vertex_ids,
            "closed-loop source current lost its canonical face record");
        const long double orientation=coincident_cut_v2::dot(cross,normal);
        require(std::isfinite(orientation) && orientation!=0.0L,"closed-loop source orientation is invalid");
        const long double outward=(orientation>0.0L?1.0L:-1.0L)*found->flux_a;
        source_current+=outward; absolute_flux+=std::abs(outward);
    }
    const double current=static_cast<double>(source_current),scale=static_cast<double>(absolute_flux);
    require(std::isfinite(source_current) && std::isfinite(absolute_flux) && std::isfinite(current) &&
        std::isfinite(scale) && (source_current==0.0L || current!=0.0) && (absolute_flux==0.0L || scale!=0.0),
        "closed-loop signed source current is not representable");
    require(sampled.size()<=output.cells_capacity,"closed-loop source snapshot capacity changed");
    auto reactions=potential.paired_weak_reactions_v2();
    std::sort(reactions.begin(),reactions.end(),[](const auto &a,const auto &b){return std::tie(a.minus_vertex_id,a.plus_vertex_id)<std::tie(b.minus_vertex_id,b.plus_vertex_id);});
    require(!reactions.empty() && reactions.size()<=output.paired_weak_reactions_capacity, "closed-loop weak reaction ledger capacity mismatch");
    for(std::size_t i=0;i<reactions.size();++i) {
        const auto &row=reactions[i];
        output.paired_weak_reactions[i]={row.minus_vertex_id,row.plus_vertex_id,row.minus_reaction_a,row.plus_reaction_a};
    }
    std::snprintf(output.weak_reaction_ledger_version,sizeof(output.weak_reaction_ledger_version),"%s","original_k_paired_vertex_reactions.v2");
    output.paired_weak_reactions_len=reactions.size();
    output.source_current_a=current;
    output.source_absolute_flux_a=scale;
    output.charge_relative_residual=potential.algebraic_relative_residual();
    output.potential_jump_v=potential.potential_jump_v();
    output.gauge_mean_v=potential.gauge_mean_v();
    output.max_paired_weak_flux_mismatch_a=potential.max_paired_weak_flux_mismatch_a();
    std::snprintf(output.source_view_identity_digest,sizeof(output.source_view_identity_digest),"%s",view.identity().view_identity_digest.c_str());
    std::snprintf(output.periodic_operator_version,sizeof(output.periodic_operator_version),"%s",potential.operator_version().c_str());
    std::snprintf(output.closure_operator_version,sizeof(output.closure_operator_version),"%s",closure.operator_version.c_str());
    std::copy(sampled.begin(),sampled.end(),output.cells);
    if(prepared_output) {
        namespace codec=prepared_closed_loop_v2;
        const auto &certificate=view.canonical_balance_certificate_bytes();
        require(!potential.prepared_execution_digest().empty() && prepared_output->canonical_balance_certificate_bytes && certificate.size()<=prepared_output->canonical_balance_certificate_capacity && certificate.size()<=FULLMAG_FEM_PREPARED_CLOSED_LOOP_CERTIFICATE_MAX_BYTES,"prepared source certificate/binding capacity mismatch");
        codec::Digest d("accepted_closed_loop_source_state.v2");
        codec::nested(d,"prepared_execution_digest",potential.prepared_execution_digest()); codec::nested(d,"accepted_charge_field_digest",potential.accepted_charge_field_digest());
        d.add_string("conservative_current_operator_version",ConservativeCurrentView::operator_version); d.add_string("sampling_policy","cell_center_and_cell_local_vertices.v1"); d.add_string("source_current_orientation","authored_minus_outward.v1");
        d.add_u64("source_current_a_bits",codec::bits(current)); d.add_u64("source_absolute_flux_a_bits",codec::bits(scale));
        d.add_u64("canonical_face_count",records.size());
        const char *face_names[]={"face_vertex_0_id","face_vertex_1_id","face_vertex_2_id"};
        for(const auto &row:records) { for(int k=0;k<3;++k) d.add_u64(face_names[k],row.face_vertex_ids[k]); d.add_u64("flux_a_bits",codec::bits(row.flux_a)); }
        d.add_bytes("canonical_balance_certificate",certificate.data(),certificate.size()); d.add_string("weak_reaction_ledger_version","original_k_paired_vertex_reactions.v2"); d.add_u64("paired_weak_reaction_count",reactions.size());
        for(const auto &row:reactions) { d.add_u64("minus_vertex_id",row.minus_vertex_id); d.add_u64("plus_vertex_id",row.plus_vertex_id); d.add_u64("minus_reaction_a_bits",codec::bits(row.minus_reaction_a)); d.add_u64("plus_reaction_a_bits",codec::bits(row.plus_reaction_a)); }
        d.add_u64("max_paired_weak_flux_mismatch_a_bits",codec::bits(potential.max_paired_weak_flux_mismatch_a())); d.add_u64("sampled_cell_count",sampled.size());
        const char *xyz_names[]={"vertex_x_bits","vertex_y_bits","vertex_z_bits"},*j_names[]={"current_x_apm2_bits","current_y_apm2_bits","current_z_apm2_bits"},*center_names[]={"center_x_bits","center_y_bits","center_z_bits"},*center_j_names[]={"center_current_x_apm2_bits","center_current_y_apm2_bits","center_current_z_apm2_bits"};
        for(const auto &cell:sampled) {
            d.add_u64("source_element_index",cell.source_element_index);
            for(int local=0;local<4;++local) { d.add_u64("vertex_id",cell.vertex_ids[local]); for(int axis=0;axis<3;++axis)d.add_u64(xyz_names[axis],codec::bits(cell.vertex_xyz_m[3*local+axis])); for(int axis=0;axis<3;++axis)d.add_u64(j_names[axis],codec::bits(cell.vertex_current_xyz_apm2[3*local+axis])); }
            for(int axis=0;axis<3;++axis)d.add_u64(center_names[axis],codec::bits(cell.center_xyz_m[axis])); for(int axis=0;axis<3;++axis)d.add_u64(center_j_names[axis],codec::bits(cell.center_current_xyz_apm2[axis]));
        }
        const auto source_digest=d.sha256_hex();
        std::snprintf(prepared_output->prepared_execution_digest,65,"%s",potential.prepared_execution_digest().c_str()); std::snprintf(prepared_output->accepted_charge_field_digest,65,"%s",potential.accepted_charge_field_digest().c_str()); std::snprintf(prepared_output->accepted_source_state_digest,65,"%s",source_digest.c_str());
        std::snprintf(prepared_output->digest_encoding_version,96,"%s","canonical_named_fields_be_bits.v2"); std::snprintf(prepared_output->prepared_digest_version,96,"%s","prepared_closed_loop_execution_input.v2"); std::snprintf(prepared_output->accepted_charge_digest_version,96,"%s","accepted_closed_loop_charge_field.v2"); std::snprintf(prepared_output->accepted_source_digest_version,96,"%s","accepted_closed_loop_source_state.v2");
        std::copy(certificate.begin(),certificate.end(),prepared_output->canonical_balance_certificate_bytes); prepared_output->canonical_balance_certificate_len=certificate.size();
    }
    output.cells_len=sampled.size();
    output.error_message[0]='\0';
}

} // namespace fullmag::fem::transport
