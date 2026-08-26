const WEB_CHAIN_EDGES = ["producer->api", "api->client_mapping", "client_mapping->state_model", "state_model->ui_consumer"];

const WEB_ANCHORS = [
  ["producer", /producer|storage|persist|import|profit/i, /(?:write|insert|update|return|produce|cost|profit)/i],
  ["api", /(?:^|_)api|contract|response|transform/i, /(?:res\.|response|return|json|contract|cost|profit)/i],
  ["client_mapping", /client|mapping|fetch/i, /(?:response|payload|data|normalize|map|assign|cost|profit)/i],
  ["state_model", /state|model/i, /(?:set[A-Z]|useState|store|model|assign|cost|profit)/i],
  ["ui_consumer", /ui|view|consumer|render/i, /(?:return\s*<|<td|<div|render|display|column|row\.|model\[)/i]
];

function adapterNames(sources) {
  return new Set([...sources.values()].flatMap(source => source.code_intelligence?.adapters ?? []).map(adapter => adapter.name));
}

// The generic evidence selector consumes only this structural adapter contract. Language/domain
// patterns and the capability to prove transitions stay here; an adapter without deterministic
// transitions still provides anchors and correctly leaves the corresponding edge unknown.
export function selectFlowEvidenceAdapter(ownerText, sources) {
  const requested = /\bapi\b/i.test(String(ownerText ?? "")) && /\bui\b/i.test(String(ownerText ?? ""));
  if (!requested) return null;
  const names = adapterNames(sources);
  if (names.has("typescript-compiler")) return { id: "typescript-web-flow.v1", required_edges: WEB_CHAIN_EDGES, anchor_specs: WEB_ANCHORS, transition_adapter: "typescript-compiler", transition_method: "typescript_ast" };
  if (names.has("bsl-structural")) return { id: "bsl-structural-flow.v1", required_edges: WEB_CHAIN_EDGES, anchor_specs: WEB_ANCHORS, transition_adapter: null, transition_method: null };
  return { id: "generic-cross-layer-flow.v1", required_edges: WEB_CHAIN_EDGES, anchor_specs: WEB_ANCHORS, transition_adapter: null, transition_method: null };
}

export function adapterMaterialSymbols(left, right, ownerText) {
  const identifiers = value => new Set(String(value ?? "").match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? []);
  const leftIds = identifiers(left), rightIds = identifiers(right), ownerIds = identifiers(ownerText);
  return [...leftIds].filter(symbol => rightIds.has(symbol) && (ownerIds.has(symbol) || /cost|profit|order|sale|price|margin|commission/i.test(symbol))).sort();
}

export function adapterTransitions(flowAdapter, symbols, targetPath, sources) {
  if (!flowAdapter?.transition_adapter) return [];
  const transitions = [...sources.values()].flatMap(source => (source.code_intelligence?.adapters ?? []).flatMap(adapter => adapter.name === flowAdapter.transition_adapter ? adapter.transitions ?? [] : []));
  return transitions.filter(transition => (!targetPath || transition.path === targetPath) && symbols.some(symbol => transition.symbol_from === symbol || transition.symbol_to === symbol)).slice(0, 4);
}
