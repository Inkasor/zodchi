UPDATE operational_level_policies
SET improvement_strategy='gauntlet',
    budgets_json=json_set(budgets_json,
      '$.calls',12,
      '$.duration_ms',3600000,
      '$.correction_cycles',3,
      '$.cost_usd',2),
    correction_limit=3
WHERE level='prototype'
  AND package_key IN ('software.web-application','one-c.development','game.web','game.unity','data.analytics','infra.operations','marketing.content-operations')
  AND improvement_strategy='standard'
  AND CAST(json_extract(budgets_json,'$.calls') AS REAL)=4
  AND CAST(json_extract(budgets_json,'$.correction_cycles') AS REAL)=0;

UPDATE operational_level_budget_limits
SET limit_value=CASE metric
  WHEN 'calls' THEN 12
  WHEN 'duration_ms' THEN 3600000
  WHEN 'correction_cycles' THEN 3
  WHEN 'cost_usd' THEN 2
  ELSE limit_value END
WHERE level='prototype'
  AND package_key IN ('software.web-application','one-c.development','game.web','game.unity','data.analytics','infra.operations','marketing.content-operations')
  AND ((metric='calls' AND limit_value=4)
    OR (metric='duration_ms' AND limit_value=600000)
    OR (metric='correction_cycles' AND limit_value=0)
    OR (metric='cost_usd' AND limit_value=0.5));

INSERT OR IGNORE INTO operational_level_escalation_rules
  (project_id,package_key,level,event_key,action_key,threshold_value,ordinal)
SELECT project_id,package_key,'prototype','max_parallel_consilium_members','threshold',3,
  COALESCE((SELECT MAX(e.ordinal) FROM operational_level_escalation_rules e
    WHERE e.project_id=p.project_id AND e.package_key=p.package_key AND e.level='prototype'),0)+1
FROM operational_level_policies p
WHERE level='prototype' AND improvement_strategy='gauntlet'
  AND NOT EXISTS (SELECT 1 FROM operational_level_escalation_rules e
    WHERE e.project_id=p.project_id AND e.package_key=p.package_key
      AND e.level='prototype' AND e.event_key='max_parallel_consilium_members');
