---
title: Arquitectura de extensiones para Step types, runtimes y Source providers
version: 0.x-design
date_created: 2026-08-27
last_updated: 2026-08-27
owner: tbboot
tags:
  - architecture
  - design
  - extensibility
  - issue-26
---

# Issue #26: arquitectura de extensiones

> Diseño aprobado derivado de la Issue #26, `CONTEXT.md`, los ADR 0001, 0002,
> 0003, 0004, 0006, 0007, 0008, 0009, 0010, 0011, 0013, 0014 y 0015, y el
> trabajo previo de las Issues #11 y #17.

## Introduction

Esta especificación define una arquitectura para añadir nuevos `Step types`,
registrar y seleccionar runtimes y dejar una frontera evolutiva para futuros
`Source providers` y extensiones de terceros.

El diseño no implementa la arquitectura ni construye el prototipo de la Issue
#26. El MVP actual permanece sin cambios. La primera validación, cuando se
autorice una implementación, será un registro estático directo en el host.

## 1. Purpose & Scope

### Propósito

Definir contratos mínimos y límites de responsabilidad para que el host pueda:

- registrar y validar nuevos `Step types`;
- ejecutar un Step in-process o out-of-process según confianza y política;
- describir, descubrir y seleccionar runtimes compatibles;
- persistir estado específico sin ceder el control de la `Installation record`;
- extender el diseño a `Source providers` sin acoplarlos a los Steps;
- preparar una futura distribución explícita de extensiones de terceros.

### Alcance incluido

- Comparación de tres arquitecturas alternativas.
- Registro común de built-ins y futuros `Step types`.
- JSON Schema como contrato declarativo y validación semántica opcional con
  Zod u otro validador de código.
- Ejecución híbrida in-process/out-of-process.
- Registro híbrido de runtimes con descriptor declarativo y adaptadores
  manuales opcionales.
- Compatibilidad, versionado, confianza, autorización y capacidades.
- Contrato futuro de `Source provider`, `SourceHandle` y `SourceContent`.
- Fronteras entre el MVP actual, una primera implementación arquitectónica,
  un prototipo eventual y la arquitectura futura.

### Fuera de alcance

- Cambiar `File step`, `File Fragment step` o `Custom step` durante este
  trabajo.
- Crear un nuevo runtime productivo o modificar `node`/`pwsh`.
- Implementar un `Source provider` nuevo.
- Cargar extensiones de terceros.
- Crear un marketplace, un instalador de extensiones o un gestor de versiones.
- Construir ahora el prototipo de #26.
- Diseñar ahora el comportamiento productivo completo de `Template step`.
- Proporcionar sandboxing, elevación de privilegios o rollback general.
- Escribir un plan de implementación.

## 2. Definitions

Se mantienen los términos de `CONTEXT.md` para el dominio: Consumer
repository, Catalog, Source, Source selector, Source revision, Recipe,
Artifact, Step, Optional step, Step type, Source dependency, Installation
record, Source provider, Source reference, Source locator path, Installation
provider y Managed block.

Los siguientes nombres son contratos técnicos de esta especificación:

- **StepTypeDefinition:** definición registrada de un `Step type`, incluyendo
  schema, validación semántica, capacidades, modos de ejecución y creación del
  executor.
- **RuntimeDefinition:** descripción registrada de un runtime disponible para
  ejecutar Steps out-of-process.
- **RuntimeRequirement:** requisito de un runtime, con identidad y selector de
  versión, declarado por un `Step type` u operación.
- **SourceProviderDefinition:** contrato registrado de un `Source provider`
  para validar locators/selectors, resolver revisiones y abrir contenido.
- **SourceContent:** vista lógica, de solo lectura, del contenido de un Source.
  Su representación física es un detalle interno.
- **SourceHandle:** lease de contenido abierto que incluye identidad, revisión,
  huella y limpieza.
- **Extension:** unidad de código o paquete que puede aportar una o varias
  contribuciones a registros separados.
- **Capability:** permiso o necesidad declarada por un Step type, runtime o
  extensión. Declararla no concede acceso automáticamente.
- **Comportamiento arbitrario por instancia:** comportamiento cuyo significado
  puede ser definido por datos, scripts o comandos aportados por el usuario en
  el Step concreto. `Custom` pertenece a esta categoría.

