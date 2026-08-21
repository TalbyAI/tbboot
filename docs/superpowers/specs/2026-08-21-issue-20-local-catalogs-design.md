# Diseño: Catalogs locales para descubrir Sources

**Issue:** #20  
**Estado:** aprobado en la conversación; pendiente de revisión del documento escrito  
**Fecha:** 2026-08-21

## Objetivo

Permitir registrar y consultar Catalogs locales opcionales para descubrir
Sources mediante `title`, `description` y `keywords`, sin convertir el Catalog
en una dependencia de `doctor` o `install`. Una Source declarada directamente
seguirá funcionando aunque el registro local no exista.

## Decisiones de alcance

- La CLI añade `catalog add`, `catalog list`, `catalog info`, `catalog search`
  y `catalog remove`.
- Las entradas de un Catalog no tienen `id`. El registro sí tiene un nombre
  humano por Catalog; ese nombre es el identificador usado por los comandos.
- La misma identidad normalizada de Source puede aparecer en Catalogs
  diferentes. Solo es conflicto cuando aparece dos veces dentro del mismo
  Catalog.
- `add` registra la referencia al archivo Catalog; no copia ni modifica ese
  archivo, ni materializa o resuelve sus Sources.
- La búsqueda es local y determinista. No usa red, embeddings, LLM ni un
  servicio externo.

## Registro local

El registro se guarda en `%USERPROFILE%\.tbboot\catalogs.yaml` y tiene su
propio documento versionado:

```yaml
schemaVersion: 1
catalogs:
  - name: team
    path: C:/shared/catalog.yaml
```

El registro contiene únicamente `name` y `path` por entrada. `path` se
almacena como path absoluto y normalizado. Dos paths normalizados iguales son
un conflicto aunque estén asociados a nombres distintos.

Los nombres se comparan sin distinguir mayúsculas/minúsculas para detectar
duplicados y resolver comandos, pero se conserva la grafía registrada para la
salida. El nombre por defecto de `add` es el basename del path sin su
extensión: `team.yaml` produce `team`.

La ausencia inicial de `catalogs.yaml` equivale a un registro vacío para
`list` y `search`. Un registro existente que no pueda validarse es un error.
Las escrituras del registro se harán después de completar la validación y se
reemplazará el archivo de forma segura, sin tocar los Catalogs referenciados.

## Comandos

```text
tbboot catalog add <path> [name] [--json]
tbboot catalog list [--json]
tbboot catalog info <name-or-path> [--json]
tbboot catalog search <term> [catalog-name] [--json]
tbboot catalog remove <name-or-path> [--json]
```

### `catalog add`

Resuelve el path recibido, lo valida como documento `catalog`, calcula las
identidades normalizadas de sus entradas y comprueba que no haya duplicados
internos. Si no se indica nombre, usa el basename sin extensión. Rechaza
nombres duplicados sin distinguir mayúsculas/minúsculas y paths normalizados
duplicados. Solo después de todas las comprobaciones actualiza el registro.

### `catalog list`

Enumera los Catalogs registrados por nombre y path. Al leer cada archivo
indica los Catalogs ausentes o inválidos mediante diagnósticos; no repara el
registro ni modifica los archivos.

### `catalog info`

Acepta un nombre registrado o un path. Para un nombre, resuelve la entrada del
registro; para un path, puede inspeccionar un Catalog aunque todavía no esté
registrado. Valida el archivo y muestra su nombre registrado cuando exista,
path, cantidad de entradas y las entradas válidas. Un archivo inválido se
devuelve con sus diagnósticos en lugar de datos parciales.

### `catalog search`

Busca en todos los Catalogs registrados si no se proporciona `catalog-name`.
Con ese argumento limita la búsqueda al Catalog cuyo nombre coincida sin
distinguir mayúsculas/minúsculas.

La consulta se divide por espacios. Cada término debe aparecer como substring,
sin distinguir mayúsculas/minúsculas, en al menos uno de `title`,
`description` o `keywords`. La salida incluye el nombre del Catalog, metadata
de la entrada y la Source reference declarada. Los resultados se ordenan por
nombre de Catalog, `title` e identidad normalizada de Source. Cero resultados
es una respuesta exitosa con una lista vacía.

### `catalog remove`

Acepta un nombre registrado o un path normalizado. Elimina únicamente la
entrada del registro. Nunca elimina ni modifica el archivo Catalog.

