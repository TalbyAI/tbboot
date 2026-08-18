# Issue 39: helpers compartidos y `PlannedArtifact`

> Diseño derivado del [Issue #39](https://github.com/TalbyAI/tbboot/issues/39).
> El Issue y los ADR son la autoridad contractual.

## Objetivo

Reducir la duplicación interna entre `contract.ts`, `doctor.ts` e `install.ts`
sin cambiar el comportamiento observable de la CLI ni el formato del estado.

## Diseño aprobado

Crear un módulo interno pequeño en `src/shared.ts` que contenga una sola
implementación de:

- `errorMessage`, `errorCode` e `isNotFound` para errores de Node;
- `normalizeNewlines` para el contenido de File Fragment;
- `finish`, que calcula `status` y `exitCode` a partir de los diagnósticos.

`contract.ts`, `doctor.ts` e `install.ts` importarán esos helpers. No se añade
dependencia, API pública ni abstracción adicional.

`PlannedArtifact` conservará únicamente `input` como referencia a los bytes de
entrada. Se eliminarán `sourceInput` y `created`. `install.ts` calculará la
huella de Source desde `artifact.input`, y `created` se calculará al construir
el `StateEffect` con `artifact.targetBefore === undefined`, conservando
`created: true` si el efecto existente ya lo tenía.

## Flujo y compatibilidad

La planificación seguirá leyendo y evaluando los mismos Source, Recipe, input
y target. La instalación seguirá aplicando los mismos bytes, estados
`satisfied`, `missing`, `drift` y `conflict`, diagnósticos, códigos de salida,
reglas de `--force` y `--dry-run`, y persistencia de `.tbboot/state.yaml`.
Solo cambia dónde viven los helpers y qué campos redundantes se almacenan en
la estructura interna.

## Verificación

Se añadirá una prueba que compruebe que la planificación expone una sola
referencia de entrada y no almacena `created`. Las pruebas E2E existentes
seguirán cubriendo estados, salida, drift, `--force`, fragmentos y la
persistencia de `created`. Se ejecutarán `npm run check`, `npm run typecheck` y
`npm test`.

## Alternativas descartadas

- Mantener las implementaciones duplicadas: no satisface el alcance del Issue.
- Crear una jerarquía o una utilidad configurable: añade superficie sin un
  consumidor adicional.
