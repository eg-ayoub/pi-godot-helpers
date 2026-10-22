# pi-godot-helpers

This extension defines some helpers I use to review Godot PRs using [pi](https://pi.dev):

- **`/advise`**: a design advisor. A chat that knows the repository: ask about an idea, a design choice or a pitfall.
- **`/review`**: a code reviewer. Describe the change in plain words ("this branch against develop", "the unstaged
  changes", "the last 3 commits"). The review comes back as a page in the browser, laid out like a GitHub pull
  request, and as Markdown. Afterwards it keeps `DESIGN.md` and `AGENTS.md` consistent with the code.
- **Skills**: the [GodotPrompter](https://github.com/jame581/GodotPrompter) skills (2D, 3D, UI, optimization, …),
  kept at their newest release automatically. Each part of a change gets only the skills it needs; a small local
  model picks them.
- **Memory**: what the model learns about the project stays between sessions, outside the repository, so it does not
  read the whole project again every time.
- **A locked-down model**: in a Godot repository the model can read, search and run your checks, but it cannot change
  any file except `DESIGN.md` and `AGENTS.md`, and it cannot commit, amend or push.

Outside a Godot repository (a git repository with a `project.godot`), the extension does nothing.

## Install

```sh
pi install git:github.com/eg-ayoub/pi-godot-helpers
```

Then, inside your Godot repository, run `pi` and type `/godot-helpers-status`. It shows what works and what is
missing.

### What it needs

| What | Why | Without it |
|---|---|---|
| pi 1.3.0 or newer | the extension API it is built on | the extension turns itself off and says so |
| `bwrap` (bubblewrap) 0.10 or newer, and a kernel that allows unprivileged overlay mounts (5.11 or newer) | every shell command the model runs goes through a throwaway sandbox | the model cannot run shell commands at all (it still reads and searches) |
| `git` | the review reads the change from git, and the skills are downloaded with it | no review |
| network access to GitHub on the first start in a Godot repository | downloads the skills (4 MB) | reviews and the advisor run without skills until a start can download them |
| `llama-server` from llama.cpp 0.6.0 or newer | runs the small model that picks skills | skills are picked by rules alone (less precise, see [Routing](#routing)) |
| your checks (`gdlint`, `gdformat`, `godot` for `make check-docs`, pre-commit hooks) | the review runs them and attaches what they find | a check that cannot run is reported as skipped |

**On NixOS:** add `bubblewrap` and `llama-cpp-vulkan` (or `llama-cpp` with your GPU backend) to
`environment.systemPackages`. No service is needed: the extension starts `llama-server` itself and stops it when it
is done. The sandbox sees `/nix/store`, `/run/current-system`, `/etc` and the repository. Tools stored elsewhere (for
example a Godot binary in your home) need `sandbox.extraReadOnly` in the config. Pre-commit hook environments must
be installed beforehand: the sandbox has no network.

## Commands

| Command | What it does |
|---|---|
| `/advise [question]` | Turns the advisor on (or off), and asks the question if there is one. The advisor only reads. |
| `/review <what>` | Reviews a change. Options: `--no-docs` (skip the doc update), `--no-checks`, `--no-open` (no browser), `--rules-only` (no classifier). |
| `/review-cancel` | Stops a running review. |
| `/review-open [id]` | Opens the last review (or another one) in the browser. |
| `/memory [facts\|notes\|forget <id>]` | Shows or edits what is remembered about the repository. |
| `/memory-consolidate` | Merges near-duplicate facts and drops notes of deleted files. Asks first. |
| `/agents-md-migrate [--apply]` | Rewrites `AGENTS.md` as general rules (see [AGENTS.md](#agentsmd)). Shows the diff and asks before writing. |
| `/godot-helpers-status` | Shows the repository, the sandbox, the skills, the classifier and the memory. |
| `/godot-helpers-classifier-test` | Starts the classifier, routes a sample change and shows the time it took. The first run downloads the model. |

## Skills

The skills come from [GodotPrompter](https://github.com/jame581/GodotPrompter) (MIT). They are not part of this
repository. On every start of pi in a Godot repository, the extension fetches GodotPrompter's default branch
(`master`) and uses the newest release tag on it. A new tag goes into a new folder in
`~/.pi/agent/godot-helpers/skills/`; the folder of the previous tag stays until the next update, for reviews still
using it.

- The check runs in the background: pi does not wait for it. Measured once on a laptop: 1.9 s for
  the first download, 0.9 s for a check with no new tag.
- Only the very first start waits: a review started before any copy exists waits for the download.
- Offline, or when the download fails, the last copy stays in use. `/godot-helpers-status` shows the version in
  use and how the last check went.
- A new release can rename skills. `/godot-helpers-status` lists the skills the routing rules expect but the version
  lacks; those rules then pick nothing until the rules are updated.
- Each review records the version it used (`review.json`, `review.md` and the page).

To stop following new releases, set `skills.source.autoUpdate` to `false`; the last copy stays. To use your own copy
of the skills instead, set `skills.path` to its `skills/` folder; then nothing is downloaded.

## What `/review` does

1. **Finds the change.** It reads your words with a small parser ("this branch against develop", "staged",
   "unstaged", "uncommitted", "the last N commits", a commit, a range). If the parser does not understand, the
   current model turns the words into a git range, and you confirm it. It warns when your local base branch is behind
   `origin`; it never fetches.
2. **Reads the diff.** GDScript hunks get their enclosing function as context. Scenes and resources (`.tscn`, `.tres`)
   are summarized. Editor files (`.import`, `.uid`, `.godot/`) are skipped.
3. **Runs your checks** in the sandbox: by default `gdlint` and `gdformat --check` on the changed `.gd` files,
   `make check-todos` and `make check-docs`. Their findings become review comments.
4. **Picks skills** for each file (see [Routing](#routing)) and groups the hunks into parts that fit the model's
   context.
5. **Reviews each part** in a separate pi process with only its skills, `AGENTS.md`, the project brief and what memory
   knows about these files. Workers use the model you selected: one at a time for a local model, three at a time for
   a cloud model.
6. **Updates the docs.** The main session gets one turn to keep `DESIGN.md` and `AGENTS.md` consistent with the code.
   It may only edit those two files, with small edits. The diff is saved with the review.
7. **Shows the result.** Comments are placed under their lines, duplicates are merged, and a finding that an earlier
   review already raised is marked. The page opens in your browser; `review.md` is written next to it.

Reviews are kept in `~/.pi/agent/godot-helpers/<repository>/reviews/`.

## Routing

Not every file needs every skill. Skills are picked before any review model runs, so the review model does not spend
tokens deciding:

1. **Rules** look at the file type, the `extends` line and the changed code (for example `.gdshader` →
   `shader-basics`, a `Control` script → `godot-ui`, `await` → `gdscript-advanced`).
2. **A local decision model** answers one yes/no question per candidate skill: "does reviewing this change need this
   skill?". The default is [Kev-4B](https://huggingface.co/ggml-org/Kev-4B-GGUF) (Q4_K_M, 3 GB, Apache-2.0). The
   extension starts `llama-server` for it, registers it as a pi classifier (so pi's own `classify()` reaches it), and
   stops it before the review workers start, so it does not hold GPU memory while they run.
3. **Fallback.** If the decision model is missing or fails, the rules decide alone. Skills that were not picked are
   still listed for the review worker, which can read one itself.

**Measured** on the 35 labelled changes in `scripts/routing-cases.ts`, with the skills of GodotPrompter v1.15.1,
Kev-4B Q4_K_M and llama.cpp b11815 (Vulkan) on an RTX 4050 laptop GPU (6 GB):

| | Precision | Recall | Time per file |
|---|---|---|---|
| Rules alone | 0.46 | 0.87 | – |
| Rules + Kev-4B (the default: the rules' candidates, threshold 0.5) | 0.77 | 0.87 | 1.8 s median |
| Rules + Kev-4B, every skill asked (threshold 0.5) | 0.48 | 0.87 | 8.4 s median |

Precision is the share of picked skills that the label wanted; recall is the share of wanted skills that were
picked. The cases and their labels were written for this eval, and the threshold was chosen on the same cases, so
treat the numbers as a rough guide. Run `npm run eval:routing` (see [Development](#development)) to measure on your
machine.

The advisor works the same way, but first asks which skills fit the question (one multiple-choice question over all
skills), then yes/no on the 8 best. Measured as above: 1.3 to 1.8 s per question. The best two skills go into the
conversation as a message, not into the system prompt, so the prompt cache stays valid.

**Good to know:**

- The first start downloads the model (3 GB) into `~/.pi/agent/godot-helpers/models/`. Run
  `/godot-helpers-classifier-test` once to do it. The advisor never waits for a download; it skips routing until the
  model is there. To use a file you already have, set `classifier.modelPath`.
- Kev-4B used 3.7 GB of GPU memory with `ubatch` 512, 4.4 GB with 1024 (the default) and 5.5 GB with 2048, on the
  laptop above. If the GPU has no room (for example because another model is loaded), it runs on the CPU, which is
  much slower.
- Starting the model took 91 s with memory-mapped weights and 2 to 4 s without, on the laptop above. The extension
  turns memory mapping off.
- With a new user profile, the first request took 14 to 16 s while the GPU driver compiled its shaders; after that,
  about 2 s.

## Safety

In a Godot repository:

- **Files.** `edit` and `write` are refused, except on `DESIGN.md` and `AGENTS.md` at the repository root, and only
  during the doc update of a review. The path is checked when the model asks and again when the file is written;
  symlinks do not get around it. A single edit is capped at 6000 characters.
- **Shell.** Every command the model runs goes through two layers:
  - An allowlist: read-only commands (`ls`, `cat`, `grep`, `find`, `head`, `wc`, …), read-only `git` subcommands,
    `gdlint`, `gdformat --check`, your `make` targets and `pre-commit run`. No `;`, `&&`, redirections, command
    substitution, `git commit`, `push` or `-c`.
  - A bubblewrap sandbox: the repository is a throwaway copy, HOME is empty, there is no network and no socket to
    the outside (D-Bus, the Nix daemon, Docker). What a command writes disappears when it ends.

  If the sandbox cannot start, shell commands are refused; they never run without it.
- **Reading.** `read`, `grep`, `find` and `ls` stay inside the repository and the skills, so files elsewhere on your
  machine are not sent to a cloud model.
- **Other tools** from other extensions are refused unless you list them in `extraAllowedTools`.

Your own `!` commands are not affected.

## Memory

Kept in `~/.pi/agent/godot-helpers/<repository>/`, never in the repository:

- **File notes**: what a file does and its pitfalls, written by the model after reading it. A note remembers the
  version of the file it describes; when the file changes, the note is marked stale until it is checked again.
- **Facts**: decisions and conventions of the project, with near-duplicates merged and a size limit.
- **Raised items**: findings of earlier reviews, so a review does not repeat itself without saying so.
- **A project brief** built from `project.godot` (autoloads, main scene), the `class_name` index and the folders.
- **Reviews**: every review, its report and its logs.

## AGENTS.md

A checklist item like "do new interactions go through the action broadcaster?" only catches that one example.
`/agents-md-migrate` rewrites `AGENTS.md` after `templates/AGENTS.template.md`. Each rule becomes a principle, why it
exists, the signs of a violation, and the known instances (your original items). Then a review also catches the same
kind of problem in a new place.

The model reads `AGENTS.md`, `DESIGN.md` and the code, and proposes the new file; it cannot write it. You see the diff
and confirm; then the extension writes `AGENTS.md`. The old version and the diff are kept in
`~/.pi/agent/godot-helpers/<repository>/agents-md/`.

## Configuration

Two JSON files, both outside the repository (a repository cannot loosen its own sandbox):
`~/.pi/agent/godot-helpers/config.json` for every repository, and
`~/.pi/agent/godot-helpers/<repository>/config.json` for one (`/godot-helpers-status` prints the folder). Only the
keys you set change. The most useful ones, with their defaults:

```json
{
  "baseBranch": "develop",
  "sandbox": {
    "extraReadOnly": [],
    "makeTargets": ["check-docs", "check-todos"],
    "timeoutSeconds": 300
  },
  "checks": [
    { "name": "gdlint", "command": "gdlint {files}", "enabled": true, "scope": "changed-gd", "parser": "gdlint" },
    { "name": "gdformat", "command": "gdformat --check {files}", "enabled": true, "scope": "changed-gd", "parser": "gdformat" },
    { "name": "check-todos", "command": "make check-todos", "enabled": true, "scope": "repo", "parser": "lines" },
    { "name": "check-docs", "command": "make check-docs", "enabled": true, "scope": "repo", "parser": "lines" }
  ],
  "skills": {
    "source": { "repo": "https://github.com/jame581/GodotPrompter.git", "autoUpdate": true, "timeoutSeconds": 120 },
    "maxPerUnit": 4,
    "alwaysOn": ["godot-code-review"],
    "extraPaths": []
  },
  "classifier": {
    "enabled": true,
    "hfRepo": "ggml-org/Kev-4B-GGUF:Q4_K_M",
    "gpuLayers": "auto",
    "threshold": 0.5,
    "ubatch": 1024,
    "extraArgs": [],
    "keepAliveSeconds": 0,
    "advisorSkills": 2
  },
  "worker": { "concurrencyLocal": 1, "concurrencyCloud": 3, "extraExtensions": [] },
  "viewer": { "open": true }
}
```

- `skills.source.branch` follows another branch than the repository's default one. `skills.path` uses a folder of
  skills you keep yourself and downloads nothing. `skills.extraPaths` adds folders of your own skills.
- `classifier.llamaServer` sets the `llama-server` binary (default: the one on `PATH`), and `classifier.modelPath` a
  GGUF file you already have (default: download `hfRepo`).
- `gpuLayers: "auto"` tries the GPU and falls back to the CPU. `extraArgs` passes more flags to `llama-server`, for
  example `["-dev", "Vulkan1"]` to pick a GPU.
- `keepAliveSeconds` above 0 keeps `llama-server` running between advisor questions (faster, but it holds GPU
  memory). Reviews always stop it before the workers start.
- `classifier.piModel: "provider/id"` uses a classifier pi already knows instead of starting `llama-server`.
- `worker.model: "provider/id"` reviews with another model than the session's. `worker.extraExtensions` lists
  extensions the workers need, for example one that provides your model.

## Development

```sh
npm install
npm test                 # unit, integration and end-to-end tests (real pi 1.3.0, a scripted model, a fake llama-server)
npm run typecheck
npm run eval:routing     # routing precision and recall, rules only
npm run eval:routing -- --llama-server "$(which llama-server)" --model ~/models/Kev-4B-Q4_K_M.gguf --verbose
```

The tests use a fixed version of the skills, GodotPrompter v1.15.1, which the first run downloads into
`node_modules/.cache/` (checked against its commit). To run offline, set `PGH_TEST_SKILLS` to a copy of its `skills/`
folder. `npm run eval:routing` uses the same version (`--skills DIR` measures another one).

The sandbox tests are skipped where bubblewrap cannot run. One test runs a whole review with a real `llama-server`
and a real decision model; it runs only when you ask for it:

```sh
PGH_REAL_LLAMA_SERVER="$(which llama-server)" PGH_REAL_CLASSIFIER_MODEL=~/models/Kev-4B-Q4_K_M.gguf \
  npx vitest run tests/e2e/classifier-real.test.ts
```

## License

Apache-2.0. The GodotPrompter skills the extension downloads are MIT-licensed; their `LICENSE` is downloaded with
them.
