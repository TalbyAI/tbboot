import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
const npm =
	windows ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArgs =
	windows
		? ["/d", "/s", "/c", "npm.cmd pack --dry-run --json"]
		: ["pack", "--dry-run", "--json"];

function quoteWindows(value) {
	if (!/[\s"&|<>^]/.test(value)) return value;
	return `"${value.replaceAll('"', '""')}"`;
}

function runNpm(args, cwd) {
	const command = windows
		? spawnSync(
				npm,
				["/d", "/s", "/c", ["npm.cmd", ...args.map(quoteWindows)].join(" ")],
				{ cwd, encoding: "utf8" },
			)
		: spawnSync("npm", args, { cwd, encoding: "utf8" });
	if (command.error !== undefined || command.status !== 0) {
		throw new Error(
			command.stderr ||
				command.stdout ||
				command.error?.message ||
				`npm command failed with ${command.status}`,
		);
	}
	return command;
}

function runBinary(command, args, cwd) {
	const result = windows
		? spawnSync(
				process.env.ComSpec ?? "cmd.exe",
				[
					"/d",
					"/s",
					"/c",
					[quoteWindows(command), ...args.map(quoteWindows)].join(" "),
				],
				{ cwd, encoding: "utf8" },
			)
		: spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.error !== undefined || result.status !== 0) {
		const detail =
			result.stderr ||
			result.stdout ||
			result.error?.message ||
			`binary command failed with ${result.status}`;
		throw new Error(`${detail}\nCommand: ${command}`);
	}
}

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

const expected = new Set([
	"package.json",
	"README.md",
	"LICENSE",
	"schemas/contract-v1.json",
	...sourceFiles("src"),
]);
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

const installRoot = mkdtempSync(join(tmpdir(), "tbboot-pack-install-"));
try {
	const pack = runNpm(
		["pack", "--ignore-scripts", "--json", "--pack-destination", installRoot],
		root,
	);
	const tarball = join(installRoot, JSON.parse(pack.stdout)[0].filename);
	const localRoot = join(installRoot, "local");
	mkdirSync(localRoot);
	runNpm(
		[
			"install",
			"--ignore-scripts",
			"--no-package-lock",
			"--prefix",
			localRoot,
			tarball,
		],
		localRoot,
	);
	runBinary(
		join(localRoot, "node_modules", ".bin", windows ? "tbboot.cmd" : "tbboot"),
		["catalog", "list", "--json"],
		localRoot,
	);
	console.log("Local install: OK");

	const globalRoot = join(installRoot, "global");
	mkdirSync(globalRoot);
	runNpm(
		[
			"install",
			"--global",
			"--ignore-scripts",
			"--prefix",
			globalRoot,
			tarball,
		],
		root,
	);
	runBinary(
		join(globalRoot, windows ? "tbboot.cmd" : "bin/tbboot"),
		["catalog", "list", "--json"],
		globalRoot,
	);
	console.log("Global install: OK");

	const npxRoot = join(installRoot, "npx");
	mkdirSync(npxRoot);
	runNpm(
		[
			"exec",
			"--yes",
			"--package",
			tarball,
			"--",
			"tbboot",
			"catalog",
			"list",
			"--json",
		],
		npxRoot,
	);
	console.log("npx install: OK");
} finally {
	rmSync(installRoot, { force: true, recursive: true });
}
