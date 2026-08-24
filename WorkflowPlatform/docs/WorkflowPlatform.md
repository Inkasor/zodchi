<document id="workflow_platform" version="0.2.4" status="working" kind="governance" language="en">
<metadata owner="workflow-platform" authority="Zodchi">
</metadata>
<section id="documentator_contract" status="accepted">
Document changes go only through Documentator and pass Document Lint.
</section>
<rule id="document_changes_go_through_documentator" status="accepted">
A model proposes a structured patch; the program validates and applies it.
</rule>
<section id="installation_boundary" status="accepted">
Product sources, replaceable release, and local user state are separate areas.
</section>
<rule id="development_sources_use_git" status="accepted">
WorkflowPlatform and AgentGateway are modules of the single Zodchi repository; Git is the source history.
</rule>
<rule id="release_is_replaceable" status="accepted">
A release is assembled from committed sources, validated, and replaced as one unit; successful replacement leaves no permanent duplicate of the previous release.
</rule>
<rule id="local_state_is_external" status="accepted">
Local profiles, model assignments, project registry, run history, and both databases stay outside the release and survive product updates.
</rule>
<rule id="project_hooks_use_release" status="accepted">
Project hooks start WorkflowPlatform from the installed release, never from the development repository.
</rule>
<rule id="response_language" status="accepted">
WorkflowPlatform stores the resolved response language and passes it to every user-facing role; schema keys and enum values remain English.
</rule>
<section id="license" status="accepted">
WorkflowPlatform is distributed as part of Zodchi under the repository-level MIT License. Copyright 2026 Petr Tsap.
</section>
</document>
