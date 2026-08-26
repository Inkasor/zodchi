function adapterNames(sources) {
  return new Set([...sources.values()].flatMap(source => source.code_intelligence?.adapters ?? []).map(adapter => adapter.name));
}

// Selection is package/workflow structural. Natural-language owner text and platform business
// vocabulary deliberately play no role here.
export function selectFlowEvidenceAdapter(flows, workflowKey, sources) {
  const candidates = (flows ?? []).filter(flow => flow.status === "active" && (flow.workflow_keys ?? []).includes(workflowKey));
  if (!candidates.length) return { status: "none", reason: "no_registered_flow_for_workflow", flow: null };
  const available = adapterNames(sources);
  const ranked = candidates.map(flow => ({
    ...flow,
    transition_adapter_available: !flow.transition?.adapter || available.has(flow.transition.adapter)
  })).sort((left, right) => Number(right.transition_adapter_available) - Number(left.transition_adapter_available) || left.key.localeCompare(right.key));
  return { status: "selected", reason: "registered_package_workflow_binding", flow: ranked[0] };
}

export function adapterMaterialSymbols(left, right, flowAdapter) {
  const identifiers = value => new Set(String(value ?? "").match(/[A-Za-zА-Яа-яЁё_$][A-Za-zА-Яа-яЁё0-9_$]{2,}/gu) ?? []);
  const leftIds = identifiers(left), rightIds = identifiers(right);
  const configured = new Set(flowAdapter?.material_symbols ?? []);
  return [...leftIds].filter(symbol => rightIds.has(symbol) && configured.has(symbol)).sort();
}

export function adapterTransitions(flowAdapter, symbols, targetPath, sources) {
  const adapterName = flowAdapter?.transition?.adapter;
  if (!adapterName) return [];
  const transitions = [...sources.values()].flatMap(source => (source.code_intelligence?.adapters ?? []).flatMap(adapter => adapter.name === adapterName ? adapter.transitions ?? [] : []));
  return transitions.filter(transition => (!targetPath || transition.path === targetPath) && symbols.some(symbol => transition.symbol_from === symbol || transition.symbol_to === symbol)).slice(0, 4);
}
