# Issue 19: desinstalar y reconciliar efectos gestionados

> Diseño derivado del [Issue #19](https://github.com/TalbyAI/tbboot/issues/19).
> El Issue, sus decisiones y los ADR son la autoridad contractual; este
> documento fija la forma de implementar la slice en la CLI existente.

## Estado

- Diseño confirmado en sesión de brainstorming el 2026-08-21.
- Dependencias #14, #16, #17 y #18 cerradas.
- La implementación queda pendiente de un plan aprobado posterior.

## Objetivo

Completar `uninstall` para retirar, en orden inverso al orden efectivo de
instalación, únicamente los efectos que tbboot pueda identificar con seguridad.
Una ejecución posterior debe poder reconciliar los efectos que sobrevivan a un
fallo o una cancelación.

`uninstall` no es rollback: no reconstruye archivos preexistentes, no deshace
efectos ya completados y no resuelve conflictos estructurales.

## Alcance

Incluye:

- planificación guiada por `.tbboot/state.yaml` para `File` y `File Fragment`;
- eliminación segura de archivos propios y de bloques gestionados propios;
- recuperación y ejecución del `Custom.uninstall` histórico;
- drift, ownership, `--force`, fallos, cancelación y reconciliación;
- persistencia compatible del orden efectivo;
- acciones de salida humana y JSON;
- pruebas de motor, estado, CLI y flujo de extremo a extremo.

Queda fuera:

- `dry-run` específico de `uninstall`;
- un comando `reconcile` separado;
- ejecución paralela o locks entre procesos concurrentes;
- restauración de archivos preexistentes sobrescritos;
- resolución automática de conflictos estructurales.

## Diseño

### Fuente de verdad

El `Installation record` es la fuente de verdad para los efectos incorporados.
La desinstalación de `File` y `File Fragment` usa el `target`, `artifactFingerprint`,
`created`, `marker` y demás identidad persistida, aunque el Source, Recipe o
Step actual haya desaparecido, cambiado o ya no sea válido.

La planificación normal de `install` no se reutiliza como fuente de esos
efectos: el manifiesto actual no puede describir de forma segura lo que una
revisión histórica escribió.

Para `Custom`, el estado conserva `source`, `revision`, `sourceFingerprint`,
`recipe` y `step`. El handler se recupera de la revisión histórica que instaló
el efecto. Su ejecución sigue requiriendo `--allow-custom`. Si no se puede
materializar o autorizar el handler histórico, el efecto se conserva y se
emite un warning.

### Componentes y responsabilidades

- `src/cli.ts` conserva el parser y el dispatch existentes para `uninstall`,
  `--force`, `--allow-custom` y `--json`.
- `src/install.ts` será dueño de leer y validar el estado, construir la
  planificación de desinstalación basada en él, ejecutar los efectos, persistir
  checkpoints y construir el envelope de salida.
- Las reglas existentes de lectura, fingerprint, markers y conflictos se
  reutilizarán desde sus seams actuales; no se duplicará una segunda semántica
  de ownership.
- `src/custom.ts` reutilizará el runner, autorización, timeout y cancelación
  existentes para el handler histórico.
- `src/contract.ts` y `schemas/contract-v1.json` aceptarán `sequence` opcional
  en los efectos del estado, manteniendo válidos los registros anteriores.

### Orden efectivo

Cada efecto completado durante `install` recibe una secuencia monotónica y la
persiste junto con el efecto. Si se actualiza un efecto lógico existente, su
nueva finalización recibe una secuencia nueva y pasa a representar su posición
efectiva más reciente.

`uninstall` ordena los efectos por `sequence` descendente. Para registros
antiguos sin `sequence`, usa la posición del array persistido como fallback,
también en orden inverso. No se añade un estado transitorio por efecto:
los efectos presentes en `state.effects` siguen pendientes; al reconciliarse,
se eliminan del registro.

### Flujo

1. Parsear y validar las opciones existentes.
2. Leer y validar `.tbboot/state.yaml`.
   - Si no existe, devolver `nothing-to-do` sin descubrir ownership fuera del
     estado y sin escribir.
   - Si existe pero es inválido, devolver error antes de cualquier mutación.
3. Construir la lista histórica completa y ordenarla en orden inverso.
4. Ejecutar un preflight completo de todos los efectos antes de borrar nada:
   validar targets, fingerprints, ownership, estructura de managed blocks,
   handlers históricos y autorización de `Custom`. La ausencia de un
   `Custom.uninstall` se clasifica como `unsupported`, no como error de
   preflight.
5. Si el preflight tiene errores previsibles, no escribir efectos ni modificar
   el estado.
6. Ejecutar la lista en orden inverso. Tras cada efecto reconciliado, actualizar
   el estado y escribirlo mediante un archivo temporal en el mismo directorio
   seguido de reemplazo atómico.
7. Agregar acciones y diagnósticos en el envelope común de salida.

El preflight evita que un drift o conflicto conocido en un efecto posterior
deje efectos anteriores ya retirados. No evita fallos inesperados del sistema,
del proceso `Custom` o del sistema de archivos después de comenzar la fase de
ejecución; esos casos usan los checkpoints persistidos.

### Reglas de reconciliación

| Efecto | Estado actual | Sin `--force` | Con `--force` | Estado persistido |
| --- | --- | --- | --- | --- |
| `File`, `created: true` | Ausente | `already-absent` | `already-absent` | Se elimina |
| `File`, `created: true` | Fingerprint exacto | `removed` | `removed` | Se elimina |
| `File`, `created: true` | Drift | Bloqueo | Se elimina; ownership demostrado | Se elimina tras éxito |
| `File`, `created: false` | Presente | `preserved-preexisting` | `preserved-preexisting` | Se elimina sin tocar el archivo |
| `File` | Conflicto estructural | Bloqueo | Bloqueo | Se conserva |
| `File Fragment` | Target o bloque ausente | `already-absent` | `already-absent` | Se elimina |
| `File Fragment` | Bloque propio sin drift | `removed` | `removed` | Se elimina |
| `File Fragment` | Drift, estructura segura | Bloqueo | Se retira solo el bloque propio | Se elimina tras éxito |
| `File Fragment` | Duplicado, incompleto, anidado o mal emparejado | Bloqueo | Bloqueo | Se conserva |
| `Custom` | `uninstall` existe y termina bien | `removed` | `removed` | Se elimina |
| `Custom` | Sin `uninstall` o handler histórico irrecuperable | `unsupported` | `unsupported` | Se conserva |

Para `File Fragment`, el drift se compara con el fingerprint histórico del
bloque instalado, no con el contenido generado por el Source actual. Un bloque
solo puede retirarse con `--force` si sus marcadores son únicos, están
correctamente emparejados y la operación no toca contenido ajeno.

Un archivo preexistente que tbboot sobrescribió nunca se elimina ni se
restaura. `preserved-preexisting` indica que tbboot deja de gestionar ese
efecto, por lo que su entrada se retira del estado.

### Optionalidad, fallos y cancelación

Cuando la definición histórica permite conocer `optional`, se conserva su
semántica: un fallo opcional emite warning, conserva el efecto pendiente y
permite continuar; un fallo requerido detiene los efectos restantes. Si la
optionalidad no puede determinarse de forma segura porque la definición
histórica ya no existe, los fallos ordinarios del efecto se tratan como
requeridos. La ausencia de `Custom.uninstall` es la excepción contractual:
siempre produce `uninstall-unsupported`, conserva el efecto y no falla por esa
ausencia.

Una cancelación de un proceso `Custom` detiene la ejecución, conserva todos los
efectos aún presentes en el estado y devuelve código `130`. No se hace rollback
de los efectos ya reconciliados.

### Salida

La salida mantiene el envelope común definido por ADR-0015. Las acciones
observables usan los mismos nombres en formato humano y JSON:

- `removed`;
- `already-absent`;
- `preserved-preexisting`;
- `unsupported`;
- `blocked`;
- `failed`.

`uninstall-unsupported` sigue siendo un warning no bloqueante. Los errores de
preflight y los fallos requeridos producen estado de comando `error` y código
distinto de cero; solo warnings de efectos opcionales o `Custom` no soportado
mantienen código cero.

## Compatibilidad y seguridad

- Los estados existentes sin `sequence` siguen siendo legibles.
- Un estado ausente no provoca un escaneo especulativo del repositorio para
  inferir ownership.
- Un estado inválido nunca se modifica parcialmente.
- La escritura atómica reduce el riesgo de dejar un registro YAML truncado;
  no se promete coordinación entre dos procesos concurrentes.
- `--force` solo amplía las dos reglas de drift documentadas y no autoriza
  borrar contenido sin ownership ni resolver conflictos.
- La ejecución de código `Custom` conserva la autorización explícita por
  `--allow-custom` incluso al recuperar revisiones históricas.

## Verificación

Las pruebas deben demostrar como mínimo:

- eliminación de `File` propio sin drift y del estado correspondiente;
- preservación de `File` preexistente y retirada de su registro;
- `already-absent` para targets ya eliminados;
- eliminación de un único managed block sin tocar contenido ajeno;
- drift bloqueado por defecto y comportamiento limitado de `--force`;
- conflictos estructurales bloqueantes incluso con `--force`;
- `Custom.uninstall` histórico, autorización, timeout, cancelación y ausencia
  de handler con `uninstall-unsupported`;
- orden inverso, `sequence` nuevo al actualizar un efecto y fallback de estados
  antiguos;
- preflight completo sin mutaciones parciales;
- checkpoint y reconciliación tras fallo requerido, fallo opcional y
  cancelación;
- estado ausente, estado inválido, escritura atómica y salida humana/JSON;
- suite completa, typecheck y checks de calidad existentes.

## Alternativas descartadas

- Usar el manifiesto o Recipe actuales como fuente única: no permite retirar
  con seguridad efectos históricos cuando el Source cambió o desapareció.
- Añadir estados `pending`/`completed` por efecto: la presencia en
  `state.effects` ya representa lo pendiente y eliminar el efecto al completar
  es suficiente.
- Repetir toda la instalación para desinstalar: mezcla estado actual con
  efectos históricos y rompe la reconciliación tras cambios de Source.
- Añadir un comando `reconcile`: la ejecución posterior de `uninstall` ya es
  el contrato acordado.
- Resolver conflictos con heurísticas en `--force`: podría borrar contenido
  ajeno y contradice la garantía de ownership.
