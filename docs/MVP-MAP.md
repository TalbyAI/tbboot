# tbboot MVP map

Estado: contrato del MVP casi cerrado; esquemas, publicación e investigación técnica pendientes
Última actualización: 2026-08-14
Progreso orientativo de definición: **~96%**

Este documento es un mapa de decisiones, no la especificación final ni un plan de implementación. El porcentaje mide el avance de definición del contrato, no el código construido.

## Cómo se calcula el progreso

Cada decisión identificada pesa lo mismo:

`decisiones confirmadas / (confirmadas + abiertas + investigación pendiente)`

Las hipótesis no se cuentan como decisiones cerradas. El porcentaje se actualizará durante la entrevista y podrá cambiar si una decisión confirmada se revisa.

## Hechos validados

- El Issue #5 está cerrado mediante el PR #6.
- El prototipo validó 12/12 escenarios de la propuesta.
- La comparación con chezmoi no se ejercitó porque no estaba instalado y no se repetirá salvo necesidad.
- El producto será una herramienta diferenciada en TypeScript sobre Node.js.
- El prototipo validó archivos, `File Fragment step`, preflight, drift, conflictos, dry-run, doctor e idempotencia.
- Los Issues #1, #2 y #3 están fuera del MVP; el Issue #4 se evalúa durante esta definición.
- En los repositorios locales inspeccionados, Node/npm aparecen con frecuencia; en la sesión están disponibles Node v24.14.1 y npm 11.17.0. No existe todavía una población formal de repositorios objetivo.

## Decisiones confirmadas

### Producto y plataforma

- Node.js LTS y npm son prerrequisitos explícitos. tbboot no instala su propio runtime.
- El MVP soporta Node `>=24.12 <25`; npm usa la versión incluida con Node 24 y no tiene mínimo independiente.
- El modelo declarativo se prepara para varias plataformas, pero el único proveedor de instalación garantizado por el MVP es Windows x64.
- macOS, Linux, WSL, ARM64 y soporte multiplataforma completo quedan fuera de la garantía del MVP.

### Lenguaje del dominio e identidad

- El término canónico es `File Fragment step`; no se usa `text-block`.
- `Source` es una definición de una colección relacionada de Recipes.
- `Recipe` es una definición reutilizable de Steps ordenados.
- `Step` es una operación ordenada que detecta o genera un Artifact.
- Se eliminan los campos `id` de `source.yaml` y `recipe.yaml`.
- La identidad de un Source es `provider + locator` normalizado, sin incluir el selector.
- La identidad de una Recipe se deriva de su ruta relativa dentro del Source.
- Dos locators distintos no se unifican por compartir un nombre.

### Manifest y Sources

- El Manifest canónico es `tbboot.yaml` en la raíz del repositorio consumidor; `manifest.yaml` pertenece solo al prototipo.
- Todos los documentos YAML authored o generados declaran `schemaVersion: 1`; una versión desconocida falla antes de escribir.
- El `Manifest` puede declarar Sources completos directamente.
- Cada Source declarado instala todas sus Recipes; la selección de subconjuntos queda fuera del contrato del MVP.
- Los Source providers iniciales son local y Git.
- Las dependencias reutilizan la misma forma de declaración de Source que `Manifest.sources`.
- Las referencias de Source usan una forma estructurada canónica con provider, locator y selector opcional; sus componentes adicionales dependen del provider.
- `source.yaml` no declara versión ni enumera Recipes.
- `source.yaml` puede declarar Source dependencies.
- Las Recipes se descubren solo en carpetas de primer nivel que contengan `recipe.yaml`; no hay descubrimiento recursivo implícito.

### Locators

- La estructura del locator es provider-specific.
- El provider local recibe directamente la ruta a la carpeta del Source y no admite una segunda subruta.
- Git admite repositorio y un `path` opcional dentro del repositorio.
- El `path` Git es relativo a la raíz, normalizado, sin rutas absolutas, `..` ni globs.
- Sin `path`, el Source Git está en la raíz del repositorio.
- La carpeta localizada debe contener `source.yaml`.
- En Git, `repository + path` forma parte de la identidad del Source.

### Catalogs

- Un `Catalog` indexa Sources completos, no Recipes ni Artifacts.
- Un catálogo no es obligatorio para instalar un Source directo.
- Los catálogos incluyen metadatos de descubrimiento, inicialmente `title`, `description` y `keywords`.
- Cada entrada de catálogo envuelve una referencia estructurada de Source; no tiene `id` y las identidades normalizadas duplicadas son inválidas.
- El MVP ofrece búsqueda local determinista por keywords.
- La búsqueda semántica con embeddings, LLM o servicios externos queda fuera y requiere investigación posterior.

