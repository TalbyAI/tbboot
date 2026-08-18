# Issue 14: instalación local de File y File Fragment

> Diseño derivado del [Issue #14](https://github.com/TalbyAI/tbboot/issues/14).
> El issue y los ADR son la autoridad contractual; este documento fija la
> forma de implementarlos en la CLI existente.

## Objetivo

Añadir `install` e `install --dry-run` para Sources locales, reutilizando la
frontera de descubrimiento y diagnóstico que ya usa `doctor`. La operación
debe construir el plan completo antes de escribir, preservar cambios ajenos y
dejar un `Installation record` suficiente para reconciliación posterior.

Git, Source dependencies, Custom, Catalogs y `uninstall` permanecen fuera de
esta slice.

## Diseño

`src/doctor.ts` seguirá siendo el dueño de la planificación local: discovery
determinista, resolución segura de inputs/targets, estados de File y File
Fragment y conflictos. La planificación expondrá los bytes de entrada, el
target canónico y el contenido reconciliado que necesita la fase de escritura,
sin duplicar las reglas de `doctor`.

`src/install.ts` será el único dueño de la mutación. Recibirá ese plan, leerá y
validará el estado existente, decidirá qué efectos son aplicables según
`--force`, escribirá en orden declarado y actualizará el estado después de
cada efecto completado. `src/cli.ts` solo ampliará el parser existente y
delegará en `runInstall`.

La instalación mantendrá la acción existente por Step (`missing`, `satisfied`,
`drift`, `conflict`) para que el diagnóstico humano y JSON de `doctor` y
`install` compartan contexto. `install` devolverá el mismo envelope común con
`command: "install"` y `changed` calculado a partir de escrituras de Artifacts
o metadatos.

## Flujo

1. Parsear `install`, `--root`, `--dry-run`, `--force` y `--json`.
2. Construir el plan local completo sin crear directorios ni ficheros.
3. Validar `.tbboot/state.yaml` si existe; un estado inválido es un error de
   preflight.
4. Si hay errores de preflight, serializar diagnósticos y salir sin escribir.
5. En dry-run, serializar acciones y salir con `changed: false`.
6. Para cada Artifact aplicable, calcular el contenido final en memoria,
   crear sus directorios padres, escribirlo solo si cambia y registrar su
   efecto.
7. Escribir `.tbboot/state.yaml` y garantizar `/state.yaml` en
   `.tbboot/.gitignore` cuando cambie el estado.

No se promete rollback después de comenzar las escrituras. Un fallo requerido
detiene el resto; una ejecución posterior vuelve a comprobar y reconcilia.

## Reglas de contenido

File usa `Buffer` y copia bytes exactamente. File Fragment normaliza solo el
contenido gestionado a `LF`, usa los marcadores Markdown fijados por el ADR y
reemplaza únicamente el bloque propio cuando `--force` está activo. Distintos
marcadores pueden compartir target; conflictos estructurales nunca se fuerzan.

Las huellas del estado son SHA-256 en hexadecimal minúsculo: la huella de
Source se calcula sobre los bytes del input y la huella de Artifact sobre los
bytes reconciliados (el Managed block para File Fragment). Un File registra
`created: true` solo cuando tbboot creó el target; un target preexistente no se
considera propiedad de tbboot.

## Errores y seguridad

Se conservan los códigos y severidades de `doctor`. Drift requerido sin
`--force`, conflictos, escapes, providers no soportados, errores de schema y
fallos de lectura bloquean todo el plan. Un fallo ordinario de un Optional step
es warning y permite continuar; un escape o conflicto estructural sigue siendo
fatal aunque sea opcional.

El estado y `.tbboot/.gitignore` nunca se crean en `doctor` ni dry-run. El
`.gitignore` de la raíz nunca se modifica.

## Verificación

La seam será la CLI real ejecutada contra Consumer repositories temporales.
Las pruebas comprobarán exit code, stdout, stderr, acciones, diagnósticos,
bytes de Artifacts, `state.yaml`, `.tbboot/.gitignore` y snapshots antes y
después. Cubrirán creación, no-op, drift, force, fragmentos compartidos,
conflictos estructurales, preflight completo, opcionalidad y dry-run.

## Alternativas descartadas

- Duplicar discovery y detección en `install`: produciría divergencias entre
  `doctor` e `install`.
- Añadir una librería de escritura atómica o rollback: no está en el contrato
  de esta slice y añadiría una promesa que los ADR descartan.
- Implementar Git, Custom o uninstall aquí: son slices independientes y ya
  tienen issues propios.
