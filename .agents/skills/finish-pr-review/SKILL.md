---
name: finish-pr-review
description: Use when explicitly asked to finish the current pull request without approving, merging, or closing it, especially when CI failures or CodeRabbit/reviewer comments remain.
disable-model-invocation: true
---

# Finish PR Review

El objetivo es dejar el pull request actual listo para cierre o merge, sin
aprobarlo, hacer merge ni cerrarlo.

## Puerta de inicio

1. Identifica con `gh` el PR abierto y su head branch.
2. Confirma que la rama actual es exactamente esa head branch y que no es
   `main`.
3. Antes de crear el Goal, registra como baseline de este Goal la rama,
   `git rev-parse HEAD`, `git status --short --branch`, los parches de
   `git diff --binary` y `git diff --cached --binary`, y las rutas no
   rastreadas. Para cada archivo no rastreado registra su hash SHA-256; para
   directorios registra además su inventario recursivo y los hashes de sus
   archivos. No modifiques, borres, renombres ni incluyas esos paths en el
   commit del Goal; si el trabajo los necesita, detente.
   Conserva ese baseline para separar los cambios nuevos de los preexistentes;
   si un archivo rastreado mezcla ambos, conserva los hunks previos y añade
   solo los hunks creados durante este Goal.
4. Crea un único Goal con `create_goal` antes de comenzar el trabajo.

Si la puerta no se puede confirmar, no continúes ni cierres el Goal.

## Bucle de revisión

Repite este ciclo hasta que se cumpla el predicado de finalización:

1. Inspecciona con `gh` los comentarios del PR, los review threads y los
   required checks. Consulta además `gh api graphql --paginate --slurp` sobre
   `pullRequest.reviewThreads`: la query define `$endCursor: String`, usa
   `after: $endCursor` y solicita `pageInfo { hasNextPage endCursor }`; procesa
   todas las páginas, leyendo `isResolved` y los cuerpos de sus comentarios.
   Un hilo es accionable si está sin resolver y tiene un cuerpo no vacío.
2. Corrige los fallos del pipeline y los comentarios válidos.
3. Responde los comentarios rechazados con evidencia documentada.
4. Ejecuta las comprobaciones relevantes.
5. Haz commit solo de cambios acotados al PR y ausentes del baseline del Goal.
6. Antes de hacer push, vuelve a leer con `gh` el owner (`owner`), repositorio
   (`repository`), ref (`ref`) y
   `headRefOid` del PR y compáralos con el remote local y la rama actual.
   Compara también el SHA de `git ls-remote` para esa ref con el `headRefOid`;
   si owner, repositorio, ref, remote o SHA no coinciden, detente. Haz solo un
   push normal fast-forward: nunca uses force, mirror ni borres/recrees refs.
7. Haz push únicamente a la head branch del PR.
8. Después del push, vuelve a leer el estado de CI y de los reviewers.

Los checks en estado pending o una review esperada después de un push mantienen
el Goal activo. Durante las esperas o reconsultas, usa `get_goal` para comprobar
que el Goal dedicado sigue activo. Registra el `headRefOid` cuyos checks verdes
se verificaron; el trabajo de código terminado no equivale a Goal completo.

## Predicado de finalización

Solo puedes terminar cuando se cumplen simultáneamente estas condiciones:

- Todos los required checks están green.
- Todos los required checks están green para el `headRefOid` registrado como
  probado.
- La consulta paginada de `pullRequest.reviewThreads` no devuelve hilos
  accionables sin resolver (`unresolved`) con `isResolved: false`; cada
  comentario externo al hilo está
  corregido o rechazado mediante una respuesta documentada y basada en
  evidencia.
- Los reviewers y CodeRabbit indican que no queda ninguna review pendiente.
- Una nueva lectura del PR confirma que su `headRefOid` sigue siendo el SHA
  probado.

Cuando el predicado completo sea verdadero, llama a
`update_goal({ status: "complete" })`. No llames antes.

## Reglas de seguridad

- El objetivo positivo es preparar el PR para cierre o merge; no realizar esas
  operaciones.
- Usa `gh` para consultar el estado del PR.
- Conserva el trabajo no relacionado.
- Conserva el baseline del Goal y solo prepara para commit los cambios nuevos
  de ese Goal.
- Valida antes de cada push que el owner (`owner`), repositorio (`repository`)
  y ref (`ref`) del PR coinciden
  con el remote local y la rama actual, y que `git ls-remote` coincide con el
  `headRefOid` leído justo antes del push.
- Solo permite pushes fast-forward normales; nunca uses force, mirror ni
  operaciones que borren o recreen refs.
- Solo puedes crear commits y hacer push con cambios creados durante este
  Goal; conserva intacto todo trabajo preexistente o no relacionado.
- Nunca uses `gh pr approve`, `gh pr merge` ni `gh pr close`.
- Nunca hagas push a `main` ni a otra rama distinta de la head branch del PR.

Ejemplo: si el pipeline está green pero CodeRabbit muestra una review pending,
el PR no está listo y el Goal permanece activo; espera o resuelve esa review y
vuelve a leer el estado.
