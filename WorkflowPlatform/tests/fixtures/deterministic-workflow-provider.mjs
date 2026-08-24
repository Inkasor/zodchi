let input = "";
for await (const chunk of process.stdin) input += chunk;
const role = input.match(/^ROLE: ([^\r\n]+)/m)?.[1] ?? "unknown";

function contractEnvelope() {
  const match = input.match(/WORKFLOW ROLE CONTRACT\r?\n(\{.*\})\r?\nReturn exactly/s);
  return match ? JSON.parse(match[1]) : null;
}

let result;
if (role === "classifier") {
  const conversation = input.includes("SCENARIO:conversation"), research = input.includes("SCENARIO:research");
  result = {
    schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "game-development", discipline: "software",
    risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null,
    reason: "A registered read-only verification route was requested.", questions: [], human_response: null
  };
  if (conversation) Object.assign(result, { work_type: "conversation", artifact_type: "none", domain: "general", discipline: "general", planning_level: "L0", planning_required: false, reply_mode: "conversation", reason: "Ordinary conversation requires no productive role.", human_response: "Привет! Workflow Platform отвечает в тот же чат без запуска рабочих ролей." });
  if (research) Object.assign(result, { work_type: "research", artifact_type: "document", domain: "research", discipline: "software", planning_level: "L1", planning_required: false, reply_mode: "research", reason: "Bounded research uses only registered project documents.", human_response: null });
} else if (role === "researcher") {
  result = "Исследование выполнено только по зарегистрированным документам Project R; файлы не изменялись, worker и reviewer не запускались.";
} else if (role === "planner") {
  const contract = contractEnvelope(), checks = contract?.package?.registered_checks ?? [];
  result = {
    schema_version: 1, outcome: "ready", scope: { included: ["read-only technical verification"], excluded: ["source edits", "owner acceptance", "publication"] },
    allowed_paths: [], inputs: ["registered project documents", "current working tree"], checks, risks: ["existing dirty worktree is preserved"], artifacts: [],
    completion_criteria: ["all registered required checks pass", "reviewer returns PASS"], questions: [],
    steps: [{ key: "verify_project", role: "game_programmer", objective: "Perform no edits; provide structured evidence so registered checks can verify the current project.", allowed_paths: [], artifact_keys: [], check_ids: checks, required: true, irreversible: false, max_attempts: 1 }]
  };
} else if (role === "game_programmer") {
  result = { schema_version: 1, status: "completed", summary: "No source edits were made; the package is ready for registered read-only checks.", changed_paths: [], artifacts: [], evidence: ["zero-path allowlist", "project gate follows"], questions: [] };
} else if (role === "reviewer" || role.includes("reviewer")) {
  result = { schema_version: 1, decision: "PASS", summary: "Registered checks are green and no source path was changed by the bounded worker.", blockers: [], required_actions: [], evidence_refs: ["project-gate:passed", "worker:zero-change"] };
} else {
  result = { schema_version: 1, status: "completed", summary: `The bounded ${role} contract completed without source edits or owner decisions.`, changed_paths: [], artifacts: [], evidence: ["zero-path allowlist"], questions: [] };
}

console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 64, cached_input_tokens: 16, output_tokens: 32, reasoning_output_tokens: 4, service_tier: "deterministic-contract" } }));
console.log(JSON.stringify({ result: JSON.stringify(result) }));
