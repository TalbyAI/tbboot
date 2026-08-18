#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { DoctorEnvelope } from "./doctor.ts";
import { runDoctor } from "./doctor.ts";
import type { InstallEnvelope } from "./install.ts";
import { runInstall } from "./install.ts";

const usage = [
	"usage: tbboot doctor [--root <consumer-root>] [--json]",
	"usage: tbboot install [--root <consumer-root>] [--dry-run] [--force] [--json]",
].join("\n");

type ParseResult =
	| {
			ok: true;
			command: "doctor";
			options: { root: string; json: boolean };
	  }
	| {
			ok: true;
			command: "install";
			options: { root: string; json: boolean; dryRun: boolean; force: boolean };
	  }
	| { ok: false; message: string };

function parseCommandLine(argv: string[], cwd: string): ParseResult {
	if (argv[0] !== "doctor" && argv[0] !== "install") {
		return { ok: false, message: "Expected the doctor or install command" };
	}
	const command = argv[0];
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
		const cliOptions: ParseArgsOptionsConfig =
			command === "doctor"
				? { root: { type: "string" }, json: { type: "boolean" } }
				: {
						root: { type: "string" },
						json: { type: "boolean" },
						"dry-run": { type: "boolean" },
						force: { type: "boolean" },
					};
		const { values, tokens = [] } = parseArgs({
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
		if (
			command === "install" &&
			tokens.filter(
				(token) => token.kind === "option" && token.name === "force",
			).length > 1
		) {
			return { ok: false, message: "--force may only be specified once" };
		}
		const root = resolve(cwd, (values.root as string | undefined) ?? ".");
		const json = (values.json as boolean | undefined) ?? false;
		if (command === "doctor") {
			return { ok: true, command, options: { root, json } };
		}
		return {
			ok: true,
			command,
			options: {
				root,
				json,
				dryRun: (values["dry-run"] as boolean | undefined) ?? false,
				force: (values.force as boolean | undefined) ?? false,
			},
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : "Invalid arguments",
		};
	}
}

type CommandEnvelope = DoctorEnvelope | InstallEnvelope;

function renderHuman(envelope: CommandEnvelope): string {
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
	const result =
		command.command === "doctor"
			? await runDoctor(command.options.root)
			: await runInstall(command.options.root, {
					dryRun: command.options.dryRun,
					force: command.options.force,
				});
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
