<document id="workflow_platform" version="0.1" status="working" kind="governance" language="ru">
<metadata owner="workflow-platform" authority="Workflow Platform">
</metadata>
<section id="documentator_contract" status="accepted">
Документные изменения выполняются только через Documentator и проходят Document Lint.
</section>
<rule id="document_changes_go_through_documentator" status="accepted">
Модель предлагает структурированный patch; программа проверяет и применяет его.
</rule>
<section id="installation_boundary" status="accepted">
Исходники продукта, заменяемая поставка и локальное состояние пользователя являются тремя разными контурами.
</section>
<rule id="development_sources_use_git" status="accepted">
Workflow Platform и Agent Gateway являются отдельными модулями единого репозитория Zodchi; Git является историей исходного кода.
</rule>
<rule id="release_is_replaceable" status="accepted">
Поставка собирается из зафиксированных исходников, проверяется линтером и заменяется целиком; успешная замена не оставляет постоянную резервную копию предыдущей поставки.
</rule>
<rule id="local_state_is_external" status="accepted">
Локальные профили, назначения моделей, реестр проектов, история запусков и обе базы данных хранятся вне папки поставки и не перезаписываются при обновлении продукта.
</rule>
<rule id="project_hooks_use_release" status="accepted">
Проектные hooks запускают Workflow Platform из установленной поставки, а не из репозитория разработки.
</rule>
</document>

## License

Модуль Workflow Platform распространяется в составе Zodchi по лицензии MIT.
Copyright 2026 Petr Tsap.
