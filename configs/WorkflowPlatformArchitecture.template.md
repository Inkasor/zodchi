<document id="workflow_platform_architecture" status="proposed" authority="workflow-platform" version="0.2.0">
  <title>Zodchi — описание и настройка</title>
  <purpose>Шаблон для человека и onboarding-модели. Модель заполняет TODO только проверенными значениями.</purpose>

  <system id="workflow_platform" status="accepted">
    <component id="workflow_platform_component" role="semantic_runtime">Смысл, контекст, классификация, маршруты, проверки и документы.</component>
    <component id="agent_gateway" role="model_gateway">Технический запуск провайдеров, профилей и моделей. Gateway не выбирает смысловой маршрут.</component>
    <component id="codex_hook" role="entrypoint">UserPromptSubmit передаёт новое сообщение в Workflow Platform.</component>
    <component id="workflow_database" role="state_store">Реестр проектов, документов, ролей, запусков, решений и проверок.</component>
  </system>

  <flow id="default_flow" status="accepted">
    <step order="1" role="codex_hook">Получить сообщение из чата.</step>
    <step order="2" role="context_builder">Собрать зарегистрированные документы и рабочий контекст.</step>
    <step order="3" role="classifier">Определить намерение, work_type, дисциплину, уровень, качество и необходимость документирования.</step>
    <step order="4" role="router">Выбрать маршрут по решению классификатора.</step>
    <step order="5" role="agent_gateway">Передать конкретную роль и контекст выбранному профилю модели.</step>
    <step order="6" role="checks">Запустить программные проверки.</step>
    <step order="7" role="documentator">Применить разрешённое документное изменение и прогнать document-lint.</step>
    <step order="8" role="response_formatter">Вернуть человеку простой русский результат.</step>
  </flow>

  <installation status="proposed">
    <field id="workflow_platform_path">TODO</field>
    <field id="agent_gateway_path">TODO</field>
    <field id="workflow_db_path">TODO</field>
    <field id="gateway_db_path">TODO</field>
    <field id="codex_cli_path">TODO</field>
    <field id="project_root">TODO</field>
    <field id="project_id">TODO</field>
  </installation>

  <initial_configuration status="proposed">
    <purpose>Начальные роли, справочники, проверки и маршруты поставляются как рабочая отправная точка и могут быть изменены владельцем.</purpose>
    <rule id="initial_config_is_editable">Начальная настройка не является неизменяемым каноном.</rule>
    <rule id="project_owns_configuration">Проект и его владелец определяют роли, документы, маршруты и проверки.</rule>
    <source>TODO: semantic-пакет или локальная запись, из которой загружена настройка.</source>
  </initial_configuration>

  <registry id="project_registry" status="accepted">
    <rule id="documents_are_registered">Документы проекта регистрируются в Workflow DB, а не зашиваются в код workflow.</rule>
    <rule id="role_owns_document_access">Роль получает документы через связи role_documents с правами read_access и write_access.</rule>
    <rule id="documentator_writes_by_permission">Documentator изменяет только документ, для которого у роли есть разрешение записи.</rule>
    <documents>TODO: список зарегистрированных документов.</documents>
    <roles>TODO: список ролей проекта.</roles>
    <assignments>TODO: связи роль → документ.</assignments>
  </registry>

  <roles status="accepted">
    <role id="classifier" artifact="classification" access="read">Определяет намерение и маршрут.</role>
    <role id="researcher" artifact="research" access="read">Работает только с переданным контекстом.</role>
    <role id="planner" artifact="plan" access="read">Создаёт bounded-план.</role>
    <role id="worker" artifact="result">Выполняет ограниченный пакет.</role>
    <role id="reviewer" artifact="review" access="read">Проверяет результат и критерии приёмки.</role>
    <role id="documentator" artifact="document_patch" access="registered_write">Создаёт или изменяет разрешённые документы.</role>
    <profiles>TODO: для каждой роли указать исполнительную среду Gateway, локальный профиль, поставщика модели и model ID.</profiles>
    <contract_rule id="portable_role_contract">Назначение, границы, типы работ и артефактов, документы, инструменты, skills, checks, transitions, limits, result schema и escalation хранятся в переносимом versioned role contract.</contract_rule>
    <assignment_rule id="local_profile_assignment">Конкретные профиль и model ID назначаются локально и не являются частью переносимого role contract.</assignment_rule>
    <assignment_rule id="harness_provider_separation">Исполнительная среда и поставщик модели являются независимыми полями: одна модель может вызываться через разные агентские программы или прямой совместимый API.</assignment_rule>
  </roles>

  <structured_execution status="accepted">
    <rule id="planner_schema">Planner возвращает строгий план или вопросы до авторизации; worker получает только нормализованный пакет.</rule>
    <rule id="registered_gates_only">Запускаются только зарегистрированные проверки для проекта, типа артефакта и operational level.</rule>
    <rule id="reviewer_decision">Reviewer возвращает только PASS, CHANGES_REQUESTED или REJECT; последние два решения блокируют completed.</rule>
    <rule id="human_acceptance_separate">Reviewer PASS не заменяет программные gates и человеческую визуальную, игровую, продуктовую или бизнес-приёмку.</rule>
    <rule id="documentator_atomic">Documentator проверяет зарегистрированный target, authority, write permission, operation и exact version, выполняет lint до атомарной замены и сохраняет исходник при конфликте.</rule>
    <rule id="role_and_quality_contracts_are_separate">Роль имеет один устойчивый контракт; режим качества передаётся отдельным универсальным контрактом.</rule>
    <rule id="workflow_owns_retries">Workflow Platform владеет общими бюджетами, исправлениями, проверками и эскалацией; один запуск Gateway выполняет один вызов модели.</rule>
    <rule id="empty_program_gate_is_unavailable">Для программного артефакта отсутствие применимых проверок означает unavailable, а не passed.</rule>
  </structured_execution>

  <portable_package status="accepted">
    <field id="package_key">TODO: устойчивый смысловой ключ.</field>
    <field id="package_version">TODO: semver.</field>
    <field id="package_purpose">TODO: назначение пакета.</field>
    <rule id="complete_package">Пакет включает roles/contracts, logical profiles, graph/transitions, state contract, routes, questions, schemas, checks, operational levels/budgets, correction/escalation, documents/authority/permissions, prompt template versions и anonymized scenarios.</rule>
    <rule id="no_local_identity">Секреты, root paths, local profile IDs и model IDs не экспортируются.</rule>
    <rule id="proposal_first_import">Импорт сначала создаёт hash-bound proposal и diff; apply требует подтверждения владельца и неизменных package/target hashes.</rule>
  </portable_package>

  <experience_v1 status="accepted">
    <rule id="structured_observations_only">Хранить только structured result, error category, gate outcomes, confirmed human feedback и технические metrics; не хранить prompt/output/transcript.</rule>
    <rule id="bounded_changes">Предлагать только изменение role contract, prompt template, check или route.</rule>
    <rule id="scenario_evaluation">Сравнивать quality, estimated cost, duration и passed на сохранённых anonymized scenarios.</rule>
    <rule id="confirmed_new_version">Применять только после подтверждения как новую patch-версию пакета.</rule>
  </experience_v1>

  <workflows status="proposed">
    <workflow id="conversation">classifier → response_formatter</workflow>
    <workflow id="research">classifier → researcher → response_formatter</workflow>
    <workflow id="decision">classifier → documentator → document-lint</workflow>
    <workflow id="implementation">classifier → planner → worker → checks → bounded_correction → conditional_reviewer → documentator</workflow>
    <workflow id="content_production">classifier → research → plan → content_roles → checks → review → documentator</workflow>
    <project_workflows>TODO: маршруты конкретного проекта.</project_workflows>
  </workflows>

  <quality_modes status="accepted">
    <mode id="prototype" reviewer="none" correction_limit="0">Проверить одну рисковую гипотезу; обязательны настроенные статические проверки и один наблюдаемый сигнал.</mode>
    <mode id="mvp" reviewer="conditional" correction_limit="1">Довести один полный пользовательский сценарий; обязательны применимые проверки и специальные тесты.</mode>
    <mode id="production" reviewer="required" correction_limit="1">Собрать, развернуть, проверить целевую среду и откат; необратимое действие требует решения владельца.</mode>
    <mode id="security-audit" reviewer="security_required" correction_limit="0">Провести отдельную проверку безопасности только на чтение; исправления выполняются другим маршрутом.</mode>
    <contract_source>contracts/quality-contracts.xml</contract_source>
  </quality_modes>

  <codex_hook status="proposed">
    <path>.codex/hooks.json</path>
    <command>node &lt;WORKFLOW_PLATFORM_ROOT&gt;\hooks\codex-user-prompt-submit.mjs</command>
    <human_action>После изменения hook пользователь подтверждает доверие к нему в интерфейсе Codex.</human_action>
    <verification>Проверить codex --version, тестовое событие и запись workflow_runs.</verification>
  </codex_hook>

  <extension_rules status="accepted">
    <rule id="no_project_names_in_runtime">Workflow Platform не содержит названий конкретных пользовательских документов и проектов.</rule>
    <rule id="new_workflow_is_configured">Новый workflow настраивается через справочники, роли, связи документов, профили и маршрут.</rule>
    <rule id="fail_closed_classifier">Если LLM-классификатор не вернул корректное решение, workflow останавливается с classification_failed.</rule>
  </extension_rules>
</document>
