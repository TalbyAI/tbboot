# Diseño: pipeline CI de calidad

**Issue:** #33
**Parent:** #8
**Prerequisito satisfecho:** #31
**Fecha:** 2026-08-17

**Actualización:** incorpora la normalización de scripts definida en
`docs/superpowers/specs/2026-08-17-quality-script-normalization-design.md`.

## Objetivo

Crear un workflow de integración continua para el repositorio principal que
ejecute checks reproducibles antes de continuar con los Issues #32 y #14.

El workflow se ejecutará en pull requests y en pushes a `main`. Preparará una
instalación limpia con `npm ci` y ejecutará, como pasos identificables,
comprobación de Markdown, comprobación de código (lint y formato), typecheck,
build del entrypoint y `npm test`.

Los mismos checks estarán disponibles como scripts npm locales. `npm run check`
será la conveniencia local que agrega Markdown y código; CI ejecutará sus dos
componentes por separado. Un fallo de cualquier check producirá un código
distinto de cero y hará fallar el job.

## Contexto y restricciones

- El paquete es ESM y usa el type stripping nativo de Node para ejecutar
  `src/cli.ts` directamente.
- `package.json` declara Node `>=24.12 <25` y el bin del paquete apunta a
  `src/cli.ts`.
- Este cambio introduce `@biomejs/biome` y `markdownlint-cli2` como
  `devDependencies`, actualiza `package-lock.json` y versiona `biome.json` y
  `.markdownlint-cli2.jsonc`.
- El objetivo de compatibilidad documentado es Windows x64; el workflow usará
  `windows-latest` para probar el entorno soportado.
- `prototypes/` no forma parte del pipeline principal.
- No se cambiarán el contrato JSON, los diagnósticos, los códigos de salida,
  el comportamiento funcional del CLI ni la implementación de producción.

## Enfoque aprobado

Se incorporarán `@biomejs/biome` y `markdownlint-cli2` como dependencias de
desarrollo reproducibles mediante `npm ci`.

Biome ejecutará `check` sobre `src/` y `test/`, con sus reglas recomendadas. El
gate cubre lint y formato de código dentro de ese alcance; `fix:code` será una
operación explícita y local. No se añadirá una configuración de formatter
separada.

`markdownlint-cli2` revisará únicamente los documentos Markdown versionados
relevantes y ofrecerá un script local separado para aplicar sus fixes:

- `AGENTS.md`;
- `CONTEXT.md`;
- `docs/**/*.md`.

`prototypes/**` queda excluido. El check de Markdown usará las reglas estándar
de markdownlint y no modificará archivos. Si algún documento canónico existente
requiere una excepción, esta será específica de una regla y quedará registrada
en la configuración; no se desactivará globalmente el lint.

### Alternativas descartadas

- **ESLint con typescript-eslint:** ofrece más extensibilidad, pero introduce
  más dependencias y configuración para un repositorio que solo necesita un
  lint básico de TypeScript/JavaScript.

## Cambios y componentes

### Scripts npm

`package.json` expondrá exactamente estos seis comandos canónicos de calidad:

```json
{
  "check:md": "markdownlint-cli2",
  "check:code": "biome check src test",
  "check": "npm run check:md && npm run check:code",
  "fix:md": "markdownlint-cli2 --fix",
  "fix:code": "biome check --write src test",
  "fix": "npm run fix:md && npm run fix:code"
}
```

Se eliminan `lint`, `lint:fix`, `format:check` y `format:md`. `test`, `doctor` y
`typecheck` permanecen sin cambios. Se incorpora `build` como
`node --check src/cli.ts`; `package-lock.json` se actualiza con las dos nuevas
dependencias de desarrollo. `fix:md`, `fix:code` y `fix` son operaciones opt-in
para desarrollo local; no se ejecutarán en CI ni mediante hooks automáticos.

`npm run check` deja de ser el agregado de comprobaciones de sintaxis de Node y
pasa a ser solo la conveniencia local para Markdown y código.

### Configuración de Biome

