//! Input-only prepared admission and independently retained accepted evidence.
use super::*;
use fullmag_ir::ResolvedAntennaClosedLoopCurrentInputIR;
use serde::Serialize;
use std::ffi::c_char;

#[derive(Debug,Clone)]
pub(crate) struct NativeFemPreparedClosedLoopChargeRequest {
    pub mesh:MeshIR,pub execution:NativeFemSteadyTransportExecution,pub gauge:NativeFemSteadyTransportGauge,
    pub charge_conductivity_spm_per_element:Vec<f64>,pub relative_tolerance:f64,pub absolute_tolerance:f64,pub maximum_iterations:u32,
}
#[derive(Debug,Clone)]
pub(crate) struct PreparedClosedLoopRuntimeBinding {
    pub source_module_id:String, pub mesh_revision:String, pub topology_revision:String,
    pub envelope_revision:String, pub envelope_digest:String,
    pub stage_identity:u64, pub evaluation_time_s:f64, pub evaluated_envelope_multiplier:f64,
}
#[derive(Debug,Clone,Serialize)]
pub(crate) struct PreparedTerminalObservationCurrent {
    pub id:String,pub part_id:String,pub selector:String,pub normal_convention:String,
    pub current_a:f64,pub absolute_flux_a:f64,
}
#[derive(Debug,Clone,Serialize)]
pub(crate) struct PreparedClosedLoopAcceptedSnapshot {
    pub source:ClosedLoopSourceSnapshot,
    pub prepared_execution_digest:String,pub accepted_charge_field_digest:String,pub accepted_source_state_digest:String,
    pub digest_encoding:String,pub prepared_execution_preimage:Vec<u8>,pub accepted_charge_field_preimage:Vec<u8>,pub accepted_source_state_preimage:Vec<u8>,
    pub canonical_balance_certificate:Vec<u8>,pub terminal_observation_currents:Vec<PreparedTerminalObservationCurrent>,
}
fn bad(s:&str)->RunError { RunError{message:format!("prepared closed-loop v2 refused: {s}")} }
struct Encoder { codec:crate::antenna_field_solution::closed_loop_identity_v2::NamedFieldsBuilder }
impl Encoder {
    fn new(domain:&str)->Result<Self,RunError>{Ok(Self{codec:crate::antenna_field_solution::closed_loop_identity_v2::NamedFieldsBuilder::new(domain)})}
    fn field(&mut self,name:&str,tag:u8,value:&[u8])->Result<(),RunError>{
        let extra=17usize.checked_add(name.len()).and_then(|n|n.checked_add(value.len())).ok_or_else(||bad("preimage length overflow"))?;
        self.codec.payload.try_reserve(extra).map_err(|_|bad("preimage allocation failed"))?;
        match tag {1=>self.codec.add_string(name,std::str::from_utf8(value).map_err(|_|bad("UTF-8"))?),2=>self.codec.add_u64(name,u64::from_be_bytes(value.try_into().map_err(|_|bad("u64"))?)),3=>self.codec.add_bytes(name,value),_=>return Err(bad("field tag"))};Ok(())
    }
    fn string(&mut self,n:&str,v:&str)->Result<(),RunError>{if v.len()>=256 || v.contains('\0'){return Err(bad("bounded UTF-8 label"));}self.field(n,1,v.as_bytes())}
    fn u64(&mut self,n:&str,v:u64)->Result<(),RunError>{self.field(n,2,&v.to_be_bytes())}
    fn bits(&mut self,n:&str,v:f64)->Result<(),RunError>{if !v.is_finite(){return Err(bad("nonfinite raw bits"));}self.u64(n,v.to_bits())}
    fn nested(&mut self,n:&str,v:&str)->Result<(),RunError>{let v=v.strip_prefix("sha256:").unwrap_or(v);if v.len()!=64 || !v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(bad("noncanonical SHA-256"));}let bytes=(0..32).map(|i|u8::from_str_radix(&v[2*i..2*i+2],16).map_err(|_|bad("invalid digest"))).collect::<Result<Vec<_>,_>>()?;self.field(n,3,&bytes)}
    fn hash(&self)->String {self.codec.sha256_hex()}
}
fn vertices(d:&mut Encoder,input:&ResolvedAntennaClosedLoopCurrentInputIR,v:Option<&[f64]>)->Result<(),RunError>{
    d.u64("vertex_count",input.source_mesh.nodes.len() as u64)?;
    for (i,xyz) in input.source_mesh.nodes.iter().enumerate(){d.u64("vertex_id",input.source.stable_vertex_ids[i])?;for (n,x) in ["vertex_x_bits","vertex_y_bits","vertex_z_bits"].into_iter().zip(xyz){d.bits(n,*x)?;}if let Some(v)=v{d.bits("potential_v_bits",v[i])?;}}Ok(())
}
fn elements(d:&mut Encoder,input:&ResolvedAntennaClosedLoopCurrentInputIR)->Result<(),RunError>{
    let cells=input.source_mesh.cells.require_tet4().map_err(|_|bad("Tet4 required"))?;d.u64("element_count",cells.len() as u64)?;
    for (i,c) in cells.iter().enumerate(){for (n,node) in ["cell_vertex_0_id","cell_vertex_1_id","cell_vertex_2_id","cell_vertex_3_id"].into_iter().zip(c){d.u64(n,input.source.stable_vertex_ids[*node as usize])?;}d.bits("conductivity_spm_bits",input.conductivity_spm_per_element[i])?;}Ok(())
}
fn execution(input:&ResolvedAntennaClosedLoopCurrentInputIR,b:&PreparedClosedLoopRuntimeBinding,request:&NativeFemPreparedClosedLoopChargeRequest)->Result<Encoder,RunError>{
    let ConservativeCurrentClosureIR::ClosedGeometry{operator_version,revision,digest,source_cuts}= &input.source.closure else{return Err(bad("closed closure required"));};
    let mut d=Encoder::new("prepared_closed_loop_execution_input.v2")?;let s=&input.source;
    for (n,v) in [("source_revision",&s.revision),("object_id",&s.object_id),("geometry_id",&s.geometry_id),("source_module_id",&b.source_module_id),("mesh_revision",&b.mesh_revision),("topology_revision",&b.topology_revision),("mesh_digest",&s.mesh_digest),("authored_input_digest",&s.authored_input_digest),("materials_digest",&s.materials_digest),("closure_revision",revision),("closure_digest",digest),("envelope_revision",&b.envelope_revision),("envelope_digest",&b.envelope_digest)]{d.string(n,v)?;}
    d.u64("stage_identity",b.stage_identity)?;d.bits("evaluation_time_s_bits",b.evaluation_time_s)?;d.bits("evaluated_envelope_multiplier_bits",b.evaluated_envelope_multiplier)?;
    d.string("stable_vertex_id_version","stable_mesh_vertex_u64.v1")?;d.string("periodic_operator_version","fem_charge_h1_periodic_jump.v2")?;d.string("closure_operator_version",operator_version)?;
    for (n,v) in [("execution_lane",1),("charge_gauge",2),("maximum_iterations",request.maximum_iterations as u64)]{d.u64(n,v)?;}
    for (n,v) in [("charge_relative_tolerance_bits",request.relative_tolerance),("charge_absolute_tolerance_bits",request.absolute_tolerance),("rt0_algebraic_tolerance_bits",input.algebraic_relative_tolerance),("physical_relative_gate_bits",input.physical_relative_gate),("physical_absolute_gate_a_bits",input.physical_absolute_gate_a)]{d.bits(n,v)?;}
    vertices(&mut d,input,None)?;elements(&mut d,input)?;
    d.u64("material_assignment_count",input.authored_definition.materials.len() as u64)?;d.u64("material_part_count",s.material_parts.len() as u64)?;
    for p in &s.material_parts{d.string("part_id",&p.part_id)?;d.u64("material_assignment_index",p.material_assignment_index as u64)?;d.u64("part_element_count",p.element_ordinals.len() as u64)?;for i in &p.element_ordinals{d.u64("part_element_ordinal",*i)?;}}
    d.u64("boundary_face_count",input.boundary_roles.len() as u64)?;
    for f in &input.boundary_roles{for (n,id) in ["boundary_vertex_0_id","boundary_vertex_1_id","boundary_vertex_2_id"].into_iter().zip(f.face_vertex_ids){d.u64(n,id)?;}d.u64("boundary_role",match f.role{fullmag_ir::ConservativeCurrentBoundaryRoleIR::InsulatingOuter=>1,fullmag_ir::ConservativeCurrentBoundaryRoleIR::SourceCut=>2,fullmag_ir::ConservativeCurrentBoundaryRoleIR::ClosureInterface=>3})?;d.string("boundary_circuit_id",f.circuit_id.as_deref().unwrap_or(""))?;}
    d.u64("source_cut_count",source_cuts.len() as u64)?;
    for cut in source_cuts{d.string("source_cut_id",&cut.id)?;for (n,v) in ["translation_x_bits","translation_y_bits","translation_z_bits"].into_iter().zip(cut.translation_m){d.bits(n,v)?;}d.bits("potential_drop_v_bits",cut.potential_drop_v)?;d.u64("source_pair_count",cut.face_pairs.len() as u64)?;for p in &cut.face_pairs{for (n,id) in ["minus_vertex_0_id","minus_vertex_1_id","minus_vertex_2_id","plus_vertex_0_id","plus_vertex_1_id","plus_vertex_2_id"].into_iter().zip(p.minus_face_vertex_ids.into_iter().chain(p.plus_face_vertex_ids)){d.u64(n,id)?;}}}
    d.u64("observation_count",s.terminal_observations.len() as u64)?;
    for o in &s.terminal_observations{for (n,v) in [("observation_id",&o.id),("observation_part_id",&o.part_id),("observation_selector",&o.selector),("normal_convention",&o.normal_convention)]{d.string(n,v)?;}d.u64("observation_face_count",o.faces.len() as u64)?;for f in &o.faces{for (n,id) in ["observation_vertex_0_id","observation_vertex_1_id","observation_vertex_2_id"].into_iter().zip(f.face_vertex_ids){d.u64(n,id)?;}d.u64("part_cell_ordinal",f.part_cell_ordinal)?;d.u64("bridge_cell_ordinal",f.bridge_cell_ordinal)?;}}Ok(d)
}

