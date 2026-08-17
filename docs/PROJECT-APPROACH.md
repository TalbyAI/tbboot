# Project Approach: contrato de entorno del repositorio

## TL;DR

Todavía no se ha decidido construir una herramienta propia. El siguiente paso es un prototipo comparativo que pruebe el núcleo frente a una composición de herramientas existentes. Solo se construirá un producto diferenciado si demuestra una ventaja clara.

## Validated Prototype Direction

The prototype will use a Windows test repository and compare:

- composition with existing tools plus the smallest necessary integration repository;
- the proposed declarative model with local sources, recipes, `doctor`, `install --dry-run`, and `install`.

Its source model is deliberately small:

- a source folder contains `source.yaml` and first-level recipe folders;
- a recipe folder is discovered by the presence of `recipe.yaml`;
- recipes contain ordered `file` and `file-fragment` steps only;
- local source references are relative, absolute, or UNC paths without a `file:` prefix;
- source installation includes all recipes; individual recipe selection, catalogs, Git providers, versions, parameters, command checks, and interactive mode are deferred.

`CONTEXT.md` and the ADRs in `docs/adr/` capture the accepted domain language and safety boundaries. The exploratory recommendations below remain hypotheses until the comparison is complete.

La idea solo se considerará viable como producto propio si la semántica declarativa ofrece una ventaja clara frente a la composición.

El núcleo debería ser:

1. Un manifiesto versionado dentro del repositorio.
2. Catálogos versionados de artefactos reutilizables.
3. `doctor`, siempre de solo lectura.
4. `install`, que aplica el manifiesto sin modificarlo.
5. Comprobaciones seguras para archivos, fragmentos y herramientas.

Recomiendo empezar con TypeScript/Node y distribución mediante npm. Mantendría Go como segunda fase si Node/npm resulta ser un obstáculo de bootstrap.

## Project Frame

El producto resuelve una diferencia importante:

- Un `README` describe manualmente el entorno, pero no lo verifica.
- Un Dev Container crea un entorno aislado, pero exige que el equipo adopte contenedores.
- Tu herramienta verifica y modifica el entorno real del desarrollador, sin sandbox obligatorio.

El usuario principal son equipos y organizaciones que quieren:

- reducir el tiempo de incorporación;
- comprobar que todos trabajan con las herramientas correctas;
- reutilizar configuraciones comunes entre repositorios;
- instalar instrucciones, configuraciones y herramientas de forma idempotente;
- ejecutar la validación también en CI.

Interpreto “GLOW” como “Go”.

Criterios principales:

- velocidad de desarrollo;
- bajo coste operativo;
- simplicidad;
- seguridad;
- compatibilidad Windows/macOS/Linux;
- poca dependencia de una plataforma central.

La métrica de éxito inicial debería ser sencilla: un desarrollador nuevo ejecuta un comando, obtiene un diagnóstico claro y puede dejar el repositorio listo sin copiar instrucciones manualmente.

## Evidence Reviewed

- Descripción y restricciones proporcionadas por ti.
- No se inspeccionó el repositorio actual, por indicación expresa.
- Investigación oficial realizada el 11 de agosto de 2026.
- No se usaron X, Reddit ni YouTube.
- Se revisaron Dev Containers, mise, chezmoi, Ansible, skills CLI, npm y Go.

## Comparable Projects

