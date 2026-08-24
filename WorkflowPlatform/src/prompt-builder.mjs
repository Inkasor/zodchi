import { escapeXml } from "./limited-xml.mjs";
import { DEFAULT_QUALITY_CONTRACTS, operationalLevel, renderQualityContract } from "./quality-contracts.mjs";
import { stableJson } from "./role-contracts.mjs";
import { languageName, normalizeLanguage } from "./language.mjs";

export function buildPrompt(input) {
  const required = ["role", "stage", "intent", "classification", "quality", "format"];
  for (const key of required) if (input[key] === undefined) throw new Error(`prompt contract: missing ${key}`);
  const level = operationalLevel(input.quality);
  const quality = DEFAULT_QUALITY_CONTRACTS.find(item => item.level === level);
  if (!quality) throw new Error(`prompt contract: missing quality contract ${level}`);
  const stableContext = { role: input.role, stage: input.stage, classification: input.classification, plan: input.plan ?? null, document: input.document ?? "", evidence: input.evidence ?? [], constraints: input.constraints ?? [], response_format: input.format };
  const responseLanguage = normalizeLanguage(input.responseLanguage) ?? "en";
  return `<workflow_request schema_version="2">\n`+
    `  <role id="${escapeXml(input.role)}" stage="${escapeXml(input.stage)}"/>\n`+
    `  <communication language="${responseLanguage}">Write human-facing text in ${languageName(responseLanguage)}. Keep schema keys, enum values and machine-only identifiers in English.</communication>\n`+
    `${renderQualityContract(quality, "  ")}\n`+
    `  <context format="application/json">${escapeXml(stableJson(stableContext))}</context>\n`+
    `  <current_intent>${escapeXml(input.intent)}</current_intent>\n`+
    `</workflow_request>`;
}
