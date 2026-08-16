# Diseño: validación estática estricta de TypeScript

**Issue:** #31
**Prerequisito de:** #27
**Fecha:** 2026-08-16

## Objetivo

Añadir una validación estática reproducible para el código TypeScript de
tbboot y corregir los errores que revele, sin cambiar el contrato JSON, los
códigos de salida ni el comportamiento funcional existente.

El comando público será `npm run typecheck`. Debe comprobar los archivos
TypeScript de `src/` y `test/`, fallar con código distinto de cero ante un
error y no emitir archivos.

## Contexto actual

- El repositorio es ESM (`"type": "module"`) y ejecuta `.ts` directamente con
  el type stripping nativo de Node `>=24.12 <25`.
- `src/cli.ts`, `src/contract.ts`, `src/doctor.ts` y
  `test/doctor.e2e.test.ts` contienen JavaScript válido escrito en archivos
  `.ts`, pero no tienen anotaciones estáticas suficientes.
- No existe `tsconfig.json`, ni TypeScript ni `@types/node` instalados como
  dependencias del proyecto.
- `npm run check` y `npm test` pasan antes del cambio. La suite tiene 19 tests:
  18 pasan y 1 se omite en sistemas de archivos insensibles a mayúsculas.
- El test E2E importa `runCommand` y `parseJsonOutput` desde
  `prototypes/issue-12/harness.mjs`. Esa dependencia se mantiene en #31 y se
  eliminará en #32, que ya define `test/support.ts` como solución separada.

## Alcance

### Incluido

- Añadir `typescript` y `@types/node` como dependencias de desarrollo y
  actualizar `package-lock.json`.
- Crear `tsconfig.json` para el runtime ESM actual.
- Añadir `npm run typecheck`.
- Tipar las fronteras y los datos internos de los tres módulos de producción y
  del test E2E.
- Añadir, solo si la resolución de TypeScript lo exige, una declaración
  adyacente para el módulo `.mjs` del harness. La declaración será de tipos,
  no cambiará el runtime y se podrá eliminar cuando se complete #32.

### Excluido

- Cambiar el parser de CLI o usar `node:util.parseArgs`; corresponde a #27.
- Desacoplar el test del prototipo; corresponde a #32.
- Tipar o incluir todos los prototipos, documentos, esquemas JSON o archivos
  JavaScript del repositorio.
- Generar tipos automáticamente desde `schemas/contract-v1.json`.
- Cambiar diagnósticos, contratos, códigos de salida, orden de acciones o
  comportamiento de producción.
- Añadir una librería de testing, un compilador de runtime o una etapa de
  emisión de JavaScript.

## Configuración propuesta

`tsconfig.json` tendrá una configuración mínima y explícita para el runtime:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`strict: true` activa `noImplicitAny` y el tratamiento seguro de variables de
tipo `unknown` en `catch`. `module: "NodeNext"` respeta el sistema ESM del
paquete y `allowImportingTsExtensions` permite conservar imports existentes
como `./doctor.ts` cuando no se emite JavaScript.

El script será explícito sobre el proyecto y la ausencia de emisión:

```json
"typecheck": "tsc --project tsconfig.json --noEmit"
```

No se usarán `allowJs`, supresiones globales ni opciones que rebajen el
chequeo estricto del código `.ts`. `npm run check` continuará siendo el check
de sintaxis de Node y `npm test` continuará ejecutando la suite E2E real.

`package.json` declarará ambas dependencias con la convención semver que ya
usa el repositorio; `package-lock.json` registrará las versiones resueltas.
La verificación reproducible de una instalación limpia usará `npm ci` antes de
ejecutar `npm run typecheck`.

## Modelo de tipos

AJV y las comprobaciones actuales seguirán siendo la autoridad de validación
en runtime. No se duplicará el esquema completo en tipos TypeScript; se
describirán únicamente las propiedades que el código consume.

### `src/contract.ts`

Añadirá tipos para:

- `DocumentKind` y los argumentos de `validateDocument`.
- Contexto de diagnóstico y `Diagnostic`, con severidad `error` o `warning`.
- Resultado de validación con valor opcional y diagnósticos.
- Formas mínimas de Manifest, Source, Recipe, Source reference y Step que se
  usan después de la validación AJV.
