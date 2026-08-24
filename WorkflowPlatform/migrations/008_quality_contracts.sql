CREATE TABLE quality_contracts (
  level TEXT PRIMARY KEY CHECK (level IN ('prototype','mvp','production','security-audit')),
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  reviewer_policy TEXT NOT NULL CHECK (reviewer_policy IN ('none','conditional','required','security_required')),
  documentation_policy TEXT NOT NULL CHECK (documentation_policy IN ('evidence','verified_result','release_record','security_report')),
  correction_limit INTEGER NOT NULL CHECK (correction_limit >= 0),
  status TEXT NOT NULL CHECK (status IN ('active','superseded','disabled'))
);

CREATE TABLE quality_contract_rules (
  level TEXT NOT NULL REFERENCES quality_contracts(level) ON DELETE CASCADE,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('success','allowed_shortcut','forbidden_shortcut','required_evidence')),
  rule_key TEXT NOT NULL,
  description TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(level,rule_type,rule_key),
  UNIQUE(level,rule_type,ordinal)
);

CREATE TABLE quality_contract_budgets (
  level TEXT NOT NULL REFERENCES quality_contracts(level) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('calls','duration_ms','correction_cycles')),
  limit_value REAL NOT NULL CHECK (limit_value >= 0),
  PRIMARY KEY(level,metric)
);

CREATE TABLE quality_contract_escalations (
  level TEXT NOT NULL REFERENCES quality_contracts(level) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  action_key TEXT NOT NULL,
  threshold_value REAL,
  description TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(level,event_key),
  UNIQUE(level,ordinal)
);

CREATE TABLE operational_level_budget_limits (
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('prototype','mvp','production','security-audit')),
  metric TEXT NOT NULL CHECK (metric IN ('calls','duration_ms','correction_cycles')),
  limit_value REAL NOT NULL CHECK (limit_value >= 0),
  PRIMARY KEY(project_id,package_key,level,metric)
);

CREATE TABLE operational_level_escalation_rules (
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('prototype','mvp','production','security-audit')),
  event_key TEXT NOT NULL,
  action_key TEXT NOT NULL,
  threshold_value REAL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(project_id,package_key,level,event_key),
  UNIQUE(project_id,package_key,level,ordinal)
);

ALTER TABLE workflow_runs ADD COLUMN quality_contract_version TEXT;
ALTER TABLE workflow_runs ADD COLUMN correction_cycles INTEGER NOT NULL DEFAULT 0 CHECK (correction_cycles >= 0);
ALTER TABLE workflow_runs ADD COLUMN reviewer_policy TEXT;

ALTER TABLE document_operations ADD COLUMN quality_level TEXT;
ALTER TABLE document_operations ADD COLUMN quality_contract_version TEXT;
ALTER TABLE document_operations ADD COLUMN evidence_type TEXT;
ALTER TABLE document_operations ADD COLUMN decision_status TEXT;

INSERT OR IGNORE INTO semantic_statuses(id,name,category) VALUES
  ('accepted','Accepted','decision'),
  ('proposed','Proposed','decision'),
  ('open','Open','decision'),
  ('rejected','Rejected','decision'),
  ('superseded','Superseded','lifecycle'),
  ('working','Working','legacy_content'),
  ('target','Target','legacy_content'),
  ('observed','Observed','legacy_content'),
  ('log','Log','legacy_content'),
  ('verified','Verified','evidence');

INSERT OR IGNORE INTO evidence_types(id,name) VALUES
  ('authoritative','Authoritative'),
  ('verified','Verified'),
  ('estimate','Estimate'),
  ('observation','Observation');

INSERT INTO quality_contracts(level,version,name,purpose,reviewer_policy,documentation_policy,correction_limit,status) VALUES
  ('prototype','1.0.0','Prototype','Test one highest-risk assumption with the smallest reversible artifact.','none','evidence',0,'active'),
  ('mvp','1.0.0','MVP','Deliver one complete relevant user scenario with deterministic evidence.','conditional','verified_result',1,'active'),
  ('production','1.0.0','Production','Prepare and verify a real release and deployment with rollback boundaries.','required','release_record',1,'active'),
  ('security-audit','1.0.0','Security audit','Perform a read-only scoped security assessment and report residual risk.','security_required','security_report',0,'active');

INSERT INTO quality_contract_budgets(level,metric,limit_value) VALUES
  ('prototype','calls',4),('prototype','duration_ms',600000),('prototype','correction_cycles',0),
  ('mvp','calls',12),('mvp','duration_ms',3600000),('mvp','correction_cycles',1),
  ('production','calls',18),('production','duration_ms',7200000),('production','correction_cycles',1),
  ('security-audit','calls',8),('security-audit','duration_ms',3600000),('security-audit','correction_cycles',0);