1. **Dev Container Specification** — [containers.dev](https://containers.dev/overview)

   Transfiere bien:

   - manifiestos declarativos;
   - componentes reutilizables;
   - separación entre configuración y ejecución;
   - integración con CI.

   No conviene copiar:

   - dependencia de Docker o contenedores;
   - aislamiento como requisito;
   - ciclo de vida basado en imágenes.

   La diferencia de producto debe ser explícita: tu herramienta configura el host existente; Dev Containers crean otro entorno.

2. **mise** — [configuración](https://mise.jdx.dev/configuration.html) y [instalación](https://mise.jdx.dev/cli/install.html)

   Ya combina herramientas, variables de entorno y tareas en un `mise.toml`, e instala versiones de herramientas por proyecto.

   Transfiere:

   - declaración de versiones;
   - configuración por proyecto;
   - instalación idempotente;
   - soporte de múltiples plataformas.

   No conviene copiar:

   - un catálogo enorme de backends;
   - gestión de tareas y shell activation;
   - convertirse en otro gestor de toolchains.

   Puede ser un backend futuro, pero no debería definir toda tu arquitectura.

3. **chezmoi** — [setup y aplicación](https://www.chezmoi.io/user-guide/setup/)

   Es relevante por su modelo de `diff`, `apply`, plantillas y configuración multiplataforma. También se distribuye como binario independiente sin dependencias externas.

   Transfiere:

   - mostrar cambios antes de aplicarlos;
   - evitar sobreescrituras silenciosas;
   - aplicar configuraciones de forma repetible;
   - diferenciar archivos comunes y específicos de cada máquina.

   No conviene copiar:

   - su enfoque centrado en dotfiles;
   - gestión de secretos y plantillas como parte del núcleo.

4. **Ansible Collections** — [catálogos, dependencias y fuentes](https://docs.ansible.com/projects/ansible/latest/collections_guide/collections_installing.html)

   Es la referencia más útil para catálogos, dependencias, fuentes Git, versiones y firmas.

   Transfiere:

   - catálogos autocontenidos;
   - dependencias declaradas por artefacto;
   - fuentes versionadas;
   - validación antes de instalar.

   No conviene copiar:

   - ejecución arbitraria de YAML;
   - complejidad de automatización de servidores;
   - arquitectura pesada para el caso local.

5. **skills CLI** — [CLI oficial](https://www.skills.sh/docs/cli)

   Es un buen modelo de UX para instalar elementos concretos desde una fuente, seleccionar skills y aplicar un alcance determinado. Tu producto podría ofrecer un adaptador para skills posteriormente, pero no debería limitarse a ese dominio.

## Arquitectura recomendada

```text
manifest.yaml
     │
     ├── referencias a catálogos
     └── artefactos requeridos
              │
              ▼
       resolvedor de dependencias
              │
              ▼
          plan de cambios
          ├── doctor
          └── install
              │
              ▼
      adaptadores del sistema operativo
      ├── archivos
      ├── fragmentos de texto
      ├── comandos/versiones
      └── gestores de paquetes
```

Los conceptos deben estar separados:

- **Manifest**: qué necesita este repositorio.
- **Catalog**: qué es cada artefacto y cómo se comprueba o instala.
- **Artifact**: una unidad concreta gestionable.
- **Provider**: cómo se instala en una plataforma concreta.
- **Lockfile**: qué versiones y fuentes se resolvieron realmente.

El manifiesto selecciona artefactos. El catálogo posee las dependencias. Por tanto, si `service-baseline` depende de `node`, esa dependencia debe declararse en el catálogo, no repetirse en cada repositorio.

## Modelo de artefacto

El MVP debería soportar solo estos tipos:

| Tipo | Ejemplo | Coste | Valor |
| --- | --- | ---: | ---: |
| `file` | Crear `.editorconfig` | Bajo | Alto |
| `text-block` | Insertar bloque en `AGENTS.md` | Bajo/medio | Alto |
| `command` | Verificar `npm >= 10` | Bajo | Alto |
| `package` | Instalar mediante `winget`, Homebrew o apt | Medio | Alto |
| `bundle` | Agrupar configuración de microservicio | Medio | Alto |
| `script` | Ejecutar comandos arbitrarios | Alto | Alto pero peligroso |

`script` no debe formar parte del MVP. Convierte cualquier catálogo remoto en código ejecutable con los permisos del usuario.

Para `AGENTS.md`, usaría bloques delimitados:

```md
<!-- managed-by: catalog/artifact -->
Contenido administrado
<!-- end-managed-by: catalog/artifact -->
```

Así puedes comprobar, actualizar y eliminar exactamente tu bloque sin intentar interpretar todo el Markdown.

## Comandos

Separaría claramente declaración y aplicación:

```text
tool add catalog/artifact     Modifica el manifiesto
tool doctor                   Comprueba el estado, sin escribir
tool install                  Aplica el manifiesto existente
tool install --dry-run        Muestra el plan
tool catalog validate         Valida un catálogo
tool catalog list             Lista sus artefactos
```

`install` no debería añadir automáticamente cosas al manifiesto. Si mezcla declaración y aplicación, una orden aparentemente inocua puede cambiar el contrato del repositorio.

El flujo de `install` debería ser:

1. Leer el manifiesto.
2. Resolver catálogos y dependencias.
3. Ejecutar todas las comprobaciones.
4. Mostrar el plan.
5. Pedir confirmación para cambios sensibles.
6. Aplicar cambios idempotentes.
7. Ejecutar `doctor` de nuevo.

## Qué debe declarar un catálogo

Cada catálogo debería tener:

```text
id
version
source
artifacts
```

Cada artefacto debería declarar:

```text
id
kind
description
platforms
check
install
dependencies
```

Reglas importantes:

- IDs únicos dentro del catálogo.
- Dependencias sin referencias rotas.
- Detección obligatoria.
- Instaladores específicos por plataforma.
- Ningún archivo o paquete gestionado fuera del inventario `artifacts`.
- Catálogos remotos referenciados mediante tag o commit.
- Sin comandos shell arbitrarios por defecto.

La búsqueda de catálogos y un registro central pueden esperar. Para el MVP basta con catálogos locales o repositorios Git versionados.

## Prioridad coste-beneficio

### MVP

1. Manifiesto con esquema validable.
2. `doctor` con salida humana y `--json`.
3. Artefactos `file`, `text-block` y `command`.
4. Catálogos locales y Git.
5. Dependencias entre artefactos.
6. `install --dry-run`.
7. Aplicación sin sobreescribir archivos modificados silenciosamente.
8. Un proveedor de instalación para la plataforma inicial, probablemente Windows.

La compatibilidad multiplataforma debe dividirse en tres niveles:

- manifiesto multiplataforma;
- `doctor` multiplataforma;
- instalación multiplataforma.

Puedes ofrecer los dos primeros desde el inicio y añadir proveedores de instalación progresivamente. Intentar soportar completamente `winget`, Homebrew, apt, Chocolatey, Scoop, npm, gestores de versiones y binarios descargables desde el primer día dispararía el coste.

### Segunda fase

- lockfile con versiones resueltas y hashes;
- proveedores macOS/Linux;
- instalación de binarios directos;
- perfiles reutilizables para microservicios;
- adaptador específico para skills;
- variables limitadas para rutas y nombres de proyecto.

### Más adelante

- plugins de terceros;
- scripts arbitrarios con permisos explícitos;
- registro central de catálogos;
- políticas organizativas;
- interfaz web;
- secretos;
- servicios del sistema, drivers y configuración de máquina completa.

## Stack y distribución

### Recomendación inicial: TypeScript + Node

Es la mejor opción para validar el producto rápidamente:

- encaja con `npx`;
- facilita manipular archivos y procesos;
- tiene buena experiencia multiplataforma;
- permite publicar inmediatamente;
- reduce el coste de desarrollo inicial.

Usaría pocas dependencias:

- `yaml` para manifiestos legibles;
- `ajv` o equivalente para validación de esquema;
- `semver` para versiones;
- APIs nativas de Node para archivos, procesos, hashes y argumentos.

El campo `bin` de npm permite publicar una orden ejecutable, y `npx` puede invocarla directamente. npm documenta tanto `bin` como las dependencias opcionales y los campos `os`/`cpu`. [Documentación de `package.json`](https://docs.npmjs.com/files/package.json/)

El problema es el bootstrap: si el repositorio no tiene Node/npm, no puede ejecutar `npx`. Por eso TypeScript deja de ser la mejor opción si tus usuarios trabajan frecuentemente en repositorios sin Node.

### Alternativa: Go

Go gana cuando:

- el usuario no tiene Node;
- la herramienta debe funcionar en CI minimalista;
- quieres distribuir un binario único;
- quieres reducir dependencias runtime.

Go permite compilar para distintos pares `GOOS`/`GOARCH` desde CI. [Documentación oficial de Go](https://go.dev/doc/install/source)

La distribución podría ser:

```text
@org/tool
@org/tool-win32-x64
@org/tool-darwin-arm64
@org/tool-linux-x64
```

El paquete principal seleccionaría el binario adecuado mediante dependencias opcionales y restricciones `os`/`cpu`.

No recomendaría compilar Go en la máquina del usuario. Publicaría binarios precompilados desde CI.

Evitaría inicialmente un `postinstall` que descargue un binario remoto: los scripts de instalación pueden estar deshabilitados y añaden una superficie de ataque. GoReleaser documenta esta limitación en su publicación npm. [GoReleaser npm](https://www.goreleaser.com/customization/publish/npm/)

## Seguridad mínima

Este producto escribe en el sistema y puede instalar software; la seguridad es parte del núcleo.

Debe tener desde el primer prototipo:

- `doctor` completamente de solo lectura;
- catálogo remoto tratado como no confiable;
- referencias Git fijadas a tags o commits;
- hashes para archivos descargables;
- nunca sobrescribir un archivo modificado sin confirmación;
- rutas restringidas al repositorio, directorio de configuración declarado o destino explícitamente autorizado;
- procesos ejecutados con argumentos separados, no concatenando strings shell;
- confirmación visible para privilegios elevados;
- ningún secreto dentro del manifiesto;
- salida explicando exactamente qué se va a escribir o instalar.

Más adelante puedes añadir firmas de catálogos y attestations. Sigstore documenta la verificación de blobs firmados, y GitHub documenta attestations de artefactos. [Sigstore](https://docs.sigstore.dev/cosign/verifying/verify/), [GitHub Artifact Attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

## Coste operativo

El MVP no necesita servidor, base de datos ni servicio gestionado:

- manifiestos dentro de Git;
- catálogos en repositorios Git;
- binarios en releases;
- CLI en npm.

El coste real aparecerá después en:

- matriz de compilación para plataformas;
- firma y publicación de binarios;
- hosting de catálogos privados;
- compatibilidad con gestores de paquetes;
- soporte de instalaciones fallidas;
- mantenimiento de adaptadores por sistema operativo.

## Alternativas

1. **Go desde el primer día**

   Ganas bootstrap independiente de Node y distribución sencilla para CI. Pierdes velocidad inicial de desarrollo y parte de la comodidad del ecosistema npm.

   Es la opción correcta si el primer usuario real trabaja en repositorios heterogéneos donde Node no está garantizado.

2. **Componer herramientas existentes**

   Usar `mise` para herramientas, `chezmoi` para archivos y un pequeño `doctor` propio reduce mucho el código inicial.

   Ganas velocidad de validación. Pierdes una semántica única, una experiencia coherente y control sobre catálogos y dependencias.

   Es una buena forma de validar la necesidad antes de construir un producto completo.

3. **Dev Containers o Nix**

   Son mejores si el requisito termina siendo reproducibilidad fuerte, aislamiento o control completo del toolchain. Tu recomendación deja de ser correcta cuando el host ya no debe modificarse o cuando la organización necesita entornos idénticos y efímeros.

## Build Plan

1. Crear un prototipo externo con un único repositorio de prueba:
   - comprobar `npm`;
   - comprobar una versión mínima;
   - crear un archivo;
   - insertar un bloque en `AGENTS.md`;
   - ejecutar `doctor` dos veces sin producir cambios inesperados.

2. Añadir catálogos Git y dependencias entre artefactos.

3. Añadir `install --dry-run`, confirmaciones y detección de drift.

4. Implementar el primer proveedor de instalación para Windows.

5. Publicar la CLI TypeScript mediante npm y probarla en CI.

6. Incorporar lockfile, hashes y proveedores adicionales solo después de observar qué instalaciones fallan realmente.

## Failure Conditions

La recomendación cambia si:

- Node/npm no está presente en una parte importante de los repositorios objetivo;
- se exige instalar drivers, servicios, componentes del sistema o software que requiere reinicios;
- se necesita reproducibilidad exacta y aislamiento;
- los catálogos deben ejecutar lógica arbitraria;
- se requiere una política central con auditoría, SSO y control organizativo;
- mantener proveedores para cada sistema operativo consume más tiempo que el valor que aportan.

La recomendación concreta es: **TypeScript primero, contrato declarativo + catálogos + `doctor` + `install` seguro; sin marketplace, plugins ni scripts arbitrarios en el MVP**. La primera decisión que conviene validar es si los usuarios objetivo ya tienen Node/npm; si no, empieza directamente con Go.