pub(super) struct PreparedRequestBuffer<'a>{
    pub input:&'a ResolvedAntennaClosedLoopCurrentInputIR, pub binding:&'a PreparedClosedLoopRuntimeBinding,
    strings:Vec<CString>,parts:Vec<ffi::fullmag_fem_prepared_closed_loop_material_part_v2>,
    _observation_faces:Vec<Vec<ffi::fullmag_fem_prepared_closed_loop_observation_face_v2>>,observations:Vec<ffi::fullmag_fem_prepared_closed_loop_observation_v2>,
    execution:Encoder,pub outer:ffi::fullmag_fem_prepared_closed_loop_source_snapshot_result_v2,certificate:Vec<u8>,
}
impl<'a> PreparedRequestBuffer<'a>{
    pub(super) fn new(input:&'a ResolvedAntennaClosedLoopCurrentInputIR,binding:&'a PreparedClosedLoopRuntimeBinding,request:&NativeFemPreparedClosedLoopChargeRequest)->Result<Self,RunError>{
        let n=input.source_mesh.nodes.len();let cells=input.source_mesh.cell_count();
        if request.execution!=NativeFemSteadyTransportExecution::CpuDouble || request.gauge!=NativeFemSteadyTransportGauge::ZeroMeanPotential || request.mesh.element_markers.len()!=cells || request.mesh.facet_count()!=request.mesh.boundary_markers.len() || !request.mesh.periodic_boundary_pairs.is_empty() || !request.mesh.periodic_node_pairs.is_empty() || request.charge_conductivity_spm_per_element.iter().any(|s|!s.is_finite() || *s<=0.0){return Err(bad("pure-charge CPU/gauge/mesh/material preflight"));}
        if n==0 || n>4*ffi::FULLMAG_FEM_CLOSED_LOOP_SOURCE_SNAPSHOT_MAX_CELLS || cells==0 || cells>ffi::FULLMAG_FEM_CLOSED_LOOP_SOURCE_SNAPSHOT_MAX_CELLS || input.source.stable_vertex_ids.len()!=n || input.conductivity_spm_per_element.len()!=cells || input.boundary_roles.len()>4*cells || !input.source.validation_errors("source").is_empty(){return Err(bad("prepared counts or input contract"));}
        for cell in input.source_mesh.cells.require_tet4().map_err(|_|bad("Tet4 required"))?{if cell.iter().any(|v|*v as usize>=n){return Err(bad("vertex ordinal outside mesh"));}}
        if request.mesh != input.source_mesh || request.charge_conductivity_spm_per_element!=input.conductivity_spm_per_element || request.relative_tolerance!=1e-12 || request.absolute_tolerance!=0.0 || request.maximum_iterations==0 || input.algebraic_relative_tolerance!=1e-12 || input.physical_relative_gate!=1e-10 || input.physical_absolute_gate_a!=1e-18{return Err(bad("resolved mesh/material/gates differ from numeric request"));}
        let mut ownership=vec![false;cells];
        for part in &input.source.material_parts {
            let material=input.authored_definition.materials.get(part.material_assignment_index as usize).ok_or_else(||bad("part material assignment absent"))?;
            if material.material.sigma_parallel_spm.is_some() || material.material.sigma_perpendicular_spm.is_some() || material.material.sigma_ahe_spm.is_some(){return Err(bad("prepared scalar conductivity contract"));}
            for ordinal in &part.element_ordinals {let ordinal=usize::try_from(*ordinal).map_err(|_|bad("material ordinal overflow"))?;if ordinal>=cells || ownership[ordinal] || input.conductivity_spm_per_element[ordinal].to_bits()!=material.material.sigma_spm.to_bits(){return Err(bad("material coverage or sole-owner conductivity mismatch"));}ownership[ordinal]=true;}
        }
        if ownership.iter().any(|owned|!*owned){return Err(bad("incomplete material coverage"));}
        let execution=execution(input,binding,request)?;let hash=execution.hash();
        let mut texts=vec![input.source.revision.as_str(),input.source.object_id.as_str(),input.source.geometry_id.as_str(),binding.source_module_id.as_str(),binding.mesh_revision.as_str(),binding.topology_revision.as_str(),input.source.mesh_digest.as_str(),input.source.authored_input_digest.as_str(),input.source.materials_digest.as_str(),binding.envelope_revision.as_str(),binding.envelope_digest.as_str(),hash.as_str(),"transport_constitutive.one_way.fullmag.v1","fem_charge_conforming_h1_p1.transparent.v1","charge_balance_integrated_l2.v1"];
        for p in &input.source.material_parts{texts.push(&p.part_id);}for o in &input.source.terminal_observations{texts.extend([o.id.as_str(),o.part_id.as_str(),o.selector.as_str(),o.normal_convention.as_str()]);}
        let strings=texts.iter().map(|s|c_string(s,"prepared input label")).collect::<Result<Vec<_>,_>>()?;
        let parts=input.source.material_parts.iter().enumerate().map(|(i,p)|ffi::fullmag_fem_prepared_closed_loop_material_part_v2{part_id:strings[15+i].as_ptr(),material_assignment_index:p.material_assignment_index,reserved:0,element_ordinals:const_ptr(&p.element_ordinals),element_count:p.element_ordinals.len() as u64}).collect();
        let observation_faces=input.source.terminal_observations.iter().map(|o|o.faces.iter().map(|f|ffi::fullmag_fem_prepared_closed_loop_observation_face_v2{face_vertex_ids:f.face_vertex_ids,part_cell_ordinal:f.part_cell_ordinal,bridge_cell_ordinal:f.bridge_cell_ordinal}).collect::<Vec<_>>()).collect::<Vec<_>>();
        let observations=input.source.terminal_observations.iter().enumerate().map(|(i,_)|{let k=15+input.source.material_parts.len()+4*i;ffi::fullmag_fem_prepared_closed_loop_observation_v2{id:strings[k].as_ptr(),part_id:strings[k+1].as_ptr(),selector:strings[k+2].as_ptr(),normal_convention:strings[k+3].as_ptr(),faces:const_ptr(&observation_faces[i]),face_count:observation_faces[i].len() as u64}}).collect();
        let mut certificate=Vec::new();certificate.try_reserve_exact(ffi::FULLMAG_FEM_PREPARED_CLOSED_LOOP_CERTIFICATE_MAX_BYTES).map_err(|_|bad("certificate allocation failed"))?;certificate.resize(ffi::FULLMAG_FEM_PREPARED_CLOSED_LOOP_CERTIFICATE_MAX_BYTES,0);
        let dummy=SourceSnapshotBuffer::new(1,1)?; let mut source=dummy.header; source.cells=ptr::null_mut();source.cells_capacity=0;source.paired_weak_reactions=ptr::null_mut();source.paired_weak_reactions_capacity=0;
        let outer=ffi::fullmag_fem_prepared_closed_loop_source_snapshot_result_v2{source,prepared_execution_digest:[0;65],accepted_charge_field_digest:[0;65],accepted_source_state_digest:[0;65],digest_encoding_version:[0;96],prepared_digest_version:[0;96],accepted_charge_digest_version:[0;96],accepted_source_digest_version:[0;96],canonical_balance_certificate_bytes:certificate.as_mut_ptr(),canonical_balance_certificate_capacity:certificate.len() as u64,canonical_balance_certificate_len:0};
        Ok(Self{input,binding,strings,parts,_observation_faces:observation_faces,observations,execution,outer,certificate})
    }
    pub(super) fn descriptor(&self,r:&ffi::fullmag_fem_steady_transport_rt0_request_v1)->ffi::fullmag_fem_prepared_closed_loop_request_v2{
        let b=&self.binding;let s=&self.strings;let numeric=&r.base;
        let base=ffi::fullmag_fem_charge_transport_request_v1{abi_version:ffi::FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION,reserved_flags:0,struct_size:std::mem::size_of::<ffi::fullmag_fem_charge_transport_request_v1>() as u64,execution_lane:numeric.execution_lane,charge_gauge:numeric.charge_gauge,constitutive_version:s[12].as_ptr(),operator_version:s[13].as_ptr(),physical_residual_version:s[14].as_ptr(),mesh:numeric.mesh,charge_conductivity_spm_per_element:numeric.charge_conductivity_spm_per_element,charge_conductivity_spm_per_element_len:numeric.charge_conductivity_spm_per_element_len,relative_tolerance:numeric.relative_tolerance,absolute_tolerance:numeric.absolute_tolerance,maximum_iterations:numeric.maximum_iterations,dirichlet_boundary_attributes:ptr::null(),dirichlet_boundary_values_v:ptr::null(),dirichlet_boundary_count:0};
        let binding=ffi::fullmag_fem_prepared_closed_loop_binding_v2{abi_version:2,reserved_flags:0,struct_size:std::mem::size_of::<ffi::fullmag_fem_prepared_closed_loop_binding_v2>() as u64,source_revision:s[0].as_ptr(),object_id:s[1].as_ptr(),geometry_id:s[2].as_ptr(),source_module_id:s[3].as_ptr(),mesh_revision:s[4].as_ptr(),topology_revision:s[5].as_ptr(),mesh_digest:s[6].as_ptr(),authored_input_digest:s[7].as_ptr(),materials_digest:s[8].as_ptr(),envelope_revision:s[9].as_ptr(),envelope_digest:s[10].as_ptr(),expected_prepared_execution_digest:s[11].as_ptr(),stage_identity:b.stage_identity,evaluation_time_s:b.evaluation_time_s,evaluated_envelope_multiplier:b.evaluated_envelope_multiplier};
        ffi::fullmag_fem_prepared_closed_loop_request_v2{abi_version:2,reserved_flags:0,struct_size:std::mem::size_of::<ffi::fullmag_fem_prepared_closed_loop_request_v2>() as u64,base,binding,stable_vertex_identities:r.stable_vertex_identities,boundary_faces:r.boundary_faces,boundary_face_count:r.boundary_face_count,closed_geometry:r.closed_geometry,material_assignment_count:self.input.authored_definition.materials.len() as u64,material_parts:const_ptr(&self.parts),material_part_count:self.parts.len() as u64,observations:const_ptr(&self.observations),observation_count:self.observations.len() as u64,algebraic_relative_tolerance:r.algebraic_relative_tolerance,physical_relative_gate:r.physical_relative_gate,physical_absolute_gate_a:r.physical_absolute_gate_a}
    }
    pub(super) fn attach(&mut self,source:&SourceSnapshotBuffer){self.outer.source=source.header;self.outer.source.struct_size=std::mem::size_of_val(&self.outer) as u64;}
    pub(super) fn finish(self,source:ClosedLoopSourceSnapshot,potential:&[f64],faces:&[([u64;3],f64)],balance_digest:&str)->Result<PreparedClosedLoopAcceptedSnapshot,RunError>{
        let h=&self.outer;
        if h.source.struct_size!=1336 || h.source.abi_version!=2 || h.source.reserved_flags!=0 || h.canonical_balance_certificate_bytes!=self.certificate.as_ptr().cast_mut() || h.canonical_balance_certificate_capacity!=self.certificate.len() as u64 || h.canonical_balance_certificate_len==0 || h.canonical_balance_certificate_len>self.certificate.len() as u64{return Err(bad("outer certificate header"));}
        let certificate=self.certificate[..h.canonical_balance_certificate_len as usize].to_vec();if format!("{:x}",Sha256::digest(&certificate))!=balance_digest{return Err(bad("retained balance certificate hash"));}
        let chars=|v:&[c_char]|->Result<String,RunError>{let e=v.iter().position(|b|*b==0).ok_or_else(||bad("unterminated receipt"))?;if v[e..].iter().any(|b|*b!=0){return Err(bad("noncanonical receipt padding"));}String::from_utf8(v[..e].iter().map(|b|*b as u8).collect()).map_err(|_|bad("receipt UTF-8"))};
        for (v,wanted) in [(&h.digest_encoding_version[..],"canonical_named_fields_be_bits.v2"),(&h.prepared_digest_version[..],"prepared_closed_loop_execution_input.v2"),(&h.accepted_charge_digest_version[..],"accepted_closed_loop_charge_field.v2"),(&h.accepted_source_digest_version[..],"accepted_closed_loop_source_state.v2")]{if chars(v)?!=wanted{return Err(bad("receipt version"));}}
        let prepared=chars(&h.prepared_execution_digest)?;if prepared!=self.execution.hash(){return Err(bad("independent prepared digest"));}
        let mut charge=Encoder::new("accepted_closed_loop_charge_field.v2")?;charge.nested("prepared_execution_digest",&prepared)?;charge.string("periodic_operator_version","fem_charge_h1_periodic_jump.v2")?;charge.string("stable_vertex_id_version","stable_mesh_vertex_u64.v1")?;vertices(&mut charge,self.input,Some(potential))?;elements(&mut charge,self.input)?;
        let ConservativeCurrentClosureIR::ClosedGeometry{source_cuts,..}= &self.input.source.closure else{return Err(bad("closure absent"));};
        for (n,v) in [("potential_drop_v_bits",source_cuts[0].potential_drop_v),("measured_potential_jump_v_bits",source.potential_jump_v),("gauge_mean_v_bits",source.gauge_mean_v),("charge_relative_residual_bits",source.charge_relative_residual)]{charge.bits(n,v)?;}
        let accepted_charge=chars(&h.accepted_charge_field_digest)?;if accepted_charge!=charge.hash(){return Err(bad("independent accepted charge digest"));}
        let mut d=Encoder::new("accepted_closed_loop_source_state.v2")?;d.nested("prepared_execution_digest",&prepared)?;d.nested("accepted_charge_field_digest",&accepted_charge)?;d.string("conservative_current_operator_version","fem_conservative_current_rt0_view.v1")?;d.string("sampling_policy",source.sampling_policy)?;d.string("source_current_orientation",source.source_current_orientation)?;d.bits("source_current_a_bits",source.source_current_a)?;d.bits("source_absolute_flux_a_bits",source.source_absolute_flux_a)?;
        d.u64("canonical_face_count",faces.len() as u64)?;for (ids,f) in faces{for(n,id)in["face_vertex_0_id","face_vertex_1_id","face_vertex_2_id"].into_iter().zip(ids){d.u64(n,*id)?;}d.bits("flux_a_bits",*f)?;}
        d.field("canonical_balance_certificate",3,&certificate)?;d.string("weak_reaction_ledger_version",&source.weak_reaction_ledger_version)?;d.u64("paired_weak_reaction_count",source.paired_weak_reactions.len() as u64)?;
        for r in &source.paired_weak_reactions{d.u64("minus_vertex_id",r.minus_vertex_id)?;d.u64("plus_vertex_id",r.plus_vertex_id)?;d.bits("minus_reaction_a_bits",r.minus_reaction_a)?;d.bits("plus_reaction_a_bits",r.plus_reaction_a)?;}
        d.bits("max_paired_weak_flux_mismatch_a_bits",source.max_paired_weak_flux_mismatch_a)?;d.u64("sampled_cell_count",source.cells.len() as u64)?;
        for c in &source.cells{d.u64("source_element_index",c.source_element_index)?;for local in 0..4{d.u64("vertex_id",c.vertex_ids[local])?;for(n,v)in["vertex_x_bits","vertex_y_bits","vertex_z_bits"].into_iter().zip(&c.vertex_xyz_m[3*local..3*local+3]){d.bits(n,*v)?;}for(n,v)in["current_x_apm2_bits","current_y_apm2_bits","current_z_apm2_bits"].into_iter().zip(&c.vertex_current_xyz_apm2[3*local..3*local+3]){d.bits(n,*v)?;}}for(n,v)in["center_x_bits","center_y_bits","center_z_bits"].into_iter().zip(c.center_xyz_m){d.bits(n,v)?;}for(n,v)in["center_current_x_apm2_bits","center_current_y_apm2_bits","center_current_z_apm2_bits"].into_iter().zip(c.center_current_xyz_apm2){d.bits(n,v)?;}}
        let accepted_source=chars(&h.accepted_source_state_digest)?;if accepted_source!=d.hash(){return Err(bad("independent accepted source digest"));}
        let fluxes=faces.iter().copied().collect::<std::collections::BTreeMap<_,_>>();let mut observations=Vec::new();
        for o in &self.input.source.terminal_observations{let(mut sum,mut correction,mut absolute)=(0.0_f64,0.0_f64,0.0_f64);for f in &o.faces{let mut key=f.face_vertex_ids;key.sort_unstable();let flux=*fluxes.get(&key).ok_or_else(||bad("owned observation flux absent"))?;let sign=if f.face_vertex_ids==key{1.0}else{-1.0};let v=sign*flux;let next=sum+v;correction+=if sum.abs()>=v.abs(){(sum-next)+v}else{(v-next)+sum};sum=next;absolute+=v.abs();}let current=sum+correction;if !current.is_finite() || !absolute.is_finite(){return Err(bad("nonfinite owned observation current or absolute flux"));}observations.push(PreparedTerminalObservationCurrent{id:o.id.clone(),part_id:o.part_id.clone(),selector:o.selector.clone(),normal_convention:o.normal_convention.clone(),current_a:current,absolute_flux_a:absolute});}
        Ok(PreparedClosedLoopAcceptedSnapshot{source,prepared_execution_digest:prepared,accepted_charge_field_digest:accepted_charge,accepted_source_state_digest:accepted_source,digest_encoding:"canonical_named_fields_be_bits.v2".into(),prepared_execution_preimage:self.execution.codec.payload,accepted_charge_field_preimage:charge.codec.payload,accepted_source_state_preimage:d.codec.payload,canonical_balance_certificate:certificate,terminal_observation_currents:observations})
    }
}