## 3. Requirements, Constraints & Guidelines

### Requisitos funcionales

- **REQ-001:** El host deberá poder registrar un `StepTypeDefinition` y
  resolver Steps mediante su identificador.
- **REQ-002:** Los built-ins deberán usar el mismo mecanismo conceptual de
  definición y registro que los tipos externos futuros.
- **REQ-003:** El schema de un Step type deberá validar el objeto Step completo,
  incluidos los campos comunes y los campos específicos del tipo.
- **REQ-004:** El contrato no deberá exigir un subobjeto `config`; los campos
  específicos podrán extender los campos comunes a primer nivel.
- **REQ-005:** Un Step type podrá ofrecer ejecución in-process, out-of-process
  o ambas.
- **REQ-006:** El host deberá mantener invariantes comunes para lifecycle,
  resultados, timeout, cancelación, optionalidad, diagnósticos y persistencia.
- **REQ-007:** La selección de runtime deberá escoger el primer candidato
  disponible, compatible y autorizado en el orden declarado.
- **REQ-008:** El host deberá distinguir la confianza del código de una
  extensión, la confianza del Source y la autorización de una instancia de
  comportamiento arbitrario.
- **REQ-009:** El estado específico de un Step deberá ser JSON opaco y quedar
  persistido bajo control del host.
- **REQ-010:** El contrato futuro de `Source provider` deberá separar locator,
  selector, identidad, revisión, apertura, contenido y limpieza.

### Requisitos de compatibilidad

- **COMP-001:** `schemaVersion` permanecerá en `1` mientras tbboot sea menor
  que `1.0`.
- **COMP-002:** La versión del schema YAML y la versión de la API de una
  extensión serán conceptos separados.
- **COMP-003:** Durante `0.x` no se prometerá compatibilidad entre documentos o
  definiciones de extensiones producidos por versiones distintas.
- **COMP-004:** No habrá migraciones pre-`1.0` por defecto.
- **COMP-005:** Una extensión deberá declarar la API del host que necesita y
  esa compatibilidad se resolverá antes de validar o ejecutar Recipes.

### Requisitos de seguridad

- **SEC-001:** El registro rechazará identificadores duplicados; no existirá
  comportamiento `last write wins`.
- **SEC-002:** Las extensiones externas futuras se activarán explícitamente y
  solo después de validar manifiesto, API, capacidades y confianza.
- **SEC-003:** Un tipo declarativo confiable podrá recibir confianza a nivel de
  tipo; un tipo con comportamiento arbitrario por instancia requerirá
  autorización del Step concreto.
- **SEC-004:** La autorización por instancia incluirá identidad del tipo,
  identidad/versión/huella de extensión, `Source revision`, huella canónica del
  Step y capacidades solicitadas.
- **SEC-005:** La ejecución out-of-process no se considerará un sandbox por sí
  misma.
- **SEC-006:** Los procesos out-of-process no usarán shell implícito y el host
  conservará control sobre timeout, cancelación y terminación del árbol de
  procesos.
- **SEC-007:** Las referencias de Source no contendrán secretos. Red,
  credenciales y otros accesos deberán declararse como capacidades.

### Restricciones

- **CON-001:** La primera implementación será registro estático directo en el
  host.
- **CON-002:** Los registros de Step types, runtimes y Source providers serán
  separados.
- **CON-003:** No se instalarán runtimes automáticamente.
- **CON-004:** No se cargará código de terceros en la primera implementación.
- **CON-005:** No se construirá un prototipo salvo que persista una pregunta
  técnica concreta que no pueda resolverse conceptualmente.

### Guías de diseño

- **GUD-001:** El host será dueño del lifecycle y de la semántica observable;
  los tipos y runtimes aportarán comportamiento específico.
- **GUD-002:** JSON Schema será el contrato portable; Zod podrá complementar
  reglas semánticas en código.
- **GUD-003:** Se preferirá un descriptor declarativo de runtime y se recurrirá
  a adaptadores manuales solo para diferencias reales.
- **GUD-004:** La infraestructura común resolverá identidad, compatibilidad,
  capacidades, confianza y autorización sin crear un plugin universal.
- **GUD-005:** Los nombres de dominio existentes se conservarán; los nombres
  técnicos nuevos de esta especificación no se convertirán en términos de
  dominio adicionales salvo que una iteración posterior lo justifique.

