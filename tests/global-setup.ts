// Runs once before the tests: the fixed GodotPrompter version the tests use (downloaded on the first run).
import { ensureTestSkills } from "./helpers/skills.ts";

export default function setup(): void {
	ensureTestSkills();
}
