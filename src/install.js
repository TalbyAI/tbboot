import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile, } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { validateDocument } from "./contract.js";
import { sourceFingerprint as calculateSourceFingerprint, isCancellation, prepareCustomStep, runPreparedOperation, } from "./custom.js";
import { inspectManagedBlock, planLocalInstall, scanManagedBlock, } from "./doctor.js";
import { materializeGitSource, normalizeGitPath, normalizeGitRepository, } from "./git.js";
import { errorMessage, finish, isInside, isNotFound, normalizeNewlines, } from "./shared.js";
function envelopeFromPlan(plan) {
    return {
        schemaVersion: 1,
        command: "install",
        status: "ok",
        changed: false,
        actions: plan.actions,
        diagnostics: plan.diagnostics,
    };
}
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function fragmentBlock(input, marker) {
    const body = normalizeNewlines(input.toString("utf8"));
    const start = `<!-- managed-by: ${marker} -->`;
    const end = `<!-- end-managed-by: ${marker} -->`;
    return Buffer.from(`${start}\n${body}${body.endsWith("\n") ? "" : "\n"}${end}`);
}
function appendFragment(target, block) {
    if (target === undefined || target.length === 0) {
        return Buffer.concat([block, Buffer.from("\n")]);
    }
    const endsWith = (suffix) => target.subarray(-Buffer.byteLength(suffix)).equals(Buffer.from(suffix));
    const separator = endsWith("\n\n") || endsWith("\r\n\r\n")
        ? ""
        : endsWith("\n") || endsWith("\r\n")
            ? "\n"
            : "\n\n";
    return Buffer.concat([
        target,
        Buffer.from(separator),
        block,
        Buffer.from("\n"),
    ]);
}
function replaceFragment(target, block, marker) {
    const range = scanManagedBlock(target, marker).range;
    if (range === undefined)
        return target;
    return Buffer.concat([
        target.subarray(0, range.start),
        block,
        target.subarray(range.end),
    ]);
}
function stateKey(consumerRoot, effect) {
    const source = effect.source.provider === "local"
        ? `local:${resolve(consumerRoot, effect.source.locator.path)}`
        : `git:${normalizeGitRepository(consumerRoot, effect.source.locator.repository)}|${normalizeGitPath(effect.source.locator.path) ?? ""}`;
    return JSON.stringify([
        source,
        effect.recipe,
        effect.step,
        effect.type,
        "target" in effect ? effect.target : "",
        effect.marker ?? "",
    ]);
}
function addDiagnostic(diagnostics, code, message, context = {}, severity = "error") {
    diagnostics.push({
        code,
        severity,
        message,
        ...(context.source === undefined ? {} : { source: context.source }),
        ...(context.recipe === undefined ? {} : { recipe: context.recipe }),
        ...(context.step === undefined ? {} : { step: context.step }),
    });
}
async function readState(root, diagnostics) {
    const path = join(root, ".tbboot", "state.yaml");
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (error) {
        if (isNotFound(error))
            return { schemaVersion: 1, effects: [] };
        addDiagnostic(diagnostics, "state-read", `Unable to read ${path}: ${errorMessage(error)}`);
        return undefined;
    }
    const result = validateDocument({
        kind: "state",
        text,
        document: ".tbboot/state.yaml",
    });
    diagnostics.push(...result.diagnostics);
    return result.value;
}
function effectFor(artifact, consumerRoot, content, existing) {
    const source = artifact.source;
    const target = relative(consumerRoot, artifact.targetPath)
        .split(sep)
        .join("/");
    if (artifact.type === "file") {
        return {
            source,
            ...(artifact.revision === undefined
                ? {}
                : { revision: artifact.revision }),
            sourceFingerprint: sha256(artifact.input),
            recipe: artifact.recipe,
            step: artifact.step,
            type: "file",
            target,
            artifactFingerprint: sha256(content),
            created: existing?.type === "file" && existing.created
                ? true
                : artifact.targetBefore === undefined,
        };
    }
    return {
        source,
        ...(artifact.revision === undefined ? {} : { revision: artifact.revision }),
        sourceFingerprint: sha256(artifact.input),
        recipe: artifact.recipe,
        step: artifact.step,
        type: "file-fragment",
        target,
        marker: artifact.marker,
        artifactFingerprint: sha256(content),
    };
}
function customEffect(step) {
    return {
        source: step.source,
        ...(step.revision === undefined ? {} : { revision: step.revision }),
        sourceFingerprint: step.prepared.context.sourceFingerprint,
        recipe: step.recipe,
        step: step.step,
        type: "custom",
        uninstallSupported: step.prepared.uninstallSupported,
    };
}
function sameEffect(left, right) {
    if (left === undefined)
        return false;
    const withoutSequence = (effect) => {
        const { sequence: _sequence, ...rest } = effect;
        return rest;
    };
    return (JSON.stringify(withoutSequence(left)) ===
        JSON.stringify(withoutSequence(right)));
}
function nextSequence(state) {
    let max = state.effects.length;
    for (const effect of state.effects) {
        if (effect.sequence !== undefined)
            max = Math.max(max, effect.sequence);
    }
    return max + 1;
}
async function persistState(root, state) {
    const stateDirectory = join(root, ".tbboot");
    const statePath = join(stateDirectory, "state.yaml");
    const nextState = stringify(state);
    let previousState;
    try {
        previousState = await readFile(statePath, "utf8");
    }
    catch (error) {
        if (!isNotFound(error))
            throw error;
    }
    await mkdir(stateDirectory, { recursive: true });
    let changed = previousState !== nextState;
    if (changed) {
        const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryPath, nextState, "utf8");
            await rename(temporaryPath, statePath);
        }
        finally {
            await unlink(temporaryPath).catch(() => undefined);
        }
    }
    const gitignorePath = join(stateDirectory, ".gitignore");
    let gitignore = "";
    try {
        gitignore = await readFile(gitignorePath, "utf8");
    }
    catch (error) {
        if (!isNotFound(error))
            throw error;
    }
    const entries = gitignore.length === 0 ? [] : gitignore.split(/\r\n|\n|\r/);
    while (entries.at(-1) === "")
        entries.pop();
    if (!entries.includes("/state.yaml")) {
        entries.push("/state.yaml");
        await writeFile(gitignorePath, `${entries.join("\n")}\n`, "utf8");
        changed = true;
    }
    return changed;
}
async function persistLockfile(root, document) {
    const path = join(root, "tbboot.lock.yaml");
    const next = stringify(document);
    let previous;
    try {
        previous = await readFile(path, "utf8");
    }
    catch (error) {
        if (!isNotFound(error))
            throw error;
    }
    if (previous === next)
        return false;
    await writeFile(path, next, "utf8");
    return true;
}
async function applyArtifact(artifact, force, workingTargets) {
    const current = workingTargets.has(artifact.targetPath)
        ? workingTargets.get(artifact.targetPath)
        : artifact.targetBefore;
    let content = current ?? Buffer.alloc(0);
    let artifactBytes = artifact.input;
    if (artifact.type === "file") {
        content = artifact.input;
    }
    else {
        const block = fragmentBlock(artifact.input, artifact.marker);
        artifactBytes = block;
        content =
            artifact.action.state === "drift" && force
                ? replaceFragment(current, block, artifact.marker)
                : artifact.action.state === "satisfied"
                    ? current
                    : appendFragment(current, block);
    }
    workingTargets.set(artifact.targetPath, content);
    return {
        content,
        artifactBytes,
        wrote: !content.equals(current ?? Buffer.alloc(0)),
    };
}
export async function runInstall(root, options) {
    if (options.signal?.aborted) {
        return {
            envelope: {
                schemaVersion: 1,
                command: "install",
                status: "ok",
                changed: false,
                actions: [],
                diagnostics: [],
            },
            exitCode: 130,
        };
    }
    const lockMode = options.frozenLockfile
        ? "frozen"
        : options.updateLock
            ? "update"
            : "normal";
    const plan = await planLocalInstall(root, options.force, lockMode, {
        allowCustom: options.allowCustom,
        profileRoot: options.profileRoot,
        interactive: !options.dryRun && process.stdin.isTTY && process.stdout.isTTY,
        persistTrust: !options.dryRun,
    });
    try {
        return await applyInstallPlan(plan, options);
    }
    finally {
        await plan.cleanup?.();
    }
}
async function applyInstallPlan(plan, options) {
    const envelope = envelopeFromPlan(plan);
    const state = await readState(plan.consumerRoot, envelope.diagnostics);
    if (state === undefined ||
        envelope.diagnostics.some(({ severity }) => severity === "error")) {
        return finish(envelope);
    }
    if (options.dryRun) {
        for (const custom of plan.customSteps) {
            envelope.diagnostics.push({
                code: "custom-check-deferred",
                severity: "warning",
                message: "Custom check and lifecycle actions are deferred during dry-run",
                source: custom.sourceRoot,
                recipe: custom.recipe,
                step: custom.step,
            });
        }
        return finish(envelope);
    }
    if (options.signal?.aborted) {
        return { ...finish(envelope), exitCode: 130 };
    }
    if (plan.lockfile !== undefined && plan.lockfileChanged) {
        try {
            envelope.changed =
                (await persistLockfile(plan.consumerRoot, plan.lockfile)) ||
                    envelope.changed;
        }
        catch (error) {
            addDiagnostic(envelope.diagnostics, "lockfile-write", `Unable to persist tbboot.lock.yaml: ${errorMessage(error)}`);
            return finish(envelope);
        }
    }
    const effects = new Map(state.effects.map((effect) => [
        stateKey(plan.consumerRoot, effect),
        effect,
    ]));
    let sequence = nextSequence(state);
    const workingTargets = new Map();
    const artifactsByAction = new Map(plan.artifacts.map((artifact) => [artifact.action, artifact]));
    const customByAction = new Map(plan.customSteps.map((custom) => [custom.action, custom]));
    let stderr = "";
    let cancelled = false;
    let stopped = false;
    for (const action of plan.actions) {
        if (options.signal?.aborted) {
            cancelled = true;
            break;
        }
        if (stopped)
            break;
        if (action.type === "custom") {
            const custom = customByAction.get(action);
            if (custom?.prepared === undefined)
                continue;
            const prepared = custom.prepared;
            const report = (status, message) => {
                action.state = status;
                envelope.diagnostics.push({
                    code: status === "missing"
                        ? "custom-missing"
                        : status === "drift"
                            ? "custom-drift"
                            : "custom-error",
                    severity: custom.optional ? "warning" : "error",
                    message,
                    source: custom.sourceRoot,
                    recipe: custom.recipe,
                    step: custom.step,
                });
                return !custom.optional;
            };
            try {
                const run = async (operation) => {
                    const outcome = await runPreparedOperation(operation, prepared.context, options.signal);
                    stderr += outcome.stderr;
                    if (outcome.result.changed)
                        envelope.changed = true;
                    if (outcome.result.status !== "ok") {
                        return {
                            failed: true,
                            fatal: report(outcome.result.status, outcome.result.message ??
                                `Custom ${operation.name} returned ${outcome.result.status}`),
                        };
                    }
                    return { failed: false, fatal: false };
                };
                if (prepared.install !== undefined) {
                    const installation = await run(prepared.install);
                    if (installation.failed) {
                        stopped ||= installation.fatal;
                        continue;
                    }
                }
                if (prepared.check === undefined) {
                    stopped = report("error", "Custom check is not prepared");
                    continue;
                }
                const check = await run(prepared.check);
                if (check.failed) {
                    stopped ||= check.fatal;
                    continue;
                }
                action.state = "ok";
                const existing = effects.get(stateKey(plan.consumerRoot, {
                    source: custom.source,
                    recipe: custom.recipe,
                    step: custom.step,
                    type: "custom",
                }));
                const effect = customEffect({ ...custom, prepared });
                if (!sameEffect(existing, effect)) {
                    const sequenced = { ...effect, sequence: sequence++ };
                    effects.set(stateKey(plan.consumerRoot, effect), sequenced);
                    envelope.changed =
                        (await persistState(plan.consumerRoot, {
                            schemaVersion: 1,
                            effects: [...effects.values()],
                        })) || envelope.changed;
                }
            }
            catch (error) {
                stderr +=
                    typeof error.stderr === "string"
                        ? error.stderr
                        : "";
                if (isCancellation(error)) {
                    cancelled = true;
                    stopped = true;
                    envelope.diagnostics.push({
                        code: "custom-cancelled",
                        severity: "error",
                        message: "Custom execution was cancelled",
                        source: custom.sourceRoot,
                        recipe: custom.recipe,
                        step: custom.step,
                    });
                    continue;
                }
                if (report("error", error instanceof Error ? error.message : "Custom execution failed"))
                    stopped = true;
            }
            continue;
        }
        const artifact = artifactsByAction.get(action);
        if (artifact === undefined ||
            (artifact.action.state === "drift" && !options.force))
            continue;
        try {
            const existing = effects.get(stateKey(plan.consumerRoot, {
                source: artifact.source,
                recipe: artifact.recipe,
                step: artifact.step,
                type: artifact.type,
                target: relative(plan.consumerRoot, artifact.targetPath)
                    .split(sep)
                    .join("/"),
                ...(artifact.marker === undefined ? {} : { marker: artifact.marker }),
            }));
            const { content, artifactBytes, wrote } = await applyArtifact(artifact, options.force, workingTargets);
            if (wrote) {
                await mkdir(dirname(artifact.targetPath), { recursive: true });
                await writeFile(artifact.targetPath, content);
                envelope.changed = true;
            }
            const effect = effectFor(artifact, plan.consumerRoot, artifactBytes, existing);
            if (!sameEffect(existing, effect)) {
                const sequenced = { ...effect, sequence: sequence++ };
                effects.set(stateKey(plan.consumerRoot, effect), sequenced);
                envelope.changed =
                    (await persistState(plan.consumerRoot, {
                        schemaVersion: 1,
                        effects: [...effects.values()],
                    })) || envelope.changed;
            }
        }
        catch (error) {
            addDiagnostic(envelope.diagnostics, "install-write", `Unable to apply ${artifact.type} target: ${errorMessage(error)}`, {
                source: artifact.sourceRoot,
                recipe: artifact.recipe,
                step: artifact.step,
            }, artifact.optional ? "warning" : "error");
            if (!artifact.optional)
                break;
        }
    }
    if (plan.artifacts.some(({ action }) => action.state !== "drift" || options.force) ||
        plan.customSteps.some(({ action }) => action.state === "ok")) {
        try {
            envelope.changed =
                (await persistState(plan.consumerRoot, {
                    schemaVersion: 1,
                    effects: [...effects.values()],
                })) || envelope.changed;
        }
        catch (error) {
            addDiagnostic(envelope.diagnostics, "install-write", `Unable to persist Installation record: ${errorMessage(error)}`);
        }
    }
    const result = finish(envelope);
    return {
        ...result,
        ...(stderr === "" ? {} : { stderr }),
        exitCode: cancelled ? 130 : result.exitCode,
    };
}
function effectSource(effect) {
    return effect.source.provider === "local"
        ? effect.source.locator.path
        : `${effect.source.locator.repository}${effect.source.locator.path === undefined ? "" : `/${effect.source.locator.path}`}`;
}
function uninstallAction(effect) {
    return {
        source: effectSource(effect),
        recipe: effect.recipe,
        step: effect.step,
        type: effect.type,
        ...(effect.type === "custom" ? {} : { target: effect.target }),
        state: "blocked",
    };
}
async function targetPath(root, target) {
    const path = resolve(root, target);
    if (!isInside(root, path))
        return { error: "Target escapes the Consumer root" };
    try {
        const info = await lstat(path);
        if (!info.isFile())
            return { error: "Target is not a regular file" };
        const canonicalRoot = await realpath(root);
        if (!isInside(canonicalRoot, await realpath(path))) {
            return { error: "Target escapes the Consumer root through a link" };
        }
        return { path, missing: false };
    }
    catch (error) {
        if (isNotFound(error))
            return { path, missing: true };
        return { error: errorMessage(error) };
    }
}
function removeManagedBlock(target, range) {
    // ponytail: the state has no pre-install boundary, so remove one generated separator when it is distinguishable.
    let start = range.start;
    let end = range.end;
    if (target[end] === 0x0d && target[end + 1] === 0x0a)
        end += 2;
    else if (target[end] === 0x0a || target[end] === 0x0d)
        end += 1;
    if (start >= 2 &&
        (target[start - 1] === 0x0a || target[start - 1] === 0x0d) &&
        target[start - 1] === target[start - 2])
        start -= 1;
    return Buffer.concat([target.subarray(0, start), target.subarray(end)]);
}
async function historicalRecipeRoot(sourceRoot, recipe) {
    const recipeRoot = await realpath(join(sourceRoot, recipe));
    if (!isInside(sourceRoot, recipeRoot))
        throw new Error("Historical Recipe escapes the Source root");
    return recipeRoot;
}
async function historicalSource(root, effect) {
    if (effect.source.provider === "local") {
        const sourceRoot = await realpath(resolve(root, effect.source.locator.path));
        return { sourceRoot };
    }
    if (effect.revision === undefined)
        throw new Error("Historical Git Source revision is missing");
    const materialized = await materializeGitSource(root, effect.source, effect.revision);
    return {
        sourceRoot: materialized.sourceRoot,
        cleanup: materialized.cleanup,
    };
}
async function historicalCustom(root, effect, options, authCache) {
    let sourceRoot = effectSource(effect);
    let cleanup;
    try {
        const source = await historicalSource(root, effect);
        sourceRoot = source.sourceRoot;
        cleanup = source.cleanup;
    }
    catch (error) {
        return {
            custom: { sourceRoot, optional: false },
            unsupported: {
                code: "uninstall-unsupported",
                message: `Unable to recover historical Custom handler: ${errorMessage(error)}`,
            },
        };
    }
    if (!effect.uninstallSupported) {
        try {
            const recipeRoot = await historicalRecipeRoot(sourceRoot, effect.recipe);
            await readFile(join(recipeRoot, "recipe.yaml"), "utf8");
        }
        catch (error) {
            if (isNotFound(error)) {
                return {
                    custom: {
                        sourceRoot: effectSource(effect),
                        optional: false,
                        cleanup,
                    },
                    unsupported: {
                        code: "custom-effect-unmatched",
                        message: "Installation record Custom effect has no matching current Custom step; the effect was preserved",
                    },
                };
            }
        }
        return {
            custom: { sourceRoot, optional: false, cleanup },
            unsupported: {
                code: "uninstall-unsupported",
                message: "Custom step does not declare an uninstall operation",
            },
        };
    }
    try {
        const recipeRoot = await historicalRecipeRoot(sourceRoot, effect.recipe);
        const recipePath = join(recipeRoot, "recipe.yaml");
        const result = validateDocument({
            kind: "recipe",
            text: await readFile(recipePath, "utf8"),
            document: "recipe.yaml",
            source: sourceRoot,
            recipe: effect.recipe,
        });
        if (result.value === undefined) {
            throw new Error(result.diagnostics[0]?.message ?? "Historical recipe is invalid");
        }
        const step = result.value.steps[effect.step - 1];
        if (step?.type !== "custom" || step.uninstall === undefined) {
            return {
                custom: { sourceRoot, optional: step?.optional === true, cleanup },
                unsupported: {
                    code: "custom-effect-unmatched",
                    message: "Installation record Custom effect has no matching historical Custom uninstall handler; the effect was preserved",
                },
            };
        }
        const prepared = await prepareCustomStep(step, {
            consumerRoot: root,
            sourceRoot,
            recipeRoot,
            recipe: effect.recipe,
            step: effect.step,
            source: effect.source,
            revision: effect.revision,
            sourceFingerprint: effect.source.provider === "local"
                ? await calculateSourceFingerprint(sourceRoot)
                : effect.sourceFingerprint,
        }, {
            allowCustom: options.allowCustom,
            profileRoot: options.profileRoot,
            interactive: process.stdin.isTTY && process.stdout.isTTY,
            persistTrust: false,
            cache: authCache,
        }, ["uninstall"]);
        return {
            custom: {
                sourceRoot,
                optional: step.optional === true,
                prepared,
                cleanup,
            },
        };
    }
    catch (error) {
        return {
            custom: { sourceRoot, optional: false, cleanup },
            unsupported: {
                code: "uninstall-unsupported",
                message: `Unable to prepare historical Custom handler: ${errorMessage(error)}`,
            },
        };
    }
}
function orderedEffects(state) {
    return state.effects
        .map((effect, index) => ({ effect, order: effect.sequence ?? index }))
        .sort((left, right) => right.order - left.order)
        .map(({ effect }) => effect);
}
async function applyUninstallState(root, state, options, initialDiagnostics) {
    const envelope = {
        schemaVersion: 1,
        command: "uninstall",
        status: "ok",
        changed: false,
        actions: [],
        diagnostics: [...initialDiagnostics],
    };
    if (state.effects.length === 0)
        return finish(envelope);
    const consumerRoot = resolve(root);
    const effects = new Map(state.effects.map((effect) => [stateKey(consumerRoot, effect), effect]));
    const records = [];
    const cleanups = [];
    const authCache = new Map();
    let stderr = "";
    try {
        for (const effect of orderedEffects(state)) {
            const action = uninstallAction(effect);
            envelope.actions.push(action);
            if (effect.type === "custom") {
                const prepared = await historicalCustom(consumerRoot, effect, options, authCache);
                if (prepared.custom.cleanup !== undefined)
                    cleanups.push(prepared.custom.cleanup);
                if (prepared.custom.prepared?.uninstall !== undefined) {
                    action.source = prepared.custom.sourceRoot;
                    records.push({
                        effect,
                        action,
                        optional: prepared.custom.optional,
                        status: "ready",
                        custom: prepared.custom,
                    });
                    continue;
                }
                action.source = prepared.custom.sourceRoot;
                action.state = "unsupported";
                const unsupported = prepared.unsupported ?? {
                    code: "uninstall-unsupported",
                    message: "Historical Custom uninstall handler is unavailable",
                };
                envelope.diagnostics.push({
                    code: unsupported.code,
                    severity: "warning",
                    message: unsupported.message,
                    source: prepared.custom.sourceRoot,
                    recipe: effect.recipe,
                    step: effect.step,
                });
                records.push({
                    effect,
                    action,
                    optional: prepared.custom.optional,
                    status: "unsupported",
                    custom: prepared.custom,
                });
                continue;
            }
            const target = await targetPath(consumerRoot, effect.target);
            if ("error" in target) {
                action.state = "blocked";
                envelope.diagnostics.push({
                    code: "target-read",
                    severity: "error",
                    message: target.error,
                    source: effectSource(effect),
                    recipe: effect.recipe,
                    step: effect.step,
                });
                records.push({
                    effect,
                    action,
                    optional: false,
                    status: "blocked",
                });
                continue;
            }
            if (target.missing) {
                action.state = "already-absent";
                records.push({
                    effect,
                    action,
                    optional: false,
                    status: "already-absent",
                });
                continue;
            }
            let current;
            try {
                current = await readFile(target.path);
            }
            catch (error) {
                action.state = "blocked";
                envelope.diagnostics.push({
                    code: "target-read",
                    severity: "error",
                    message: `Unable to read the target: ${errorMessage(error)}`,
                    source: effectSource(effect),
                    recipe: effect.recipe,
                    step: effect.step,
                });
                records.push({ effect, action, optional: false, status: "blocked" });
                continue;
            }
            if (effect.type === "file") {
                if (!effect.created) {
                    action.state = "preserved-preexisting";
                    records.push({
                        effect,
                        action,
                        optional: false,
                        status: "preserved-preexisting",
                    });
                    continue;
                }
                const drift = sha256(current) !== effect.artifactFingerprint;
                if (drift && !(options.force ?? false)) {
                    action.state = "blocked";
                    envelope.diagnostics.push({
                        code: "file-drift",
                        severity: "error",
                        message: "Target bytes differ from the historically installed File",
                        source: effectSource(effect),
                        recipe: effect.recipe,
                        step: effect.step,
                    });
                    records.push({
                        effect,
                        action,
                        optional: false,
                        status: "blocked",
                    });
                    continue;
                }
                records.push({
                    effect,
                    action,
                    optional: false,
                    status: "ready",
                    targetPath: target.path,
                });
                continue;
            }
            const inspection = inspectManagedBlock(current, effect.marker);
            if (inspection.state === "missing") {
                action.state = "already-absent";
                records.push({
                    effect,
                    action,
                    optional: false,
                    status: "already-absent",
                });
                continue;
            }
            if (inspection.state === "conflict") {
                action.state = "blocked";
                envelope.diagnostics.push({
                    code: inspection.code,
                    severity: "error",
                    message: "Managed fragment structure is unsafe to reconcile",
                    source: effectSource(effect),
                    recipe: effect.recipe,
                    step: effect.step,
                });
                records.push({
                    effect,
                    action,
                    optional: false,
                    status: "blocked",
                });
                continue;
            }
            const block = current.subarray(inspection.range.start, inspection.range.end);
            if (sha256(block) !== effect.artifactFingerprint &&
                !(options.force ?? false)) {
                action.state = "blocked";
                envelope.diagnostics.push({
                    code: "fragment-drift",
                    severity: "error",
                    message: "Managed fragment differs from the historically installed block",
                    source: effectSource(effect),
                    recipe: effect.recipe,
                    step: effect.step,
                });
                records.push({
                    effect,
                    action,
                    optional: false,
                    status: "blocked",
                });
                continue;
            }
            records.push({
                effect,
                action,
                optional: false,
                status: "ready",
                targetPath: target.path,
                fragmentRange: inspection.range,
            });
        }
        if (records.some(({ status }) => status === "blocked"))
            return finish(envelope);
        if (options.signal?.aborted)
            return { ...finish(envelope), exitCode: 130 };
        const checkpoint = async (effect) => {
            effects.delete(stateKey(consumerRoot, effect));
            envelope.changed =
                (await persistState(consumerRoot, {
                    schemaVersion: 1,
                    effects: [...effects.values()],
                })) || envelope.changed;
        };
        let cancelled = false;
        for (const record of records) {
            if (options.signal?.aborted) {
                cancelled = true;
                break;
            }
            if (record.status === "unsupported")
                continue;
            if (record.status === "already-absent") {
                record.action.state = "already-absent";
                await checkpoint(record.effect);
                continue;
            }
            if (record.status === "preserved-preexisting") {
                record.action.state = "preserved-preexisting";
                await checkpoint(record.effect);
                continue;
            }
            try {
                if (record.effect.type === "custom") {
                    const prepared = record.custom?.prepared;
                    const operation = prepared?.uninstall;
                    if (prepared === undefined || operation === undefined)
                        continue;
                    const outcome = await runPreparedOperation(operation, prepared.context, options.signal);
                    stderr += outcome.stderr;
                    if (outcome.result.changed)
                        envelope.changed = true;
                    if (outcome.result.status !== "ok") {
                        record.action.state = "failed";
                        envelope.diagnostics.push({
                            code: outcome.result.status === "missing"
                                ? "custom-missing"
                                : outcome.result.status === "drift"
                                    ? "custom-drift"
                                    : "custom-error",
                            severity: record.optional ? "warning" : "error",
                            message: outcome.result.message ??
                                `Custom uninstall returned ${outcome.result.status}`,
                            source: record.action.source,
                            recipe: record.effect.recipe,
                            step: record.effect.step,
                        });
                        if (!record.optional)
                            break;
                        continue;
                    }
                    record.action.state = "removed";
                    await checkpoint(record.effect);
                    continue;
                }
                if (record.targetPath === undefined)
                    continue;
                if (record.effect.type === "file") {
                    const verified = await targetPath(consumerRoot, record.effect.target);
                    if ("error" in verified || verified.missing)
                        throw new Error("Target changed after preflight");
                    const current = await readFile(verified.path);
                    if (sha256(current) !== record.effect.artifactFingerprint &&
                        !(options.force ?? false))
                        throw new Error("File drifted after preflight");
                    await unlink(verified.path);
                }
                else if (record.fragmentRange !== undefined) {
                    if (record.effect.type !== "file-fragment")
                        throw new Error("Invalid fragment uninstall record");
                    const verified = await targetPath(consumerRoot, record.effect.target);
                    if ("error" in verified || verified.missing)
                        throw new Error("Target changed after preflight");
                    const current = await readFile(verified.path);
                    const inspection = inspectManagedBlock(current, record.effect.marker);
                    if (inspection.state !== "present")
                        throw new Error("Managed fragment changed after preflight");
                    if (sha256(current.subarray(inspection.range.start, inspection.range.end)) !== record.effect.artifactFingerprint &&
                        !(options.force ?? false))
                        throw new Error("Managed fragment drifted after preflight");
                    await writeFile(verified.path, removeManagedBlock(current, inspection.range));
                }
                record.action.state = "removed";
                await checkpoint(record.effect);
            }
            catch (error) {
                if (isCancellation(error)) {
                    cancelled = true;
                    envelope.diagnostics.push({
                        code: "custom-cancelled",
                        severity: "error",
                        message: "Custom uninstall was cancelled",
                        source: record.action.source,
                        recipe: record.effect.recipe,
                        step: record.effect.step,
                    });
                    break;
                }
                record.action.state = "failed";
                envelope.diagnostics.push({
                    code: "uninstall-write",
                    severity: record.optional ? "warning" : "error",
                    message: `Unable to reconcile ${record.effect.type}: ${errorMessage(error)}`,
                    source: record.action.source,
                    recipe: record.effect.recipe,
                    step: record.effect.step,
                });
                if (!record.optional)
                    break;
            }
        }
        const result = finish(envelope);
        return {
            ...result,
            ...(stderr === "" ? {} : { stderr }),
            exitCode: cancelled ? 130 : result.exitCode,
        };
    }
    finally {
        for (const cleanup of cleanups.reverse())
            await cleanup().catch(() => undefined);
    }
}
export async function runUninstall(root, options) {
    if (options.signal?.aborted) {
        return {
            envelope: {
                schemaVersion: 1,
                command: "uninstall",
                status: "ok",
                changed: false,
                actions: [],
                diagnostics: [],
            },
            exitCode: 130,
        };
    }
    const diagnostics = [];
    const state = await readState(resolve(root), diagnostics);
    const envelope = {
        schemaVersion: 1,
        command: "uninstall",
        status: "ok",
        changed: false,
        actions: [],
        diagnostics,
    };
    if (state === undefined ||
        diagnostics.some(({ severity }) => severity === "error"))
        return finish(envelope);
    return applyUninstallState(resolve(root), state, options, diagnostics);
}
