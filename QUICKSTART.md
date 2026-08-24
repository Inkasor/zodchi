<document id="zodchi_quickstart" status="accepted" authority="zodchi" version="0.3.0-beta.2" language="ru">
  <title>Быстрый запуск Zodchi моделью</title>
  <purpose>Эта инструкция предназначена для LLM. Человек описывает желаемый результат, а модель выполняет технические команды и задаёт только необходимые смысловые вопросы.</purpose>

  <entry status="accepted">
    <user_message>Открой репозиторий Zodchi, прочитай ONBOARDING_PROMPT.md, установи последнюю версию и настрой её для моего проекта.</user_message>
    <rule id="llm_operates_tools">Не перекладывай команды на человека, если можешь безопасно выполнить их своими инструментами.</rule>
    <rule id="human_decisions_only">Спрашивай человека только о папке установки, подключаемом проекте, назначениях моделей, правах, публикации и других решениях владельца.</rule>
  </entry>

  <installation status="accepted">
    <step order="1">Прочитай ONBOARDING_PROMPT.md полностью.</step>
    <step order="2">Если Zodchi ещё не установлен, запусти tools/install-latest.ps1 с подтверждённой папкой назначения.</step>
    <step order="3">Проверь Node.js 24 или новее и Codex CLI.</step>
    <step order="4">Создай отдельную папку личных данных вне папки программы.</step>
    <step order="5">Зарегистрируй проект, импортируй подтверждённый пакет рабочего процесса и назначь локальные профили моделей.</step>
    <step order="6">Создай проектный .codex/hooks.json из шаблона поставки.</step>
    <step order="7">Попроси человека подтвердить доверие к hook в интерфейсе Codex и перезапустить Codex.</step>
    <step order="8">После перезапуска проверь обычным сообщением, что запуск и квитанции появились в локальных базах.</step>
  </installation>

  <verification status="accepted">
    <command id="product_tests">npm test</command>
    <command id="run_statistics">node WorkflowPlatform/src/cli.mjs run-statistics --db &lt;workflow-db&gt; --run &lt;run-id&gt;</command>
    <rule id="no_raw_transcript">Полные запросы и ответы моделей в базах не сохраняются.</rule>
    <rule id="failed_gate_is_not_green">Недоступная или не пройденная обязательная проверка не считается успешной.</rule>
  </verification>
</document>
