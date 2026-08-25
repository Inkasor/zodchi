-- A package names the profile it requires; onboarding names the profile the installation actually has.
-- The two are different namespaces by design, because a portable package carries no local identity, so
-- a local profile id can never be expected to equal a portable requirement key. The assignment records
-- which requirement it fulfils, and that is what the role contract is checked against.
ALTER TABLE role_profile_assignments ADD COLUMN satisfies_profile_key TEXT;

-- Exactly one requirement exists per project and role, so an existing assignment fulfils it
-- unambiguously. An assignment for a role the package never declared keeps a null key and stays
-- outside the requirement check.
UPDATE role_profile_assignments
SET satisfies_profile_key = (
  SELECT r.profile_key FROM portable_profile_requirements r
  WHERE r.project_id = role_profile_assignments.project_id
    AND r.role_id = role_profile_assignments.role_id
)
WHERE satisfies_profile_key IS NULL;

CREATE INDEX idx_role_profile_assignments_requirement ON role_profile_assignments(project_id, satisfies_profile_key);