### Selectors y Git

- El campo común es `selector`, no `version`.
- La sintaxis y las capacidades del selector pertenecen al provider.
- El provider local solo acepta selector ausente o vacío.
- Git usa `selector.ref` para una etiqueta o rama exacta y `selector.from`/`selector.to` para rangos inclusivos.
- Las refs Git pueden ser cortas o `refs/tags/...`/`refs/heads/...`; una colisión tag-rama en nombre corto es error de ambigüedad.
- Git puede aceptar tags y ramas exactos, además de rangos acotados.
- Un tag o rama se resuelve al commit observado; el commit resuelto se guarda en el lockfile.
- `install` usa una entrada compatible del lockfile como fuente autoritativa; si no existe, resuelve el selector y guarda el commit.
- Un selector cambiado o un lockfile obsoleto produce error; renovar la resolución requiere un flag explícito de actualización.
- El lockfile es `tbboot.lock.yaml`, vive en la raíz del repositorio consumidor junto al Manifest y se versiona con él.
- `install` usa el lockfile como autoritativo; `--update-lock` renueva resoluciones y `--frozen-lockfile` prohíbe crear o modificar el lockfile y falla si falta o está obsoleto.
- En el MVP, cada entrada del lockfile contiene provider, locator normalizado, selector original, revisión resuelta y huella del contenido.
- Los resultados reales de instalación nunca pertenecen al lockfile; se guardan en la Installation record.
- La Installation record vive en `.tbboot/state.yaml`, es local al checkout y no se versiona; `.tbboot/.gitignore` controla qué estado de esa carpeta se ignora.
- Durante `install`, tbboot garantiza `/state.yaml` en `.tbboot/.gitignore` preservando otras entradas; `doctor` y dry-run no escriben esos metadatos.
- Tras comenzar escrituras no hay rollback: se registra lo completado, un fallo obligatorio o cancelación detiene el plan, un fallo opcional continúa como warning y la siguiente ejecución reconcilia.
- Dirección futura: cuando se implemente la selección de Recipes, el lockfile fijará también el grafo efectivo resuelto para que `--frozen-lockfile` garantice el plan completo.
- Los rangos Git tienen dos refs y límites inclusivos.
- El límite inferior debe ser ancestro del superior.
- La comparación se basa en ascendencia del grafo Git, no en fechas cronológicas.
- Un rango con límites iguales selecciona un único commit.
- Una intersección con varios máximos no comparables es conflicto.
- Los selectores de techo sin límite superior, como `^from`, quedan fuera del MVP.

### Source dependencies

- Las dependencias pertenecen al Source y son entre Sources completos.
- Una dependencia puede usar un Source para satisfacer prerrequisitos de Recipes de otro Source.
- `doctor` e `install` procesan cada Source dependency antes que el Source dependiente; `uninstall` recorre el orden efectivo inverso.
- La resolución es transitiva y ordenada por dependencias.
- Si varias ramas del grafo transitivo convergen en la misma identidad y selectors compatibles, se intersectan y el Source se procesa una sola vez. Repetir en una lista la misma identidad con un selector equivalente es un duplicado; selectors distintos se intersectan y una intersección incompatible falla en preflight.
- Los ciclos de Source dependencies y los conflictos de resolución fallan en preflight; el diagnóstico de ciclo muestra la ruta completa.
- Los catálogos pueden indexar dependencias, pero no son la fuente obligatoria para instalar un Source directo.

### Steps y Custom

