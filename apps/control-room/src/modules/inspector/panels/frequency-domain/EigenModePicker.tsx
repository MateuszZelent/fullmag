"use client";
import { useMemo, useState } from "react";
import { useKernel } from "@/kernel/KernelContext";
import { useFrequencyDomainEigenSpectrumResource, useFrequencyDomainManifestResource } from "@/kernel/resources/studyRuntimeResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { buildEigenModeBrowser, modePickerPage, MODE_PICKER_PAGE_SIZE, type ModeBrowserSample } from "@/shared/domain/analysis/eigenModeBrowser";
import { Button } from "@/shared/ui/Button";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";

export function useEigenModeBrowserData() {
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const manifest = useFrequencyDomainManifestResource();
  const browser = useMemo(() => buildEigenModeBrowser(spectrum.data, manifest.data), [spectrum.data, manifest.data]);
  return { ...browser, spectrum, manifest };
}

/** Bounded native choices share the Inspector's established select controls. */
function PagedChoice({ label, items, value, onChange }: { label: string; items: { label: string; value: string }[]; value: string; onChange: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const result = useMemo(() => modePickerPage(items, search, page), [items, search, page]);
  const selected = items.find(item=>item.value===value);
  const choices = selected && !result.items.some(item=>item.value===value) ? [selected, ...result.items] : result.items;
  return <>
    {items.length > MODE_PICKER_PAGE_SIZE ? <FieldRow label={`Find ${label.toLowerCase()}`} value={<input className="fm-inspector-input" aria-label={`Find ${label.toLowerCase()}`} value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}} />} /> : null}
    <FieldRow label={label} value={<select className="fm-inspector-select" aria-label={`Mode ${label.toLowerCase()}`} value={value} onChange={event=>onChange(event.target.value)} disabled={!items.length}>{choices.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select>} />
    {items.length > MODE_PICKER_PAGE_SIZE ? <div className="fm-frequency-domain-visualization-actions"><Button size="sm" disabled={result.current===0} aria-label={`Previous ${label.toLowerCase()} page`} onClick={()=>setPage(result.current-1)}>Previous</Button><span>{result.current+1}/{result.pages} · {result.count} matches</span><Button size="sm" disabled={result.current+1>=result.pages} aria-label={`Next ${label.toLowerCase()} page`} onClick={()=>setPage(result.current+1)}>Next</Button></div> : null}
  </>;
}

export function EigenModePicker({ samples, selection }: { samples: ModeBrowserSample[]; selection: Selection }) {
  const kernel = useKernel();
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const selectedSample = samples.find(sample=>sample.index===ref?.sampleIndex) ?? samples[0];
  const selectedMode = selectedSample?.modes.find(mode=>mode.key===`${ref?.sampleIndex}:${ref?.modeIndex}`) ?? selectedSample?.modes[0];
  const wavevectors = useMemo(()=>samples.map(sample=>({value:String(sample.index),label:sample.label})),[samples]);
  const frequencies = useMemo(()=>selectedSample?.modes.map(mode=>({value:mode.key,label:mode.frequencyLabel})) ?? [],[selectedSample]);
  const select = (next: Selection | undefined) => { if(next) kernel.selection.set(next,"inspector"); };
  return <InspectorGroup title="Choose mode" badge={`${samples.length} k points`}>
    {!selectedMode ? <p className="fm-result-inspector__help">No returned modes in this result.</p> : <>
      <PagedChoice label="Wavevector" items={wavevectors} value={String(selectedSample.index)} onChange={value=>select(samples.find(sample=>sample.index===Number(value))?.modes[0]?.selection)} />
      <PagedChoice key={selectedSample.index} label="Frequency" items={frequencies} value={selectedMode.key} onChange={value=>select(selectedSample.modes.find(mode=>mode.key===value)?.selection)} />
      {ref?.modeIndex == null ? <Button size="sm" variant="primary" onClick={()=>select(selectedMode.selection)}>Inspect selected mode</Button> : null}
      <p className="fm-result-inspector__help">{selectedSample.modes.length} returned frequencies at this k. Selecting another k starts with its lowest returned frequency; this does not track a branch.</p>
    </>}
  </InspectorGroup>;
}

export function EigenModeBrowserPanel({ selection }: { selection: Selection }) {
  const data=useEigenModeBrowserData();
  return <div data-inspector-surface="eigen-modes-browser"><EigenModePicker samples={data.samples} selection={selection} /></div>;
}
