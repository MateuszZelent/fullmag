"""Interpreted prepared ABI/identity contract; never native solver qualification."""
import ctypes as c
import hashlib
import math
from pathlib import Path
import re
import subprocess
import unittest
from test_antenna_closed_loop_snapshot_alias_contract import overlap
ROOT=Path(__file__).resolve().parents[1]
HEADER=ROOT/'native/include/fullmag_fem.h'
def structures(text):
    text=re.sub(r'/\*.*?\*/','',text,flags=re.S)
    bodies={n:b for b,n in re.findall(r'typedef\s+struct\s*\{([^{}]*)\}\s*(\w+)\s*;',text,re.S)}
    enums=set(re.findall(r'typedef\s+enum\s*\{[^{}]*\}\s*(\w+)\s*;',text,re.S))
    types={'uint32_t':c.c_uint32,'uint64_t':c.c_uint64,'int32_t':c.c_int32,'uint8_t':c.c_uint8,'double':c.c_double,'char':c.c_char,'int':c.c_int}
    macros={'FULLMAG_FEM_STEADY_TRANSPORT_RT0_STRING_CAPACITY':96,'FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY':65}
    def get(name):
        if name in types:return types[name]
        if name in enums:return c.c_int
        cls=type(name,(c.Structure,),{});types[name]=cls;fields=[]
        for decl in bodies[name].split(';'):
            decl=decl.strip()
            if not decl:continue
            base,rest=re.fullmatch(r'(?:const\s+)?(\w+)\s*(.+)',decl,re.S).groups()
            for value in rest.split(','):
                value=value.strip();pointer=value.startswith('*');value=value.lstrip('*').strip()
                field,count=re.fullmatch(r'(\w+)(?:\[([^]]+)\])?',value).groups()
                kind=c.c_void_p if pointer else get(base)
                if count:kind=kind*(macros[count] if count in macros else int(count))
                fields.append((field,kind))
        cls._fields_=fields;return cls
    return get,bodies

def field(name,tag,payload):
    name=name.encode();return len(name).to_bytes(8,'big')+name+bytes([tag])+len(payload).to_bytes(8,'big')+payload

def guarded_write(ranges,storage):
    for i,first in enumerate(ranges):
        for second in ranges[i+1:]:
            if overlap(*first,*second):raise ValueError('overlap')
    storage[:]=b'accepted'