- Todos los Steps son obligatorios por defecto.
- `optional: true` hace que un Step sea no bloqueante.
- Un fallo opcional genera un warning y permite continuar.
- Un fallo obligatorio bloquea la Recipe.
- Si solo fallan Steps opcionales, la operación termina con código `0`; un fallo obligatorio produce código distinto de `0`.
- `Custom step` forma parte del MVP.
- La presencia de un Custom step se detecta al leer una Recipe; el Manifest no la declara ni la autoriza.
- Un Custom step tiene entrypoints separados para `check`, `install` y `uninstall`.
- Cada operación puede declarar su propio runtime.
- Cada operación admite exactamente una forma de ejecución: `script` externo o `content` inline.
- Dirección futura: cada operación podrá declarar candidatos ordenados de runtime, con restricciones de versión específicas del runtime; se usará el primer candidato disponible y compatible.
- `script` o `content` pertenecen a cada candidato de runtime y no a la operación global.
- El selector de runtime es opcional: sin selector se aplica el mínimo recomendado por el provider; uno explícito puede permitir una versión anterior.
- El MVP resuelve un único runtime por operación y solo implementa `node` y PowerShell 7.
- PowerShell 7 y Windows PowerShell 5.1 son runtimes distintos; Windows PowerShell no es un objetivo separado del MVP.
- Los nombres canónicos son `node`, `pwsh` (PowerShell 7) y `windows-powershell` (Windows PowerShell 5.1); el MVP implementa solo `node` y `pwsh`.
- Los rangos por defecto del MVP son Node `>=24.12 <25` y PowerShell `>=7.6 <8`.
- `node` ejecuta JavaScript directamente y TypeScript con el type stripping nativo, sin flags ni runner auxiliar. El MVP admite solo sintaxis TypeScript borrable; construcciones como `enum` y parameter properties, que en Node 24 requieren `--experimental-transform-types`, quedan fuera.
- En el MVP, `File step` y `File Fragment step` son los únicos Steps incorporados; el resto del comportamiento, incluidas las comprobaciones de comandos, usa `Custom step`.
- El MVP no incluye `package step` ni integración WinGet; las instalaciones Windows declaradas por una Recipe usan `Custom.install` autorizado.
- Los patrones seguros y repetidos de `Custom step` podrán promoverse posteriormente a Steps específicos.
- El `check` se ejecuta desde `doctor` y debe ser de solo lectura.
- El protocolo de procesos usa JSON por `stdin`, un único resultado JSON por `stdout` y logs por `stderr`.
- Cada runtime adapta un handler asíncrono común: `content` es el cuerpo envuelto por tbboot, `script` expone el handler del runtime y los Steps incorporados comparten el contrato lógico internamente.
- El código de salida `0` indica resultado JSON válido; cualquier otro código indica fallo del runner o del script. El objeto JSON contiene el estado semántico del Step.
- El envelope mínimo es `{ status, changed, message?, details? }`, con estados `ok`, `missing`, `drift` y `error`.
- Cada operación recibe un request JSON por `stdin`, se ejecuta con el repositorio consumidor como directorio de trabajo y no recibe secretos por este contrato.
- `check` es obligatorio en todo `Custom`; `install` es opcional para permitir Steps solo de doctor; `uninstall` solo puede existir si existe `install`.
- `doctor` siempre ejecuta `check`; `install` ejecuta `install` cuando existe y después `check`, o solo `check` en un Step de validación.
- Un Step solo de `check` nunca instala ni actualiza Node implícitamente; esa acción requiere una operación `install` declarada por la Recipe.
- La autorización de Custom no es un sandbox: el proceso usa los permisos normales de tbboot; el MVP no aplica allowlists de filesystem/red ni eleva privilegios automáticamente.
- Los timeouts Custom son configurables por candidato; por defecto `check` tiene 60 segundos e `install`/`uninstall` 30 minutos. La expiración es error sujeto a opcionalidad.
- `Ctrl+C` termina el proceso Custom y sus descendientes, detiene el plan sin rollback, conserva lo completado y devuelve código `130`.
- Las rutas `Custom.script` son relativas a la carpeta de la Recipe; pueden subir a carpetas compartidas dentro de la Source, pero nunca escapar de la raíz de la Source.
- El drift de `File` y `File Fragment` bloquea escrituras por defecto; `install --force` permite sobrescribir el archivo o reemplazar solo el bloque gestionado, pero no resuelve conflictos estructurales.
- `install --dry-run` no ejecuta procesos Custom ni escribe. Valida estáticamente su autorización, runtime y definición, marca sus comprobaciones y acciones como aplazadas y construye el resto del plan.
- `doctor` es de solo lectura; devuelve código distinto de `0` si falla un requisito obligatorio y `0` si solo existen warnings de Steps opcionales.
- `doctor`, `install`, `install --dry-run` y `uninstall` ofrecen salida humana por defecto y `--json`; en JSON, stdout contiene un único documento y stderr queda para logs.
- El envelope JSON común es `{ schemaVersion, command, status, changed, actions, diagnostics }`; los diagnósticos incluyen `code`, `severity`, `message` y contexto disponible.
- `install` devuelve `0` solo cuando completa el plan obligatorio. `install --dry-run` devuelve `0` cuando pasa el preflight estático, aunque avisa de comprobaciones Custom aplazadas; conflictos, errores de preflight, fallos obligatorios observados o drift sin `--force` devuelven distinto de `0`.
- `uninstall` retira efectos gestionados en orden inverso: elimina Files creados sin drift, conserva Files preexistentes sobrescritos, elimina solo bloques gestionados y ejecuta `Custom.uninstall` cuando existe; no restaura estados previos.
- El drift bloquea `uninstall`; con `--force` solo puede eliminarse un File creado por tbboot o un bloque gestionado, nunca un File preexistente sobrescrito. Los conflictos estructurales siguen siendo errores.
- Un `Custom` sin `uninstall` queda intacto, genera warning `uninstall-unsupported` y conserva su entrada en la Installation record; no hace fallar el comando por sí solo.
- El Issue #4 queda fuera del MVP como modo interactivo general: no hay menús de Sources, Recipes o catálogos, y el drift exige `--force` sin preguntar.
- La única interacción del MVP es la autorización de Custom una vez por Source; en modo no interactivo requiere perfil de confianza o `--allow-custom`.
- La autorización es externa al Manifest y se concede por Source y revisión resuelta.
- En modo interactivo se puede preguntar una vez por Source.
- En modo no interactivo no se pregunta.
- `--allow-custom <source>` concede autorización temporal para esa ejecución.
- La confianza persistente pertenece al perfil local.
- El perfil persistente vive en `~/.tbboot/trust.yaml` (`%USERPROFILE%\.tbboot\trust.yaml` en Windows) y una revisión nueva requiere autorización nueva.
- La decisión de autorización debe impedir escrituras parciales antes de ejecutar cualquier Step requerido bloqueado.

