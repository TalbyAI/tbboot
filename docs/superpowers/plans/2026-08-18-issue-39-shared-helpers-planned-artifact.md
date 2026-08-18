# Issue 39: helpers compartidos y `PlannedArtifact` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar la duplicación interna de helpers y los campos redundantes de `PlannedArtifact` sin cambiar el comportamiento de `doctor` o `install`.

**Architecture:** Un nuevo `src/shared.ts` será el único dueño de `errorMessage`, `errorCode`, `isNotFound`, `normalizeNewlines` y `finish`. `contract.ts`, `doctor.ts` e `install.ts` consumirán esos helpers. `PlannedArtifact` conservará solo `input`; `install.ts` derivará la huella de Source y `created` en `effectFor`.

**Tech Stack:** TypeScript 7, Node.js 24, Node test runner, Biome, npm scripts existentes.

## Global Constraints

- No añadir dependencias.
- Mantener el alcance limitado a la simplificación interna y sus pruebas necesarias.
- No modificar el contrato YAML, la salida JSON/humana ni el comportamiento de `--force` o `--dry-run`.
- Conservar exactamente los estados `satisfied`, `missing`, `drift` y `conflict`, los diagnósticos y los códigos de salida actuales.
- Mantener la misma detección de drift, cálculo de huellas y persistencia de `created`.
- No modificar los prototipos ni implementar otros hallazgos del audit.

---

## Mapa de archivos

- Crear `src/shared.ts`: helpers internos compartidos y cálculo común de resultado.
- Modificar `src/contract.ts`: consumir `errorMessage` compartido.
- Modificar `src/doctor.ts`: consumir helpers compartidos y simplificar `PlannedArtifact`.
- Modificar `src/install.ts`: consumir helpers compartidos y derivar huellas/`created` desde `input` y `targetBefore`.
- Modificar `test/doctor.e2e.test.ts`: proteger la forma mínima de `PlannedArtifact`.

### Task 1: Añadir la regresión de forma de `PlannedArtifact`

**Files:**
- Modify: `test/doctor.e2e.test.ts:12-15, después de los helpers de ejecución`

**Interfaces:**
- Consumes: `planLocalInstall(root: string, force: boolean)` desde `src/doctor.ts`.
- Produces: una prueba que falla con la estructura actual porque todavía existen `sourceInput` y `created`.

- [ ] **Step 1: Importar `planLocalInstall` junto al tipo `DoctorEnvelope`**

```ts
import { planLocalInstall, type DoctorEnvelope } from "../src/doctor.ts";
```

- [ ] **Step 2: Escribir la prueba que comprueba una sola referencia de entrada**

Añadir después de `createFixture` y antes de las pruebas CLI:

```ts
test("local install plans keep only the input bytes and derive creation", async () => {
	const fixture = await createFixture();
	try {
		const plan = await planLocalInstall(fixture.consumerRoot, false);
		const artifact = plan.artifacts.find(
			({ recipe, type }) => recipe === "baseline" && type === "file",
		);
		assert.ok(artifact);
		assert.equal(artifact.input.toString(), "hello\n");
		assert.equal("sourceInput" in artifact, false);
		assert.equal("created" in artifact, false);
	} finally {
		await fixture.cleanup();
	}
});
```

- [ ] **Step 3: Ejecutar la prueba para confirmar RED**

Run: `node --test test/doctor.e2e.test.ts`

Expected: FAIL en la aserción `"sourceInput" in artifact` o `"created" in artifact`, porque la implementación actual todavía expone ambos campos.

### Task 2: Consolidar helpers y reducir `PlannedArtifact`

**Files:**
- Create: `src/shared.ts`
- Modify: `src/contract.ts:1-3,148`
- Modify: `src/doctor.ts:12-15,42-55,132-164,500,913-925`
- Modify: `src/install.ts:4-8,29-74,191-203`

**Interfaces:**
- Consumes: los tipos actuales `Diagnostic`, `DoctorEnvelope`, `InstallEnvelope` y `PlannedArtifact`.
- Produces: helpers importables y `PlannedArtifact` sin `sourceInput` ni `created`.

- [ ] **Step 1: Crear el módulo compartido con las implementaciones existentes**

```ts
type FinishEnvelope = {
	status: "ok" | "warning" | "error";
	diagnostics: readonly { severity: "error" | "warning" }[];
};

export function finish<T extends FinishEnvelope>(
	envelope: T,
): { envelope: T; exitCode: 0 | 1 } {
	const hasError = envelope.diagnostics.some(
		({ severity }) => severity === "error",
	);
	const hasWarning = envelope.diagnostics.some(
		({ severity }) => severity === "warning",
	);
	envelope.status = hasError ? "error" : hasWarning ? "warning" : "ok";
	return { envelope, exitCode: hasError ? 1 : 0 };
}

export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isNotFound(error: unknown): boolean {
	return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

export function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}
```