Se versionará `biome.json` con el linter habilitado, reglas recomendadas y
alcance limitado a `src/` y `test/`. La configuración no
incluirá prototipos, esquemas, documentación ni código generado.

### Configuración de Markdown

Se versionará `.markdownlint-cli2.jsonc` con los globs de los tres grupos
anteriores y la exclusión explícita de `prototypes/**`. Ejecutar
`markdownlint-cli2` sin argumentos usará esa configuración, por lo que el
script local y el paso de CI tendrán exactamente el mismo alcance.

### Workflow

Se creará `.github/workflows/ci.yml` con:

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

El workflow limitará `GITHUB_TOKEN` a `contents: read`. El job usará
`windows-latest`, `actions/checkout@v6` con `persist-credentials: false` y
`actions/setup-node@v6`.
`setup-node` leerá `engines.node` desde `package.json` mediante
`node-version-file: package.json` y habilitará la caché de npm. Después de
`npm ci`, los checks se ejecutarán como pasos separados y ordenados:

1. `npm run check:md`;
2. `npm run check:code`;
3. `npm run typecheck`;
4. `npm run build`;
5. `npm test`.

El workflow no ejecutará `npm run check` como paso adicional, ni los comandos
`fix:*`.

No se usará `continue-on-error`. El comportamiento por defecto de GitHub
Actions detendrá el job ante el primer fallo y conservará el nombre del paso
que lo produjo.

## Build y modelo de ejecución

El proyecto no genera JavaScript: Node ejecuta directamente el entrypoint
TypeScript mediante type stripping. Por tanto, `build` no añadirá un
transpilador ni un directorio de salida; ejecutará `node --check src/cli.ts`
para validar la sintaxis del entrypoint que declara `package.json`.

`npm run check` ya no verificará por separado la sintaxis de los módulos Node:
agregará `check:md` y `check:code`. `build` representa el gate del entrypoint
real y `typecheck` cubre el análisis estático restante; no se conserva un paso
CI separado para el antiguo agregado de sintaxis.

## Flujo de errores

- `npm ci` falla si el lockfile no permite una instalación limpia.
- Biome devuelve código distinto de cero ante una infracción de lint o formato.
- markdownlint devuelve código distinto de cero ante una infracción de
  Markdown.
- TypeScript mantiene el comportamiento de `npm run typecheck` de #31.
- `build`, `check:md`, `check:code`, `check` y `test` propagan los códigos de
  salida de sus comandos.
- No se ocultarán fallos con `continue-on-error`, `|| true` ni equivalentes.

Los checks son de solo lectura sobre el código fuente y la documentación. No
crean artefactos de build, no publican paquetes, no despliegan y no ejecutan
prototipos.

## Verificación

La implementación se validará con:

```powershell
npm ci
npm run check:md
npm run check:code
npm run fix:md
npm run fix:code
npm run check:md
npm run check:code
npm run check
npm run typecheck
npm run build
npm test
git diff --check
```

También se comprobará que:

- `package-lock.json` contiene ambas dependencias de desarrollo;
- `package.json` expone exactamente los seis scripts canónicos y no conserva
  los nombres retirados;
- el workflow se activa solo para pull requests y pushes a `main`;
- cada uno de los cinco controles CI es un paso identificable;
- el workflow no referencia los nombres retirados ni `npm run check`;
- los globs no incluyen `prototypes/`;
- no aparecen `.js`, mapas ni otros artefactos emitidos;
- el contrato JSON, los códigos de salida y la suite E2E permanecen sin
  cambios funcionales.

## Fuera de alcance

- Reformatear archivos fuera de `src/`, `test/` o del alcance Markdown aprobado.
- Ejecutar fixes automáticamente en CI o mediante hooks de pre-commit.
- Ejecutar lint sobre `prototypes/`, `schemas/` o documentos fuera del alcance
  Markdown aprobado.
- Añadir cobertura, análisis de seguridad, publicación o despliegue.
- Introducir una transpilación, bundler o nuevo framework de testing.
