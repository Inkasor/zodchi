<document id="zodchi_readme" status="accepted" authority="zodchi" version="0.6.5" language="en" format="markdown+xml_semantic">

# Zodchi

[English](README.md) · [Русский](docs/ru/README.md)

Zodchi helps Codex and Claude Code carry real project work through to a checked result.

You describe the outcome in an ordinary chat. Zodchi can prepare a plan, divide the work between suitable models, keep important project context, run the project's checks, and record accepted decisions. You still decide what may be changed, published, deployed, or treated as complete.

<section id="how_it_works" status="accepted">

## How it works

1. A setup chat installs Zodchi and examines the project, available models, tools, and existing documents.
2. Zodchi proposes how the project should work. Nothing is registered until you confirm it.
3. In a project chat, enter `/zodchi` once. Continue talking normally in that chat.
4. Before substantial work starts, Zodchi shows how it intends to work: the required quality, whether to persist until the goal is reached, how strongly to verify the result, and whether one or several planners are available.
5. Zodchi performs the work, checks the result, and either finishes with evidence or explains the real blocker.

Other chats remain ordinary Codex or Claude Code chats. Closing the chat ends its Zodchi mode.

</section>

<section id="what_it_is_for" status="accepted">

## What it is for

Zodchi can support software development, 1C, web and Unity projects, research and data work, infrastructure and releases, marketing, and content production.

Included workflows are starting points, not mandatory templates. During setup, Zodchi studies how the project already works and proposes only useful controls. You choose which documents and rules matter, and you can change that choice later without deleting the files themselves.

Different models can do different jobs. Routine work can use faster models, while stronger models can be reserved for planning, difficult decisions, or independent checks.

</section>

<section id="install" status="accepted">

## Try it

Open a new Codex or Claude Code chat and send:

> Open https://github.com/Inkasor/zodchi, read `ONBOARDING_PROMPT.md`, install the latest Zodchi release, and configure it for my project. Do the technical setup yourself and ask me only for decisions you cannot safely infer.

Keep this setup chat: later you can use it to add projects, change models, and adjust how work is performed.

Codex asks you to trust locally installed hooks. Open `/hooks`, approve both Zodchi entries, and start a new project chat; merely enabling their toggles is not approval.

Zodchi requires Node.js 24 or newer. Windows and macOS are supported. Linux passes automated checks but is still experimental.

</section>

Zodchi is released under the MIT License.

</document>