class PreparedContract(unittest.TestCase):
    def test_header_abi_sizes_and_offsets(self):
        get,_=structures(HEADER.read_text(encoding='utf-8'))
        sizes={'binding':136,'material_part':32,'observation_face':40,'observation':48,'request':608,'oersted_request':672,'source_snapshot_result':1336}
        for suffix,size in sizes.items():self.assertEqual(c.sizeof(get('fullmag_fem_prepared_closed_loop_'+suffix+'_v2')),size)
        outer=get('fullmag_fem_prepared_closed_loop_source_snapshot_result_v2')
        self.assertEqual(outer.canonical_balance_certificate_bytes.offset,1312)
        self.assertEqual(outer.prepared_execution_digest.offset,728)
        self.assertEqual(c.sizeof(get('fullmag_fem_closed_loop_source_snapshot_result_v2')),728)
    def test_existing_v1_struct_bodies_unchanged(self):
        _,now=structures(HEADER.read_text(encoding='utf-8'))
        previous=subprocess.check_output(['git','show','HEAD:native/include/fullmag_fem.h'],cwd=ROOT).decode('utf-8')
        _,old=structures(previous)
        for name in ('fullmag_fem_charge_transport_request_v1','fullmag_fem_steady_transport_rt0_request_v1','fullmag_fem_steady_transport_rt0_result_v1','fullmag_fem_steady_transport_rt0_oersted_request_v1'):
            self.assertEqual(re.sub(r'\s+','',now[name]),re.sub(r'\s+','',old[name]))
    def test_prepared_input_has_no_accepted_pin_slots(self):
        _,bodies=structures(HEADER.read_text(encoding='utf-8'))
        for name in ('fullmag_fem_prepared_closed_loop_request_v2','fullmag_fem_prepared_closed_loop_binding_v2'):
            self.assertNotRegex(bodies[name],r'\b(pins|identity|source_field_digest|accepted_charge_field_digest)\b')
        self.assertIn('fullmag_fem_charge_transport_request_v1 base',bodies['fullmag_fem_prepared_closed_loop_request_v2'])
    def test_named_codec_preserves_raw_bits_and_domains(self):
        positive=field('schema',1,b'accepted_closed_loop_charge_field.v2')+field('potential_v_bits',2,(0).to_bytes(8,'big'))
        negative=field('schema',1,b'accepted_closed_loop_charge_field.v2')+field('potential_v_bits',2,(1<<63).to_bytes(8,'big'))
        self.assertNotEqual(hashlib.sha256(positive).digest(),hashlib.sha256(negative).digest())
        other=negative.replace(b'accepted_closed_loop_charge_field.v2',b'accepted_closed_loop_source_state.v2')
        self.assertNotEqual(hashlib.sha256(negative).digest(),hashlib.sha256(other).digest())
        # Fixed framing: tag 3 is bytes, tag 2 is an eight-byte BE integer.
        self.assertEqual(field('x',2,b'\0'*8),bytes.fromhex('0000000000000001780200000000000000080000000000000000'))
        self.assertEqual(field('x',3,b'ab'),bytes.fromhex('0000000000000001780300000000000000026162'))
    def test_certificate_alias_rejects_exact_and_partial_without_payload_write(self):
        certificate=(16384,128)
        for name in ('charge','H','faces','header','cells','weak'):
            for pointer in (certificate[0],certificate[0]-1,certificate[0]+127):
                with self.subTest(name=name,pointer=pointer):
                    storage=bytearray(b'sentinel')
                    with self.assertRaises(ValueError):guarded_write([certificate,(pointer,16)],storage)
                    self.assertEqual(storage,b'sentinel')
    def test_outer_header_is_a_new_owned_range(self):
        outer=(32768,1336)
        for pointer in (32768,32767,34103):
            storage=bytearray(b'sentinel')
            with self.assertRaises(ValueError):guarded_write([outer,(pointer,16)],storage)
            self.assertEqual(storage,b'sentinel')
    def test_prepared_alias_admission_precedes_header_resets(self):
        source=(ROOT/'backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp').read_text(encoding='utf-8')
        for name in ('fullmag_fem_solve_prepared_closed_loop_rt0_v2','fullmag_fem_solve_prepared_closed_loop_rt0_oersted_v2'):
            body=source[source.index('extern "C" int '+name):]
            self.assertLess(body.index('prepared_output_ranges_are_disjoint'),body.index('return call_with_prepared_closed_loop'))
        helper=source[source.index('bool prepared_output_ranges_are_disjoint'):source.index('template<typename Result, typename Solve>')]
        self.assertNotIn('set_error',helper)
        self.assertNotIn('std::copy',helper)
        self.assertIn('{source,sizeof(*source)}',helper)
    def test_observation_overflow_refuses_receipt(self):
        def receipt(values):
            total,correction,absolute=0.0,0.0,0.0
            for value in values:
                following=total+value
                correction+=(total-following)+value if abs(total)>=abs(value) else (value-following)+total
                total=following;absolute+=abs(value)
            current=total+correction
            if not math.isfinite(current) or not math.isfinite(absolute):raise ValueError('nonfinite observation')
            return current,absolute
        for values in ([1e308,1e308],[1e308,-1e308],[1e308,-1e308,1e308]):
            with self.subTest(values=values):
                with self.assertRaises(ValueError):receipt(values)
        self.assertEqual(receipt([1.0,-0.5]),(0.5,1.5))
        source=(ROOT/'crates/fullmag-runner/src/native_fem/steady_transport/prepared_closed_loop.rs').read_text(encoding='utf-8')
        start=source.index('let current=sum+correction;')
        end=source.index('observations.push(',start)
        self.assertIn('!current.is_finite() || !absolute.is_finite()',source[start:end])
    def test_certificate_disjoint_adjacency(self):
        storage=bytearray(b'sentinel');guarded_write([(16384,128),(16512,16),(16368,16)],storage);self.assertEqual(storage,b'accepted')

if __name__=='__main__':unittest.main()
