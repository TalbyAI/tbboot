import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = mkdtempSync(join(tmpdir(), "tbboot-build-"));

try {
	const result = spawnSync(
		process.execPath,
		[
			join(root, "node_modules", "typescript", "bin", "tsc"),
			"--project",
			join(root, "tsconfig.build.json"),
			"--outDir",
			output,
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(`TypeScript build failed with ${result.status}`);
	}
	cpSync(output, join(root, "src"), { force: true, recursive: true });
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	rmSync(output, { force: true, recursive: true });
}
