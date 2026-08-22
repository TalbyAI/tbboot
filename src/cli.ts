#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { CatalogCommand, CatalogEnvelope } from "./catalog.ts";
import { type CatalogResult, runCatalog } from "./catalog.ts";
import type { DoctorEnvelope } from "./doctor.ts";
import { runDoctor } from "./doctor.ts";
import { isRepositoryUrl } from "./git.ts";
import type { InstallEnvelope } from "./install.ts";
import { runInstall, runUninstall, type UninstallEnvelope } from "./install.ts";

const usage = [
	"usage: tbboot doctor [--root <consumer-root>] [--allow-custom <source>] [--json]",
	"usage: tbboot install [--root <consumer-root>] [--dry-run] [--force] [--allow-custom <source>] [--update-lock|--frozen-lockfile] [--json]",
	"usage: tbboot uninstall [--root <consumer-root>] [--force] [--allow-custom <source>] [--json]",
	"usage: tbboot catalog add <path> [name] [--json]",
	"usage: tbboot catalog list [--json]",
	"usage: tbboot catalog info <name-or-path> [--json]",
	"usage: tbboot catalog search <term> [catalog-name] [--json]",
	"usage: tbboot catalog remove <name-or-path> [--json]",
].join("\n");

type ParseResult =
	| {
			ok: true;
			command: "doctor";
			options: { root: string; json: boolean; allowCustom: string[] };
	  }
	| {
			ok: true;
			command: "install";
			options: {
				root: string;
				json: boolean;
				dryRun: boolean;
				force: boolean;
				updateLock: boolean;
				frozenLockfile: boolean;
				allowCustom: string[];
			};
	  }
	| {
			ok: true;
			command: "uninstall";
			options: {
				root: string;
				json: boolean;
				force: boolean;
				allowCustom: string[];
			};
	  }
	| {
			ok: true;
			command: "catalog";
			options: { json: boolean; catalog: CatalogCommand };
	  }
	| { ok: false; message: string };

function parseCatalogCommand(args: string[]): ParseResult {
	const subcommand = args[0];
	if (
		subcommand !== "add" &&
		subcommand !== "list" &&
		subcommand !== "info" &&
		subcommand !== "search" &&
		subcommand !== "remove"
	) {
		return {
			ok: false,
			message:
				"Expected the catalog add, list, info, search, or remove command",
		};
	}
	try {
		const { values, positionals } = parseArgs({
			args: args.slice(1),
			options: { json: { type: "boolean" } },
			allowPositionals: true,
			strict: true,
		});
		const expected =
			subcommand === "list"
				? [0]
				: subcommand === "info" || subcommand === "remove"
					? [1]
					: [1, 2];
		if (
			!expected.includes(positionals.length) ||
			positionals.some((value) => value.length === 0) ||
			(subcommand === "search" && positionals[0]?.trim().length === 0)
		) {
			return {
				ok: false,
				message: `Invalid arguments for catalog ${subcommand}`,
			};
		}
		const catalog =
			subcommand === "add"
				? ({
						name: "add",
						path: positionals[0] as string,
						...(positionals[1] === undefined
							? {}
							: { catalogName: positionals[1] }),
					} satisfies CatalogCommand)
				: subcommand === "list"
					? ({ name: "list" } satisfies CatalogCommand)
					: subcommand === "info"
						? ({
								name: "info",
								selector: positionals[0] as string,
							} satisfies CatalogCommand)
						: subcommand === "search"
							? ({
									name: "search",
									term: positionals[0] as string,
									...(positionals[1] === undefined
										? {}
										: { catalogName: positionals[1] }),
								} satisfies CatalogCommand)
							: ({
									name: "remove",
									selector: positionals[0] as string,
								} satisfies CatalogCommand);
		return {
			ok: true,
			command: "catalog",
			options: { json: values.json === true, catalog },
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : "Invalid arguments",
		};
	}
}