## 4. Interfaces & Data Contracts

Las siguientes formas son contratos conceptuales. No constituyen todavía
implementación productiva ni fijan nombres de archivos internos.

### 4.1 Step type registry

El registro expone conceptualmente operaciones equivalentes a:

```ts
stepTypeRegistry.register(definition: StepTypeDefinition): void
stepTypeRegistry.get(typeId: string): StepTypeDefinition | undefined
```

La unidad mínima de registro es un `StepTypeDefinition`:

```ts
type StepTypeDefinition = {
  id: string
  apiVersion: number
  extension: ExtensionIdentity

  schema: JsonSchema
  semanticValidate?: SemanticValidator

  behavior: "declarative" | "arbitrary-instance"
  capabilities: Capability[]

  execution: {
    inProcess?: InProcessDefinition
    outOfProcess?: {
      entrypoint: string
      runtimes: RuntimeRequirement[]
    }
  }

  createExecutor(
    step: Step,
    context: StepExecutionContext
  ): StepExecutor
}
```

Un `Step` obligatorio cuyo tipo no esté registrado será un error. Un tipo
desconocido en un `Optional step` se omitirá con warning. Un tipo registrado
pero inválido según su schema siempre será un error de validación.

### 4.2 Schema y validación

El host compondrá el schema de campos comunes con el schema del tipo:

```text
document parsing
  -> common Step schema
  -> Step type resolution
  -> complete type schema
  -> optional semantic validator
  -> planning/execution
```

La composición deberá conservar las restricciones de propiedades desconocidas
sin obligar a encapsular los campos específicos en `config`. La implementación
podrá usar composición equivalente a `allOf`/`unevaluatedProperties` o un
schema compuesto por el host, según las capacidades efectivas del validador.

El validador de código recibirá un objeto ya validado estructuralmente y solo
podrá añadir reglas semánticas, como relaciones entre campos o restricciones
dependientes del entorno.

### 4.3 Lifecycle y resultado

El host creará un executor por instancia:

```ts
type StepExecutor = {
  check?: (context: StepExecutionContext, state?: JsonValue) =>
    Promise<StepResult>
  install?: (context: StepExecutionContext, state?: JsonValue) =>
    Promise<StepResult>
  uninstall?: (context: StepExecutionContext, state?: JsonValue) =>
    Promise<StepResult>
}
```

El resultado lógico mantiene la forma existente de Custom:

```ts
type StepResult = {
  status: "ok" | "missing" | "drift" | "error"
  changed: boolean
  message?: string
  details?: JsonValue
  state?: JsonValue
}
```

El host decide cómo se traducen esos estados según la optionalidad del Step.
No se permite que un runtime o un Step type redefina su significado.

`install` recibe el estado previo y puede devolver uno nuevo. `check` y
`uninstall` reciben el último estado persistido. El host solo actualiza la
`Installation record` cuando el executor devuelve explícitamente estado nuevo.

### 4.4 StepExecutionContext

```ts
type StepExecutionContext = {
  recipe: Recipe
  step: Step

  source?: {
    identity: SourceIdentity
    revision: SourceRevision
    content: SourceContent
  }

  mode: "in-process" | "out-of-process"
  runtime?: SelectedRuntime
  services: HostServices
  capabilities: GrantedCapabilities
  cancellation: CancellationContext
}
```

Los servicios serán explícitos y acotados. El contexto no concede acceso
ambiental al sistema de archivos, proceso, red, credenciales o entorno.

`SourceContent` será de solo lectura y expondrá una interfaz lógica mínima para
leer, listar y consultar metadata de rutas relativas seguras. No exige que el
provider mantenga una carpeta real.

### 4.5 Selección del modo de ejecución

La Recipe selecciona el `Step type`, no un modo privilegiado. La política del
host y del usuario elige entre los modos anunciados por el tipo.

Reglas:

- un tipo puede anunciar solo in-process;
- un tipo puede anunciar solo out-of-process;
- un tipo puede anunciar ambos;
- código no confiable no puede ser forzado in-process;
- si no existe un modo permitido y el Step es obligatorio, el preflight falla;
- un Step opcional produce el diagnóstico opcional correspondiente;
- no existe fallback silencioso hacia un modo con más privilegios.

