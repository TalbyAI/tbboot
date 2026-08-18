#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DoctorEnvelope } from "./doctor.ts";
import { runDoctor } from "./doctor.ts";

const usage = "usage: tbboot doctor [--root <consumer-root>] [--json]";
const cliOptions = {
	root: { type: "string" },
	json: { type: "boolean" },
} as const;

type ParseResult =
	| {
			ok: true;
			command: "doctor";
			options: { root: string; json: boolean };
	  }
	| { ok: false; message: string };

function parseCommandLine(argv: string[], cwd: string): ParseResult {
	if (argv[0] !== "doctor") {
		return { ok: false, message: "Expected the doctor command" };
	}
	const args = argv.slice(1);
	const inlineRoot = args.find((arg) => arg.startsWith("--root="));
	if (inlineRoot) {
		return { ok: false, message: `Unknown argument: ${inlineRoot}` };
	}
	const dashedRoot = args.findIndex(
		(arg, index) =>
			arg === "--root" &&
			args[index + 1]?.startsWith("-") &&
			!args[index + 1].startsWith("--"),
	);
	if (dashedRoot !== -1) {
		args.splice(dashedRoot, 2, `--root=${args[dashedRoot + 1]}`);
	}
	try {
		const { values, tokens } = parseArgs({
			args,
			options: cliOptions,
			strict: true,
			tokens: true,
		});
		if (values.root === "") {
			return { ok: false, message: "--root requires a non-empty value" };
		}
		if (
			tokens.filter((token) => token.kind === "option" && token.name === "root")
				.length > 1
		) {
			return { ok: false, message: "--root may only be specified once" };
		}
		return {
			ok: true,
			command: "doctor",
			options: {
				root: resolve(cwd, values.root ?? "."),
				json: values.json ?? false,
			},
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : "Invalid arguments",
		};
	}
}

function renderHuman(envelope: DoctorEnvelope): string {
	const lines = [`status: ${envelope.status}`];
	for (const action of envelope.actions) {
		lines.push(
			`${action.state}: ${action.type} ${action.target} (${action.source}/${action.recipe} step ${action.step})`,
		);
	}
	for (const diagnostic of envelope.diagnostics) {
		const context = [
			diagnostic.document,
			diagnostic.path,
			diagnostic.source,
			diagnostic.recipe,
			diagnostic.step === undefined ? undefined : `step ${diagnostic.step}`,
		]
			.filter((value) => value !== undefined)
			.join(" ");
		lines.push(
			`${diagnostic.severity}: ${diagnostic.code}${context ? ` [${context}]` : ""}: ${diagnostic.message}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const command = parseCommandLine(argv, process.cwd());
	if (!command.ok) {
		process.stderr.write(`${command.message}\n${usage}\n`);
		return 2;
	}
	const result = await runDoctor(command.options.root);
	process.stdout.write(
		command.options.json
			? `${JSON.stringify(result.envelope)}\n`
			: renderHuman(result.envelope),
	);
	return result.exitCode;
}

const entrypoint = process.argv[1];
if (
	entrypoint &&
	realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))
) {
	main().then((code) => {
		process.exitCode = code;
	});
}
