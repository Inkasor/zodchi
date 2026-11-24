# Сборка из исходников

[English](install-from-source.md) · [Главная](../README.ru.md)

Установите [Rust](https://rustup.rs), клонируйте репозиторий и откройте его корень. Для установки готового выпуска см. [инструкцию к пакету](flow.md#client-packages).

```sh
git clone https://github.com/Inkasor/zodchi.git
cd zodchi
./install/install.sh --out ../zodchi-bundle
```

В Windows выполните из корня репозитория в PowerShell.

```powershell
.\install\install.ps1 -Out ..\zodchi-bundle
```

В папке сборки будут CLI, роли моделей, каталог процессов и манифесты для обоих клиентов. Добавьте её папку `bin` в PATH и выполните `zodchi --version` и `zodchi flow list`.

Чтобы подключить общий плагин, выполните `zodchi release register --clients codex,claude` бинарником из этой сборки. Можно указать один клиент. Затем [загрузите плагин в чат](install.ru.md#после-установки-плагина).

Для ролей Codex войдите в [Codex CLI](https://learn.chatgpt.com/docs). Роли Claude подключаются через [настройки исполнителя](flow-claude.md). Доступные процессы показывает [каталог](flow.md#running-it), модели выбираются в [таблице ролей](model-roles.md).

Сборка из исходников привязана к выбранной ревизии. Для следующей ревизии укажите новую папку. Для автоматических обновлений используйте [установщик выпусков](flow.md#client-packages).

## Локальные DEV-сборки

Codex, Claude Code и терминал используют обычную команду `zodchi`. Она берёт выбранную DEV-сборку для новых задач. Каждый DEV-запуск сохраняет Git-ревизию и продолжается на той же сборке.

В Windows закоммитьте изменения и выполните `.\install\dev.ps1 -RegisterClients` для сборки, проверок и подключения общего плагина. Для следующей сборки достаточно `.\install\dev.ps1`. Добавляйте `-RegisterClients`, когда меняются инструкции плагина.

Архив можно собрать командой `zodchi release build --out <new-directory> --archive` и подключить через `zodchi release dev --archive <file> --sha256 <digest>`. Используйте CLI из собираемой ревизии. Команда запуска находится в папке `bin` внутри каталога Zodchi. `zodchi release current` показывает текущий CLI, ревизию и папку журналов.
