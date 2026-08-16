# Diseño: pipeline CI de calidad

**Issue:** #33
**Parent:** #8
**Prerequisito satisfecho:** #31
**Fecha:** 2026-08-16

## Objetivo

Crear un workflow de integración continua para el repositorio principal que
ejecute checks reproducibles antes de continuar con los Issues #32 y #14.

El workflow se ejecutará en pull requests y en pushes a `main`. Preparará una
instalación limpia con `npm ci` y ejecutará, como pasos identificables, lint de
TypeScript/JavaScript, formato de Markdown, typecheck, build del entrypoint,
`npm run check` y `npm test`.

Los mismos checks estarán disponibles como scripts npm locales. Un fallo de
cualquier check producirá un código distinto de cero y hará fallar el job.

## Contexto y restricciones

- El paquete es ESM y usa el type stripping nativo de Node para ejecutar
  `src/cli.ts` directamente.
- `package.json` declara Node `>=24.12 <25` y el bin del paquete apunta a
  `src/cli.ts`.
- `npm run check`, `npm test` y `npm run typecheck` ya existen y pasan.
- El repositorio no tiene todavía workflow de CI ni herramientas de lint.
- El objetivo de compatibilidad documentado es Windows x64; el workflow usará
  `windows-latest` para probar el entorno soportado.
- `prototypes/` no forma parte del pipeline principal.
- No se cambiarán el contrato JSON, los diagnósticos, los códigos de salida,
  el comportamiento funcional del CLI ni la implementación de producción.

## Enfoque aprobado

Se añadirán `@biomejs/biome` y `markdownlint-cli2` como dependencias de
desarrollo.

Biome ejecutará únicamente lint sobre `src/` y `test/`, con sus reglas
recomendadas. No se activará el formateador de Biome ni se añadirá una orden de
autofix.

`markdownlint-cli2` revisará únicamente los documentos Markdown versionados
relevantes:

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
- **Biome `check` para lint y formato de código:** reduciría una herramienta,
  pero ampliaría el alcance a reformatear código existente sin que el Issue lo
  pida. El formato requerido por el Issue es el de Markdown.

## Cambios y componentes

### Scripts npm

`package.json` conservará los scripts actuales y añadirá:

```json
{
  "lint": "biome lint src test",
  "format:check": "markdownlint-cli2",
  "build": "node --check src/cli.ts"
}
```

El lockfile se actualizará con `npm install --save-dev
@biomejs/biome markdownlint-cli2`. `npm ci` será la instalación de CI y la
fuente reproducible de las versiones resueltas.

### Configuración de Biome

Se creará `biome.json` con el linter habilitado, reglas recomendadas y alcance
limitado a `src/` y `test/`. La configuración no incluirá prototipos, esquemas,
documentación ni código generado.

### Configuración de Markdown

Se creará `.markdownlint-cli2.jsonc` con los globs de los tres grupos
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

El job usará `windows-latest`, `actions/checkout@v6` y
`actions/setup-node@v6`.
`setup-node` leerá `engines.node` desde `package.json` mediante
`node-version-file: package.json` y habilitará la caché de npm. Después de
`npm ci`, los checks se ejecutarán como pasos separados y ordenados:

1. `npm run lint`;
2. `npm run format:check`;
3. `npm run typecheck`;
4. `npm run build`;
5. `npm run check`;
6. `npm test`.

No se usará `continue-on-error`. El comportamiento por defecto de GitHub
Actions detendrá el job ante el primer fallo y conservará el nombre del paso
que lo produjo.

## Build y modelo de ejecución

El proyecto no genera JavaScript: Node ejecuta directamente el entrypoint
TypeScript mediante type stripping. Por tanto, `build` no añadirá un
transpilador ni un directorio de salida; ejecutará `node --check src/cli.ts`
para validar la sintaxis del entrypoint que declara `package.json`.

`npm run check` seguirá verificando la sintaxis de todos los módulos actuales,
por lo que la validación del entrypoint aparecerá también allí. La repetición
es deliberada: `build` representa el gate del artefacto real y `check` conserva
el check existente.

## Flujo de errores

- `npm ci` falla si el lockfile no permite una instalación limpia.
- Biome devuelve código distinto de cero ante una infracción de lint.
- markdownlint devuelve código distinto de cero ante una infracción de
  Markdown.
- TypeScript mantiene el comportamiento de `npm run typecheck` de #31.
- `build`, `check` y `test` propagan los códigos de salida de sus comandos.
- No se ocultarán fallos con `continue-on-error`, `|| true` ni equivalentes.

Los checks son de solo lectura sobre el código fuente y la documentación. No
crean artefactos de build, no publican paquetes, no despliegan y no ejecutan
prototipos.

## Verificación

La implementación se validará con:

```powershell
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run build
npm run check
npm test
git diff --check
```

También se comprobará que:

- `package-lock.json` contiene ambas dependencias de desarrollo;
- el workflow se activa solo para pull requests y pushes a `main`;
- cada control es un paso identificable;
- los globs no incluyen `prototypes/`;
- no aparecen `.js`, mapas ni otros artefactos emitidos;
- el contrato JSON, los códigos de salida y la suite E2E permanecen sin
  cambios funcionales.

## Fuera de alcance

- Reformatear todo el código con Biome.
- Añadir autofix o hooks de pre-commit.
- Ejecutar lint sobre `prototypes/`, `schemas/` o documentos fuera del alcance
  Markdown aprobado.
- Añadir cobertura, análisis de seguridad, publicación o despliegue.
- Introducir una transpilación, bundler o nuevo framework de testing.
