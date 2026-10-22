# AGENTS.md

## Critical rule

**Under no circumstances are you to modify, delete, or create any files in this repository, except for `AGENTS.md` and `DESIGN.md`.**

## Where things live

- `DESIGN.md`: the architecture. Read it first.
- The code is the source of truth. When a document and the code disagree, the code wins.
- Cite `file:line` for every finding.

## Invariants

An invariant is a rule that holds everywhere in the project, not a checklist line. Review every change against the
principle. The known instances show how the rule looks today; they are examples, not the full list. A new kind of
violation that no instance mentions is still a violation.

### <Short name of the rule>

- **Principle:** <one sentence that is true everywhere in the project>
- **Why:** <what breaks, or what becomes impossible, when the rule is broken>
- **Signals of a violation:** <what to look for in a diff; names and patterns that can be searched for>
- **Known instances:** <the classes, functions and folders that implement the rule today>

<!-- Example (replace with the project's own rules):

### One entry point for player actions

- **Principle:** every interaction the player starts goes through the single action entry point.
- **Why:** undo, replays and the AI listen to that entry point; an interaction that bypasses it is invisible to them.
- **Signals of a violation:** an `_input` or `_gui_input` handler, or a signal callback, that changes another
  entity's state directly; a new kind of interaction with no call to the entry point.
- **Known instances:** `Game.actions.request(self)`; receivers use the `Receiver` component.
-->

## Conventions

<Short style rules. Name the check that enforces each one, if any.>

## Checks

The reviewer runs the project's checks itself, in a sandbox, and attaches their findings to the review. They are set
in the pi-godot-helpers config (`checks`), not here. To run them by hand: <list the commands>.

## Keeping DESIGN.md and AGENTS.md current

After a review, the doc pass may:

- update `DESIGN.md` where the reviewed change adds, removes, renames or moves a part of the architecture: a class,
  an autoload, a resource type, a folder, a signal flow;
- add a known instance under an existing invariant in `AGENTS.md` when the change adds one.

It may not:

- redesign, restyle or reorder either document;
- add or remove an invariant, or change its principle (a person decides that; a review may suggest it in a finding);
- change any other file.
