const TOKEN = /[\p{L}_$][\p{L}\p{N}_$.-]{2,}/gu;

function normalizedTokens(value) {
  return (String(value ?? "").match(TOKEN) ?? []).map(token => token.replace(/[.]+$/, "").toLowerCase()).filter(Boolean);
}

function codeShaped(token) {
  return /[_.$\d]/u.test(token) || /[\p{Ll}][\p{Lu}]/u.test(token);
}

// Language is deliberately not an input. Terms are ranked by their measured distribution in the
// candidate corpus, plus structural identifier shape. This makes ordinary words cheap regardless of
// whether the request is Russian, English or Serbian, while a rare project symbol remains decisive.
export function rankTerms(text, documents, { limit = 32, exactHits = [] } = {}) {
  const raw = String(text ?? "").match(TOKEN) ?? [];
  const queryFrequency = new Map(), original = new Map();
  for (const token of raw) {
    const key = token.replace(/[.]+$/, "").toLowerCase();
    if (!key) continue;
    queryFrequency.set(key, (queryFrequency.get(key) ?? 0) + 1);
    if (!original.has(key)) original.set(key, token);
  }
  const corpus = (documents ?? []).map(normalizedTokens).map(tokens => new Set(tokens));
  const exact = new Set(exactHits.map(value => String(value).toLowerCase()));
  const ranked = [];
  for (const [token, frequency] of queryFrequency) {
    const documentFrequency = corpus.filter(document => document.has(token)).length;
    if (!documentFrequency) continue;
    const rarity = Math.log2((corpus.length + 1) / (documentFrequency + 1)) + 1;
    const identifierBonus = codeShaped(original.get(token)) ? 2 : 0;
    const exactBonus = exact.has(token) ? 3 : 0;
    ranked.push({ token, original: original.get(token), document_frequency: documentFrequency, query_frequency: frequency, code_shaped: identifierBonus > 0, weight: rarity * (1 + Math.log2(frequency + 1)) + identifierBonus + exactBonus });
  }
  return ranked.sort((left, right) => right.weight - left.weight || left.document_frequency - right.document_frequency || left.token.localeCompare(right.token, "en")).slice(0, limit);
}

export function documentTermScore(document, rankedTerms) {
  const tokens = new Set(normalizedTokens(document));
  return rankedTerms.reduce((total, term) => total + (tokens.has(term.token) ? term.weight : 0), 0);
}

