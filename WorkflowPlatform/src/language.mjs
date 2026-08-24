const SUPPORTED_LANGUAGES = new Set(["en", "ru"]);

export function normalizeLanguage(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-").split("-")[0];
  return SUPPORTED_LANGUAGES.has(normalized) ? normalized : null;
}

function detectedLanguage(text, { allowShortLatin = false } = {}) {
  const value = String(text ?? "");
  const cyrillic = (value.match(/[\u0400-\u04ff]/g) ?? []).length;
  const latin = (value.match(/[a-z]/gi) ?? []).length;
  if (cyrillic > 0) return "ru";
  if (latin >= 8 || (allowShortLatin && latin > 0) || (value.match(/[a-z]+/gi) ?? []).length >= 2) return "en";
  return null;
}

export function resolveResponseLanguage({ message, preferredLanguage = null, history = [] } = {}) {
  const previous = [...history].reverse().map(item => detectedLanguage(item?.content, { allowShortLatin: true })).find(Boolean) ?? null;
  const preferred = normalizeLanguage(preferredLanguage);
  return detectedLanguage(message, { allowShortLatin: previous === null && preferred === null }) ?? previous ?? preferred ?? "en";
}

export function languageName(language) {
  return normalizeLanguage(language) === "ru" ? "Russian" : "English";
}
