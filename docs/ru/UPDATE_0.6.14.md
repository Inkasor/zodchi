<document id="zodchi_update_0_6_14" status="working" authority="zodchi" version="0.6.14" language="ru" format="markdown+xml_semantic">

# Обновление Zodchi до 0.6.14

<section id="before_update" status="working">

## До изменения живой установки

1. Снять хеши `workflow.sqlite`, `gateway.sqlite` и `policy.local.json`, а перед установкой сохранить копию всего data root.
2. Не удалять историю SQL-командой вручную. Проверить будущую очистку только чтением:

   `node <ZODCHI>\WorkflowPlatform\src\cli.mjs history-cleanup --db <DATA>\workflow\workflow.sqlite --gateway-db <DATA>\gateway\gateway.sqlite`

3. Перегенерировать и проверить все workflow packages. Формат пакета остаётся schema v4, а в поставляемых пакетах появляется техническая роль `conversation_responder`.
4. Импортировать package proposal и менять локальные профили только после отдельного подтверждения владельца. Установка нового кода сама по себе не должна переписывать живую историю или overlay.

</section>

<section id="conversation_and_profiles" status="working">

## Разговор и локальные профили

- Разговорный маршрут вызывает `classifier`, затем `conversation_responder`. Для второй роли нужен локальный профиль с отдельной моделью и `reasoning_effort`; он должен разрешать только `context_input`, не иметь `project_write`, `external_mutation` и `local_endpoint`, а списки skills/MCP/instruction files должны быть пустыми.
- Responder получает историю текущей сессии. В `conversation_messages` сохраняется только его непустой `answer`; внутренний `reason` классификатора туда не копируется.
- Для `one-c.development` сохраняются назначенные Николаям skills: информационные — исследователю, изменяющие дерево — worker; structural validation остаётся платформенной проверкой.
- Несовместимые назначения Kimi не обходятся молча: до отдельного доказательства они остаются `incompatible` и не допускаются к вызову.

</section>

<section id="history_cleanup" status="working">

## Очистка истории

Команда по умолчанию ничего не меняет и перечисляет точные таблицы и количество строк:

`node <ZODCHI>\WorkflowPlatform\src\cli.mjs history-cleanup --db <DATA>\workflow\workflow.sqlite --gateway-db <DATA>\gateway\gateway.sqlite`

Только после проверки dry-run и явного разрешения владельца добавляется `--apply`. Команда перед записью создаёт соседние копии обеих баз, удаляет только явный allowlist истории, сверяет хеши реестра в транзакции и требует пустой `foreign_key_check` и `integrity_check = ok`. Параметр `--apply` в этой инструкции не является частью установки и не запускается автоматически.

</section>

<section id="acceptance" status="working">

## Приёмка 0.6.14

Проверять на живой установке по содержимому баз, а не по тексту отчёта:

1. Разговор: две квитанции на run, существенный ответ и отсутствие `reason` в сообщении `role='assistant'`.
2. Исследование: `run_evidence` с `research_inspection`, непустые проверенные пути и ответ, опирающийся на переданные файлы.
3. Планирование: заполненный `plans`, завершённый шаг planning, результат `planner.v1`, `prompt_bytes < 85%` лимита.
4. Документирование: вызван `documentator`, есть `document_operations`, изменён зарегистрированный файл.
5. Боевая задача Shared Map Engine: полный маршрут plan → worker → gate → review, непустые `gate_runs` и `artifacts`, хотя бы одна passed-проверка и настоящий diff в зарегистрированном корне общего движка.

Для Playwright acceptance e2e с `pinnedVersion: "fixture"` доказывает проводку allowlist и sentinel-контракта, но не работоспособность установленного Playwright. Это ограничение фикстуры должно оставаться видимым в доказательстве.

</section>

</document>
