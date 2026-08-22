import assert from "node:assert/strict";
import test from "node:test";
import { validateDocument } from "../src/contract.ts";

test("accepts the local Catalog registry shape", () => {
	const result = validateDocument({
		kind: "catalog-registry",
		text: [
			"schemaVersion: 1",
			"catalogs:",
			"  - name: team",
			"    path: C:/shared/catalog.yaml",
			"",
		].join("\n"),
		document: ".tbboot/catalogs.yaml",
	});
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.value?.catalogs[0]?.name, "team");
});

test("rejects a registry with an empty name", () => {
	const result = validateDocument({
		kind: "catalog-registry",
		text: [
			"schemaVersion: 1",
			"catalogs:",
			"  - name: ''",
			"    path: C:/catalog.yaml",
			"",
		].join("\n"),
		document: ".tbboot/catalogs.yaml",
	});
	assert.equal(result.value, undefined);
	assert.equal(result.diagnostics[0]?.code, "schema-validation-failed");
});
