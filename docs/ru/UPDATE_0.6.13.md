<document id="zodchi_update_0_6_13" status="working" authority="zodchi" version="0.6.13" language="ru" format="markdown+xml_semantic">

# Обновление Zodchi до 0.6.13

<section id="before_update" status="working">

## До изменения живой установки

1. Сделать полную копию data root и проверить хеши `workflow.sqlite`, `gateway.sqlite` и `policy.local.json`.
2. Репетировать установку и миграцию 038 только на копии.
3. Перегенерировать все пользовательские workflow packages через prompt builder 3.5.0 и повысить их SemVer: переносимый формат теперь schema v4 и содержит allowlist MCP-серверов и нативных инструкций. Старые schema v1-v3 отклоняются fail-closed.
4. Импортировать каждый новый package proposal только после явного подтверждения владельца. До перегенерации и импорта пользовательский пакет не получает новые входные границы.

</section>

<section id="local_bindings" status="working">

## Локальные привязки

- Для роли с `allowed_skills` каждый скилл должен быть явно указан в профиле AgentGateway; отсутствующий скилл даёт `PROFILE_SKILL_MISSING` до вызова модели.
- Для `allowed_mcp_servers` сервер должен одновременно присутствовать в профиле и локальном `external_tool_registry` с закреплённой версией и описанием границ.
- Внешний инструмент регистрируется командой `WorkflowPlatform/src/cli.mjs external-tool-register`; это локальное решение владельца и оно не переносится внутри пакета.
- В `software.web-application` только профиль `worker` должен объявить `playwright` в `allowedMcpServers` и `browserMcpServer`; `researcher` и рецензенты этот MCP не получают. Профиль без локальной регистрации и закреплённой версии не допускается до вызова.
- Если этот MCP-контур действительно read-only, профиль также должен иметь отдельно подтверждённый технический override `external_mutation: { status: "unavailable", enforcement: "technical", access: "none", evidenceRef: "<owner-evidence>" }`: один только `read_only_mode` registry не доказывает техническое отсутствие мутации у провайдера. Без такого подтверждения readiness остаётся `PROFILE_CAPABILITY_MISMATCH`.
- `game.web` требует локальной регистрации Playwright для browser-sentinel gate; 1С-валидатор требует локального `cc-1c-skills-validate`. Без регистрации проверка честно остаётся `unavailable`.
- `data.analytics` читает только зарегистрированный ресурс `data.primary`; SQLite открывается с `readOnly: true` и `PRAGMA query_only=ON`, а ожидаемый scalar-результат сравнивается только для единственной строки и единственной колонки.

</section>

<section id="verification" status="working">

## Проверка

После импорта выполнить `profiles-check` и readiness по каждому проекту и маршруту. Проверить, что в новых квитанциях есть `environment.input_manifest`, а два одинаковых промпта с разным набором скиллов, MCP или инструкций имеют разные `manifest_hash`.

</section>

</document>
