// A small Godot 4 project in a git repo, shaped like the user's (an action broadcaster, identity resources vs
// runtime data, transformation descriptors), with a develop branch, a feature branch carrying planted issues,
// and staged and unstaged edits.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Fixture {
	root: string;
	git(...args: string[]): string;
	write(path: string, content: string): void;
}

const BASE: Record<string, string> = {
	"project.godot": `config_version=5

[application]
config/name="Fixture"

[autoload]
GameManager="*res://game/game_manager.gd"
`,
	"DESIGN.md": `# Design

## Architecture
- \`GameManager\` (autoload) owns the \`ActionBroadcaster\`. Every player-initiated interaction calls
  \`GameManager.action_broadcaster.call_for_action(self)\`; receivers are \`Receiver\` components.
- Cards: \`CardIdentity\` (a Resource, the blueprint) and \`CardData\` (the runtime instance).
- Motion: every movement and rotation goes through \`ItemTransformationDescriptor\`.

## Folders
- game/items: Item, Draggable, Card
- game/components: Receiver
- game/resources: CardIdentity, CardData
- game/ui: HUD
`,
	"AGENTS.md": `# Agents

## CRITICAL RULE
Do not modify any file except AGENTS.md and DESIGN.md.

## Invariants
- Interactions go through the action broadcaster.
- Identity resources are never mutated at runtime.
`,
	Makefile: `.PHONY: check-docs check-todos
check-todos:
\t@git diff --cached --name-only -- '*.gd' | while read f; do grep -Hn 'TODO' "$$f" && exit 1; done; exit 0

check-docs:
\t@status=0; for f in $$(git ls-files '*.gd'); do awk -v f="$$f" 'prev !~ /^##/ && /^func / {print f ":" NR ": missing doc comment: " $$0; bad=1} {prev=$$0} END {exit bad}' "$$f" || status=1; done; exit $$status
`,
	"game/game_manager.gd": `## Global game state; owns the action broadcaster.
extends Node

## Dispatches player actions to receivers.
var action_broadcaster := ActionBroadcaster.new()
`,
	"game/action_broadcaster.gd": `## Dispatches an action to every receiver that may accept it.
class_name ActionBroadcaster
extends RefCounted

## Ask every receiver whether it accepts the action from \`source\`.
func call_for_action(source: Node) -> void:
	for receiver in source.get_tree().get_nodes_in_group("receivers"):
		if receiver.get_parent().receiver_may_accept(source):
			receiver.accept(source)
`,
	"game/items/item.gd": `## Base class of every game object.
class_name Item
extends Node2D

## Moves the item through the transformation descriptor.
func move_to(target: Vector2) -> void:
	ItemTransformationDescriptor.new(self).translate_to(target).fire()
`,
	"game/items/card.gd": `## A card on the table.
class_name Card
extends Item

## The blueprint of this card; never mutated.
@export var identity: CardIdentity
## Runtime state of this card.
var data: CardData

## Builds the runtime data from the identity.
func _ready() -> void:
	data = CardData.from_identity(identity)
`,
	"game/resources/card_identity.gd": `## Blueprint of a card (shared Resource).
class_name CardIdentity
extends Resource

## Base cost.
@export var cost := 1
`,
	"game/resources/card_data.gd": `## Runtime instance of a card.
class_name CardData
extends RefCounted

## Current cost.
var cost := 1

## Copies the identity's values.
static func from_identity(identity: CardIdentity) -> CardData:
	var d := CardData.new()
	d.cost = identity.cost
	return d
`,
	"game/transforms/item_transformation_descriptor.gd": `## Declarative motion of an item.
class_name ItemTransformationDescriptor
extends RefCounted

## The item to move.
var item: Item

## Creates a descriptor for \`target_item\`.
func _init(target_item: Item) -> void:
	item = target_item

## Sets the destination.
func translate_to(_target: Vector2) -> ItemTransformationDescriptor:
	return self

## Runs the motion.
func fire() -> void:
	pass
`,
	"game/ui/hud.gd": `## Heads-up display.
extends Control

## Shows the score.
func set_score(value: int) -> void:
	$Score.text = str(value)
`,
	"game/shaders/glow.gdshader": `shader_type canvas_item;

void fragment() {
	COLOR = texture(TEXTURE, UV);
}
`,
};

