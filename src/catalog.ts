import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	resolve,
} from "node:path";
import { stringify } from "yaml";
import {
	type CatalogDocument,
	type CatalogEntry,
	type CatalogRegistryDocument,
	type Diagnostic,
	type SourceReference,
	validateDocument,
} from "./contract.ts";
import { normalizeGitPath, normalizeGitRepository } from "./git.ts";
import { errorMessage, finish, isNotFound } from "./shared.ts";

export type CatalogCommand =
	| { name: "add"; path: string; catalogName?: string }
	| { name: "list" }
	| { name: "info"; selector: string }
	| { name: "search"; term: string; catalogName?: string }
	| { name: "remove"; selector: string };

export type CatalogRunOptions = {
	cwd?: string;
	profileRoot?: string;
};

export type CatalogAction = {
	type: "catalog";
	state: "registered" | "removed" | "match";
	name?: string;
	path?: string;
};

export type CatalogSummary = {
	name: string;
	path: string;
	valid: boolean;
	entries?: number;
};

export type CatalogInfo = {
	name?: string;
	path: string;
	entries: CatalogEntry[];
};

export type CatalogSearchResult = CatalogEntry & {
	catalog: string;
	path: string;
	identity: string;
};

export type CatalogEnvelope = {
	schemaVersion: 1;
	command: `catalog ${CatalogCommand["name"]}`;
	status: "ok" | "warning" | "error";
	changed: boolean;
	actions: CatalogAction[];
	diagnostics: Diagnostic[];
	catalogs?: CatalogSummary[];
	catalog?: CatalogInfo;
	results?: CatalogSearchResult[];
};

export type CatalogResult = {
	envelope: CatalogEnvelope;
	exitCode: 0 | 1;
	stderr: string;
};

class CatalogFailure extends Error {
	readonly code: string;
	readonly document?: string;
	readonly path?: string;

	constructor(
		code: string,
		message: string,
		context: { document?: string; path?: string } = {},
	) {
		super(message);
		this.name = "CatalogFailure";
		this.code = code;
		this.document = context.document;
		this.path = context.path;
	}
}

type LoadedCatalog = {
	path: string;
	document: CatalogDocument;
	identities: string[];
};

function profileRoot(options: CatalogRunOptions): string | undefined {
	return options.profileRoot ?? process.env.USERPROFILE ?? process.env.HOME;
}

function registryPath(root: string): string {
	return join(root, ".tbboot", "catalogs.yaml");
}

function pathKey(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function diagnostic(
	code: string,
	message: string,
	context: { document?: string; path?: string } = {},
): Diagnostic {
	return {
		code,
		severity: "error",
		message,
		...(context.document === undefined ? {} : { document: context.document }),
		...(context.path === undefined ? {} : { path: context.path }),
	};
}

function failureDiagnostic(error: unknown): Diagnostic {
	if (error instanceof CatalogFailure) {
		return diagnostic(error.code, error.message, {
			document: error.document,
			path: error.path,
		});
	}
	return diagnostic("catalog-read-failed", errorMessage(error));
}

function validated<T extends "catalog" | "catalog-registry">(
	kind: T,
	text: string,
	document: string,
): Extract<CatalogDocument | CatalogRegistryDocument, { schemaVersion: 1 }> {
	const result = validateDocument({ kind, text, document });
	if (result.value === undefined) {
		throw new CatalogFailure(
			kind === "catalog"
				? "catalog-validation-failed"
				: "catalog-registry-invalid",
			result.diagnostics.map(({ message }) => message).join("; "),
			{ document },
		);
	}
	return result.value as Extract<
		CatalogDocument | CatalogRegistryDocument,
		{ schemaVersion: 1 }
	>;
}

function validateRegistryIntegrity(document: CatalogRegistryDocument): void {
	const names = new Set<string>();
	const paths = new Set<string>();
	for (const entry of document.catalogs) {
		const name = entry.name.toLowerCase();
		if (names.has(name)) {
			throw new CatalogFailure(
				"catalog-name-duplicate",
				`Catalog name is duplicated: ${entry.name}`,
				{ document: ".tbboot/catalogs.yaml" },
			);
		}
		if (!isAbsolute(entry.path)) {
			throw new CatalogFailure(
				"catalog-registry-invalid",
				`Catalog path must be absolute: ${entry.path}`,
				{ document: ".tbboot/catalogs.yaml" },
			);
		}
		const path = pathKey(entry.path);
		if (paths.has(path)) {
			throw new CatalogFailure(
				"catalog-path-duplicate",
				`Catalog path is duplicated: ${entry.path}`,
				{ document: ".tbboot/catalogs.yaml" },
			);
		}
		names.add(name);
		paths.add(path);
	}
}

async function readRegistry(root: string): Promise<CatalogRegistryDocument> {
	const path = registryPath(root);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return { schemaVersion: 1, catalogs: [] };
		throw new CatalogFailure("catalog-registry-invalid", errorMessage(error), {
			document: ".tbboot/catalogs.yaml",
		});
	}
	const document = validated(
		"catalog-registry",
		text,
		".tbboot/catalogs.yaml",
	) as CatalogRegistryDocument;
	validateRegistryIntegrity(document);
	return document;
}

