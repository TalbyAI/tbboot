import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { parseAllDocuments } from "yaml";
import { errorMessage } from "./shared.js";
const schemaId = "https://tbboot.dev/schemas/contract-v1";
const contract = JSON.parse(readFileSync(new URL("../schemas/contract-v1.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(contract);
const documentKinds = [
    "manifest",
    "source",
    "recipe",
    "catalog",
    "catalog-registry",
    "lockfile",
    "state",
    "trust",
];
const validators = Object.assign(Object.create(null), Object.fromEntries(documentKinds.map((kind) => [
    kind,
    ajv.getSchema(`${schemaId}#/$defs/${kind}`),
])));
if (Object.values(validators).some((validator) => validator === undefined)) {
    throw new Error("The contract does not expose all document schemas");
}
function isSchemaVersionRecord(value) {
    return (value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.hasOwn(value, "schemaVersion"));
}
function errorParam(error, key) {
    const params = error.params;
    const value = params[key];
    return typeof value === "string" ? value : String(value);
}
function diagnostic(code, message, { document, path, source, recipe, step } = {}) {
    return {
        code,
        severity: "error",
        message,
        ...(document === undefined ? {} : { document }),
        ...(path === undefined ? {} : { path }),
        ...(source === undefined ? {} : { source }),
        ...(recipe === undefined ? {} : { recipe }),
        ...(step === undefined ? {} : { step }),
    };
}
function escapePointerToken(value) {
    return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
function errorPath(error) {
    if (error.keyword === "additionalProperties") {
        return `${error.instancePath}/${escapePointerToken(errorParam(error, "additionalProperty"))}`;
    }
    if (error.keyword === "required") {
        return `${error.instancePath}/${escapePointerToken(errorParam(error, "missingProperty"))}`;
    }
    if (error.keyword === "dependencies") {
        return `${error.instancePath}/${escapePointerToken(errorParam(error, "property"))}`;
    }
    if (error.keyword === "discriminator") {
        return `${error.instancePath}/${escapePointerToken(errorParam(error, "tag"))}`;
    }
    if (error.keyword === "uniqueItems") {
        return `${error.instancePath}/${errorParam(error, "i")}`;
    }
    return error.instancePath;
}
function schemaMessage(error) {
    if (error.keyword === "additionalProperties") {
        return `Unknown field: ${errorParam(error, "additionalProperty")}`;
    }
    if (error.keyword === "discriminator") {
        return `Unsupported ${errorParam(error, "tag")}: ${errorParam(error, "tagValue")}`;
    }
    return error.message ?? "Schema validation failed";
}
function actionableErrors(errors) {
    const actionable = errors.filter(({ keyword }) => keyword !== "oneOf" && keyword !== "if");
    return actionable.length > 0 ? actionable : [...errors];
}
function stepFromPath(path) {
    const match = /^\/steps\/(\d+)(?:\/|$)/.exec(path);
    return match ? Number(match[1]) + 1 : undefined;
}
function reservedDiagnostics(kind, value, context) {
    const diagnostics = [];
    const selections = kind === "manifest"
        ? value.sources.map((entry, index) => [entry, `/sources/${index}/recipes`])
        : kind === "source"
            ? (value.dependencies ?? []).map((entry, index) => [entry, `/dependencies/${index}/recipes`])
            : [];
    for (const [entry, path] of selections) {
        if (!Object.hasOwn(entry, "recipes"))
            continue;
        const recipes = entry.recipes;
        diagnostics.push(diagnostic(recipes.length === 0 ? "recipes-empty" : "recipes-not-supported", recipes.length === 0
            ? "recipes must be omitted when no selection is requested"
            : "Recipe selection is not supported in the MVP", { ...context, path }));
    }
    if (kind === "recipe" &&
        (value.requires?.length ?? 0) > 0) {
        diagnostics.push(diagnostic("requires-not-supported", "Recipe requirements are not supported in the MVP", { ...context, path: "/requires" }));
    }
    return diagnostics;
}
export function validateDocument({ kind, text, document, source, recipe, }) {
    if (!Object.hasOwn(validators, kind))
        throw new TypeError(`Unsupported document kind: ${kind}`);
    const validator = validators[kind];
    let yamlDocuments;
    try {
        yamlDocuments = parseAllDocuments(text, {
            schema: "core",
            uniqueKeys: true,
            version: "1.2",
        });
    }
    catch (error) {
        return {
            value: undefined,
            diagnostics: [
                diagnostic("yaml-parse-error", errorMessage(error), {
                    document,
                    source,
                    recipe,
                }),
            ],
        };
    }
    const yaml11Directive = yamlDocuments.some(({ directives }) => directives?.yaml?.version === "1.1");
    if (yaml11Directive ||
        yamlDocuments.length !== 1 ||
        yamlDocuments[0].errors.length > 0 ||
        yamlDocuments[0].contents === null) {
        const message = yaml11Directive
            ? "YAML 1.1 is not supported"
            : yamlDocuments.length === 0
                ? "Expected one non-empty YAML document"
                : yamlDocuments.length > 1
                    ? "Expected exactly one YAML document"
                    : (yamlDocuments[0].errors[0]?.message ??
                        "Expected a non-empty YAML document");
        return {
            value: undefined,
            diagnostics: [
                diagnostic("yaml-parse-error", message, { document, source, recipe }),
            ],
        };
    }
    const yamlDocument = yamlDocuments[0];
    const value = yamlDocument.toJS();
    if (!isSchemaVersionRecord(value)) {
        return {
            value: undefined,
            diagnostics: [
                diagnostic("schema-version-missing", "Missing required schemaVersion", {
                    document,
                    path: "/schemaVersion",
                    source,
                    recipe,
                }),
            ],
        };
    }
    if (value.schemaVersion !== 1) {
        let schemaVersion;
        try {
            schemaVersion = JSON.stringify(value.schemaVersion);
        }
        catch {
            schemaVersion = String(value.schemaVersion);
        }
        return {
            value: undefined,
            diagnostics: [
                diagnostic("schema-version-unsupported", `Unsupported schemaVersion: ${schemaVersion}`, { document, path: "/schemaVersion", source, recipe }),
            ],
        };
    }
    const valid = validator(value);
    if (!valid) {
        const diagnostics = actionableErrors(validator.errors ?? []).map((error) => {
            const path = errorPath(error);
            return diagnostic("schema-validation-failed", schemaMessage(error), {
                document,
                path,
                source,
                recipe,
                step: stepFromPath(path),
            });
        });
        return { value: undefined, diagnostics };
    }
    const documentValue = value;
    const diagnostics = reservedDiagnostics(kind, documentValue, {
        document,
        source,
        recipe,
    });
    return {
        value: diagnostics.length === 0 ? documentValue : undefined,
        diagnostics,
    };
}