### 4.6 Runtime registry

El runtime registry es independiente del Step type registry:

```ts
runtimeRegistry.register(definition: RuntimeDefinition): void
runtimeRegistry.get(runtimeId: string): RuntimeDefinition | undefined
```

La definición combina una base declarativa con un adaptador manual opcional:

```ts
type RuntimeDefinition = {
  id: string
  apiVersion: number

  availability: AvailabilityProbe
  versionSelector: VersionSelector
  capabilities: Capability[]
  protocol: "json-stdio-v1"
  launch: DeclarativeLaunchDefinition
  adapter?: ManualRuntimeAdapter
}
```

Un `RuntimeRequirement` contiene, como mínimo, identidad, selector de versión
y capacidades requeridas:

```ts
type RuntimeRequirement = {
  id: string
  version?: string
  capabilities?: Capability[]
}
```

Los candidatos se prueban en el orden declarado. El host conserva un motivo
por candidato si falla la selección: no encontrado, versión incompatible,
probe fallido, capacidad denegada u otra incompatibilidad.

`node` y `pwsh` se registrarían conceptualmente mediante este modelo, usando
adaptadores manuales para sus diferencias actuales de probe, argumentos,
ejecución y cancelación. No se cambia su comportamiento productivo en esta
especificación.

El runtime no instala ejecutables y no puede sobrescribir las invariantes del
host sobre resultados, timeout, cancelación, seguridad o privilegios.

### 4.7 Protocolo out-of-process

El protocolo lógico común será JSON por stdin/stdout:

- una petición JSON por operación;
- un resultado JSON por operación;
- stderr reservado para logs y diagnósticos no estructurales;
- validación del resultado por el host;
- timeout y cancelación controlados por el host;
- ejecución sin shell implícito;
- terminación del árbol de procesos cuando corresponda.

El runtime adapta comando, argumentos, entorno, transporte y lanzamiento. No
adapta los estados lógicos del lifecycle.

### 4.8 Source provider registry

Un futuro `Source provider` se registra por separado:

```ts
type SourceProviderDefinition = {
  id: string
  locatorSchema: JsonSchema
  selectorSchema: JsonSchema

  validateLocator(locator: unknown): ValidationResult
  validateSelector(selector: unknown): ValidationResult
  normalizeIdentity(locator: unknown): SourceIdentity

  resolveRevision(
    locator: SourceLocator,
    selector?: SourceSelector
  ): Promise<SourceRevision>

  open(revision: SourceRevision): Promise<SourceHandle>
}
```

El provider conserva la semántica específica de locator, selector, revisión,
credenciales, red, fingerprint y materialización. El host conserva lifecycle,
limpieza, rutas seguras, confianza, diagnósticos y uso por los Steps.

```ts
type SourceHandle = {
  identity: SourceIdentity
  revision: SourceRevision
  fingerprint: SourceFingerprint
  content: SourceContent
  close(): Promise<void>
}
```

La identidad sigue siendo `provider + locator normalizado`; el selector no
forma parte de la identidad y se resuelve como `Source revision`.

`SourceContent` es un filesystem virtual lógico, de solo lectura. Puede tener
un árbol en memoria como backend inicial o proyectarse temporalmente a un
filesystem real solo cuando un proceso out-of-process lo necesite.

### 4.9 Extension manifest futuro

La carga dinámica no forma parte de la primera implementación. El contrato
futuro será explícito y manifest-driven:

```json
{
  "id": "example.vendor",
  "version": "0.1.0",
  "hostApi": "^1",
  "contributions": {
    "stepTypes": [],
    "runtimes": [],
    "sourceProviders": []
  },
  "capabilities": [],
  "fingerprint": "..."
}
```

El orden de activación será:

```text
read manifest
  -> validate host API and contributions
  -> apply capabilities and trust policy
  -> activate extension code
  -> register contributions
  -> validate Recipes
```

No habrá escaneo automático, activación desde un Source ni marketplace
implícito.

### 4.10 Trust, authorization y estado

La confianza de una extensión se asociará a identidad, versión, API,
contribuciones, capacidades y huella del artefacto. Una firma podrá añadirse
posteriormente, pero no se presupone ahora.

Los built-ins se autoaprueban por defecto, excepto `Custom` y cualquier futuro
tipo que permita comportamiento arbitrario por instancia. La autorización de
una instancia arbitraria se asociará a:

