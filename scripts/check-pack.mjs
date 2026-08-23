import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm =
	process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArgs =
	process.platform === "win32"
		? ["/d", "/s", "/c", "npm.cmd pack --dry-run --json"]
		: ["pack", "--dry-run", "--json"];

function sourceFiles(directory) {
	const files = [];
	for (const entry of readdirSync(join(root, directory), {
		withFileTypes: true,
	})) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else files.push(relative(root, join(root, path)).replaceAll("\\", "/"));
	}
	return files;
}

const expected = new Set([
	"package.json",
	"README.md",
	"LICENSE",
	"schemas/contract-v1.json",
	...sourceFiles("src"),
]);
const result = spawnSync(npm, npmArgs, {
	cwd: root,
	encoding: "utf8",
});

if (result.error !== undefined) {
	process.stderr.write(`Could not run npm: ${result.error.message}\n`);
	process.exit(1);
}
if (result.status !== 0) {
	process.stderr.write(result.stderr || `npm pack failed with ${result.status}\n`);
	process.exit(1);
}

let actual;
try {
	const report = JSON.parse(result.stdout);
	actual = new Set(report[0]?.files?.map(({ path }) => path) ?? []);
} catch (error) {
	process.stderr.write(`Could not parse npm pack output: ${error}\n`);
	process.exit(1);
}

const missing = [...expected].filter((path) => !actual.has(path)).sort();
const unexpected = [...actual].filter((path) => !expected.has(path)).sort();
const binary = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
).bin?.tbboot;
if (typeof binary !== "string" || !binary.endsWith(".js")) {
	console.error("The tbboot bin must point to a JavaScript entrypoint.");
	process.exit(1);
}
if (!actual.has(binary)) {
	console.error(`Missing binary: ${binary}`);
	process.exit(1);
}
if (missing.length > 0 || unexpected.length > 0) {
	if (missing.length > 0) console.error(`Missing: ${missing.join(", ")}`);
	if (unexpected.length > 0)
		console.error(`Unexpected: ${unexpected.join(", ")}`);
	process.exit(1);
}

console.log(`Package contains ${actual.size} expected files.`);
