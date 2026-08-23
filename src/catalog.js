import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, } from "node:path";
import { stringify } from "yaml";
import { validateDocument, } from "./contract.js";
import { isRepositoryUrl, normalizeGitPath, normalizeGitRepository, } from "./git.js";
import { errorMessage, finish, isNotFound } from "./shared.js";
class CatalogFailure extends Error {
    code;
    document;
    path;
    constructor(code, message, context = {}) {
        super(message);
        this.name = "CatalogFailure";
        this.code = code;
        this.document = context.document;
        this.path = context.path;
    }
}
function profileRoot(options) {
    return options.profileRoot ?? process.env.USERPROFILE ?? process.env.HOME;
}
function registryPath(root) {
    return join(root, ".tbboot", "catalogs.yaml");
}
function pathKey(value) {
    return process.platform === "win32" ? value.toLowerCase() : value;
}
function diagnostic(code, message, context = {}) {
    return {
        code,
        severity: "error",
        message,
        ...(context.document === undefined ? {} : { document: context.document }),
        ...(context.path === undefined ? {} : { path: context.path }),
    };
}
function failureDiagnostic(error) {
    if (error instanceof CatalogFailure) {
        return diagnostic(error.code, error.message, {
            document: error.document,
            path: error.path,
        });
    }
    return diagnostic("catalog-read-failed", errorMessage(error));
}
function validated(kind, text, document) {
    const result = validateDocument({ kind, text, document });
    if (result.value === undefined) {
        throw new CatalogFailure(kind === "catalog"
            ? "catalog-validation-failed"
            : "catalog-registry-invalid", result.diagnostics.map(({ message }) => message).join("; "), { document });
    }
    return result.value;
}
async function validateRegistryIntegrity(document) {
    const names = new Set();
    const paths = new Set();
    for (const entry of document.catalogs) {
        const name = entry.name.toLowerCase();
        if (names.has(name)) {
            throw new CatalogFailure("catalog-name-duplicate", `Catalog name is duplicated: ${entry.name}`, { document: ".tbboot/catalogs.yaml" });
        }
        if (!isAbsolute(entry.path)) {
            throw new CatalogFailure("catalog-registry-invalid", `Catalog path must be absolute: ${entry.path}`, { document: ".tbboot/catalogs.yaml" });
        }
        const path = pathKey(await canonicalPath(entry.path));
        if (paths.has(path)) {
            throw new CatalogFailure("catalog-path-duplicate", `Catalog path is duplicated: ${entry.path}`, { document: ".tbboot/catalogs.yaml" });
        }
        names.add(name);
        paths.add(path);
    }
}
async function readRegistry(root) {
    const path = registryPath(root);
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (error) {
        if (isNotFound(error))
            return { schemaVersion: 1, catalogs: [] };
        throw new CatalogFailure("catalog-registry-invalid", errorMessage(error), {
            document: ".tbboot/catalogs.yaml",
        });
    }
    const document = validated("catalog-registry", text, ".tbboot/catalogs.yaml");
    await validateRegistryIntegrity(document);
    return document;
}
async function writeRegistry(root, document) {
    const directory = join(root, ".tbboot");
    const path = registryPath(root);
    const temporary = `${path}.tmp-${process.pid}`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, stringify(document), "utf8");
    await rename(temporary, path);
}
async function canonicalPath(path) {
    return realpath(path).catch(() => resolve(path));
}
async function sourceIdentity(catalogPath, source) {
    const base = dirname(catalogPath);
    if (source.provider === "local") {
        const sourcePath = await canonicalPath(resolve(base, source.locator.path));
        return `local:${pathKey(sourcePath)}`;
    }
    const repository = normalizeGitRepository(base, source.locator.repository);
    const path = normalizeGitPath(source.locator.path) ?? "";
    const repositoryKey = repository.toLowerCase().startsWith("file://") ||
        !isRepositoryUrl(repository)
        ? pathKey(repository)
        : repository;
    return `git:${repositoryKey}|${pathKey(path)}`;
}
async function readCatalog(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (error) {
        throw new CatalogFailure("catalog-read-failed", errorMessage(error), {
            document: path,
        });
    }
    const document = validated("catalog", text, path);
    const identities = [];
    const seen = new Set();
    for (const entry of document.entries) {
        let identity;
        try {
            identity = await sourceIdentity(path, entry.source);
        }
        catch (error) {
            throw new CatalogFailure("catalog-validation-failed", errorMessage(error), {
                document: path,
            });
        }
        if (seen.has(identity)) {
            throw new CatalogFailure("catalog-entry-duplicate-source", `Source identity is duplicated in Catalog: ${identity}`, { document: path });
        }
        seen.add(identity);
        identities.push(identity);
    }
    return { path, document, identities };
}
function defaultName(path) {
    return basename(path, extname(path));
}
async function resolveRegistered(document, selector, cwd) {
    const name = selector.toLowerCase();
    const byName = document.catalogs.findIndex((entry) => entry.name.toLowerCase() === name);
    if (byName !== -1)
        return {
            index: byName,
            entry: document.catalogs[byName],
        };
    const candidate = pathKey(await canonicalPath(resolve(cwd, selector)));
    const canonical = await Promise.all(document.catalogs.map(async (entry) => pathKey(await canonicalPath(entry.path))));
    const byPath = canonical.indexOf(candidate);
    return byPath === -1
        ? undefined
        : {
            index: byPath,
            entry: document.catalogs[byPath],
        };
}
function baseEnvelope(name) {
    return {
        schemaVersion: 1,
        command: `catalog ${name}`,
        status: "ok",
        changed: false,
        actions: [],
        diagnostics: [],
    };
}
function compareText(left, right) {
    const leftKey = left.toLowerCase();
    const rightKey = right.toLowerCase();
    return leftKey < rightKey
        ? -1
        : leftKey > rightKey
            ? 1
            : left < right
                ? -1
                : left > right
                    ? 1
                    : 0;
}
async function runAdd(command, options, envelope) {
    const cwd = options.cwd ?? process.cwd();
    const root = profileRoot(options);
    if (root === undefined)
        throw new CatalogFailure("catalog-profile-unavailable", "Unable to determine the user profile");
    const registry = await readRegistry(root);
    let path;
    try {
        path = await realpath(resolve(cwd, command.path));
    }
    catch (error) {
        if (isNotFound(error)) {
            throw new CatalogFailure("catalog-not-found", `Catalog not found: ${command.path}`);
        }
        throw error;
    }
    const loaded = await readCatalog(path);
    const name = command.catalogName ?? defaultName(path);
    const nameKey = name.toLowerCase();
    if (registry.catalogs.some((entry) => entry.name.toLowerCase() === nameKey)) {
        throw new CatalogFailure("catalog-name-duplicate", `Catalog name is duplicated: ${name}`);
    }
    if ((await Promise.all(registry.catalogs.map((entry) => canonicalPath(entry.path)))).some((entryPath) => pathKey(entryPath) === pathKey(path))) {
        throw new CatalogFailure("catalog-path-duplicate", `Catalog path is duplicated: ${path}`);
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
async function runList(options, envelope) {
    const root = profileRoot(options);
    if (root === undefined)
        throw new CatalogFailure("catalog-profile-unavailable", "Unable to determine the user profile");
    const registry = await readRegistry(root);
    const catalogs = [];
    for (const entry of registry.catalogs) {
        try {
            const loaded = await readCatalog(entry.path);
            catalogs.push({
                name: entry.name,
                path: entry.path,
                valid: true,
                entries: loaded.document.entries.length,
            });
        }
        catch (error) {
            envelope.diagnostics.push(failureDiagnostic(error));
            catalogs.push({ name: entry.name, path: entry.path, valid: false });
        }
    }
    envelope.catalogs = catalogs;
}
async function runInfo(command, options, envelope) {
    const cwd = options.cwd ?? process.cwd();
    const root = profileRoot(options);
    if (root === undefined)
        throw new CatalogFailure("catalog-profile-unavailable", "Unable to determine the user profile");
    const registry = await readRegistry(root);
    const registered = await resolveRegistered(registry, command.selector, cwd);
    let path;
    if (registered !== undefined) {
        path = registered.entry.path;
    }
    else {
        try {
            path = await realpath(resolve(cwd, command.selector));
        }
        catch (error) {
            if (isNotFound(error)) {
                throw new CatalogFailure("catalog-not-found", `Catalog not found: ${command.selector}`);
            }
            throw error;
        }
    }
    const loaded = await readCatalog(path);
    envelope.catalog = {
        ...(registered === undefined ? {} : { name: registered.entry.name }),
        path,
        entries: loaded.document.entries,
    };
}
async function runSearch(command, options, envelope) {
    const root = profileRoot(options);
    if (root === undefined)
        throw new CatalogFailure("catalog-profile-unavailable", "Unable to determine the user profile");
    const registry = await readRegistry(root);
    const selected = command.catalogName === undefined
        ? registry.catalogs
        : registry.catalogs.filter((entry) => entry.name.toLowerCase() === command.catalogName?.toLowerCase());
    if (command.catalogName !== undefined && selected.length === 0) {
        throw new CatalogFailure("catalog-not-found", `Catalog not found: ${command.catalogName}`);
    }
    const normalizedTerm = command.term.trim().toLowerCase();
    if (normalizedTerm.length === 0) {
        throw new CatalogFailure("catalog-not-found", "Search term must not be empty");
    }
    const terms = normalizedTerm.split(/\s+/);
    const results = [];
    for (const entry of selected) {
        try {
            const loaded = await readCatalog(entry.path);
            for (const [index, catalogEntry] of loaded.document.entries.entries()) {
                const fields = [
                    catalogEntry.title,
                    catalogEntry.description,
                    ...catalogEntry.keywords,
                ].map((value) => value.toLowerCase());
                if (!terms.every((term) => fields.some((field) => field.includes(term))))
                    continue;
                results.push({
                    ...catalogEntry,
                    catalog: entry.name,
                    path: entry.path,
                    identity: loaded.identities[index],
                });
            }
        }
        catch (error) {
            envelope.diagnostics.push(failureDiagnostic(error));
        }
    }
    if (envelope.diagnostics.length > 0) {
        envelope.results = [];
        return;
    }
    results.sort((left, right) => compareText(left.catalog, right.catalog) ||
        compareText(left.title, right.title) ||
        compareText(left.identity, right.identity));
    envelope.results = results;
}
async function runRemove(command, options, envelope) {
    const cwd = options.cwd ?? process.cwd();
    const root = profileRoot(options);
    if (root === undefined)
        throw new CatalogFailure("catalog-profile-unavailable", "Unable to determine the user profile");
    const registry = await readRegistry(root);
    const registered = await resolveRegistered(registry, command.selector, cwd);
    if (registered === undefined)
        throw new CatalogFailure("catalog-not-found", `Catalog not found: ${command.selector}`);
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
export async function runCatalog(command, options = {}) {
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
    }
    catch (error) {
        envelope.diagnostics.push(failureDiagnostic(error));
    }
    return { ...finish(envelope), stderr: "" };
}
