# gamedev-unity

Procedural game assets built in Blender and checked in the Unity Editor,
with art judged by critics and accepted by a human.

## Agents

| Agent | Model | Job |
| --- | --- | --- |
| `modeller` | Haiku | One round of procedural asset work from a brief: builds, number tuning, views, LOD bakes |
| `unity-runner` | Haiku | Blender builds, checks and Unity Editor operations; returns evidence |
| `art-critic` | Fable | Second opinion on a picture when the first critic (gateway role `art-critic`) was mixed, or before a showing |

`coder`, `applier` and `researcher` come from `core/`.

## Workflows

| Workflow | When |
| --- | --- |
| `method-question` | Before the first build of a new kind of asset, and at the stop rule: how the thing looks and works in real life, how games usually build it, and what follows for the model |
| `asset-round` | One round of an asset: gate on the ledger, change, fast check, show export, Unity import, frames, rubric, ledger row |
| `rubric-probe` | After adding or rewording a Decisions rubric question: does it tell defective frames from sound ones |
| `unity-check` | Run a written list of Editor steps and bring back readback and frames |

## Asset stages

An asset moves through four stages: **method** (a construction chosen from
the method question), **blockout**, **look** and **production**. Each asset
has a ledger, a JSON file with `method`, optionally `lookMethod`, and a
`rounds` array. `asset-round` reads the ledger, writes a row per round and
refuses to start when:

- no method is chosen yet;
- the owner has not judged the previous round (the `owner` field of the last
  row);
- three rounds have passed since the method was chosen without a verdict that
  starts with the acceptance word (`accepted` by default, or `args.accepted`).

Before acceptance only triangles, texture memory and frame time are gates.
Precision is spent only on a look the owner has accepted.

## Lessons this domain is built on

- **Critics judge the engine frame**: the asset standing among accepted
  ones, not a single-asset sheet. A human spotted four defects of the whole
  in two minutes in the Editor while two critics argued about a detail.
- **Ask how the real thing grows before tuning.** An asset that went eleven
  rounds on detail cards had the wrong construction from the start, and
  nobody had asked.
- **Three rounds without acceptance means a new method,** not a fourth
  round.
- **One Blender at a time;** two builds at once can kill each other.
- **Haiku agents hold their window at 100k tokens** (`autoCompactWindow`).
  Past that, the price per token rises sharply.
