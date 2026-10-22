// The skills a review can use: the downloaded GodotPrompter skills plus any extra skill directories, each a
// folder with a SKILL.md (Agent Skills layout: frontmatter with name and description).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillInfo {
	name: string;
	title?: string;
	description: string;
	/** Directory holding SKILL.md. */
	dir: string;
	file: string;
	related: string[];
	addon?: string;
	/** Rough token count of SKILL.md (characters / 4). */
	tokens: number;
}

/** Minimal frontmatter reader: `key: value` lines, quoted values, and folded `>`/`|` blocks. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
	if (!text.startsWith("---")) return { data: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { data: {}, body: text };
	const head = text.slice(text.indexOf("\n") + 1, end);
	const body = text.slice(text.indexOf("\n", end + 1) + 1);
	const data: Record<string, string> = {};
	const lines = head.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
		if (!m) continue;
		let value = m[2].trim();
		if (value === ">" || value === "|" || value === ">-" || value === "|-") {
			const block: string[] = [];
			while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
			value = block.join(value.startsWith(">") ? " " : "\n");
		} else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		data[m[1]] = value;
	}
	return { data, body };
}

interface IndexEntry {
	name: string;
	title?: string;
	description?: string;
	relatedSkills?: string[];
	addon?: string | null;
}

export class SkillCatalog {
	private readonly skills = new Map<string, SkillInfo>();

	static load(roots: string[]): SkillCatalog {
		const catalog = new SkillCatalog();
		for (const root of roots) catalog.addRoot(root);
		return catalog;
	}

	private addRoot(root: string): void {
		if (!existsSync(root)) return;
		const index = new Map<string, IndexEntry>();
		const indexFile = join(root, "index.json");
		if (existsSync(indexFile)) {
			try {
				const parsed = JSON.parse(readFileSync(indexFile, "utf8")) as { skills?: IndexEntry[] };
				for (const e of parsed.skills ?? []) index.set(e.name, e);
			} catch {
				// a broken index only loses titles and related skills
			}
		}
		for (const entry of readdirSync(root)) {
			const dir = join(root, entry);
			const file = join(dir, "SKILL.md");
			if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
			const text = readFileSync(file, "utf8");
			const { data } = parseFrontmatter(text);
			const name = data.name || entry;
			if (!data.description || this.skills.has(name)) continue;
			const meta = index.get(name);
			this.skills.set(name, {
				name,
				title: meta?.title,
				description: data.description,
				dir,
				file,
				related: meta?.relatedSkills ?? [],
				addon: meta?.addon ?? undefined,
				tokens: Math.ceil(text.length / 4),
			});
		}
	}

	get size(): number {
		return this.skills.size;
	}

	has(name: string): boolean {
		return this.skills.has(name);
	}

	get(name: string): SkillInfo | undefined {
		return this.skills.get(name);
	}

	all(): SkillInfo[] {
		return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/** SKILL.md without its frontmatter. */
	body(name: string): string {
		const s = this.skills.get(name);
		if (!s) return "";
		return parseFrontmatter(readFileSync(s.file, "utf8")).body.trim();
	}

	/** Names in `names` the catalog does not know. */
	unknown(names: Iterable<string>): string[] {
		return [...new Set(names)].filter((n) => !this.skills.has(n));
	}
}
