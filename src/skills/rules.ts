// Tier-1 routing: cheap, deterministic rules that score skills for a piece of a diff. A score of 2 or more
// selects a skill; 1 makes it a candidate the classifier (or the worker) may still pick.
import type { Lang } from "../review/types.ts";

export interface RoutingInput {
	file: string;
	lang: Lang;
	/** Added and removed lines. */
	changed: string;
	/** Surrounding source (enclosing functions). */
	context: string;
	/** extends / class_name lines of the file. */
	header: string;
}

export interface Rule {
	skill: string;
	weight: number;
	langs?: Lang[];
	path?: RegExp;
	/** Matched against changed lines. */
	changed?: RegExp;
	/** Matched against changed lines, enclosing functions and the file header. */
	any?: RegExp;
	header?: RegExp;
	why: string;
}

const GD: Lang[] = ["gdscript", "csharp"];
const CODE_OR_SCENE: Lang[] = ["gdscript", "csharp", "scene", "resource"];

export const RULES: Rule[] = [
	// shaders
	{ skill: "shader-basics", weight: 3, langs: ["shader"], why: "shader file" },
	{ skill: "shader-basics", weight: 2, langs: GD, changed: /ShaderMaterial|set_shader_parameter|shader_parameter\//, why: "shader parameters" },
	{ skill: "godot-optimization", weight: 1, langs: ["shader"], changed: /\bfor\s*\(|texture\s*\(/, why: "shader loops and samples" },
	// UI
	{ skill: "godot-ui", weight: 3, langs: GD, header: /extends\s+(Control|Container|[A-Z]\w*Container|Label|RichTextLabel|Button|TextureRect|Panel|PanelContainer|LineEdit|TextEdit|ItemList|Tree|TabContainer|ScrollContainer|Range|ProgressBar|ColorRect|NinePatchRect|BaseButton|OptionButton|CheckBox)\b/, why: "Control script" },
	{ skill: "godot-ui", weight: 2, langs: CODE_OR_SCENE, changed: /add_theme_\w+_override|\btheme\b|size_flags|anchors?_preset|set_anchors|custom_minimum_size|offset_(left|right|top|bottom)|layout_mode|grow_(horizontal|vertical)/, why: "layout/theme code" },
	{ skill: "godot-ui", weight: 2, langs: ["scene"], changed: /type="(Control|[A-Z]\w*Container|Label|Button|Panel|TextureRect|RichTextLabel)"/, why: "Control nodes in a scene" },
	{ skill: "responsive-ui", weight: 2, langs: CODE_OR_SCENE.concat(["project"]), changed: /content_scale|stretch\/|window\/stretch|get_viewport_rect|DisplayServer\.screen/, why: "stretch/scale settings" },
	{ skill: "hud-system", weight: 1, path: /hud|ui\/.*(health|score|bar)/i, why: "HUD path" },
	// 2D / 3D
	{ skill: "2d-essentials", weight: 2, langs: CODE_OR_SCENE, any: /\b(Node2D|Sprite2D|AnimatedSprite2D|TileMap|TileMapLayer|CanvasLayer|Parallax\w*|PointLight2D|LightOccluder2D|Line2D|Polygon2D|MeshInstance2D|CanvasItem)\b|\b_draw\(|draw_(line|rect|circle|texture|polygon)/, why: "2D nodes and drawing" },
	{ skill: "3d-essentials", weight: 2, langs: CODE_OR_SCENE, any: /\b(Node3D|MeshInstance3D|StandardMaterial3D|ORMMaterial3D|WorldEnvironment|Environment|DirectionalLight3D|OmniLight3D|SpotLight3D|Camera3D|GPUParticles3D|Decal|VoxelGI|LightmapGI|ReflectionProbe)\b/, why: "3D nodes" },
	// data
	{ skill: "resource-pattern", weight: 3, langs: GD, header: /extends\s+Resource\b/, why: "custom Resource" },
	{ skill: "resource-pattern", weight: 2, langs: ["resource"], why: ".tres resource" },
	{ skill: "resource-pattern", weight: 2, langs: GD, changed: /\bResource\b|\.duplicate\(|resource_local_to_scene|ResourceLoader|preload\(|load\(/, why: "Resource use" },
	{ skill: "save-load", weight: 2, langs: GD, changed: /FileAccess|ConfigFile|ResourceSaver|user:\/\/|JSON\.(stringify|parse)|save_game|load_game/, why: "persistence" },
	// GDScript
	{ skill: "gdscript-advanced", weight: 2, langs: ["gdscript"], changed: /\bawait\b|\bsignal\b|\.connect\(|\.emit\(|emit_signal|Callable|\.bind\(|call_deferred|@tool|\bset_meta|\bget_meta/, why: "await, signals, callables" },
	{ skill: "gdscript-patterns", weight: 1, langs: ["gdscript"], changed: /\S/, why: "GDScript change" },
	{ skill: "gdscript-patterns", weight: 1, langs: ["gdscript"], changed: /\bvar\s+\w+\s*=|:=|\bmatch\b|func\s+\w+\([^)]*\)\s*:/, why: "typing, match, signatures" },
	{ skill: "godot-optimization", weight: 2, langs: GD, any: /func\s+_(physics_)?process\s*\(/, changed: /get_node|\$\w|get_tree\(\)|get_nodes_in_group|\.new\(\)|\[\]|\{\}|load\(|instantiate\(|for\s+\w+\s+in|while\s/, why: "work inside _process" },
	{ skill: "godot-optimization", weight: 1, langs: GD, changed: /get_nodes_in_group|find_children|find_child|instantiate\(|queue_free/, why: "possibly expensive calls" },
	// architecture
	{ skill: "event-bus", weight: 2, langs: GD, changed: /EventBus|Events\.\w+\.(connect|emit)|get_node\("\/root\//, why: "global bus / root lookups" },
	{ skill: "dependency-injection", weight: 2, langs: GD, changed: /get_node\("\/root\/|\/root\/|get_tree\(\)\.root|Engine\.get_singleton|ServiceLocator/, why: "hard dependencies on globals" },
	{ skill: "dependency-injection", weight: 1, langs: GD, changed: /@export\s+var\s+\w+\s*:\s*Node/, why: "exported node references" },
	{ skill: "component-system", weight: 2, langs: GD, any: /component|Component/, why: "components" },
	{ skill: "component-system", weight: 1, langs: GD, changed: /add_child\(|get_parent\(\)|owner\b/, why: "node composition" },
	{ skill: "scene-organization", weight: 2, langs: ["scene"], why: "scene change" },
	{ skill: "scene-organization", weight: 1, langs: GD, changed: /instantiate\(|PackedScene|add_child\(|remove_child\(|reparent\(|get_parent\(\)/, why: "scene tree manipulation" },
	{ skill: "state-machine", weight: 2, langs: GD, any: /\bState(Machine)?\b|func\s+(enter|exit)\s*\(|transition_to|change_state/, why: "state machine" },
	// gameplay systems
	{ skill: "player-controller", weight: 2, langs: GD, any: /extends\s+CharacterBody(2D|3D)|move_and_slide|move_and_collide/, why: "character body" },
	{ skill: "physics-system", weight: 2, langs: CODE_OR_SCENE, any: /\b(RigidBody(2D|3D)|Area(2D|3D)|CollisionShape(2D|3D)|CollisionPolygon2D|RayCast(2D|3D)|ShapeCast(2D|3D)|PhysicsDirectSpaceState\w*|collision_(layer|mask)|body_entered|area_entered)\b/, why: "physics" },
	{ skill: "input-handling", weight: 2, langs: GD, changed: /\bInput\.|func\s+_(unhandled_)?(key_)?input\(|_gui_input|InputEvent\w*|InputMap|is_action_(just_)?(pressed|released)/, why: "input" },
	{ skill: "animation-system", weight: 2, langs: CODE_OR_SCENE, changed: /AnimationPlayer|AnimationTree|AnimatedSprite|\.play\(\s*"|animation_finished/, why: "animation" },
	{ skill: "tween-animation", weight: 2, langs: GD, changed: /create_tween|\bTween\b|tween_(property|method|callback|interval)|set_trans|set_ease/, why: "tweens" },
	{ skill: "audio-system", weight: 2, langs: CODE_OR_SCENE, changed: /AudioStreamPlayer\w*|AudioServer|AudioStream\w*|\bbus\s*=/, why: "audio" },
	{ skill: "ai-navigation", weight: 2, langs: CODE_OR_SCENE, any: /Navigation(Agent|Region|Server|Obstacle|Link)(2D|3D)?|get_next_path_position|is_navigation_finished/, why: "navigation" },
	{ skill: "camera-system", weight: 2, langs: CODE_OR_SCENE, changed: /\bCamera(2D|3D)\b|make_current|screen_shake|\bshake\b/, why: "cameras" },
	{ skill: "particles-vfx", weight: 2, langs: CODE_OR_SCENE, any: /(GPU|CPU)Particles(2D|3D)|ParticleProcessMaterial/, why: "particles" },
	{ skill: "inventory-system", weight: 1, langs: GD, any: /inventory|Inventory|\bslot\b|Slot\b|stack(_size|able)/, why: "inventory / slots" },
	{ skill: "ability-system", weight: 2, langs: GD, any: /\bability\b|Ability|cooldown|\bbuff\b|debuff|StatModifier/i, why: "abilities and buffs" },
	{ skill: "dialogue-system", weight: 2, langs: GD, any: /dialogue|Dialogue/, why: "dialogue" },
	{ skill: "localization", weight: 2, langs: GD.concat(["text", "project"]), changed: /\btr\(|tr_n\(|TranslationServer|\.po\b|locale/, why: "localization" },
	{ skill: "multiplayer-basics", weight: 2, langs: GD, changed: /@rpc|\brpc(_id)?\(|multiplayer\.|MultiplayerPeer|ENetMultiplayerPeer|WebSocketMultiplayerPeer|is_multiplayer_authority/, why: "multiplayer" },
	{ skill: "multiplayer-sync", weight: 2, langs: CODE_OR_SCENE, changed: /MultiplayerSynchronizer|MultiplayerSpawner|replication/, why: "replication" },
	{ skill: "multithreading", weight: 2, langs: GD, changed: /\bThread\b|Mutex|Semaphore|WorkerThreadPool|call_deferred|set_deferred/, why: "threads and deferred calls" },
	{ skill: "math-essentials", weight: 1, langs: GD, changed: /\blerp|slerp|\bBasis\b|Transform(2D|3D)|\.angle_to|\.rotated\(|deg_to_rad|rad_to_deg|randf|randi|RandomNumberGenerator/, why: "math" },
	{ skill: "procedural-generation", weight: 2, langs: GD, changed: /FastNoiseLite|\bnoise\b|\bseed\b|generate_(map|level|dungeon)/, why: "procedural generation" },
	{ skill: "godot-testing", weight: 3, path: /(^|\/)(tests?|spec)\//, why: "test files" },
	{ skill: "godot-testing", weight: 2, langs: GD, any: /extends\s+(GutTest|GdUnitTestSuite)|func\s+test_/, why: "test code" },
	{ skill: "addon-development", weight: 3, path: /^addons\//, why: "addon code" },
	{ skill: "addon-development", weight: 2, langs: GD, any: /@tool\b|EditorPlugin|EditorInspectorPlugin/, why: "editor code" },
	{ skill: "godot-debugging", weight: 1, langs: GD, changed: /push_error|push_warning|assert\(|print_debug|breakpoint/, why: "error handling" },
	{ skill: "csharp-godot", weight: 3, langs: ["csharp"], why: "C# file" },
	{ skill: "csharp-signals", weight: 2, langs: ["csharp"], changed: /\[Signal\]|EmitSignal|\+= \w+;|ToSignal/, why: "C# signals" },
	{ skill: "export-pipeline", weight: 3, path: /(^|\/)export_presets\.cfg$/, why: "export presets" },
	{ skill: "assets-pipeline", weight: 2, path: /\.import$/, why: "import settings" },
	{ skill: "gdextension", weight: 3, path: /\.gdextension$/, why: "GDExtension" },
	{ skill: "xr-development", weight: 2, langs: CODE_OR_SCENE, changed: /XROrigin3D|XRCamera3D|OpenXR|XRController3D/, why: "XR" },
	{ skill: "mobile-development", weight: 2, langs: GD, changed: /JavaClassWrapper|Engine\.has_singleton\("(GodotGooglePlay|AppleStore)|OS\.get_name\(\)\s*==\s*"(Android|iOS)"/, why: "mobile" },
	// third-party addons
	{ skill: "beehave", weight: 3, langs: CODE_OR_SCENE, any: /Beehave|beehave/, why: "Beehave" },
	{ skill: "limboai", weight: 3, langs: CODE_OR_SCENE, any: /LimboAI|BTTask|LimboHSM|BTPlayer/, why: "LimboAI" },
	{ skill: "popochiu", weight: 3, langs: CODE_OR_SCENE, any: /Popochiu/, why: "Popochiu" },
	{ skill: "dialogue-manager", weight: 3, any: /DialogueManager|\.dialogue\b/, why: "Dialogue Manager" },
	{ skill: "phantom-camera", weight: 3, langs: CODE_OR_SCENE, any: /PhantomCamera/, why: "Phantom Camera" },
];

/** Skills worth asking the classifier about for any change in this language, besides rule hits. */
export const DEFAULT_CANDIDATES: Partial<Record<Lang, string[]>> = {
	gdscript: [
		"gdscript-patterns",
		"gdscript-advanced",
		"godot-optimization",
		"scene-organization",
		"component-system",
		"resource-pattern",
		"event-bus",
		"dependency-injection",
		"state-machine",
		"godot-debugging",
	],
	csharp: ["csharp-godot", "csharp-signals", "godot-optimization", "scene-organization", "component-system", "resource-pattern"],
	scene: ["scene-organization", "godot-ui", "2d-essentials", "3d-essentials", "component-system"],
	resource: ["resource-pattern"],
	shader: ["shader-basics", "godot-optimization"],
};

export interface RuleScore {
	skill: string;
	score: number;
	reasons: string[];
}

function ruleMatches(rule: Rule, input: RoutingInput): boolean {
	if (rule.langs && !rule.langs.includes(input.lang)) return false;
	if (rule.path && !rule.path.test(input.file)) return false;
	if (rule.changed && !rule.changed.test(input.changed)) return false;
	if (rule.header && !rule.header.test(input.header)) return false;
	if (rule.any && !rule.any.test(`${input.changed}\n${input.context}\n${input.header}`)) return false;
	return true;
}

/** Scores per skill for one piece of the diff, best first. Rules naming unknown skills are ignored by the caller. */
export function scoreRules(input: RoutingInput, rules: Rule[] = RULES): RuleScore[] {
	const scores = new Map<string, RuleScore>();
	for (const rule of rules) {
		if (!ruleMatches(rule, input)) continue;
		const s = scores.get(rule.skill) ?? { skill: rule.skill, score: 0, reasons: [] };
		s.score += rule.weight;
		s.reasons.push(rule.why);
		scores.set(rule.skill, s);
	}
	return [...scores.values()].sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
}

export function ruleSkillNames(rules: Rule[] = RULES): string[] {
	return [...new Set(rules.map((r) => r.skill))];
}
