-- Runs created by the pre-033 session router may be waiting for a chat answer without a provable
-- session association. Leaving those interactions pending would make them invisible in every isolated
-- chat forever. Cancel only live waits whose recorded intake source proves they came from a Zodchi chat;
-- stateless CLI and automation runs remain untouched and can still be managed explicitly.
CREATE TEMP TABLE migration_034_orphaned_chat_runs (
  run_id TEXT PRIMARY KEY
);

INSERT INTO migration_034_orphaned_chat_runs(run_id)
SELECT DISTINCT wr.id
FROM workflow_runs wr
JOIN events event ON event.entity_type='workflow_run' AND event.entity_id=wr.id AND event.kind='created'
LEFT JOIN zodchi_chat_session_runs bound ON bound.run_id=wr.id
WHERE bound.run_id IS NULL
  AND wr.state IN ('clarification_required','external_evidence_required','approval_required')
  AND json_extract(event.payload_json,'$.source') LIKE '%-zodchi-session';

UPDATE approvals
SET status='cancelled',
    resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    answer_json=json_object(
      'reason','pre-0.6.12 chat session cannot be reconstructed safely; restart the request in that chat',
      'migration',34
    )
WHERE status='pending' AND run_id IN (SELECT run_id FROM migration_034_orphaned_chat_runs);

UPDATE document_proposals
SET status='cancelled',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE status='pending' AND run_id IN (SELECT run_id FROM migration_034_orphaned_chat_runs);

INSERT INTO events(event_id,entity_type,entity_id,task_id,run_id,kind,payload_json,created_at)
SELECT 'migration-034:' || wr.id,'workflow_run',wr.id,wr.task_id,wr.id,'migration_cancelled',
       json_object(
         'reason','unbound pre-session-isolation chat wait',
         'action','restart the request in the original chat after upgrade'
       ),
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM workflow_runs wr
JOIN migration_034_orphaned_chat_runs orphan ON orphan.run_id=wr.id;

UPDATE tasks
SET state='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN (
  SELECT wr.task_id FROM workflow_runs wr
  JOIN migration_034_orphaned_chat_runs orphan ON orphan.run_id=wr.id
);

UPDATE workflow_runs
SET state='cancelled',
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN (SELECT run_id FROM migration_034_orphaned_chat_runs);

DROP TABLE migration_034_orphaned_chat_runs;