async function writeRegistry(
	root: string,
	document: CatalogRegistryDocument,
): Promise<void> {
	const directory = join(root, ".tbboot");
	const path = registryPath(root);
	const temporary = `${path}.tmp-${process.pid}`;
	await mkdir(directory, { recursive: true });
	await writeFile(temporary, stringify(document), "utf8");
	await rename(temporary, path);
}

async function canonicalPath(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

async function sourceIdentity(
	catalogPath: string,
	source: SourceReference,
): Promise<string> {
	const base = dirname(catalogPath);
	if (source.provider === "local") {
		const sourcePath = await canonicalPath(resolve(base, source.locator.path));
		return `local:${pathKey(sourcePath)}`;
	}
	const repository = normalizeGitRepository(base, source.locator.repository);
	const path = normalizeGitPath(source.locator.path) ?? "";
	return `git:${repository}|${path}`;
}

async function readCatalog(path: string): Promise<LoadedCatalog> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new CatalogFailure("catalog-read-failed", errorMessage(error), {
			document: path,
		});
	}
	const document = validated("catalog", text, path) as CatalogDocument;
	const identities: string[] = [];
	const seen = new Set<string>();
	for (const entry of document.entries) {
		let identity: string;
		try {
			identity = await sourceIdentity(path, entry.source);
		} catch (error) {
			throw new CatalogFailure(
				"catalog-validation-failed",
				errorMessage(error),
				{
					document: path,
				},
			);
		}
		if (seen.has(identity)) {
			throw new CatalogFailure(
				"catalog-entry-duplicate-source",
				`Source identity is duplicated in Catalog: ${identity}`,
				{ document: path },
			);
		}
		seen.add(identity);
		identities.push(identity);
	}
	return { path, document, identities };
}

function defaultName(path: string): string {
	return basename(path, extname(path));
}

async function resolveRegistered(
	document: CatalogRegistryDocument,
	selector: string,
	cwd: string,
): Promise<
	| { index: number; entry: CatalogRegistryDocument["catalogs"][number] }
	| undefined
> {
	const name = selector.toLowerCase();
	const byName = document.catalogs.findIndex(
		(entry) => entry.name.toLowerCase() === name,
	);
	if (byName !== -1)
		return {
			index: byName,
			entry: document.catalogs[
				byName
			] as CatalogRegistryDocument["catalogs"][number],
		};
	const candidate = pathKey(await canonicalPath(resolve(cwd, selector)));
	const byPath = document.catalogs.findIndex(
		(entry) => pathKey(entry.path) === candidate,
	);
	return byPath === -1
		? undefined
		: {
				index: byPath,
				entry: document.catalogs[
					byPath
				] as CatalogRegistryDocument["catalogs"][number],
			};
}

function baseEnvelope(name: CatalogCommand["name"]): CatalogEnvelope {
	return {
		schemaVersion: 1,
		command: `catalog ${name}`,
		status: "ok",
		changed: false,
		actions: [],
		diagnostics: [],
	};
}

async function runAdd(
	command: Extract<CatalogCommand, { name: "add" }>,
	options: CatalogRunOptions,
	envelope: CatalogEnvelope,
): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const root = profileRoot(options);
	if (root === undefined)
		throw new CatalogFailure(
			"catalog-profile-unavailable",
			"Unable to determine the user profile",
		);
	const registry = await readRegistry(root);
	const path = await realpath(resolve(cwd, command.path));
	const loaded = await readCatalog(path);
	const name = command.catalogName ?? defaultName(path);
	const nameKey = name.toLowerCase();
	if (registry.catalogs.some((entry) => entry.name.toLowerCase() === nameKey)) {
		throw new CatalogFailure(
			"catalog-name-duplicate",
			`Catalog name is duplicated: ${name}`,
		);
	}
	if (
		registry.catalogs.some((entry) => pathKey(entry.path) === pathKey(path))
	) {
		throw new CatalogFailure(
			"catalog-path-duplicate",
			`Catalog path is duplicated: ${path}`,
		);
	}
	registry.catalogs.push({ name, path });
	await writeRegistry(root, registry);
	envelope.changed = true;
	envelope.actions.push({
		type: "catalog",
		state: "registered",
		name,
		path: loaded.path,
	});
}