/** The feature branch: planted issues for the reviewer to find. */
const FEATURE: Record<string, string> = {
	"game/player.gd": `## The player.
class_name Player
extends CharacterBody2D

## Movement speed.
@export var speed := 200.0
var enemies := []

func _process(delta: float) -> void:
	var visible_enemies = []
	for e in get_tree().get_nodes_in_group("enemies"):
		if e.visible:
			visible_enemies.append(e)
	var hud = get_node("/root/Main/HUD")
	hud.set_score(visible_enemies.size())

## Attacks every enemy one after another.
func attack_all() -> void:
	for e in enemies:
		await e.take_hit()
`,
	"game/items/card.gd": `## A card on the table.
class_name Card
extends Item

## The blueprint of this card; never mutated.
@export var identity: CardIdentity
## Runtime state of this card.
var data: CardData

## Builds the runtime data from the identity.
func _ready() -> void:
	data = CardData.from_identity(identity)

## Discounts this card.
func discount() -> void:
	identity.cost -= 1

## Drops the card on a slot.
func drop_on(slot: Node2D) -> void:
	position = slot.position
	slot.receive(self)
`,
	"game/ui/hud.gd": `## Heads-up display.
extends Control

## Shows the score.
func set_score(value: int) -> void:
	$Score.text = str(value)
	add_theme_color_override("font_color", Color.RED)
	$Score.size = Vector2(300, 40)
`,
	"game/shaders/glow.gdshader": `shader_type canvas_item;

uniform float strength = 1.0;

void fragment() {
	vec4 c = texture(TEXTURE, UV);
	for (int i = 0; i < 64; i++) {
		c += texture(TEXTURE, UV + vec2(float(i) * 0.001, 0.0)) * strength;
	}
	COLOR = c / 65.0;
}
`,
};

export function makeGodotFixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pgh-godot-")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const write = (path: string, content: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	};
	git("init", "-q", "-b", "develop");
	git("config", "user.email", "dev@example.com");
	git("config", "user.name", "Dev");
	git("config", "commit.gpgsign", "false");
	for (const [p, c] of Object.entries(BASE)) write(p, c);
	git("add", "-A");
	git("commit", "-q", "-m", "base project");
	git("checkout", "-q", "-b", "feature/player");
	for (const [p, c] of Object.entries(FEATURE)) write(p, c);
	git("add", "-A");
	git("commit", "-q", "-m", "player, card discount, hud, glow");
	// a staged edit and an unstaged edit on top of the feature branch
	write("game/resources/card_identity.gd", `${BASE["game/resources/card_identity.gd"]}\n## Display name.\n@export var title := ""\n`);
	git("add", "game/resources/card_identity.gd");
	write("game/game_manager.gd", `${BASE["game/game_manager.gd"]}\nfunc reset() -> void:\n\taction_broadcaster = ActionBroadcaster.new()\n`);
	return { root, git, write };
}

/** Fake gdlint/gdformat printing gdtoolkit's output format, in a directory to put on PATH. */
export function makeFakeGdtoolkit(): string {
	const bin = realpathSync(mkdtempSync(join(tmpdir(), "pgh-bin-")));
	writeFileSync(
		join(bin, "gdlint"),
		`#!/bin/sh
status=0
for f in "$@"; do
  [ -f "$f" ] || continue
  grep -n '^func [a-z_]*[A-Z]' "$f" | while IFS=: read -r line rest; do echo "$f:$line: Error: Function name is not valid (function-name)"; done
  if grep -q 'var hud = get_node' "$f"; then n=$(grep -n 'var hud = get_node' "$f" | cut -d: -f1); echo "$f:$n: Error: Variable \\"hud\\" has no static type (untyped-variable)"; status=1; fi
done
exit $status
`,
	);
	writeFileSync(
		join(bin, "gdformat"),
		`#!/bin/sh
n=0
for f in "$@"; do
  case "$f" in -*) continue;; esac
  if grep -q '  ' "$f" 2>/dev/null; then echo "would reformat $f" >&2; n=$((n+1)); fi
done
[ $n -gt 0 ] && { echo "$n file(s) would be reformatted" >&2; exit 1; }
echo "all files would be left unchanged" >&2
exit 0
`,
	);
	chmodSync(join(bin, "gdlint"), 0o755);
	chmodSync(join(bin, "gdformat"), 0o755);
	return bin;
}
