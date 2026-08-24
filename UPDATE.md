<document id="zodchi_update" status="accepted" authority="zodchi" version="0.3.0-beta.2" language="ru">
  <title>Обновление Zodchi моделью</title>
  <purpose>Безопасно заменить программу, сохранив личные проекты, настройки, базы и историю запусков.</purpose>

  <contract status="accepted">
    <rule id="release_is_replaceable">Папка программы заменяема целиком.</rule>
    <rule id="data_is_external">Личные данные находятся вне папки программы и не переносятся в релиз.</rule>
    <rule id="verified_release_only">Используй опубликованный GitHub Release и проверяй SHA-256 архива.</rule>
    <rule id="llm_runs_update">Команды выполняет модель; человек подтверждает папку назначения и доверие к изменившемуся hook.</rule>
  </contract>

  <procedure status="accepted">
    <step order="1">Проверь состояние установленной версии и путь внешних данных.</step>
    <step order="2">При необходимости создай штатный снимок локальных баз командой backup.</step>
    <step order="3">Запусти tools/install-latest.ps1 из доверенного репозитория с текущей папкой назначения.</step>
    <step order="4">Проверь bundle-manifest.json и выполни npm test в установленной копии.</step>
    <step order="5">Если изменился hook, попроси человека заново подтвердить доверие в Codex.</step>
  </procedure>

  <recovery status="accepted">
    <rule id="atomic_installer">Штатный установщик заменяет программу атомарно и восстанавливает прежнюю папку при ошибке.</rule>
    <rule id="no_permanent_backups">После успешного обновления не оставляй постоянные дубли поставки.</rule>
  </recovery>
</document>