- [ ] **Step 2: Reemplazar las copias locales en `contract.ts`, `doctor.ts` e `install.ts`**

En cada módulo, importar solo los helpers usados y eliminar las funciones locales con los mismos nombres. `contract.ts` importa `errorMessage`; `doctor.ts` importa `errorCode`, `errorMessage`, `finish`, `isNotFound` y `normalizeNewlines`; `install.ts` importa `errorCode`, `errorMessage`, `finish`, `isNotFound` y `normalizeNewlines`.

- [ ] **Step 3: Reducir la estructura `PlannedArtifact` y su construcción**

En `src/doctor.ts`, eliminar estos campos del tipo y del objeto de `planLocalInstall`:

```ts
sourceInput: Buffer;
created: boolean;
```

Conservar `input: Buffer` como única referencia a los bytes leídos del Source.

- [ ] **Step 4: Derivar la huella y `created` al crear el efecto**

En `src/install.ts`, cambiar ambas huellas de Source a `sha256(artifact.input)` y sustituir el cálculo de `created` por:

```ts
created:
	existing?.type === "file" && existing.created
		? true
		: artifact.targetBefore === undefined,
```

Esto conserva la propiedad histórica `true` del estado existente y deriva el caso nuevo desde la ausencia del target antes de instalar.

- [ ] **Step 5: Ejecutar la prueba focalizada para confirmar GREEN**

Run: `node --test test/doctor.e2e.test.ts`

Expected: PASS, incluyendo la nueva prueba y las regresiones E2E existentes.

- [ ] **Step 6: Ejecutar typecheck y lint antes de continuar**

Run: `npm run typecheck`

Expected: salida sin errores y código 0.

Run: `npm run check:code`

Expected: Biome sin errores y código 0.

### Task 3: Revisar la implementación contra el Issue 39

**Files:**
- Review: `src/shared.ts`, `src/contract.ts`, `src/doctor.ts`, `src/install.ts`, `test/doctor.e2e.test.ts`
- Reference: Issue 39 y `docs/adr/0005-preflight-before-installation-writes.md`, `docs/adr/0013-installation-record-is-local.md`, `docs/adr/0015-cli-supports-human-and-json-output.md`

- [ ] **Step 1: Confirmar que no quedan helpers duplicados en los tres módulos**

Run: `rg -n "^(function|export function) (errorMessage|errorCode|isNotFound|normalizeNewlines|finish)" src/contract.ts src/doctor.ts src/install.ts src/shared.ts`

Expected: cada helper aparece únicamente como exportación en `src/shared.ts`.

- [ ] **Step 2: Confirmar que no quedan campos redundantes**

Run: `rg -n "sourceInput|created: descriptor\.targetBefore|artifact\.created" src`

Expected: no coincidencias de `sourceInput`, `artifact.created` ni del cálculo eliminado; `created` solo permanece en el contrato de estado y en la derivación de `effectFor`.

- [ ] **Step 3: Revisar el diff y verificar que el alcance es interno**

Run: `git diff --check; git diff -- src/shared.ts src/contract.ts src/doctor.ts src/install.ts test/doctor.e2e.test.ts`

Expected: solo cambian los helpers compartidos, `PlannedArtifact`, la prueba y los documentos derivados; no hay dependencias ni cambios en CLI, YAML o prototipos.

### Task 4: Verificación final y commit

**Files:**
- Verify: todos los archivos del cambio.

- [ ] **Step 1: Ejecutar el conjunto completo solicitado por el Issue**

Run: `npm run check`

Expected: markdownlint y Biome terminan con código 0.

Run: `npm run typecheck`

Expected: TypeScript termina con código 0.

Run: `npm test`

Expected: todas las pruebas terminan con código 0 y sin fallos.

- [ ] **Step 2: Revisar el diff final y el estado Git**

Run: `git diff --check; git status --short; git diff --stat`

Expected: sin errores de whitespace, solo cambios intencionados y ningún archivo temporal.

- [ ] **Step 3: Committear la implementación**

```bash
git add src/shared.ts src/contract.ts src/doctor.ts src/install.ts test/doctor.e2e.test.ts
git commit -m "refactor: share issue 39 helpers"
```

Completion criterion: el commit contiene únicamente la implementación y su prueba; los tests, typecheck y checks finales tienen código 0.
