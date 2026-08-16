# Diseño: CLI productiva de `doctor`

## Objetivo

El Issue #13 inicia la implementación de producción de tbboot. Entrega el
primer comando de la CLI, `doctor`, para diagnosticar Sources locales y sus
Recipes sin modificar el Consumer repository ni ningún estado externo.

Los prototipos de los Issues #5, #9 y #12 son evidencia, contrato, fixtures o
harness reutilizables. No son una dependencia ni la ubicación de la
implementación productiva.

## Alcance

`doctor` cubrirá:

- un Consumer repository seleccionado por `--root` o, por defecto, el
  directorio actual;
- el Manifest `tbboot.yaml`;
- Source references con provider `local`;
- `source.yaml` y Recipes de primer nivel con `recipe.yaml`;
- validación de documentos mediante el contrato cerrado de schemaVersion 1;
- validación de rutas y orden declarado de Steps;
- comprobación de File y File Fragment steps;
- salida humana y el envelope JSON común de ADR-0015.

Git, escritura de instalación, Source dependencies, Custom, uninstall,
Catalogs y selección efectiva de Recipes quedan fuera de esta slice y se
integrarán posteriormente sobre las mismas fronteras.

## Estructura productiva

La implementación vivirá en la raíz del repositorio:

```text
package.json
schemas/contract-v1.json
src/
  cli.ts
  contract.ts
  doctor.ts
test/
  doctor.e2e.test.ts
```

El paquete usará Node `>=24.12 <25` y el type stripping nativo de Node. No se
añade un compilador TypeScript ni un workspace mientras la CLI sea el único
paquete ejecutable.

El schema de producción se promoverá a `schemas/contract-v1.json`. El código
productivo no importará desde `prototypes/issue-9`; el prototipo permanecerá
como evidencia reproducible del contrato.

Dependencias directas: `yaml` para parseo YAML 1.2 y `ajv` para la validación
del schema existente. El resto usará APIs nativas de Node.

## Interfaz de la CLI

```text
tbboot doctor [--root <consumer-root>] [--json]
```

`--root` se normaliza a una ruta absoluta. Si se omite, se usa el directorio
actual. Los argumentos desconocidos producen uso en stderr y código `2`.

En modo humano, stdout contiene diagnósticos y estados accionables. En modo
`--json`, stdout contiene exactamente un documento JSON y no recibe logs ni
mensajes auxiliares.

