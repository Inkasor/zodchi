# Установить и подключить Зодчи

[English](install.md) · [Главная](https://github.com/Inkasor/zodchi/blob/main/README.ru.md)

Отправьте агенту этот запрос вместе со ссылкой на репозиторий.

> Установи и подключи Зодчи на этом компьютере. Следуй инструкции и проверь CLI и плагины для установленных здесь клиентов.

В выпуск входят Rust CLI, каталог процессов, роли моделей и общий плагин Codex и Claude Code. Устанавливайте на том компьютере, где работают эти клиенты.

## Готовый выпуск

1. Скачайте исполняемый файл и архив для своей системы из [последнего стабильного выпуска](https://github.com/Inkasor/zodchi/releases/latest). Сверьте SHA-256 обоих файлов с данными на GitHub.

   | Система | Исполняемый файл | Архив |
   | --- | --- | --- |
   | Windows x64 | `zodchi-win32-x64.exe` | `zodchi-win32-x64.bundle.json.gz` |
   | Linux x64 | `zodchi-linux-x64` | `zodchi-linux-x64.bundle.json.gz` |
   | macOS Apple Silicon | `zodchi-darwin-arm64` | `zodchi-darwin-arm64.bundle.json.gz` |
   | macOS Intel | `zodchi-darwin-x64` | `zodchi-darwin-x64.bundle.json.gz` |

2. Запустите скачанный файл с командой `release install`. Передайте опубликованный хэш архива без префикса `sha256:` и перечислите нужные клиенты. Для установки только CLI опустите `--clients`.

   В Windows выполните команду из PowerShell.

   ```powershell
   $archiveSha256 = '<опубликованный SHA-256 архива>'
   .\zodchi-win32-x64.exe release install --archive .\zodchi-win32-x64.bundle.json.gz --sha256 $archiveSha256 --clients 'codex,claude'
   ```

   Для Linux x64 используйте эти имена файлов.

   ```sh
   archive_sha256='<опубликованный SHA-256 архива>'
   chmod +x ./zodchi-linux-x64
   ./zodchi-linux-x64 release install --archive ./zodchi-linux-x64.bundle.json.gz --sha256 "$archive_sha256" --clients codex,claude
   ```

   На macOS подставьте имена файлов из таблицы. Для разработки или другой системы см. [сборку из исходников](install-from-source.ru.md).

3. Добавьте папку указанного в результате `launcher` в пользовательский PATH. По умолчанию это `~/.zodchi/bin`, а при заданном `ZODCHI_HOME` — его папка `bin`. Выполните `zodchi release current` и `zodchi flow list`. При необходимости настройте вход и роли моделей. [Роли](model-roles.md) · [Исполнитель Claude](flow-claude.md)

## После установки плагина

- В открытом Claude Code выполните `/reload-plugins`. [Команды Claude Code](https://code.claude.com/docs/en/commands)
- В Codex откройте новый чат в том же проекте, чтобы появились навыки плагина. Если терминал приложения всё ещё видит прежний PATH, перезапустите приложение. [Плагины Codex](https://learn.chatgpt.com/docs/plugins)

Состояние начатой задачи показывает `zodchi flow status <run-id>`. Продолжайте с тем же run ID. Журнал хранится на компьютере и доступен обоим клиентам.

## Порядок для агента

1. Определи систему, архитектуру, установленные команды `codex` и `claude` и состояние Zodchi. При рабочей установке проверь текущую сборку и используй [порядок обновления](flow.md#client-packages). Для первой установки переходи к загрузке.
2. Прочитай данные последнего выпуска и выбери два файла из таблицы для этой платформы. Скачай их по `browser_download_url` из этого репозитория и сверь байты с опубликованными полями `digest`. После сверки используй скачанный CLI. [Данные выпуска](https://api.github.com/repos/Inkasor/zodchi/releases/latest) · [API выпусков GitHub](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
3. Запусти `release install` с проверенным хэшем архива и списком установленных клиентов, которые попросили подключить. Добавь папку возвращённого `launcher` в пользовательский PATH с сохранением существующих путей.
4. Проверь CLI командами `zodchi release current` и `zodchi flow list`. Если текущий чат использует старое окружение, используй абсолютный путь из результата. Проверь `zodchi@zodchi-local` через `codex plugin list --json` или `claude plugin list --json` для каждого подключённого клиента. Сообщи версию, путь, подключённые клиенты и как загрузить навыки в чат. Для входа, который требует пользователя, используй штатный вход нужного клиента.
