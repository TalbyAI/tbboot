# Diseño: Git Sources y lockfile autoritativo

> Diseño derivado del Issue #15: [Resolver Git Sources mediante lockfile autoritativo](https://github.com/TalbyAI/tbboot/issues/15).
> El Issue, `CONTEXT.md` y los ADR son la autoridad contractual.

## Objetivo y límites

La CLI productiva resolverá Sources Git desde la raíz del repositorio o desde
un `path` interno seguro, fijará la revisión exacta y su fingerprint en
`tbboot.lock.yaml`, y reutilizará esa entrada como autoridad durante `install`.
La implementación se integra con el plan local existente de `doctor` e
`install`; no introduce Source dependencies, selección de Recipes, Custom,
Catalogs ni `uninstall`.

Se implementan también `--update-lock` y `--frozen-lockfile`. `doctor` y
`install --dry-run` siguen siendo completamente read-only, incluido el
lockfile y cualquier metadata del Consumer repository.

## Enfoque

Se añadirá un provider Git pequeño basado en el ejecutable `git`, invocado con
`execFile` y listas de argumentos. No se añade una dependencia Git ni se
construyen comandos mediante shell. Cada operación materializa el repositorio
seleccionado en una carpeta temporal fuera del Consumer repository; la carpeta
se elimina al terminar. Esto permite que `doctor` y dry-run no creen cachés o
metadatos persistentes.

El provider:

- normaliza la identidad como `repository + path`, conservando el selector
  fuera de la identidad;
- resuelve refs cortas solo cuando hay una coincidencia entre tags y branches,
  y acepta `refs/tags/...` y `refs/heads/...` completos;
- resuelve rangos inclusivos con `git merge-base --is-ancestor`, exige que el
  límite inferior sea ancestro del superior y selecciona un único máximo;
- intersecta las restricciones de varias referencias a la misma identidad;
- produce diagnósticos estables para refs ausentes o ambiguas, rangos
  inválidos, intersecciones incompatibles y máximos incomparables;
- verifica que la raíz o el subárbol seleccionado contenga `source.yaml`;
- calcula el fingerprint del Source sobre una representación determinista de
  su árbol Git usando SHA-256.

El plan común de `doctor.ts` consumirá Sources resueltos tanto locales como
Git. La discovery de `source.yaml`, Recipes de primer nivel, Steps, rutas,
colisiones y estados de Artifact seguirá siendo una sola implementación.
Cada Artifact Git conservará la revisión resuelta para que `install` la copie
al Installation record existente; Sources locales mantienen el estado actual
sin `revision`.

## Lockfile

El lockfile se valida con el schema cerrado existente antes de resolver o
escribir. Cada entrada conserva la referencia con locator normalizado y
selector original, la revisión Git resuelta y el fingerprint del Source.

La resolución de una identidad sigue estas reglas:

1. Una entrada existente debe coincidir con la identidad y con todas las
   restricciones selectoras actuales. Su revisión se usa como autoridad y se
   verifica contra el repositorio y el fingerprint esperado.
2. Una entrada para una identidad cuyo selector cambió, cuya revisión ya no es
   válida o cuyo fingerprint no coincide es stale. El modo normal y
   `--frozen-lockfile` fallan antes de escribir; `--update-lock` la vuelve a
   resolver.
3. Una identidad sin entrada se resuelve en modo normal y queda preparada para
   ser escrita. `--frozen-lockfile` falla antes de cualquier escritura.
4. `--update-lock` renueva solo las entradas afectadas y permite crear las que
   faltan.

El lockfile solo se escribe en `install`, después del preflight completo y
antes de la primera escritura de Artifact. Si el preflight falla, no se
modifica ningún archivo. Dry-run y doctor nunca escriben el lockfile.

## Flujo de datos y errores

1. La CLI parsea `install`, `--update-lock`, `--frozen-lockfile`, `--dry-run`,
   `--force` y `--json`; flags de lock incompatibles o duplicados son errores
   de uso con código `2`.
2. Se valida el Manifest y se agrupan sus Sources por identidad normalizada.
3. Se lee y valida el lockfile existente, se resuelven las restricciones y se
   materializan los Sources Git en temporales.
4. El plan común valida todos los Sources y Artifacts antes de escribir.
5. Si hay un diagnóstico de error, se emite el envelope habitual y se sale sin
   escribir lockfile, Artifacts, state, `.gitignore` o trust.
6. En doctor o dry-run se descartan los temporales y no se escribe nada.
7. En install se escribe el lockfile preparado en su frontera documentada y se
   continúa con el aplicador local existente.

Los errores de Git, lectura del repositorio, selector, lockfile y Source
incluyen `document`, `path` y `source` cuando existan. Los fallos de resolución
son errores aunque la referencia o Step sea opcional: no es seguro aplicar un
plan incompleto.

## Verificación

Las pruebas nuevas usarán `node:test`, la CLI real y repositorios Git
temporales. Cubrirán:

- Source Git en raíz y con `path` interno;
- refs cortas y completas, rangos inclusivos y límites iguales;
- ref corta ambigua, límite no ancestro, intersección vacía y máximos
  incomparables;
- lockfile generado, reutilizado como autoridad y detectado como stale;
- `--update-lock` y `--frozen-lockfile` con ausencia, cambios y éxito;
- dry-run/doctor sin modificaciones byte-for-byte en Consumer, Sources,
  perfil, lockfile, state o metadata;
- aplicación de Artifact Git y persistencia de la revisión en state.

Se conservarán las pruebas locales existentes y se ejecutarán typecheck, la
suite focalizada, los checks de repositorio, build y la suite completa antes
del commit de implementación.

## Alternativas descartadas

- Copiar el prototipo de #10: duplicaría la semántica y no resolvería la
  integración con la CLI ni el lockfile.
- Añadir una biblioteca Git: amplía dependencias y superficie de mantenimiento
  para operaciones que el ejecutable requerido ya expone.
- Mantener un caché persistente: violaría las garantías read-only de doctor y
  dry-run y no es necesario para el MVP.