async function runList(
	options: CatalogRunOptions,
	envelope: CatalogEnvelope,
): Promise<void> {
	const root = profileRoot(options);
	if (root === undefined)
		throw new CatalogFailure(
			"catalog-profile-unavailable",
			"Unable to determine the user profile",
		);
	const registry = await readRegistry(root);
	const catalogs: CatalogSummary[] = [];
	for (const entry of registry.catalogs) {
		try {
			const loaded = await readCatalog(entry.path);
			catalogs.push({
				name: entry.name,
				path: entry.path,
				valid: true,
				entries: loaded.document.entries.length,
			});
		} catch (error) {
			envelope.diagnostics.push(failureDiagnostic(error));
			catalogs.push({ name: entry.name, path: entry.path, valid: false });
		}
	}
	envelope.catalogs = catalogs;
}

async function runInfo(
	command: Extract<CatalogCommand, { name: "info" }>,
	options: CatalogRunOptions,
	envelope: CatalogEnvelope,
): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const root = profileRoot(options);
	if (root === undefined)
		throw new CatalogFailure(
			"catalog-profile-unavailable",
			"Unable to determine the user profile",
		);
	const registry = await readRegistry(root);
	const registered = await resolveRegistered(registry, command.selector, cwd);
	const path =
		registered?.entry.path ?? (await realpath(resolve(cwd, command.selector)));
	const loaded = await readCatalog(path);
	envelope.catalog = {
		...(registered === undefined ? {} : { name: registered.entry.name }),
		path,
		entries: loaded.document.entries,
	};
}

async function runSearch(
	command: Extract<CatalogCommand, { name: "search" }>,
	options: CatalogRunOptions,
	envelope: CatalogEnvelope,
): Promise<void> {
	const root = profileRoot(options);
	if (root === undefined)
		throw new CatalogFailure(
			"catalog-profile-unavailable",
			"Unable to determine the user profile",
		);
	const registry = await readRegistry(root);
	const selected =
		command.catalogName === undefined
			? registry.catalogs
			: registry.catalogs.filter(
					(entry) =>
						entry.name.toLowerCase() === command.catalogName?.toLowerCase(),
				);
	if (command.catalogName !== undefined && selected.length === 0) {
		throw new CatalogFailure(
			"catalog-not-found",
			`Catalog not found: ${command.catalogName}`,
		);
	}
	const terms = command.term.trim().toLowerCase().split(/\s+/);
	const results: CatalogSearchResult[] = [];
	for (const entry of selected) {
		try {
			const loaded = await readCatalog(entry.path);
			for (const [index, catalogEntry] of loaded.document.entries.entries()) {
				const fields = [
					catalogEntry.title,
					catalogEntry.description,
					...catalogEntry.keywords,
				].map((value) => value.toLowerCase());
				if (
					!terms.every((term) => fields.some((field) => field.includes(term)))
				)
					continue;
				results.push({
					...catalogEntry,
					catalog: entry.name,
					path: entry.path,
					identity: loaded.identities[index] as string,
				});
			}
		} catch (error) {
			envelope.diagnostics.push(failureDiagnostic(error));
		}
	}
	if (envelope.diagnostics.length > 0) return;
	results.sort(
		(left, right) =>
			left.catalog.localeCompare(right.catalog) ||
			left.title.localeCompare(right.title) ||
			left.identity.localeCompare(right.identity),
	);
	envelope.results = results;
}

async function runRemove(
	command: Extract<CatalogCommand, { name: "remove" }>,
	options: CatalogRunOptions,
	envelope: CatalogEnvelope,
): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const root = profileRoot(options);
	if (root === undefined)
		throw new CatalogFailure(
			"catalog-profile-unavailable",
			"Unable to determine the user profile",
		);
	const registry = await readRegistry(root);
	const registered = await resolveRegistered(registry, command.selector, cwd);
	if (registered === undefined)
		throw new CatalogFailure(
			"catalog-not-found",
			`Catalog not found: ${command.selector}`,
		);
	registry.catalogs.splice(registered.index, 1);
	await writeRegistry(root, registry);
	envelope.changed = true;
	envelope.actions.push({
		type: "catalog",
		state: "removed",
		name: registered.entry.name,
		path: registered.entry.path,
	});
}

export async function runCatalog(
	command: CatalogCommand,
	options: CatalogRunOptions = {},
): Promise<CatalogResult> {
	const envelope = baseEnvelope(command.name);
	try {
		switch (command.name) {
			case "add":
				await runAdd(command, options, envelope);
				break;
			case "list":
				await runList(options, envelope);
				break;
			case "info":
				await runInfo(command, options, envelope);
				break;
			case "search":
				await runSearch(command, options, envelope);
				break;
			case "remove":
				await runRemove(command, options, envelope);
				break;
		}
	} catch (error) {
		envelope.diagnostics.push(failureDiagnostic(error));
	}
	return { ...finish(envelope), stderr: "" };
}
