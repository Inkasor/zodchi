<document id="zodchi_architecture" status="accepted" authority="zodchi" version="0.5.13" language="en">
  <title>Zodchi system architecture</title>

  <purpose status="accepted">
    Zodchi turns an ordinary project chat into a governed workflow. The program handles repeatable routing, context assembly, model calls, checks, and result recording while the person retains authority over important decisions.
  </purpose>

  <components status="accepted">
    <component id="workflow_platform" responsibility="workflow">Classifies the request, assembles registered context, selects a route, and manages stages, documents, and deterministic checks.</component>
    <component id="code_intelligence" responsibility="source_retrieval">Maps natural-language evidence to code identifiers, expands them through bounded BSL or TypeScript/JavaScript structure, and returns measured source locations without embeddings.</component>
    <component id="agent_gateway" responsibility="model_calls">Performs one bounded call to the assigned model and stores a technical receipt without the full request or response.</component>
    <component id="project_hook" responsibility="chat_entry">Passes a new project-chat message to WorkflowPlatform and returns the result to the same chat.</component>
  </components>

  <flow status="accepted">
    <step id="intake" order="1">Receive the user message and a stable event identifier.</step>
    <step id="context" order="2">Programmatically assemble permitted project facts, registered documents, lexical source evidence, and a bounded language graph.</step>
    <step id="classification" order="3">Determine intent, work type, expected artifact, planning level, and quality mode.</step>
    <step id="dialog_or_route" order="4">Answer or ask a question when execution is unnecessary; otherwise start a registered workflow.</step>
    <step id="execution" order="5">Run planning, execution, checks, correction, review, and documentation according to the selected contracts.</step>
    <step id="response" order="6">Return a concise human result, material limitations, and the next required action in the conversation language.</step>
  </flow>

  <contracts status="accepted">
    <rule id="registered_routes_only">Routes, roles, documents, and checks come from registries; runtime code does not infer them from keywords.</rule>
    <rule id="one_gateway_call">One AgentGateway run performs exactly one bounded model call; WorkflowPlatform owns the overall process.</rule>
    <rule id="quality_cascade">A stricter quality mode includes applicable checks from simpler modes and reruns them for the changed result.</rule>
    <rule id="documentator_boundary">Documentator receives a target document and accepted decisions from the workflow, verifies version and semantic markup, then applies the change atomically.</rule>
    <rule id="human_acceptance">Technical success never implies visual, gameplay, product, business, access, publication, or deployment acceptance.</rule>
    <rule id="conversation_language">Response language comes from an explicit host value when available, then installation preference, then current conversation; the current user language has priority.</rule>
    <rule id="source_truth">Source files remain authoritative; language adapters report coverage, ambiguity, and truncation and return locations rather than replacing source with an inferred summary.</rule>
    <rule id="completion_truth">The registered completion blockers are the sole canonical completion authority; planner criteria remain advisory.</rule>
    <rule id="run_evidence">Review compares the verbatim owner objective with run-relative Git or inventory changes, deterministic gates, analytical conclusions, and retained primary source evidence.</rule>
    <rule id="bounded_gauntlet">A project may explicitly select the Gauntlet improvement strategy: targeted corrections and independent same-evidence reviews repeat only while measurable progress and declared budgets permit.</rule>
    <rule id="interruptible_execution">Gateway invocations declare cancellation capability; owner cancellation terminates the complete provider process tree, while pause waits for a safe execution boundary.</rule>
  </contracts>

  <storage status="accepted">
    <rule id="replaceable_release">The program release is replaced as one unit and is not a user-state store.</rule>
    <rule id="external_local_data">Projects, local model assignments, databases, run history, and credentials stay outside the release.</rule>
    <rule id="portable_packages">Portable workflows use semantic keys and contain no secrets, absolute paths, or local identifiers.</rule>
  </storage>
</document>
