#include "checkpoint_codec.hpp"

#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <algorithm>
#include <cstring>
#include <type_traits>

namespace fullmag::fdm::gpu::transport::spin {
namespace {
uint64_t align_to(uint64_t v, uint64_t a) { return (v + a - 1) & ~(a - 1); }
void p16(uint8_t *p,uint16_t v){p[0]=uint8_t(v);p[1]=uint8_t(v>>8);}
void p32(uint8_t *p,uint32_t v){for(size_t i=0;i<4;++i)p[i]=uint8_t(v>>(8*i));}
void p64(uint8_t *p,uint64_t v){for(size_t i=0;i<8;++i)p[i]=uint8_t(v>>(8*i));}
uint32_t g32(const uint8_t*p){return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
uint64_t g64(const uint8_t*p){uint64_t v=0;for(size_t i=0;i<8;++i)v|=uint64_t(p[i])<<(8*i);return v;}
uint16_t g16(const uint8_t*p){return uint16_t(p[0])|(uint16_t(p[1])<<8);}
template<class T> std::vector<uint8_t> raw(const T*v,size_t n){std::vector<uint8_t>b(n*sizeof(T));if(!b.empty())std::memcpy(b.data(),v,b.size());return b;}
template<class T> std::vector<uint8_t> one(T v){return raw(&v,1);}
struct F{uint16_t type;uint64_t count;std::vector<uint8_t> bytes;};
F text(const std::string&s){return {8,1,{s.begin(),s.end()}};}
F u32f(uint32_t v){return {2,1,one(v)};} F u64f(uint64_t v){return {3,1,one(v)};}
F f64f(double v){return {5,1,one(v)};}
F digestf(const std::array<uint8_t,32>&v){return {7,1,{v.begin(),v.end()}};}
template<class T> F vec(uint16_t t,const std::vector<T>&v){return {t,v.size(),raw(v.data(),v.size())};}
std::vector<uint8_t> record(const std::vector<F>&fields){
    uint64_t next=align_to(16+32*fields.size(),8);std::vector<uint64_t>off;
    for(const auto&f:fields){off.push_back(next);next=align_to(next+f.bytes.size(),8);}
    std::vector<uint8_t>r(next);p16(r.data(),1);p32(r.data()+4,fields.size());p64(r.data()+8,r.size());
    for(size_t i=0;i<fields.size();++i){auto*d=r.data()+16+32*i;p16(d,i+1);p16(d+2,fields[i].type);p32(d+4,1);p64(d+8,fields[i].count);p64(d+16,off[i]);p64(d+24,fields[i].bytes.size());if(!fields[i].bytes.empty())std::memcpy(r.data()+off[i],fields[i].bytes.data(),fields[i].bytes.size());}
    return r;
}
struct S{uint32_t id,type,width;std::vector<uint8_t> bytes;};
std::vector<uint8_t> section(const std::vector<uint8_t>&p,uint32_t id){for(uint32_t i=0;i<g32(p.data()+24);++i){const auto*d=p.data()+320+96*i;if(g32(d)==id)return {p.begin()+g64(d+24),p.begin()+g64(d+24)+g64(d+32)};}return {};}
const uint8_t *section_ptr(const uint8_t *p,uint32_t id,uint64_t *length){for(uint32_t i=0;i<g32(p+24);++i){const auto*d=p+320+96*i;if(g32(d)==id){*length=g64(d+32);return p+g64(d+24);}}return nullptr;}
const uint8_t *field_ptr(const uint8_t *record,uint16_t id,uint64_t *count,uint64_t *bytes){for(uint32_t i=0;i<g32(record+4);++i){const auto*d=record+16+32*i;if(g16(d)==id){*count=g64(d+8);*bytes=g64(d+24);return record+g64(d+16);}}return nullptr;}
bool same_interface_count(const SpinCheckpointData&s){const size_t n=s.interface_source_ids.size();if(s.interface_topology_ids.size()!=n||s.interface_axes.size()!=n||s.interface_face_linear.size()!=n||s.interface_negative_cells.size()!=n||s.interface_positive_cells.size()!=n||s.interface_from_cells.size()!=n||s.interface_to_cells.size()!=n||s.interface_orientations.size()!=n)return false;for(const auto&v:s.interface_values)if(v.size()!=n)return false;return true;}
}

bool build_checkpoint(const charge::CheckpointData &c, SpinCheckpointData &s,
                      std::vector<uint8_t> *out) {
    if(out==nullptr||s.source_revision!=c.source_revision||s.operator_revision==0||
       s.preconditioner_revision==0||!same_interface_count(s))return false;
    const uint64_t cells=c.grid[0]*c.grid[1]*c.grid[2];
    const uint64_t xf=(c.grid[0]+1)*c.grid[1]*c.grid[2],yf=c.grid[0]*(c.grid[1]+1)*c.grid[2],zf=c.grid[0]*c.grid[1]*(c.grid[2]+1);
    if(s.mu_s.size()!=3*cells||s.qx.size()!=3*xf||s.qy.size()!=3*yf||s.qz.size()!=3*zf)return false;
    for(const auto&v:s.reactions)if(v.size()!=cells)return false;for(const auto&v:s.torque)if(v.size()!=cells)return false;
    if(s.warm_iterate.size()!=3*cells||s.warm_basis.size()!=s.basis_count*3*cells)return false;
    for(size_t i=0;i<s.interface_source_ids.size();++i){
        const uint64_t face_count=s.interface_axes[i]==0?xf:s.interface_axes[i]==1?yf:s.interface_axes[i]==2?zf:0;
        if(face_count==0||s.interface_face_linear[i]>=face_count||
           s.interface_negative_cells[i]>=cells||s.interface_positive_cells[i]>=cells||
           s.interface_from_cells[i]>=cells||s.interface_to_cells[i]>=cells)return false;
    }
    charge::CheckpointData charge_data=c;charge_data.snapshot_digest.fill(0);std::vector<uint8_t>base;
    if(!charge::build_checkpoint(&charge_data,&base)) {
        return false;
    }
    std::vector<F> meta={text(s.formula_id),text(s.operator_id),text(s.electric_reconstruction_id),text(s.interface_formula_id),text(s.torque_operator_id),text(s.engine_id),text(s.preconditioner_id),text(s.residual_id),text(s.local_residual_id),u64f(s.source_revision),u64f(s.operator_revision),u64f(s.preconditioner_revision),u32f(s.convergence_reason),u64f(s.iterations),u64f(s.work_budget),f64f(s.local_balance),f64f(s.global_balance),f64f(s.interface_balance),f64f(s.torque_balance),digestf(s.deterministic_compute_digest)};
    std::vector<F> reactions;for(const auto&v:s.reactions)reactions.push_back(vec(5,v));
    std::vector<F> iface={vec(3,s.interface_source_ids),vec(3,s.interface_topology_ids),vec(2,s.interface_axes),vec(3,s.interface_face_linear),vec(3,s.interface_negative_cells),vec(3,s.interface_positive_cells),vec(3,s.interface_from_cells),vec(3,s.interface_to_cells),vec(4,s.interface_orientations)};for(const auto&v:s.interface_values)iface.push_back(vec(5,v));
    std::vector<F> torque;for(const auto&v:s.torque)torque.push_back(vec(5,v));
    std::vector<F>warm={text(s.engine_id),u64f(s.preconditioner_revision),u64f(s.restart_position),u64f(s.basis_count),vec(5,s.warm_iterate),vec(5,s.warm_basis),vec(1,s.deterministic_reduction_state)};
    std::array<uint8_t,32>zero{};std::vector<F>continuation={u64f(c.accepted_sequence),u64f(0),u64f(0),u64f(0),u64f(c.iterations),u64f(s.work_budget),digestf(zero)};
    std::vector<S> sections;for(uint32_t id=1;id<=9;++id){auto b=section(base,id);sections.push_back({id,id>=2&&id<=5?5u:6u,id>=2&&id<=5?8u:1u,std::move(b)});}
    sections.push_back({10,6,1,record(meta)});sections.push_back({11,5,8,raw(s.mu_s.data(),s.mu_s.size())});sections.push_back({12,5,8,raw(s.qx.data(),s.qx.size())});sections.push_back({13,5,8,raw(s.qy.data(),s.qy.size())});sections.push_back({14,5,8,raw(s.qz.data(),s.qz.size())});sections.push_back({15,6,1,record(reactions)});sections.push_back({16,6,1,record(iface)});sections.push_back({17,6,1,record(torque)});sections.push_back({18,6,1,section(base,18)});sections.push_back({19,6,1,record(warm)});sections.push_back({20,6,1,record(continuation)});
    std::vector<uint8_t>snapshot;for(size_t i=0;i<17;++i)snapshot.insert(snapshot.end(),sections[i].bytes.begin(),sections[i].bytes.end());charge::checkpoint_sha256(snapshot.data(),snapshot.size(),s.snapshot_digest.data());
    std::vector<uint8_t>spinbytes;for(size_t i=9;i<17;++i)spinbytes.insert(spinbytes.end(),sections[i].bytes.begin(),sections[i].bytes.end());charge::checkpoint_sha256(spinbytes.data(),spinbytes.size(),s.spin_digest.data());
    std::vector<uint8_t>warmbytes=sections[17].bytes;warmbytes.insert(warmbytes.end(),sections[18].bytes.begin(),sections[18].bytes.end());charge::checkpoint_sha256(warmbytes.data(),warmbytes.size(),s.warm_start_digest.data());
    std::vector<uint8_t>cont(s.snapshot_digest.begin(),s.snapshot_digest.end());cont.insert(cont.end(),sections[17].bytes.begin(),sections[17].bytes.end());cont.insert(cont.end(),sections[18].bytes.begin(),sections[18].bytes.end());cont.insert(cont.end(),sections[19].bytes.begin(),sections[19].bytes.end());charge::checkpoint_sha256(cont.data(),cont.size(),s.continuation_digest.data());continuation.back()=digestf(s.continuation_digest);sections[19].bytes=record(continuation);
    const uint64_t first=align_to(320+96*sections.size(),64);uint64_t total=first;std::vector<uint64_t>offs;for(const auto&x:sections){offs.push_back(total);total=align_to(total+x.bytes.size(),64);}out->assign(total,0);auto*h=out->data();std::memcpy(h,"FMGPUTR1",8);p16(h+8,1);p32(h+12,320);p32(h+16,0x01020304);p32(h+20,96);p32(h+24,sections.size());p64(h+32,total);p64(h+40,320);p64(h+48,first);p64(h+64,0x3f);p64(h+72,c.accepted_sequence);std::memcpy(h+80,c.lineage.data(),16);std::memcpy(h+96,c.device_uuid.data(),16);std::memcpy(h+112,c.build_digest.data(),32);std::memcpy(h+144,c.static_digest.data(),32);std::memcpy(h+176,s.snapshot_digest.data(),32);
    std::vector<uint8_t>ordered;for(size_t i=0;i<sections.size();++i){auto*d=h+320+96*i;p32(d,sections[i].id);p16(d+4,1);p16(d+6,1);p32(d+8,sections[i].type);p32(d+12,sections[i].width);p64(d+16,sections[i].bytes.size()/sections[i].width);p64(d+24,offs[i]);p64(d+32,sections[i].bytes.size());p64(d+40,sections[i].bytes.size());std::memcpy(h+offs[i],sections[i].bytes.data(),sections[i].bytes.size());charge::checkpoint_sha256(sections[i].bytes.data(),sections[i].bytes.size(),d+48);ordered.insert(ordered.end(),sections[i].bytes.begin(),sections[i].bytes.end());}
    charge::checkpoint_sha256(h+320,96*sections.size(),h+208);charge::checkpoint_sha256(ordered.data(),ordered.size(),h+240);std::fill(h+272,h+304,0);charge::checkpoint_sha256(h,out->size(),h+272);uint32_t kind=0;const uint32_t status=fullmag_fdm_gpu_transport_checkpoint_validate_v1(h,out->size(),&kind);return status==0&&kind==FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_SPIN;
}

bool parse_checkpoint(const uint8_t *p,uint64_t n,SpinCheckpointData *s){
    if(!p||!s)return false;uint32_t kind=0;if(fullmag_fdm_gpu_transport_checkpoint_validate_v1(p,n,&kind)!=0||kind!=FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_SPIN)return false;
    std::memcpy(s->snapshot_digest.data(),p+176,32);
    uint64_t length=0,count=0,bytes=0;const uint8_t*meta=section_ptr(p,10,&length);if(!meta)return false;
    auto read_text=[&](uint16_t id,std::string*out){const uint8_t*v=field_ptr(meta,id,&count,&bytes);if(!v||count!=1)return false;out->assign(reinterpret_cast<const char*>(v),bytes);return true;};
    if(!read_text(1,&s->formula_id)||!read_text(2,&s->operator_id)||!read_text(3,&s->electric_reconstruction_id)||!read_text(4,&s->interface_formula_id)||!read_text(5,&s->torque_operator_id)||!read_text(6,&s->engine_id)||!read_text(7,&s->preconditioner_id)||!read_text(8,&s->residual_id)||!read_text(9,&s->local_residual_id))return false;
    s->source_revision=g64(field_ptr(meta,10,&count,&bytes));s->operator_revision=g64(field_ptr(meta,11,&count,&bytes));s->preconditioner_revision=g64(field_ptr(meta,12,&count,&bytes));s->convergence_reason=g32(field_ptr(meta,13,&count,&bytes));s->iterations=g64(field_ptr(meta,14,&count,&bytes));s->work_budget=g64(field_ptr(meta,15,&count,&bytes));
    auto read_double=[&](uint16_t id,double*out){const uint8_t*v=field_ptr(meta,id,&count,&bytes);if(!v||bytes!=8)return false;std::memcpy(out,v,8);return true;};
    if(!read_double(16,&s->local_balance)||!read_double(17,&s->global_balance)||!read_double(18,&s->interface_balance)||!read_double(19,&s->torque_balance))return false;std::memcpy(s->deterministic_compute_digest.data(),field_ptr(meta,20,&count,&bytes),32);
    auto load_raw_f64=[&](uint32_t id,std::vector<double>*out){uint64_t l=0;const uint8_t*v=section_ptr(p,id,&l);if(!v||l%8)return false;out->resize(l/8);if(l)std::memcpy(out->data(),v,l);return true;};
    if(!load_raw_f64(11,&s->mu_s)||!load_raw_f64(12,&s->qx)||!load_raw_f64(13,&s->qy)||!load_raw_f64(14,&s->qz))return false;
    auto load_record_f64=[&](uint32_t section_id,uint16_t field,std::vector<double>*out){uint64_t l=0;const uint8_t*r=section_ptr(p,section_id,&l);const uint8_t*v=r?field_ptr(r,field,&count,&bytes):nullptr;if(!v||bytes!=count*8)return false;out->resize(count);if(bytes)std::memcpy(out->data(),v,bytes);return true;};
    for(uint16_t i=1;i<=9;++i)if(!load_record_f64(15,i,&s->reactions[i-1]))return false;
    uint64_t il=0;const uint8_t*iface=section_ptr(p,16,&il);if(!iface)return false;
    auto load_typed=[&](uint16_t field,auto*out){const uint8_t*v=field_ptr(iface,field,&count,&bytes);using T=typename std::decay_t<decltype(*out)>::value_type;if(!v||bytes!=count*sizeof(T))return false;out->resize(count);if(bytes)std::memcpy(out->data(),v,bytes);return true;};
    if(!load_typed(1,&s->interface_source_ids)||!load_typed(2,&s->interface_topology_ids)||!load_typed(3,&s->interface_axes)||!load_typed(4,&s->interface_face_linear)||!load_typed(5,&s->interface_negative_cells)||!load_typed(6,&s->interface_positive_cells)||!load_typed(7,&s->interface_from_cells)||!load_typed(8,&s->interface_to_cells)||!load_typed(9,&s->interface_orientations))return false;
    for(uint16_t i=10;i<=27;++i)if(!load_record_f64(16,i,&s->interface_values[i-10]))return false;
    for(uint16_t i=1;i<=10;++i)if(!load_record_f64(17,i,&s->torque[i-1]))return false;
    uint64_t wl=0;const uint8_t*warm=section_ptr(p,19,&wl);if(!warm)return false;s->preconditioner_revision=g64(field_ptr(warm,2,&count,&bytes));s->restart_position=g64(field_ptr(warm,3,&count,&bytes));s->basis_count=g64(field_ptr(warm,4,&count,&bytes));
    auto load_warm_f64=[&](uint16_t id,std::vector<double>*out){const uint8_t*v=field_ptr(warm,id,&count,&bytes);if(!v||bytes!=count*8)return false;out->resize(count);if(bytes)std::memcpy(out->data(),v,bytes);return true;};if(!load_warm_f64(5,&s->warm_iterate)||!load_warm_f64(6,&s->warm_basis))return false;const uint8_t*state=field_ptr(warm,7,&count,&bytes);s->deterministic_reduction_state.assign(state,state+bytes);
    std::vector<uint8_t>spin_domain;for(uint32_t id=10;id<=17;++id){uint64_t l=0;const uint8_t*v=section_ptr(p,id,&l);spin_domain.insert(spin_domain.end(),v,v+l);}charge::checkpoint_sha256(spin_domain.data(),spin_domain.size(),s->spin_digest.data());
    uint64_t l18=0,l19=0;const uint8_t*v18=section_ptr(p,18,&l18);const uint8_t*v19=section_ptr(p,19,&l19);std::vector<uint8_t>warm_domain(v18,v18+l18);warm_domain.insert(warm_domain.end(),v19,v19+l19);charge::checkpoint_sha256(warm_domain.data(),warm_domain.size(),s->warm_start_digest.data());uint64_t l20=0;const uint8_t*v20=section_ptr(p,20,&l20);std::memcpy(s->continuation_digest.data(),field_ptr(v20,7,&count,&bytes),32);return true;
}
} // namespace fullmag::fdm::gpu::transport::spin
