// Labelled changes for `npm run eval:routing`: each is one changed file (its added lines), with the skills a
// careful reviewer would want to consult besides godot-code-review. Written for this eval; small on purpose.
import type { Lang } from "../src/review/types.ts";

export interface RoutingCase {
	id: string;
	path: string;
	lang?: Lang;
	/** `extends` / `class_name` lines */
	header?: string;
	/** The enclosing function, when the change is inside one */
	context?: string;
	/** Added lines */
	code: string;
	labels: string[];
}

export const CASES: RoutingCase[] = [
	{
		id: "player-move",
		path: "game/player/player.gd",
		header: "extends CharacterBody2D",
		context: "func _physics_process(delta: float) -> void:",
		code: 'var dir := Input.get_vector("left", "right", "up", "down")\nvelocity = dir * speed\nif Input.is_action_just_pressed("jump") and is_on_floor():\n\tvelocity.y = jump_velocity\nmove_and_slide()',
		labels: ["player-controller", "input-handling"],
	},
	{
		id: "await-in-loop",
		path: "game/enemies/spawner.gd",
		header: "extends Node2D",
		context: "func spawn_wave(count: int) -> void:",
		code: "for i in count:\n\tvar e := enemy_scene.instantiate()\n\tadd_child(e)\n\tawait get_tree().create_timer(0.5).timeout",
		labels: ["gdscript-advanced"],
	},
	{
		id: "process-alloc",
		path: "game/world/radar.gd",
		header: "extends Node2D",
		context: "func _process(delta: float) -> void:",
		code: 'var nearby: Array = []\nfor n in get_tree().get_nodes_in_group("enemies"):\n\tif n.global_position.distance_to(global_position) < 300:\n\t\tnearby.append(n)\n$Label.text = "Enemies: %d" % nearby.size()',
		labels: ["godot-optimization"],
	},
	{
		id: "hud-theme",
		path: "game/ui/hud.gd",
		header: "extends Control",
		code: 'var label := Label.new()\nlabel.add_theme_color_override("font_color", Color.RED)\nlabel.add_theme_font_size_override("font_size", 24)\n$VBox.add_child(label)',
		labels: ["godot-ui", "hud-system"],
	},
	{
		id: "shader-loop",
		path: "game/shaders/glow.gdshader",
		lang: "shader",
		code: "shader_type canvas_item;\nuniform float strength = 1.0;\nvoid fragment() {\n\tvec4 c = vec4(0.0);\n\tfor (int i = 0; i < 32; i++) { c += texture(TEXTURE, UV + vec2(float(i) * 0.001, 0.0)); }\n\tCOLOR = c / 32.0 * strength;\n}",
		labels: ["shader-basics"],
	},
	{
		id: "mutate-resource",
		path: "game/items/card.gd",
		header: "class_name Card\nextends Node2D",
		context: "func apply_discount() -> void:",
		code: "identity.cost -= 1\nidentity.title = identity.title + \" (sale)\"",
		labels: ["resource-pattern"],
	},
	{
		id: "event-bus",
		path: "game/combat/health.gd",
		header: "extends Node",
		code: "signal died\nfunc take_damage(amount: int) -> void:\n\thp -= amount\n\tif hp <= 0:\n\t\tdied.emit()\n\t\tEvents.enemy_killed.emit(owner)",
		labels: ["event-bus"],
	},
	{
		id: "save-json",
		path: "game/autoload/save_game.gd",
		header: "extends Node",
		code: 'func save() -> void:\n\tvar f := FileAccess.open("user://save.json", FileAccess.WRITE)\n\tf.store_string(JSON.stringify({"level": level, "gold": gold}))',
		labels: ["save-load"],
	},
	{
		id: "enum-state",
		path: "game/enemies/goblin.gd",
		header: "extends CharacterBody2D",
		context: "func _physics_process(delta: float) -> void:",
		code: "match state:\n\tState.IDLE:\n\t\tif sees_player(): state = State.CHASE\n\tState.CHASE:\n\t\tchase(delta)\n\tState.ATTACK:\n\t\tattack()",
		labels: ["state-machine"],
	},
	{
		id: "tween-fade",
		path: "game/ui/toast.gd",
		header: "extends PanelContainer",
		code: 'var t := create_tween()\nt.tween_property(self, "modulate:a", 0.0, 0.4).set_delay(2.0)\nt.tween_callback(queue_free)',
		labels: ["tween-animation"],
	},
	{
		id: "anim-player",
		path: "game/player/player_anim.gd",
		header: "extends AnimatedSprite2D",
		code: 'func update_anim(v: Vector2) -> void:\n\tif v.length() > 0.1:\n\t\t$AnimationPlayer.play("run")\n\telse:\n\t\t$AnimationPlayer.play("idle")\n\t$AnimationTree.set("parameters/blend_position", v)',
		labels: ["animation-system"],
	},
	{
		id: "camera-shake",
		path: "game/world/camera.gd",
		header: "extends Camera2D",
		code: "func shake(power: float) -> void:\n\ttrauma = min(trauma + power, 1.0)\nfunc _process(delta: float) -> void:\n\toffset = Vector2(randf_range(-1, 1), randf_range(-1, 1)) * trauma * max_offset\n\ttrauma = max(trauma - delta, 0.0)",
		labels: ["camera-system"],
	},
	{
		id: "nav-agent",
		path: "game/enemies/chaser.gd",
		header: "extends CharacterBody2D",
		context: "func _physics_process(delta: float) -> void:",
		code: "nav.target_position = player.global_position\nvar next := nav.get_next_path_position()\nvelocity = global_position.direction_to(next) * speed\nmove_and_slide()",
		labels: ["ai-navigation"],
	},
	{
		id: "audio-bus",
		path: "game/audio/sfx.gd",
		header: "extends Node",
		code: 'func play(stream: AudioStream) -> void:\n\tvar p := AudioStreamPlayer.new()\n\tp.stream = stream\n\tp.bus = "SFX"\n\tadd_child(p)\n\tp.play()\n\tp.finished.connect(p.queue_free)',
		labels: ["audio-system"],
	},
	{
		id: "rpc",
		path: "game/net/player_net.gd",
		header: "extends Node",
		code: '@rpc("any_peer", "call_local", "reliable")\nfunc request_shoot(dir: Vector2) -> void:\n\tif multiplayer.get_remote_sender_id() != get_multiplayer_authority():\n\t\treturn\n\tshoot(dir)',
		labels: ["multiplayer-basics"],
	},
	{
		id: "mp-sync",
		path: "game/net/sync.gd",
		header: "extends MultiplayerSynchronizer",
		code: 'func _ready() -> void:\n\treplication_config.add_property(NodePath(".:position"))\n\tset_visibility_for(1, true)',
		labels: ["multiplayer-sync"],
	},
	{
		id: "worker-threads",
		path: "game/world/chunk_loader.gd",
		header: "extends Node",
		code: "var task := WorkerThreadPool.add_task(_generate_chunk.bind(coords))\nmutex.lock()\npending[coords] = task\nmutex.unlock()",
		labels: ["multithreading"],
	},
	{
		id: "particles",
		path: "game/fx/explosion.gd",
		header: "extends GPUParticles2D",
		code: "func boom() -> void:\n\tone_shot = true\n\tamount = 64\n\tprocess_material.initial_velocity_max = 300.0\n\temitting = true",
		labels: ["particles-vfx"],
	},
	{
		id: "translations",
		path: "game/ui/menu.gd",
		header: "extends Control",
		code: 'func _ready() -> void:\n\t$Start.text = tr("MENU_START")\n\tTranslationServer.set_locale(Settings.locale)',
		labels: ["localization"],
	},
	{
		id: "3d-material",
		path: "game/level3d/crystal.gd",
		header: "extends MeshInstance3D",
		code: "var mat := StandardMaterial3D.new()\nmat.emission_enabled = true\nmat.emission = Color(0.2, 0.6, 1.0)\nset_surface_override_material(0, mat)\nrotate_y(0.5)",
		labels: ["3d-essentials"],
	},
	{
		id: "tilemap",
		path: "game/world/level.gd",
		header: "extends Node2D",
		code: "for x in width:\n\tfor y in height:\n\t\t$Ground.set_cell(Vector2i(x, y), 0, Vector2i(0, 0))",
		labels: ["2d-essentials"],
	},
	{
		id: "inventory-stack",
		path: "game/inventory/inventory.gd",
		header: "class_name Inventory\nextends Resource",
		code: "func add_item(item: ItemData, count: int) -> int:\n\tfor slot in slots:\n\t\tif slot.item == item and slot.count < item.max_stack:\n\t\t\tvar add := mini(count, item.max_stack - slot.count)\n\t\t\tslot.count += add\n\t\t\tcount -= add\n\treturn count",
		labels: ["inventory-system", "resource-pattern"],
	},
	{
		id: "dialogue",
		path: "game/npc/npc.gd",
		header: "extends Area2D",
		code: 'func interact() -> void:\n\tvar lines := ["Hello!", "The bridge is out.", "Take the north road."]\n\tDialogueBox.show_lines(lines, portrait)',
		labels: ["dialogue-system"],
	},
	{
		id: "gut-test",
		path: "test/unit/test_inventory.gd",
		header: "extends GutTest",
		code: "func test_add_stacks() -> void:\n\tvar inv := Inventory.new()\n\tassert_eq(inv.add_item(potion, 3), 0)\n\tassert_eq(inv.slots[0].count, 3)",
		labels: ["godot-testing"],
	},
	{
		id: "noise-map",
		path: "game/world/generator.gd",
		header: "extends Node",
		code: "var noise := FastNoiseLite.new()\nnoise.seed = rng.randi()\nfor x in size:\n\tfor y in size:\n\t\tvar h := noise.get_noise_2d(x, y)\n\t\tmap[x][y] = WATER if h < -0.2 else GRASS",
		labels: ["procedural-generation"],
	},
	{
		id: "components",
		path: "game/entities/barrel.gd",
		header: "extends StaticBody2D",
		code: '@export var health: HealthComponent\n@export var hitbox: HitboxComponent\nfunc _ready() -> void:\n\thitbox.hit.connect(health.damage)\n\thealth.depleted.connect(queue_free)',
		labels: ["component-system"],
	},
	{
		id: "scene-reach",
		path: "game/enemies/turret.gd",
		header: "extends Node2D",
		code: 'func fire() -> void:\n\tvar b := preload("res://scenes/bullet.tscn").instantiate()\n\tget_parent().get_parent().get_node("Bullets").add_child(b)\n\tb.global_position = $Muzzle.global_position',
		labels: ["scene-organization"],
	},
	{
		id: "vector-math",
		path: "game/enemies/homing.gd",
		header: "extends Area2D",
		context: "func _physics_process(delta: float) -> void:",
		code: "var desired := global_position.direction_to(target.global_position)\nvar angle := transform.x.angle_to(desired)\nrotation += clampf(angle, -turn_rate * delta, turn_rate * delta)\nposition += transform.x * speed * delta",
		labels: ["math-essentials"],
	},
	{
		id: "responsive",
		path: "game/ui/main_menu.gd",
		header: "extends Control",
		code: "func _ready() -> void:\n\tget_tree().root.content_scale_mode = Window.CONTENT_SCALE_MODE_CANVAS_ITEMS\n\t$Panel.set_anchors_preset(Control.PRESET_CENTER)\n\t$Panel/VBox.size_flags_horizontal = Control.SIZE_EXPAND_FILL",
		labels: ["responsive-ui", "godot-ui"],
	},
	{
		id: "remap",
		path: "game/ui/keybind_button.gd",
		header: "extends Button",
		code: "func _input(event: InputEvent) -> void:\n\tif waiting and event is InputEventKey:\n\t\tInputMap.action_erase_events(action)\n\t\tInputMap.action_add_event(action, event)\n\t\twaiting = false",
		labels: ["input-handling"],
	},
	{
		id: "ability-cooldown",
		path: "game/abilities/dash.gd",
		header: "class_name DashAbility\nextends Ability",
		code: "func activate(user: Node) -> void:\n\tif cooldown_left > 0.0 or user.stamina < cost:\n\t\treturn\n\tuser.stamina -= cost\n\tcooldown_left = cooldown\n\tuser.velocity += user.facing * dash_speed",
		labels: ["ability-system"],
	},
	{
		id: "typed-lambdas",
		path: "game/util/sorting.gd",
		header: "class_name Sorting",
		code: "static func by_distance(from: Vector2, nodes: Array[Node2D]) -> Array[Node2D]:\n\tvar out := nodes.duplicate()\n\tout.sort_custom(func(a: Node2D, b: Node2D) -> bool: return a.global_position.distance_squared_to(from) < b.global_position.distance_squared_to(from))\n\treturn out",
		labels: ["gdscript-patterns"],
	},
	{
		id: "plain-rename",
		path: "game/util/strings.gd",
		header: "class_name Strings",
		code: "static func pad_left(text: String, width: int) -> String:\n\treturn text.lpad(width)",
		labels: [],
	},
	{
		id: "physics-layers",
		path: "game/world/projectile.gd",
		header: "extends RigidBody2D",
		code: "func _ready() -> void:\n\tcollision_layer = 1 << 3\n\tcollision_mask = (1 << 0) | (1 << 2)\n\tcontact_monitor = true\n\tmax_contacts_reported = 4\n\tbody_entered.connect(_on_hit)",
		labels: ["physics-system"],
	},
	{
		id: "autoload-di",
		path: "game/main.gd",
		header: "extends Node",
		code: "func _ready() -> void:\n\tvar services := ServiceLocator.new()\n\tservices.register(&\"audio\", $Audio)\n\tservices.register(&\"save\", SaveService.new())\n\tfor child in get_children():\n\t\tif child.has_method(\"inject\"): child.inject(services)",
		labels: ["dependency-injection"],
	},
];