El envelope es:

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "status": "ok",
  "changed": false,
  "actions": [],
  "diagnostics": []
}
```

`status` es `ok`, `warning` o `error`. Cada acción de comprobación incluye
como mínimo `source`, `recipe`, `step`, `type`, `target` y `state`, donde
`state` es `satisfied`, `missing`, `drift` o `conflict`. Cada diagnóstico
conserva `code`, `severity: "error"` o `"warning"`, `message` y el contexto
disponible del contrato común.

Un incumplimiento de un Step requerido eleva el envelope a `error` y devuelve
código distinto de cero. Un incumplimiento de un Step opcional se registra
como warning y no falla por sí solo. Una ejecución satisfactoria devuelve `0`.

## Flujo de diagnóstico

1. Parsear argumentos y obtener la raíz del Consumer repository.
2. Leer y validar `tbboot.yaml` antes de resolver Sources.
3. Rechazar providers distintos de `local` en esta slice con un diagnóstico
   estable; no se ejecuta Git.
4. Resolver cada locator local y rechazar referencias duplicadas por identidad
   normalizada.
5. Leer `source.yaml` y descubrir, en orden determinista, solo carpetas de
   primer nivel que contengan `recipe.yaml`.
6. Validar cada Recipe y conservar el índice one-based del Step para el
   contexto de diagnóstico.
7. Resolver inputs relativos a la carpeta de la Recipe y targets relativos al
   Consumer repository. La canonicalización mediante `realpath` y enlaces no
   puede permitir que una ruta escape de su raíz permitida.
8. Registrar colisiones de targets antes de producir el resultado.
9. Comprobar cada Artifact y agregar acciones y diagnósticos al envelope.
10. Serializar una única salida y asignar el código de salida según la
    severidad agregada.

No se llamará a `mkdir`, `writeFile`, `rm`, `rename` ni a APIs equivalentes.
La creación de lockfile, `.tbboot`, trust store, cachés o metadatos queda
prohibida durante todo el comando.

## Comprobación de Artifacts

### File step

- Se lee el input dentro de la raíz del Source.
- Se lee el target dentro de la raíz del Consumer repository.
- Target ausente produce `missing`.
- Target existente con bytes idénticos produce `satisfied`.
- Target existente con contenido distinto produce `drift`.
- Input ausente, escape de raíz, target que resuelve fuera del Consumer
  repository o colisión con otro escritor produce `conflict` y diagnóstico.

### File Fragment step

Se conserva el formato decidido por ADR-0005:

```text
<!-- managed-by: <source-folder>/<recipe-path> -->
...
<!-- end-managed-by: <source-folder>/<recipe-path> -->
```

- Target ausente o bloque ausente produce `missing`.
- Bloque completo e idéntico produce `satisfied`.
- Bloque existente con contenido diferente produce `drift`.
- Marcadores duplicados, incompletos, incompatibles o colisiones de marker
  producen `conflict`.
- Varios File Fragment steps pueden compartir target si sus markers son
  distintos; un File step no puede compartir target con ningún escritor.

Las comprobaciones no calculan ni aplican contenido nuevo: solo leen el
estado actual.

## Diagnósticos y contexto

Los diagnósticos del contrato de #9 se conservan sin cambiar sus códigos:

`yaml-parse-error`, `schema-version-missing`,
`schema-version-unsupported`, `schema-validation-failed`, `recipes-empty`,
`recipes-not-supported` y `requires-not-supported`.

La slice añade estos códigos de operación para lectura local, rutas y
Artifacts:

- lectura y descubrimiento: `manifest-read`, `source-read`, `recipe-read`,
  `unsupported-source-provider`, `duplicate-source` y `unsupported-step`;
- rutas e inputs: `source-input-missing`, `source-input-escape`,
  `target-escape` y `target-read`;
- File: `file-missing`, `file-drift` y `file-target-collision`;
- File Fragment: `fragment-missing`, `fragment-drift`,
  `fragment-marker-collision` e `incomplete-fragment`.

Todos mantienen el mismo envelope y contexto: `document`, JSON Pointer
`path`, `source`, `recipe` y `step` cuando existan. No se reutilizarán códigos
de Git, Custom, instalación o uninstall antes de implementar esas
capacidades.

## Pruebas

La seam principal es la CLI real ejecutada como proceso. Las pruebas usarán
Consumer repositories y Sources temporales y observarán únicamente:

- código de salida;
- stdout y stderr;
- envelope y diagnósticos;
- estados de File y File Fragment;
- snapshot byte-for-byte de todos los archivos antes y después.

La matriz mínima cubre:

- Manifest, Source y Recipe válidos;
- YAML vacío, inválido, schemaVersion desconocido y campos desconocidos;
- descubrimiento determinista de Recipes y orden de Steps;
- File satisfecho, ausente, drift y conflicto;
- File Fragment satisfecho, ausente, drift, marker incompleto y colisión;
- Step opcional con warning;
- salida humana, JSON único y logs fuera de stdout;
- ausencia de escrituras en Artifacts, lockfile, Installation record, trust y
  metadatos.

## Decisiones y alternativas descartadas

- Se elige un paquete único en la raíz en lugar de un workspace: es la menor
  estructura que permite publicar y extender la CLI.
- Se separan solo `cli`, contrato y doctor: cada módulo tiene una frontera
  observable y no se introduce una arquitectura de dominio prematura.
- Se promueve el schema al área productiva en lugar de importar el prototipo:
  la implementación no queda acoplada a una fixture experimental.
- Se prueba mediante proceso E2E en lugar de probar internals como contrato:
  esto verifica la promesa real de stdout, exit code y read-only.