- Errores de AJV y valores YAML tratados inicialmente como `unknown`.

Los valores obtenidos de YAML o JSON no se convertirán directamente a `any`.
Primero se comprobará que tienen la forma mínima requerida y después se
usarán los tipos de documento correspondientes.

### `src/doctor.ts`

Añadirá tipos para:

- Diagnósticos y envelope final del comando.
- Acciones de Artifact y sus estados existentes.
- `StepDescriptor`, incluyendo resolución de input, target, marker y acción.
- Resoluciones de rutas exitosas, escapes y errores de lectura.
- `runDoctor`, con su resultado `{ envelope, exitCode }`.

Las variables capturadas en `catch` se tratarán como `unknown` y se
convertirán a mensajes de error sin cambiar los códigos ni textos actuales.

### `src/cli.ts`

Añadirá tipos para:

- `parseArgs(argv, cwd)` como unión discriminada de éxito y error.
- Opciones de CLI, envelope, acciones y diagnósticos consumidos por
  `renderHuman`.
- `main`, que seguirá devolviendo `Promise<number>`.

El parser, la salida y el manejo del proceso seguirán siendo los mismos.

### `test/doctor.e2e.test.ts`

Añadirá tipos para fixtures, pasos auxiliares de recetas, comandos hijos,
resultados de procesos y el envelope que los tests inspeccionan. Los tests
seguirán ejecutando la CLI instalada como proceso hijo.

Si TypeScript no encuentra declaraciones para el import existente del harness,
se añadirá una declaración `.d.mts` adyacente con estas fronteras tipadas:

- `runCommand(options) -> Promise<{ exitCode: number | null; stdout: string; stderr: string }>`.
- `parseJsonOutput<T = unknown>(stdout: string) -> T`.

El test usará el tipo de envelope esperado al leer sus respuestas JSON. La
declaración no comprobará ni incluirá el código JavaScript del prototipo; #32
reemplazará posteriormente todo ese enlace por `test/support.ts`.

## Flujo de implementación

1. Añadir las dependencias de desarrollo, actualizar el lockfile, crear
   `tsconfig.json` y registrar `npm run typecheck`.
2. Ejecutar TypeScript para obtener la lista real de errores.
3. Corregir las fronteras de `contract.ts`, luego `doctor.ts`, `cli.ts` y el
   test, manteniendo los tipos pequeños y cercanos a sus consumidores.
4. Resolver el import del harness solo con la declaración estrecha descrita si
   el compilador lo requiere.
5. Ejecutar la verificación completa y revisar que no se hayan generado
   archivos ni alterado contratos observables.

Si un error de TypeScript exigiera cambiar comportamiento, modificar un
contrato público o introducir una refactorización más amplia que la tipada,
el trabajo se detendrá en ese punto. La decisión se discutirá y la Issue 31 se
actualizará antes de continuar si cambia alcance, compatibilidad o
comportamiento observable.

## Verificación y criterios de aceptación

La implementación se considerará terminada cuando todos estos comandos pasen:

```powershell
npm run typecheck
npm run check
npm test
git diff --check
```

Además se verificará que:

- `tsconfig.json` incluye `src/` y `test/` y no convierte los prototipos en
  alcance general.
- `npm run typecheck` devuelve un código distinto de cero si TypeScript
  encuentra un error.
- No aparecen archivos `.js`, mapas ni otros artefactos emitidos.
- El contrato JSON, los diagnósticos, códigos de salida y estados de la CLI no
  cambian.
- La suite E2E conserva su frontera de proceso y sus resultados actuales.

## Decisiones y deuda relacionada

- Se eligió una dependencia local de TypeScript para que el comando sea
  reproducible y no dependa de una instalación global.
- Se eligió `strict: true` sin ampliar el alcance con reglas adicionales de
  lint o comprobaciones especulativas.
- Se mantiene temporalmente el import del harness para no absorber #32 en
  #31. #32 es la tarea autorizada para mover esos helpers a `test/support.ts`
  y desconectar completamente producción de `prototypes/`.