- identidad del `Step type`;
- identidad y versión o huella de la extensión;
- `Source revision`;
- huella canónica del Step;
- capacidades solicitadas.

La confianza del código de un `Source provider` y la confianza del Source que
devuelve son decisiones separadas. El provider debe devolver la identidad
canónica del Source y su huella para poder formar claves estables de confianza,
lockfile, deduplicación y caché.

La `Installation record` conserva la identidad del Source, revisión, Recipe,
Step, orden, extensión, huellas, runtime seleccionado y estado opaco. Si falta
la extensión histórica, `uninstall` advierte, conserva el efecto y continúa;
solo una extensión exacta o compatible y autorizada puede ejecutar la
recuperación histórica.

Una caché persistente local puede conservar clones o materializaciones
temporales. La reutilización requiere verificar identidad, revisión y huella;
la caché nunca concede confianza. Los comandos futuros mínimos son `cache list`
y `cache prune`.

## 5. Acceptance Criteria

- **AC-001:** Dado un built-in registrado mediante `StepTypeDefinition`, cuando
  el host resuelve un Step existente, entonces aplica el mismo flujo de
  schema, lifecycle y resultado que aplicaría a una extensión futura.
- **AC-002:** Dado un nuevo tipo con campos específicos en el primer nivel,
  cuando se valida el documento, entonces se validan los campos comunes y los
  campos del tipo sin exigir `config`.
- **AC-003:** Dado un validador JSON Schema válido y un validador semántico
  Zod opcional, cuando ambos se ejecutan, entonces Zod solo puede añadir
  errores y no puede relajar el contrato estructural.
- **AC-004:** Dado un Step type con dos runtimes candidatos, cuando el primero
  no está disponible o no es compatible, entonces el host prueba el siguiente
  y conserva el motivo del fallo del primero.
- **AC-005:** Dado un Step type que anuncia ambos modos, cuando la política no
  permite in-process, entonces el host elige out-of-process si es compatible y
  nunca hace fallback silencioso a in-process.
- **AC-006:** Dado un Step con comportamiento arbitrario, cuando no existe
  autorización para su huella concreta, entonces el host no lo ejecuta aunque
  su extensión o runtime estén registrados.
- **AC-007:** Dado un executor que devuelve estado opaco, cuando termina
  `install`, entonces el host persiste el estado con identidad de extensión y
  huella del Step y lo entrega posteriormente a `check`/`uninstall`.
- **AC-008:** Dado un `Source provider` futuro, cuando resuelve un selector,
  entonces devuelve identidad canónica, `Source revision`, huella,
  `SourceContent` de solo lectura y limpieza explícita.
- **AC-009:** Dado un manifiesto de extensión futuro, cuando su API o política
  no es compatible, entonces el host lo rechaza antes de activar su código.
- **AC-010:** Dado que tbboot sigue por debajo de `1.0`, cuando se introducen
  cambios en el registro o en la composición de schemas, entonces los
  documentos continúan declarando `schemaVersion: 1`.
- **AC-011:** Dado el diseño aprobado, cuando se revisa el repositorio, entonces
  no existen cambios en `src/`, `schemas/`, providers existentes ni runtimes
  productivos.
- **AC-012:** Dado que no queda una pregunta técnica bloqueante, cuando se
  cierra el diseño, entonces no se construye el prototipo de #26.

## 6. Test Automation Strategy

No se implementan tests ni prototipo como parte de esta especificación. Si se
autoriza una primera implementación, la estrategia será:

- **Unit:** registro, IDs duplicados, composición de schemas, validación
  semántica, resolución de capacidades, selección de runtime y normalización
  de resultados.
- **Integration:** built-ins registrados por el mismo camino, executor con
  estado opaco, runtime declarativo con adaptador manual y protocolo JSON.
- **End-to-End:** un nuevo `Template step` in-process y out-of-process,
  optionalidad, autorización de `Custom`, timeout, cancelación y persistencia.
- **Source provider:** identidad, selector, revisión, fingerprint,
  `SourceContent` de solo lectura, materialización temporal y cleanup.
- **Security:** extensión no confiable, capacidades denegadas, huella
  modificada, ausencia de autorización y ausencia del executor histórico.