## Validación e identidad

La validación de Catalogs reutiliza `validateDocument` y el schema existente de
`catalog`. El registro local obtiene una forma tipada y un schema versionado
propio dentro del contrato, sin alterar la forma de las entradas de Catalog.

Para una entrada con provider `local`, un `locator.path` relativo se resuelve
respecto al directorio del archivo Catalog. Para una entrada Git, un repository
relativo usa esa misma base; URLs Git se conservan como locators remotos y el
path interno se normaliza con las reglas Git existentes. `add` no necesita
clonar ni consultar un repository Git.

La identidad de Source combina provider y locator normalizado. El selector no
forma parte de ella. La comparación de identidades usa los helpers existentes
de normalización de paths y Git, con la misma semántica de filesystem que el
resto de la CLI.

Los diagnósticos mínimos y estables serán:

- `catalog-registry-invalid` para un registro local inválido.
- `catalog-name-duplicate` para nombres repetidos sin distinguir mayúsculas.
- `catalog-path-duplicate` para paths registrados duplicados.
- `catalog-validation-failed` para un Catalog que no pasa el contrato.
- `catalog-entry-duplicate-source` para identidades duplicadas dentro de un
  Catalog.
- `catalog-not-found` cuando un nombre o path solicitado no existe.
- `catalog-read-failed` cuando el archivo registrado no puede leerse.

Los errores de uso de argumentos siguen devolviendo `2`. Las operaciones
válidas que encuentran un Catalog inválido devuelven un envelope de error. Los
comandos de lectura no escriben el registro; `add` y `remove` solo lo escriben
tras superar sus validaciones.

## Salida

Los cinco comandos aceptan `--json` y reutilizan el envelope común de la CLI:

```text
{ schemaVersion, command, status, changed, actions, diagnostics }
```

La información específica se incorpora en el resultado del comando: lista de
Catalogs para `list`, un Catalog para `info` y resultados de búsqueda para
`search`. En modo humano se muestran nombre, path, metadata y diagnósticos en
formato breve. `stdout` contiene exactamente un documento JSON en modo JSON y
`stderr` queda reservado para errores de uso o logs.

## Componentes y flujo

- `src/contract.ts` define el tipo del registro, el documento Catalog y sus
  validaciones.
- Un módulo de Catalogs concentra carga/escritura del registro, resolución de
  nombres o paths, validación de archivos, normalización de identidades y
  búsqueda. No duplica el planificador de `doctor`.
- `src/cli.ts` añade el routing y el parsing de los cinco comandos, conservando
  `node:util.parseArgs` y el envelope existente.
- `src/git.ts` y los helpers compartidos siguen siendo la fuente de verdad
  para normalización Git y paths.
- `doctor`, `install` y `uninstall` no consultan `%USERPROFILE%\.tbboot\catalogs.yaml`.

El flujo de una operación es: cargar y validar el registro, resolver el
selector de Catalog, leer y validar el archivo Catalog, normalizar sus
Sources, producir diagnósticos y datos deterministas, y escribir solo cuando
la operación sea `add` o `remove` y todas sus precondiciones hayan pasado.

## Pruebas

La aceptación atraviesa la CLI real y reutiliza los helpers de proceso y
fixtures existentes. Las pruebas cubrirán:

- creación del registro, nombre por defecto, nombres explícitos,
  case-insensitive y paths normalizados duplicados;
- `list`, `info` por nombre y path, `remove` por nombre y path, y la garantía
  de que nunca se borra el archivo Catalog;
- Catalogs válidos, YAML inválido, archivo ausente, schemaVersion inválido y
  duplicados internos de Source;
- paths locales relativos al directorio del Catalog y referencias Git sin
  consultas remotas;
- búsqueda global y acotada, coincidencias en los tres campos, varios
  términos, cero resultados y orden determinista;
- salida humana, salida JSON única, códigos de uso y ausencia de escrituras en
  las operaciones de lectura;
- `doctor` e `install` funcionando igual con y sin registro de Catalogs.

No se añade una caché derivada ni una dependencia externa.

## Fuera de alcance

- Instalar una Source directamente desde un resultado de búsqueda.
- Editar o publicar archivos Catalog desde la CLI.
- Resolver revisiones Git o crear/actualizar lockfiles durante discovery.
- Marketplace, registro central, embeddings, LLM, secretos o plugins.
- IDs dentro de las entradas de Catalog.
