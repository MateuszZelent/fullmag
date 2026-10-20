import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = stripTypeScriptTypes(readFileSync(new URL("../src/kernel/api/tensorFieldProjection.ts", import.meta.url), "utf8"));
const { isFlowMajorTensorDescriptor, tensorProjectionOptions, projectTensorField } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const descriptor = { rank: 2, shape: [3, 3], layout: "flow_major", axes: ["flow", "spin"], component_labels: ["Jxx", "Jxy", "Jxz", "Jyx", "Jyy", "Jyz", "Jzx", "Jzy", "Jzz"] };
const field = { nComp: 9, pointCount: 1, valueCount: 9, values: Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]) };
let checks = 0;
for (const malformed of [null, undefined, {}, { rank: 2 },
  ...["shape", "axes", "component_labels"].flatMap(key => [undefined, null, "invalid", {}].map(value => ({ ...descriptor, [key]: value }))),
  { ...descriptor, component_labels: [...descriptor.component_labels.slice(0, 8), null] },
  { ...descriptor, component_labels: [...descriptor.component_labels.slice(0, 8), " "] },
]) {
  assert.equal(isFlowMajorTensorDescriptor(malformed), false);
  assert.deepEqual(tensorProjectionOptions(malformed), []);
  assert.throws(() => projectTensorField(field, malformed, "c0"), /complete flow-major/);
  checks++;
}
assert.equal(isFlowMajorTensorDescriptor(descriptor), true);
assert.deepEqual(tensorProjectionOptions(descriptor).slice(0, 9).map(option => option.label), descriptor.component_labels);
assert.deepEqual([...projectTensorField(field, descriptor, "spin_flow_y").values], [1, 4, 7]);
assert.deepEqual([...projectTensorField(field, descriptor, "c8").values], [8]);
assert.deepEqual([...field.values], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
checks++;
console.log(JSON.stringify({ status: "passed", checks, scope: "interpreted production tensor descriptor admission; no unit-test compilation" }));
