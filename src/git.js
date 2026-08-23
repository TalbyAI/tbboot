import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { isInside } from "./shared.js";
export class GitSourceError extends Error {
    code;
    details;
    name = "GitSourceError";
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
    }
}
function gitErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function commandCode(error) {
    return error !== null && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
}
export function isRepositoryUrl(value) {
    return (/^[A-Za-z][A-Za-z+.-]*:\/\//.test(value) ||
        /^[^/\s@]+@[^:/\s]+:.+/.test(value));
}
export function normalizeGitRepository(consumerRoot, repository) {
    return isRepositoryUrl(repository)
        ? repository
        : resolve(consumerRoot, repository);
}
export function normalizeGitPath(path) {
    if (path === undefined)
        return undefined;
    const normalized = path.replaceAll("\\", "/");
    if (normalized.length === 0 ||
        isAbsolute(normalized) ||
        normalized === "~" ||
        normalized.startsWith("~/") ||
        normalized.split("/").some((part) => part === "..") ||
        /[?*[\]{}]/.test(normalized)) {
        throw new GitSourceError("git-path-invalid", `Invalid Git Source path: ${path}`, { path });
    }
    const canonical = posix.normalize(normalized);
    return canonical === "." ? undefined : canonical;
}
async function cloneRepository(repository) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "tbboot-git-repository-"));
    const checkout = join(temporaryRoot, "repository");
    try {
        await runGit([
            "-c",
            "core.autocrlf=false",
            "clone",
            "--quiet",
            "--no-checkout",
            repository,
            checkout,
        ]);
        await runGit(["config", "core.autocrlf", "false"], checkout);
        let cleaned = false;
        return {
            root: checkout,
            cleanup: async () => {
                if (cleaned)
                    return;
                cleaned = true;
                await rm(temporaryRoot, { recursive: true, force: true });
            },
        };
    }
    catch (error) {
        await rm(temporaryRoot, { recursive: true, force: true });
        throw new GitSourceError("git-repository-read", `Unable to clone Git repository: ${gitErrorMessage(error)}`, { repository });
    }
}
function runGit(args, cwd) {
    return new Promise((resolveOutput, reject) => {
        execFile("git", args, {
            cwd,
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024,
            encoding: "buffer",
            timeout: 120_000,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: "0",
                GIT_ASKPASS: "echo",
            },
        }, (error, stdout) => {
            if (error) {
                const gitError = error;
                gitError.stdout = stdout;
                reject(gitError);
                return;
            }
            resolveOutput(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        });
    });
}
async function gitAt(repositoryRoot, args) {
    try {
        return await runGit(args, repositoryRoot);
    }
    catch (error) {
        throw new GitSourceError("git-repository-read", `Unable to read Git repository: ${gitErrorMessage(error)}`, { repository: repositoryRoot, cause: error });
    }
}
async function refExists(repositoryRoot, ref) {
    try {
        await gitAt(repositoryRoot, ["show-ref", "--verify", "--quiet", ref]);
        return true;
    }
    catch (error) {
        if (error instanceof GitSourceError) {
            const cause = error.details.cause;
            if (cause !== undefined && commandCode(cause) === 1)
                return false;
        }
        throw error;
    }
}
async function refRevision(repositoryRoot, ref) {
    try {
        return (await gitAt(repositoryRoot, ["rev-parse", "--verify", `${ref}^{commit}`]))
            .toString("utf8")
            .trim();
    }
    catch (error) {
        throw new GitSourceError("git-repository-read", `Unable to resolve Git ref ${ref}: ${gitErrorMessage(error)}`, { ref });
    }
}
function refNames(name) {
    if (name.length === 0 || name.includes("\0")) {
        throw new GitSourceError("git-ref-not-found", "Git ref must be non-empty", {
            name,
        });
    }
    if (name.startsWith("refs/tags/") || name.startsWith("refs/heads/")) {
        return [name];
    }
    if (name.startsWith("refs/"))
        return [];
    return [`refs/tags/${name}`, `refs/heads/${name}`];
}
async function resolveRef(repositoryRoot, name) {
    let refs = [];
    for (const ref of refNames(name)) {
        if (await refExists(repositoryRoot, ref))
            refs.push(ref);
    }
    if (refs.length === 0 &&
        (name.startsWith("refs/heads/") || !name.startsWith("refs/"))) {
        const branchName = name.startsWith("refs/heads/")
            ? name.slice("refs/heads/".length)
            : name;
        const remoteRefs = (await gitAt(repositoryRoot, [
            "for-each-ref",
            "--format=%(refname)",
            "refs/remotes",
        ]))
            .toString("utf8")
            .split("\n")
            .filter(Boolean);
        const remotePrefix = "refs/remotes/";
        refs = remoteRefs.filter((ref) => {
            if (!ref.startsWith(remotePrefix))
                return false;
            const remoteAndBranch = ref.slice(remotePrefix.length);
            const separator = remoteAndBranch.indexOf("/");
            return (separator > 0 && remoteAndBranch.slice(separator + 1) === branchName);
        });
    }
    if (refs.length === 0) {
        throw new GitSourceError("git-ref-not-found", `Git ref not found: ${name}`, {
            name,
        });
    }
    if (refs.length > 1) {
        throw new GitSourceError("git-ref-ambiguous", `Git ref is ambiguous: ${name}`, {
            name,
            refs,
        });
    }
    return { revision: await refRevision(repositoryRoot, refs[0]), ref: refs[0] };
}
async function isAncestor(repositoryRoot, ancestor, descendant) {
    try {
        await gitAt(repositoryRoot, [
            "merge-base",
            "--is-ancestor",
            ancestor,
            descendant,
        ]);
        return true;
    }
    catch (error) {
        if (error instanceof GitSourceError) {
            const cause = error.details.cause;
            if (cause !== undefined && commandCode(cause) === 1)
                return false;
        }
        throw error;
    }
}
async function candidateRevisions(repositoryRoot) {
    const output = await gitAt(repositoryRoot, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
        "refs/tags",
        "refs/remotes",
    ]);
    const byRevision = new Map();
    for (const ref of output.toString("utf8").split("\n").filter(Boolean)) {
        const revision = await refRevision(repositoryRoot, ref);
        byRevision.set(revision, [...(byRevision.get(revision) ?? []), ref]);
    }
    return [...byRevision.entries()].map(([revision, refs]) => ({
        revision,
        refs,
    }));
}
async function selectorCandidates(repositoryRoot, selector) {
    if ("ref" in selector) {
        const resolved = await resolveRef(repositoryRoot, selector.ref);
        return [{ revision: resolved.revision, refs: [resolved.ref] }];
    }
    const lower = await resolveRef(repositoryRoot, selector.from);
    const upper = await resolveRef(repositoryRoot, selector.to);
    if (!(await isAncestor(repositoryRoot, lower.revision, upper.revision))) {
        throw new GitSourceError("git-range-invalid", "Range lower bound is not an ancestor of its upper bound", { from: selector.from, to: selector.to });
    }
    const candidates = await candidateRevisions(repositoryRoot);
    const result = [];
    for (const candidate of candidates) {
        if ((await isAncestor(repositoryRoot, lower.revision, candidate.revision)) &&
            (await isAncestor(repositoryRoot, candidate.revision, upper.revision))) {
            result.push(candidate);
        }
    }
    return result;
}
async function revisionSatisfiesSelectorLocal(repositoryRoot, selector, revision) {
    if ("ref" in selector) {
        return ((await resolveRef(repositoryRoot, selector.ref)).revision === revision);
    }
    const lower = await resolveRef(repositoryRoot, selector.from);
    const upper = await resolveRef(repositoryRoot, selector.to);
    if (!(await isAncestor(repositoryRoot, lower.revision, upper.revision))) {
        throw new GitSourceError("git-range-invalid", "Range lower bound is not an ancestor of its upper bound", { from: selector.from, to: selector.to });
    }
    return ((await isAncestor(repositoryRoot, lower.revision, revision)) &&
        (await isAncestor(repositoryRoot, revision, upper.revision)));
}
function assertGitObjectName(revision) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
        throw new GitSourceError("git-repository-read", `Git revision is not a full Git object name: ${revision}`, { revision });
    }
}
export async function isGitRevisionAllowed(repositoryRoot, selector, revision) {
    assertGitObjectName(revision);
    if (!isRepositoryUrl(repositoryRoot)) {
        return revisionSatisfiesSelectorLocal(repositoryRoot, selector, revision);
    }
    const temporary = await cloneRepository(repositoryRoot);
    try {
        return await revisionSatisfiesSelectorLocal(temporary.root, selector, revision);
    }
    finally {
        await temporary.cleanup();
    }
}
async function chooseCandidate(repositoryRoot, candidates) {
    if (candidates.length === 0) {
        throw new GitSourceError("git-selector-incompatible", "Selector has no candidate revision");
    }
    const maxima = [];
    for (const candidate of candidates) {
        let hasDescendant = false;
        for (const other of candidates) {
            if (candidate.revision !== other.revision &&
                (await isAncestor(repositoryRoot, candidate.revision, other.revision))) {
                hasDescendant = true;
                break;
            }
        }
        if (!hasDescendant)
            maxima.push(candidate);
    }
    if (maxima.length > 1) {
        throw new GitSourceError("git-selector-ambiguous", "Selector has incomparable maximal revisions", { revisions: maxima.map(({ revision }) => revision) });
    }
    return maxima[0];
}
async function resolveGitSelectorLocal(repositoryRoot, selectors) {
    if (selectors.length === 0) {
        throw new GitSourceError("git-selector-incompatible", "At least one Git selector is required");
    }
    let common = await selectorCandidates(repositoryRoot, selectors[0]);
    for (const selector of selectors.slice(1)) {
        const allowed = new Set((await selectorCandidates(repositoryRoot, selector)).map(({ revision }) => revision));
        common = common.filter(({ revision }) => allowed.has(revision));
    }
    return chooseCandidate(repositoryRoot, common);
}
export async function resolveGitSelector(repositoryRoot, selectors) {
    if (!isRepositoryUrl(repositoryRoot)) {
        return resolveGitSelectorLocal(repositoryRoot, selectors);
    }
    const temporary = await cloneRepository(repositoryRoot);
    try {
        return await resolveGitSelectorLocal(temporary.root, selectors);
    }
    finally {
        await temporary.cleanup();
    }
}
export async function resolveGitHead(repositoryRoot) {
    if (isRepositoryUrl(repositoryRoot)) {
        const temporary = await cloneRepository(repositoryRoot);
        try {
            return await resolveGitHead(temporary.root);
        }
        finally {
            await temporary.cleanup();
        }
    }
    try {
        return (await gitAt(repositoryRoot, ["rev-parse", "--verify", "HEAD"]))
            .toString("utf8")
            .trim();
    }
    catch (error) {
        if (error instanceof GitSourceError)
            throw error;
        throw new GitSourceError("git-repository-read", `Unable to resolve Git HEAD: ${gitErrorMessage(error)}`, { repository: repositoryRoot });
    }
}
function sourcePath(repositoryRoot, path) {
    const normalized = normalizeGitPath(path);
    return normalized === undefined
        ? repositoryRoot
        : join(repositoryRoot, ...normalized.split("/"));
}
async function repositoryPath(consumerRoot, repository) {
    const normalized = normalizeGitRepository(consumerRoot, repository);
    if (isRepositoryUrl(normalized))
        return normalized;
    return realpath(normalized);
}
export async function materializeGitSource(consumerRoot, reference, revision) {
    let temporary;
    try {
        assertGitObjectName(revision);
        const repository = await repositoryPath(consumerRoot, reference.locator.repository);
        temporary = await cloneRepository(repository);
        const checkout = temporary.root;
        await runGit(["checkout", "--quiet", "--detach", revision], checkout);
        const checkoutRoot = await realpath(checkout);
        let selectedRoot;
        try {
            selectedRoot = await realpath(sourcePath(checkoutRoot, reference.locator.path));
        }
        catch {
            throw new GitSourceError("git-source-missing", `Git Source path is missing: ${reference.locator.path ?? "."}`, { path: reference.locator.path });
        }
        if (!isInside(checkoutRoot, selectedRoot)) {
            throw new GitSourceError("git-path-invalid", `Git Source path escapes the repository: ${reference.locator.path ?? "."}`, { path: reference.locator.path });
        }
        if (!(await stat(selectedRoot)).isDirectory()) {
            throw new GitSourceError("git-source-missing", "Git Source path is not a directory", { path: reference.locator.path });
        }
        let sourceYaml;
        try {
            sourceYaml = await realpath(join(selectedRoot, "source.yaml"));
        }
        catch {
            throw new GitSourceError("git-source-missing", "Git Source is missing source.yaml", { path: reference.locator.path });
        }
        if (!isInside(selectedRoot, sourceYaml)) {
            throw new GitSourceError("git-path-invalid", "Git Source source.yaml escapes the selected path", { path: reference.locator.path });
        }
        await readFile(sourceYaml);
        const treePath = normalizeGitPath(reference.locator.path) ?? ".";
        const listing = await runGit(["ls-tree", "-r", "-z", revision, "--", treePath], checkout);
        const fingerprint = createHash("sha256").update(listing).digest("hex");
        return {
            source: reference,
            sourceRoot: selectedRoot,
            revision,
            fingerprint,
            cleanup: temporary.cleanup,
        };
    }
    catch (error) {
        await temporary?.cleanup();
        if (error instanceof GitSourceError)
            throw error;
        throw new GitSourceError("git-repository-read", `Unable to materialize Git Source: ${gitErrorMessage(error)}`, { repository: reference.locator.repository });
    }
}
