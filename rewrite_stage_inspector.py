import re

with open('apps/web/components/workspace/study-builder/StageInspector.tsx', 'r') as f:
    content = f.read()

# Add InspectorSection and ToggleRow to imports
primitives_import = 'import { InspectorSection, ToggleRow } from "@/components/panels/settings/primitives";\n'
content = content.replace('import StageSummaryChip from "./StageSummaryChip";', 
                          'import StageSummaryChip from "./StageSummaryChip";\n' + primitives_import)

# Remove the internal Component Definitions: Section, Field, Input, Checkbox
# They are between lines 18 and 68 roughly.
pattern = re.compile(r'function Section\(.*?\{.*?return \(\s*<div.*?</div>\s*\);\s*\}\s*function Field.*?function Input.*?function Checkbox.*?\}\s*\)\s*\}', re.DOTALL)
content = content.replace(content[content.find('function Section('):content.find('const INTEGRATOR_OPTIONS')], '')

# Replace <Section title="X"> with <InspectorSection title="X">
content = content.replace('<Section title=', '<InspectorSection title=')
content = content.replace('</Section>', '</InspectorSection>')

# Replace Field+Input with TextField
# Case 1: <Field label="Label">\n<Input value={...} onChange={(event) => ...} />\n</Field>
# Case 2: ... <Input type="number" ... />
old_field_pattern = re.compile(r'<Field label="([^"]+)">\s*<Input\s+([^>]+)\s*/>\s*</Field>')

def field_replacer(match):
    label = match.group(1)
    input_attrs = match.group(2)
    # replace onChange with onchange
    input_attrs = input_attrs.replace('onChange=', 'onchange=')
    return f'<TextField label="{label}" {input_attrs} />'

content = old_field_pattern.sub(field_replacer, content)

# Checkboxes -> ToggleRow
# <Checkbox label="foo" checked={bar} onChange={(checked) => baz} />
# becomes <ToggleRow label="foo" checked={bar} onChange={(checked) => baz} />
content = content.replace('<Checkbox\n', '<ToggleRow\n')
content = content.replace('<Checkbox', '<ToggleRow')

# Special case for "Status" enable/disable button
status_field = '''<Field label="Status">
            <div className="flex h-[2.15rem] items-center">
              <button
                type="button"
                onClick={onToggleEnabled}
                className="rounded border border-border/40 px-2.5 py-1.5 text-[0.72rem]"
              >
                {node.enabled ? "Disable node" : "Enable node"}
              </button>
            </div>
          </Field>'''
toggle_status = '''<ToggleRow
            label="Node enabled status"
            checked={Boolean(node.enabled)}
            onChange={onToggleEnabled}
          />'''
content = content.replace(status_field, toggle_status)

with open('apps/web/components/workspace/study-builder/StageInspector.tsx', 'w') as f:
    f.write(content)

