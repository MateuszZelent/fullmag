import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const root = new URL("../src/kernel/api/codecs/", import.meta.url), cache = new Map();
function load(url) { if (!cache.has(url.href)) cache.set(url.href, new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { identifier: url.href })); return cache.get(url.href); }
const entry = load(new URL("artifactFieldVectorCodec.ts", root));
await entry.link((name, parent) => load(new URL(`${name}.ts`, parent.identifier))); await entry.evaluate();
const decode = entry.namespace.decodeArtifactFieldVector;
const legacy = load(new URL("fieldVectorCodec.ts", root));
await legacy.link((name, parent) => load(new URL(`${name}.ts`, parent.identifier))); await legacy.evaluate();
const first = 9007199254740993n;
function packet(code = 4, components = 1) {
  const count = 4, stride = code === 7 ? 24 : 8;
  const digest = "ab".repeat(32), source = `sha256:${"c".repeat(64)}`, generation = `sha256:${"d".repeat(64)}`;
  const strings = ["object", "conductor-a", digest, "artifact_inspection", source, generation].map(s => new TextEncoder().encode(s));
  const mappingStart = 48 + 88 + strings.reduce((n, s) => n + s.length, 0);
  const metadataLength = Math.ceil((mappingStart - 48 + count * stride) / 8) * 8;
  const valueStart = 48 + metadataLength, buffer = new ArrayBuffer(valueStart + count * components * 8), v = new DataView(buffer);
  const put = (at, text) => new Uint8Array(buffer, at, text.length).set(new TextEncoder().encode(text));
  put(0, "FMVP"); v.setUint8(4, 6); v.setUint8(5, 1); v.setUint8(6, components);
  v.setUint32(8, metadataLength, true); v.setUint32(12, count * components, true); v.setUint32(16, count, true); v.setUint32(20, 1, true); v.setUint32(24, 1, true); put(28, components === 1 ? "V_electric" : code === 7 ? "J_charge" : "H_ant");
  put(48, "FMMI"); v.setUint16(52, 4, true); new Uint8Array(buffer, 72, 32).fill(0xab);
  v.setBigUint64(64, v.getBigUint64(72, true), true); v.setUint32(104, code, true); v.setUint32(108, count, true); v.setBigUint64(116, first, true); v.setUint32(124, stride, true); v.setUint32(128, code, true);
  let at = 136;
  [112,114,56,58,60,62].forEach((offset, i) => { v.setUint16(offset, strings[i].length, true); new Uint8Array(buffer, at, strings[i].length).set(strings[i]); at += strings[i].length; });
  for (let i = 0; i < count; i++) {
    const offset = mappingStart + i * stride;
    v.setBigUint64(offset, code === 5 || code === 6 ? BigInt(i) : code === 7 ? first + 10n : first + BigInt(i), true);
    if (code === 7) { v.setUint8(offset + 8, i); v.setBigUint64(offset + 16, first + BigInt(i), true); }
  }
  for (let i = 0; i < count * components; i++) v.setFloat64(valueStart + i * 8, i - 2, true);
  return { buffer, v, mappingStart, valueStart, metadataLength, stride };
}
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
for (const code of [4,5,6,7,8]) check(`canonical v6 mapping ${code} preserves exact IDs and values`, () => {
  const p = packet(code, code === 4 ? 1 : 3), f = decode(p.buffer);
  assert.equal(f.formatVersion, 6); assert.equal(f.sourceKind, "artifact_inspection"); assert.equal(f.sourceRevision, first.toString());
  assert.equal(f.meshTopologyRevision, p.v.getBigUint64(64, true).toString());
  assert.equal(f.artifactMapping.identityIds[0], code === 5 || code === 6 ? 0n : first);
  assert.equal(f.values[0], -2); assert.equal(f.values.length, 4 * f.nComp);
  if (code === 7) { assert.deepEqual([...f.artifactMapping.localVertexIndices], [0,1,2,3]); assert.equal(f.artifactMapping.elementOrdinals[3], first + 10n); }
});
for (const [name, mutate, code] of [
  ["wrong kind", p => p.v.setUint8(5, 2)],
  ["zero components", p => p.v.setUint8(6, 0)],
  ["inconsistent values", p => p.v.setUint32(12, 5, true)],
  ["reserved header", p => p.v.setUint32(44, 1, true)],
  ["wrong metadata version", p => p.v.setUint16(52, 3, true)],
  ["metadata overflow", p => p.v.setUint32(8, 0xffffffff, true)],
  ["zero carrier revision", p => p.v.setBigUint64(64, 0n, true)],
  ["revision differs from digest", p => p.v.setBigUint64(64, 1n, true)],
  ["mapping count", p => p.v.setUint32(108, 3, true)],
  ["mapping stride", p => p.v.setUint32(124, 24, true)],
  ["repeated indexing differs", p => p.v.setUint32(128, 8, true)],
  ["duplicate node ID", p => p.v.setBigUint64(p.mappingStart + 8, first, true)],
  ["invalid sample ordinal", p => p.v.setBigUint64(p.mappingStart, first, true), 5],
  ["mixed element", p => p.v.setBigUint64(p.mappingStart + 24, first + 99n, true), 7],
  ["wrong local vertex", p => p.v.setUint8(p.mappingStart + 8, 3), 7],
  ["nonzero local reserved", p => p.v.setUint8(p.mappingStart + 9, 1), 7],
  ["duplicate cell-local vertex", p => p.v.setBigUint64(p.mappingStart + 24 + 16, first, true), 7],
  ["NaN value", p => p.v.setFloat64(p.valueStart, NaN, true)],
  ["infinite value", p => p.v.setFloat64(p.valueStart, Infinity, true)],
  ["quantity padding", p => p.v.setUint8(43, 1)],
  ["nonzero padding", p => { assert.ok(p.valueStart > p.mappingStart + 4 * p.stride); p.v.setUint8(p.valueStart - 1, 1); }],
  ["invalid UTF8", p => p.v.setUint8(136, 0xff)],
]) check(`reject ${name}`, () => { const p = packet(code ?? 4, code === 7 ? 3 : 1); mutate(p); assert.throws(() => decode(p.buffer)); });
check("truncation never returns partial values", () => { const p = packet(); assert.throws(() => decode(p.buffer.slice(0, -8))); });
check("legacy v2 still decodes through the same entry point", () => {
  const b = new ArrayBuffer(64), v = new DataView(b); new Uint8Array(b,0,4).set(new TextEncoder().encode("FMVP"));
  v.setUint8(4,2); v.setUint8(5,1); v.setUint8(6,1); v.setUint32(12,2,true); v.setUint32(16,2,true); v.setUint32(20,1,true); v.setUint32(24,1,true); new Float64Array(b,48).set([-1,2]);
  const f = legacy.namespace.decodeFieldVector(b); assert.equal(f.formatVersion,2); assert.deepEqual([...f.values],[-1,2]); assert.equal(f.artifactMapping,undefined);
});
console.log(JSON.stringify({status:"passed",checks,unit_test_compilation:false,scope:"production decoder only; no HTTP or backend qualification"}));