INSERT INTO quality_contract_rules(level,rule_type,rule_key,description,ordinal) VALUES
  ('prototype','success','assumption_answered','The named risky assumption is answered by observable evidence.',1),
  ('prototype','success','artifact_inspectable','The artifact can be inspected or run inside the declared boundary.',2),
  ('prototype','allowed_shortcut','narrow_happy_path','One primary path, fixtures, stubs and mocks are allowed when declared.',1),
  ('prototype','forbidden_shortcut','skip_static_checks','Configured static diagnostics may not be skipped or hidden.',1),
  ('prototype','forbidden_shortcut','readiness_claim','Prototype evidence may not be presented as production readiness.',2),
  ('prototype','required_evidence','target_signal','Record at least one target signal and the known limitations.',1),
  ('mvp','success','complete_scenario','One relevant end-to-end user scenario works inside the accepted scope.',1),
  ('mvp','success','deterministic_green','All applicable static checks, dedicated tests and document lint are green.',2),
  ('mvp','allowed_shortcut','secondary_scope','Secondary paths, polish and scale work may remain explicit follow-up work.',1),
  ('mvp','forbidden_shortcut','missing_tests','Relevant newly created behavior may not ship without dedicated tests.',1),
  ('mvp','forbidden_shortcut','hidden_limitations','Known limitations and skipped coverage may not be omitted.',2),
  ('mvp','required_evidence','scenario_and_gates','Record the scenario result, gate results and remaining owner acceptance.',1),
  ('production','success','release_verified','The exact release is built, deployed and verified in the authorized target.',1),
  ('production','success','rollback_ready','Rollback, observability, compatibility and data-safety boundaries are explicit.',2),
  ('production','allowed_shortcut','none_undeclared','Only explicitly accepted non-blocking limitations are allowed.',1),
  ('production','forbidden_shortcut','unapproved_deploy','Deployment or publication may not occur without recorded owner approval.',1),
  ('production','forbidden_shortcut','partial_regression','Applicable MVP checks and release checks may not be reduced.',2),
  ('production','required_evidence','release_record','Record revision, target, checks, deployment verification and rollback evidence.',1),
  ('security-audit','success','scoped_assessment','Assets, trust boundaries, threat model and coverage are explicit.',1),
  ('security-audit','success','findings_ranked','Findings include severity, evidence, mitigation and residual risk.',2),
  ('security-audit','allowed_shortcut','none_silent','Coverage limits are allowed only when reported as limits.',1),
  ('security-audit','forbidden_shortcut','silent_remediation','The audit may not modify the target unless a separate change is authorized.',1),
  ('security-audit','forbidden_shortcut','empty_coverage_pass','Missing security coverage is unavailable, never passed.',2),
  ('security-audit','required_evidence','security_report','Record scoped findings, evidence references and residual risk.',1);

INSERT INTO quality_contract_escalations(level,event_key,action_key,threshold_value,description,ordinal) VALUES
  ('prototype','owner_decision','ask_owner',NULL,'Escalate only an owner decision or a blocked target signal.',1),
  ('mvp','high_risk','independent_review',NULL,'Use an independent reviewer for high-risk work.',1),
  ('mvp','correction_used','independent_review',1,'Use an independent reviewer after a correction cycle.',2),
  ('mvp','protected_boundary','independent_review',NULL,'Review data, access, external contracts and cross-project boundaries.',3),
  ('production','gate_green','independent_review',NULL,'Production always requires an independent reviewer after green gates.',1),
  ('production','irreversible_action','owner_approval',NULL,'Deployment, publication and irreversible actions require owner approval.',2),
  ('security-audit','audit_ready','security_review',NULL,'A designated security reviewer is mandatory.',1),
  ('security-audit','remediation_requested','separate_workflow',NULL,'Remediation is a separate authorized workflow.',2);

INSERT INTO operational_level_budget_limits(project_id,package_key,level,metric,limit_value)
SELECT project_id,package_key,level,'calls',CAST(json_extract(budgets_json,'$.calls') AS REAL)
FROM operational_level_policies WHERE json_type(budgets_json,'$.calls') IS NOT NULL;

INSERT INTO operational_level_budget_limits(project_id,package_key,level,metric,limit_value)
SELECT project_id,package_key,level,'duration_ms',CAST(json_extract(budgets_json,'$.duration_ms') AS REAL)
FROM operational_level_policies WHERE json_type(budgets_json,'$.duration_ms') IS NOT NULL;

INSERT INTO operational_level_budget_limits(project_id,package_key,level,metric,limit_value)
SELECT project_id,package_key,level,'correction_cycles',correction_limit
FROM operational_level_policies;

INSERT INTO operational_level_escalation_rules(project_id,package_key,level,event_key,action_key,threshold_value,ordinal)
SELECT p.project_id,p.package_key,p.level,j.key,
  CASE WHEN j.value IN (1,'true') THEN 'required' ELSE CAST(j.value AS TEXT) END,
  CASE WHEN json_type(p.escalation_json,'$.' || j.key) IN ('integer','real') THEN CAST(j.value AS REAL) ELSE NULL END,
  CAST(j.id AS INTEGER)+1
FROM operational_level_policies p, json_each(p.escalation_json) j;