## Decisiones abiertas

### B. Selector Git

- Validación mediante prototipo de rangos, intersecciones y candidatos máximos en grafos Git divergentes.

### D. Custom step

- Detección exacta de ejecutables `node` y `pwsh` en Windows.
- Futuro no bloqueante: lista de candidatos de runtime y sintaxis de sus selectores de versión.

### E. Manifest, Source y Recipe schema

- Esquemas exactos y diagnósticos de validación para `tbboot.yaml`, `source.yaml`, `recipe.yaml` y catálogos.

### H. Aceptación

- Escenarios end-to-end del MVP.
- Matriz Windows x64 y versiones mínimas de Node/npm.
- Sources locales y Git con paths internos.
- Intersección de selectors y conflictos de dependencias.
- Custom autorizado, no autorizado, opcional y obligatorio.
- Rechazo explícito de campos de selección de Recipes o Recipe dependencies, que no pertenecen al contrato del MVP.
- Lockfile, drift, no-op e idempotencia.
- Salida humana y `--json`.

## Hipótesis y cuestiones de investigación

- La disponibilidad de Node/npm observada en los repositorios locales representa a los repositorios objetivo reales.
- Git ancestry es suficiente para la semántica de rangos; necesita un prototipo pequeño con ramas divergentes y múltiples restricciones.
- El uso interno justifica incluir Custom steps en el MVP sin un sandbox completo, aunque sí requiere autorización explícita.
- Un catálogo local puede resolver discovery sin convertirse en un registro central.

## Áreas de decisión

El siguiente porcentaje es orientativo y pondera por igual las decisiones identificadas dentro de cada área.

| Área                        | Estado       | Progreso | Principal pendiente                         |
| --------------------------- | ------------ | -------: | ------------------------------------------- |
| Bootstrap y plataforma      | Cerrada      |     100% | Ninguna crítica                             |
| Lenguaje e identidad        | Cerrada      |     100% | Ninguna crítica                             |
| Locators                    | Cerrada      |     100% | Ninguna crítica                             |
| Manifest, Source y Recipe   | Casi cerrada |      95% | Schema y diagnósticos finales               |
| Catalogs                    | Casi cerrada |      95% | Schema y salida de búsqueda                 |
| Selectors y lockfile        | En curso     |      90% | Validación técnica de rangos Git            |
| Steps incorporados          | Cerrada      |     100% | Ninguna crítica                             |
| Custom y seguridad          | Casi cerrada |      95% | Detección técnica de ejecutables            |
| Doctor, install y uninstall | Cerrada      |     100% | Ninguna crítica                             |
| Interactividad y aceptación | En curso     |      90% | Escenarios finales                          |

## Fuera de alcance explícito

- Marketplace o registro central.
- Plugins de terceros como mecanismo de extensión.
- Secretos dentro del Manifest o Sources.
- Rollback completo.
- Instalación de drivers, servicios o componentes que requieran reinicio.
- Soporte de instalación completo para macOS/Linux.
- Selección de Recipes y Recipe dependencies.
- Parametrización de File steps.
- Generalización de delimitadores de File Fragment steps.

## Referencias

- [CONTEXT.md](../CONTEXT.md)
- [Project approach](PROJECT-APPROACH.md)
- [Issue 5 prototype](../prototypes/issue-5/README.md)
- [Comparison report](../prototypes/issue-5/comparison-report.md)
- [ADRs](adr/)