function parseCommandLine(argv: string[], cwd: string): ParseResult {
	if (argv[0] === "catalog") return parseCatalogCommand(argv.slice(1));
	if (
		argv[0] !== "doctor" &&
		argv[0] !== "install" &&
		argv[0] !== "uninstall"
	) {
		return {
			ok: false,
			message: "Expected the doctor, install, or uninstall command",
		};
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
		const cliOptions: ParseArgsOptionsConfig = {
			root: { type: "string" },
			json: { type: "boolean" },
			"allow-custom": { type: "string", multiple: true },
			...(command === "doctor"
				? {}
				: {
						force: { type: "boolean" },
						...(command === "install"
							? {
									"dry-run": { type: "boolean" },
									"update-lock": { type: "boolean" },
									"frozen-lockfile": { type: "boolean" },
								}
							: {}),
					}),
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
			(command === "install" || command === "uninstall") &&
			tokens.filter(
				(token) => token.kind === "option" && token.name === "force",
			).length > 1
		) {
			return { ok: false, message: "--force may only be specified once" };
		}
		if (
			command === "install" &&
			tokens.filter(
				(token) => token.kind === "option" && token.name === "update-lock",
			).length > 1
		) {
			return { ok: false, message: "--update-lock may only be specified once" };
		}
		if (
			command === "install" &&
			tokens.filter(
				(token) => token.kind === "option" && token.name === "frozen-lockfile",
			).length > 1
		) {
			return {
				ok: false,
				message: "--frozen-lockfile may only be specified once",
			};
		}
		if (
			command === "install" &&
			values["update-lock"] === true &&
			values["frozen-lockfile"] === true
		) {
			return {
				ok: false,
				message: "--update-lock and --frozen-lockfile cannot be used together",
			};
		}
		const root = resolve(cwd, (values.root as string | undefined) ?? ".");
		const json = (values.json as boolean | undefined) ?? false;
		const allowCustom = (
			(values["allow-custom"] as string[] | undefined) ?? []
		).map((value) => (isRepositoryUrl(value) ? value : resolve(cwd, value)));
		if (command === "doctor") {
			return { ok: true, command, options: { root, json, allowCustom } };
		}
		if (command === "uninstall") {
			return {
				ok: true,
				command,
				options: {
					root,
					json,
					force: (values.force as boolean | undefined) ?? false,
					allowCustom,
				},
			};
		}
		return {
			ok: true,
			command,
			options: {
				root,
				json,
				dryRun: (values["dry-run"] as boolean | undefined) ?? false,
				force: (values.force as boolean | undefined) ?? false,
				updateLock: (values["update-lock"] as boolean | undefined) ?? false,
				frozenLockfile:
					(values["frozen-lockfile"] as boolean | undefined) ?? false,
				allowCustom,
			},
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : "Invalid arguments",
		};
	}
}

type CommandEnvelope =
	| DoctorEnvelope
	| InstallEnvelope
	| UninstallEnvelope
	| CatalogEnvelope;

function renderCatalogHuman(envelope: CatalogEnvelope): string {
	const lines = [`status: ${envelope.status}`];
	for (const action of envelope.actions) {
		lines.push(
			`${action.state}: ${action.name ?? ""}${action.path === undefined ? "" : ` ${action.path}`}`.trim(),
		);
	}
	for (const catalog of envelope.catalogs ?? []) {
		lines.push(
			`catalog: ${catalog.name} ${catalog.path} (${catalog.valid ? `${catalog.entries ?? 0} entries` : "invalid"})`,
		);
	}
	if (envelope.catalog !== undefined) {
		lines.push(
			`catalog: ${envelope.catalog.name ?? "unregistered"} ${envelope.catalog.path}`,
		);
		for (const entry of envelope.catalog.entries) {
			lines.push(`entry: ${entry.title} — ${entry.description}`);
		}
	}
	for (const result of envelope.results ?? []) {
		lines.push(
			`match: ${result.catalog} ${result.title} — ${result.description}`,
		);
	}
	for (const diagnostic of envelope.diagnostics) {
		lines.push(
			`${diagnostic.severity}: ${diagnostic.code}${diagnostic.path === undefined ? "" : ` [${diagnostic.path}]`}: ${diagnostic.message}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function isCatalogEnvelope(
	envelope: CommandEnvelope,
): envelope is CatalogEnvelope {
	return envelope.command.startsWith("catalog ");
}

function renderHuman(envelope: CommandEnvelope): string {
	if (isCatalogEnvelope(envelope)) {
		return renderCatalogHuman(envelope);
	}
	const lines = [`status: ${envelope.status}`];
	for (const action of envelope.actions) {
		lines.push(
			`${action.state}: ${action.type}${action.target === undefined ? "" : ` ${action.target}`} (${action.source}/${action.recipe} step ${action.step})`,
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
	const controller = new AbortController();
	const cancel = (): void => controller.abort();
	process.once("SIGINT", cancel);
	let result:
		| Awaited<ReturnType<typeof runDoctor>>
		| Awaited<ReturnType<typeof runInstall>>
		| Awaited<ReturnType<typeof runUninstall>>
		| CatalogResult;
	try {
		result =
			command.command === "catalog"
				? await runCatalog(command.options.catalog)
				: command.command === "doctor"
					? await runDoctor(command.options.root, {
							allowCustom: command.options.allowCustom,
							signal: controller.signal,
						})
					: command.command === "install"
						? await runInstall(command.options.root, {
								dryRun: command.options.dryRun,
								force: command.options.force,
								updateLock: command.options.updateLock,
								frozenLockfile: command.options.frozenLockfile,
								allowCustom: command.options.allowCustom,
								signal: controller.signal,
							})
						: await runUninstall(command.options.root, {
								force: command.options.force,
								allowCustom: command.options.allowCustom,
								signal: controller.signal,
							});
	} finally {
		process.removeListener("SIGINT", cancel);
	}
	if (result.stderr) process.stderr.write(result.stderr);
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