- **Regression:** suite existente de File, File Fragment, Custom, Sources,
  `doctor`, `install`, `uninstall` y salida JSON.

Si aparece una duda que requiera ejecución, el spike será aislado en
`prototypes/issue-26/` y se limitará a la duda concreta. En particular, el
backend de `SourceContent` puede requerir un spike comparativo, pero no se
elige una librería VFS por adelantado.

## 7. Rationale & Context

### Alternativa A: registros estáticos separados — recomendada

El host mantiene tres registros separados y una infraestructura compartida.
Los built-ins usan la misma forma de definición que los tipos futuros, pero la
primera carga es estática.

Ventajas:

- mínima complejidad inicial;
- uniformidad real entre built-ins y extensiones;
- lifecycle y seguridad permanecen en el host;
- runtimes y Source providers no quedan acoplados a Steps;
- reutiliza la experiencia de #11 y #17.

Costes:

- no resuelve todavía distribución dinámica;
- la API de carga de paquetes se diseñará más adelante;
- los adaptadores manuales de runtimes siguen siendo necesarios para casos
  especiales.

### Alternativa B: API universal con paquetes dinámicos desde el principio

Una extensión podría registrar Steps, runtimes y Source providers desde un
paquete cargado dinámicamente.

Ventajas:

- prepara antes la distribución de terceros;
- ofrece una experiencia única de instalación y activación.

Costes:

- introduce simultáneamente problemas de carga de código, firma, confianza,
  compatibilidad, instalación, caché y aislamiento;
- mezcla contratos con lifecycle y riesgos diferentes;
- obliga a resolver seguridad antes de conocer la experiencia real con nuevos
  tipos mantenidos por el equipo.

### Alternativa C: adaptadores independientes por tipo

Cada nuevo tipo aporta un adaptador y el host mantiene conocimiento especial de
cada uno.

Ventajas:

- cambio inicial pequeño;
- permite probar un tipo sin crear un registro general.

Costes:

- duplica schema, lifecycle y política;
- los built-ins no validarían realmente la arquitectura futura;
- dificulta la selección uniforme de runtimes y la extensión a Source
  providers;
- aumenta el coste de soporte a largo plazo.

### Razón de la recomendación

La Alternativa A satisface el objetivo inmediato —añadir tipos mantenidos por
el equipo— con la menor superficie nueva y deja puntos de extensión claros
para paquetes, firmas, sandboxing y providers futuros. La separación de
registros evita que una decisión futura de distribución contamine el contrato
de ejecución de Steps o la semántica de Sources.

## 8. Dependencies & External Integrations

### Dependencias actuales

- **DEP-001:** Contrato de Steps, planificación y persistencia actuales de
  tbboot.
- **DEP-002:** JSON Schema/Ajv para validación estructural del documento.
- **DEP-003:** Zod u otro validador de código únicamente como mecanismo
  semántico opcional; no se añade una dependencia en esta fase de diseño.
- **DEP-004:** Node y PowerShell 7 como runtimes actuales, conservando sus
  probes, rangos y controles de proceso existentes.
- **DEP-005:** Providers local y Git, sin cambios en esta iteración.
- **DEP-006:** Protocolo JSON y control de procesos documentados por #11 y #17.

### Integraciones futuras

- **FUT-001:** Loader explícito de manifiestos o paquetes de extensiones.
- **FUT-002:** Almacén de confianza, fingerprints y firmas.
- **FUT-003:** Broker explícito para credenciales y capacidades.
- **FUT-004:** Backend de filesystem virtual para `SourceContent`.
- **FUT-005:** Sandbox o frontera de seguridad adicional para código no
  confiable.

Ninguna integración futura es necesaria para el registro estático inicial.

## 9. Examples & Edge Cases

### Built-in con el mismo mecanismo

Un built-in se registra como una definición normal, aunque su implementación
permanezca dentro del host:

```text
registerStepType(fileDefinition)
registerStepType(fileFragmentDefinition)
registerStepType(customDefinition)
```

El host no necesita una rama conceptual distinta para descubrir el tipo. La
excepción de `Custom` aparece en confianza y autorización, no en el registro.

### Nuevo Template step

Una futura instancia ilustrativa podría tener campos comunes y específicos en
el mismo nivel:

```yaml
type: example.template
source: ./templates
template: README.template
target: README.md
variables:
  projectName: tbboot
```

