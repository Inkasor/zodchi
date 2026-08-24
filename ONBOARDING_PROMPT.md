<document id="zodchi_onboarding" status="accepted" authority="zodchi" version="0.3.0-beta.1">
  <title>Первичная настройка Zodchi</title>
  <purpose>Инструкция для LLM, которая устанавливает и настраивает Zodchi. Общайся с человеком простым русским языком и не заставляй его заполнять внутренние поля.</purpose>

  <input id="user_request" status="accepted">Прочитай этот документ и запусти настройку Zodchi.</input>

  <preflight status="accepted">
    <check id="workflow_platform_path">Найди фактическую папку Workflow Platform.</check>
    <check id="agent_gateway_path">Найди фактическую папку Agent Gateway.</check>
    <check id="model_provider_catalog">Прочитай AgentGateway/model-providers.json и предлагай только реализованные там сочетания исполнительной среды и поставщика модели.</check>
    <check id="node_runtime">Проверь Node.js и package.json.</check>
    <check id="codex_cli">Найди Codex CLI и выполни codex --version.</check>
    <check id="opencode_desktop_cli">Если выбран OpenCode, отдельно проверь Desktop и CLI. Наличие OpenCode Desktop не означает наличие команды opencode. При отсутствии CLI установи официальный пакет opencode-ai, выполни opencode --version и затем безопасный тестовый вызов через Gateway.</check>
    <check id="codex_project_config">Найди проектную конфигурацию Codex и папку .codex.</check>
    <check id="provider_access">Проверь доступность настроенных провайдеров через безопасный вызов Gateway.</check>
    <check id="harness_access">Отдельно проверь доступность выбранной исполнительной среды: Codex, Claude Code, Kimi, OpenCode, Cursor или прямой совместимый API. Не считай название программы названием поставщика модели.</check>
    <check id="existing_data">Не переносить чужие базы, ключи, историю и квитанции.</check>
  </preflight>

  <project_onboarding status="accepted">
    <step order="1" id="identify_project">Найди корень первого проекта. Если найдено несколько вариантов, задай человеку один короткий вопрос.</step>
    <step order="2" id="register_project">Зарегистрируй проект, путь, домен и дисциплины в Workflow DB.</step>
    <step order="3" id="load_catalogs">Загрузи справочники из configs/catalogs.json.</step>
    <step order="4" id="discover_documents">Найди документы проекта и проверь их формат, статус и кодировку.</step>
    <step order="5" id="propose_ownership">Предложи человеку владельцев документов, роли с доступом на чтение и роли с доступом на запись.</step>
    <step order="6" id="confirm_ownership">Не назначай владельцев молча. Дождись подтверждения человека.</step>
    <step order="7" id="write_registry">После подтверждения запиши project_documents и role_documents в Workflow DB.</step>
    <step order="8" id="confirm_routes">Предложи связи зарегистрированных work_types с workflow_routes и дождись подтверждения владельца; не выбирай продуктовый маршрут молча.</step>
    <step order="9" id="write_routes">Запиши только подтверждённые workflow_routes. Классификатор не должен использовать маршрут, отсутствующий в реестре.</step>
    <step order="10" id="architecture_document">Создай копию configs/WorkflowPlatformArchitecture.template.md в локальном onboarding-документе проекта и заполни только проверенные значения.</step>
    <step order="11" id="local_assignments">На основе подтверждённых человеком назначений создай локальный installation config по шаблону configs/installation.example.json. Не помещай в него токены, cookies, пароли или auth-файлы.</step>
    <rule id="separate_harness_and_model_provider">Для каждого локального профиля отдельно зафиксируй исполнительную среду, поставщика модели и model ID. Для совместимого API записывай только baseUrl и имя переменной окружения apiKeyEnv; значение ключа не записывай.</rule>
    <rule id="tool_roles_need_harness">Роли, которым нужны файлы, терминал или другие инструменты, назначай агентской исполнительной среде. Прямой совместимый API используй только для ограниченной работы над уже переданным контекстом.</rule>
    <step order="12" id="configure_installation">Запусти `node WorkflowPlatform/src/cli.mjs configure --config &lt;local-installation-config&gt;`. Общая установка должна использовать scope=shared и localDataRoot вне папки поставки. Команда создаёт внешний runtime.json, локальный policy overlay только с профилями и пути обеих баз; universal policy и адаптеры поставки не изменять.</step>
    <step order="13" id="configure_runtime_environment">На Windows запиши возвращённый WORKFLOW_PLATFORM_CONFIG в пользовательскую переменную окружения и сообщи, что Codex нужно перезапустить. Проектные hooks должны ссылаться на WorkflowPlatform внутри поставки, а не на репозиторий разработки.</step>
    <step order="14" id="role_contracts">Предложи переносимые versioned role contracts отдельно от локальных profile/model assignments. Для каждой роли явно задай границы, artifacts, documents, tools/skills, checks, transitions, limits, result schema и escalation; локальную модель не записывай в контракт.</step>
    <step order="15" id="registered_checks">Регистрируй только проверки, релевантные проекту, artifact type и operational level. Не выводи команды автоматически из языка или наличия package.json.</step>
    <step order="16" id="portable_package_contract">Задай semantic package key/version/purpose, полный граф шагов и transitions, human questions, schemas, operational policies, prompt template versions и anonymized test scenarios. Не включай local profile/model IDs, абсолютные пути или секреты.</step>
    <step order="17" id="import_confirmation">При переносе сначала выполни workflow-import-propose, покажи человеку компактный diff и только после явного подтверждения выполни workflow-import-apply с confirmed-by.</step>
    <step order="18" id="starter_package_selection">Покажи доступные пакеты из WorkflowPlatform/packages/catalog.json. Не импортируй пакет и не назначай ему локальные profiles/check commands, пока человек не подтвердил проект и diff.</step>
    <step order="19" id="company_bundle_validation">Если выбран корпоративный набор, сначала выполни workflow-bundle-inspect для WorkflowPlatform/packages/generated/company-workflows.xml. Затем предложи только тот проектный пакет, который соответствует текущему проекту. Не копируй чужие проекты и не включай их hooks.</step>
  </project_onboarding>

  <codex_hook status="accepted">
    <step order="1">Возьми configs/codex-hooks.template.json.</step>
    <step order="2">Подставь фактический путь Workflow Platform.</step>
    <step order="3">Создай или обнови проектный .codex/hooks.json.</step>
    <step order="4">Проверь, что команда запускает hooks/codex-user-prompt-submit.mjs.</step>
    <step order="5">Проверь тестовым событием, что в workflow_runs появилась запись.</step>
    <rule id="stable_event_id">Передавай устойчивый event_id клиента для защиты от повторной доставки. Не заменяй отсутствующий ID хешем текста сообщения.</rule>
    <human_gate>Если Codex пометил hook как недоверенный, сообщи человеку: «Откройте настройки проекта Codex и включите доверие для Workflow Platform hook». Не называй это ошибкой системы.</human_gate>
    <new_chat>После подтверждения доверия попроси человека открыть новый чат и отправить обычное тестовое сообщение.</new_chat>
  </codex_hook>

  <databases status="accepted">
    <database id="workflow_db">Локальное состояние workflow, реестр документов, роли, маршруты, решения и проверки.</database>
    <database id="gateway_db">Локальные технические квитанции вызовов моделей, токены, кэш, время и ошибки.</database>
    <rule id="local_only">Базы создаются локально у каждого пользователя и не входят в поставку Zodchi.</rule>
    <rule id="local_profiles">Конкретные исполнительные среды, поставщики, профили и модели записываются только в локальный policy.local.json после подтверждения человеком.</rule>
  </databases>

  <safety status="accepted">
    <rule id="no_foreign_data">Не переносить чужие проекты, документы, базы, ключи и историю.</rule>
    <rule id="no_silent_writes">Не менять документы и не назначать владельцев без подтверждения человека.</rule>
    <rule id="classifier_fail_closed">Если LLM-классификатор не вернул корректное решение, остановиться с classification_failed.</rule>
    <rule id="registered_context_only">Classifier, researcher и остальные роли получают только зарегистрированные документы, разрешённые для роли; не сканировать известные имена файлов и папок как скрытые defaults.</rule>
    <rule id="structured_role_results">Planner, worker, reviewer и documentator должны возвращать результат своих точных схем; reviewer PASS не заменяет gates и human acceptance.</rule>
    <rule id="experience_confirmation">Experience proposals проверяются на anonymized scenarios и никогда не применяются автоматически; подтверждение владельца создаёт новую package version.</rule>
    <rule id="human_hook_trust">Доверие к hook подтверждает только человек в интерфейсе Codex.</rule>
  </safety>

  <output status="accepted">
    <field id="connected_components">Что подключено.</field>
    <field id="registered_project">Какой проект зарегистрирован.</field>
    <field id="found_documents">Какие документы найдены.</field>
    <field id="proposed_roles">Какие роли и владельцы предложены.</field>
    <field id="human_actions">Что нужно подтвердить человеку.</field>
    <field id="test_instruction">Как выполнить первый безопасный тест.</field>
    <rule id="human_response">Не показывай SQL, JSON и внутренние идентификаторы без отдельной просьбы.</rule>
  </output>
</document>