El schema central valida los campos comunes, el schema de `example.template`
valida `template` y `variables`, y el validador semántico puede comprobar
relaciones adicionales. El ejemplo no define todavía el comportamiento
productivo del tipo.

### Selección de runtime

```text
Step type: example.template
runtime candidates: [node >=24.12 <25, pwsh >=7.6 <8]

node -> no encontrado
pwsh -> encontrado, compatible y autorizado
selection -> pwsh
```

Si ambos fallan, el host devuelve un diagnóstico común con el motivo de cada
candidato.

### Step arbitrario no autorizado

Un `Custom` puede tener runtime disponible y schema válido, pero seguir sin
ejecutarse si la autorización no coincide con la huella de su instancia y
`Source revision`.

### Extensión modificada

Una extensión con el mismo nombre y versión, pero distinta huella, se trata
como una identidad de confianza distinta. No puede ejecutar automáticamente
uninstall histórico producido por la huella anterior.

### Source provider remoto

Un provider remoto puede requerir `network`, `credentials.read` y `state.write`.
Esas capacidades se evalúan antes de abrir el Source. El provider devuelve la
identidad canónica, resuelve la revisión y entrega `SourceContent` de solo
lectura. El host libera el `SourceHandle` también cuando la operación se
cancela.

### Casos de optionalidad

- tipo desconocido y Step obligatorio: error;
- tipo desconocido y Step opcional: warning y omisión;
- tipo conocido con schema inválido: error incluso si es opcional;
- runtime no disponible en Step obligatorio: error;
- runtime no disponible en Step opcional: warning;
- código arbitrario sin autorización: no se ejecuta;
- extensión histórica ausente durante uninstall: warning, efecto conservado y
  continuación.

## 10. Validation Criteria

El diseño se considera conceptualmente validado cuando se cumplen todas estas
condiciones:

- la recomendación A queda justificada frente a B y C;
- los built-ins y futuros tipos comparten el límite de `StepTypeDefinition`;
- JSON Schema y validación semántica tienen responsabilidades separadas;
- el host mantiene la semántica común de lifecycle y resultados;
- runtime registry, Step type registry y Source provider registry no están
  acoplados;
- la selección de runtime es determinista y diagnóstica;
- in-process y out-of-process tienen reglas explícitas de confianza;
- la autorización de `Custom` y futuros tipos arbitrarios es por instancia;
- el estado opaco y la recuperación histórica están definidos;
- `schemaVersion: 1` y la falta de compatibilidad pre-`1.0` están explícitas;
- `Source provider`, `SourceHandle` y `SourceContent` tienen frontera clara;
- la activación futura de extensiones es explícita y previa a la ejecución;
- el prototipo queda diferido y condicionado a una pregunta técnica real;
- no se requieren cambios en `src/`, `schemas/` ni en la implementación
  productiva para cerrar el diseño.

## 11. Related Specifications / Further Reading

- `CONTEXT.md`
- GitHub Issue #26: arquitectura de extensiones para Step types, runtimes y
  Source providers.
- `docs/adr/0001-catalogs-as-optional-local-indexes.md`
- `docs/adr/0002-source-identity-depends-on-provider.md`
- `docs/adr/0003-steps-use-source-inputs-and-repository-relative-targets.md`
- `docs/adr/0004-source-references-use-local-paths-or-recognized-schemes.md`
- `docs/adr/0006-source-owns-source-dependencies.md`
- `docs/adr/0008-source-selectors-are-provider-specific.md`
- `docs/adr/0009-source-discovery-and-metadata.md`
- `docs/adr/0010-custom-steps-are-detected-and-gated-per-source.md`
- `docs/adr/0011-steps-are-required-by-default.md`
- `docs/adr/0013-installation-record-is-local.md`
- `docs/adr/0014-yaml-documents-are-schema-versioned.md`
- `docs/adr/0015-cli-supports-human-and-json-output.md`
- `docs/adr/0016-extension-boundaries-use-separate-registries.md`
- `docs/superpowers/specs/2026-08-15-issue-11-runtime-process-implementation-notes.md`
- `docs/superpowers/specs/2026-08-20-issue-17-custom-steps-design.md`
- `docs/superpowers/specs/2026-08-26-issue-26-decisions-intermediate.md`
