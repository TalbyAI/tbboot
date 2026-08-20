# Diseño: skill local para terminar la revisión de un pull request

## Objetivo

Crear una skill local al repositorio que, al invocarse explícitamente, active un
Goal dedicado para dejar el pull request actual listo para cierre o fusión sin
aprobarlo, fusionarlo ni cerrarlo.

## Alcance

La skill debe perseguir dos frentes hasta completarlos:

- corregir los errores de ejecución del pipeline;
- corregir comentarios de reviewers o rechazarlos con una explicación y
  evidencia, dando prioridad a los comentarios de CodeRabbit.

Durante el Goal se permiten commits y `push`, pero solo sobre la rama del pull
request y para cambios creados dentro de este objetivo. La skill reutiliza las
reglas del `AGENTS.md` y las operaciones de `gh` del repositorio.

## Invocación y ubicación

La skill será user-invoked y vivirá en:

```text
.agents/skills/finish-pr-review/SKILL.md
```

Usará `disable-model-invocation: true`, porque iniciar el bucle puede producir
commits y `push` y debe requerir una orden explícita del usuario.

## Flujo

1. Confirmar que la rama actual corresponde a un pull request abierto y que no
   es `main`.
2. Crear un Goal dedicado con el objetivo completo y sus criterios de
   terminación.
3. Consultar el estado del pull request, los checks del pipeline y todos los
   comentarios o hilos de revisión.
4. Diagnosticar cada fallo del pipeline y cada comentario accionable; corregir
   la causa en el repositorio o responder rechazándolo con una justificación
   verificable.
5. Ejecutar las comprobaciones relevantes y conservar evidencia de sus
   resultados.
6. Crear un commit cuando haya cambios y hacer `push` únicamente a la rama
   head del pull request.
7. Volver a consultar CI y reviewers después de cada `push`; mantener el Goal
   activo mientras haya checks pendientes, nuevas revisiones o comentarios sin
   resolver.

## Criterio de terminación

El Goal solo puede marcarse como completo cuando se cumplen simultáneamente
estas condiciones observables:

- todos los jobs obligatorios del pipeline terminan correctamente;
- todos los comentarios de reviewers tienen una corrección aplicada o una
  respuesta de rechazo sustentada, sin comentarios accionables pendientes;
- los reviewers han indicado que no hay otra revisión pendiente, incluida la
  revisión de CodeRabbit;
- la rama del pull request contiene los últimos cambios verificados.

La ausencia temporal de comentarios, un pipeline en estado `pending`, o que no
haya llegado todavía la revisión posterior a un `push` no cumple el criterio.

## Guardas

- No ejecutar `gh pr approve`, `gh pr merge` ni `gh pr close`.
- No escribir en `main` ni en una rama distinta de la head del pull request.
- No hacer `push` de cambios anteriores al Goal.
- No marcar el Goal como completo para escapar de un fallo, un reviewer
  pendiente o un estado ambiguo.
- Si no puede identificarse el pull request, la rama head, el pipeline o el
  estado de revisión, detenerse y pedir la información necesaria.

## Enfoques considerados

1. **Una skill con Goal y bucle de estado (seleccionado).** Es la solución
   mínima y mantiene el criterio de terminación junto al proceso que lo
   aplica.
2. **Skill más script auxiliar de polling.** Añade automatización y una nueva
   superficie que mantener, aunque el problema principal es de juicio sobre
   comentarios y no de ejecución mecánica.
3. **Reglas en `AGENTS.md`.** Estarían siempre cargadas y podrían autorizar
   implícitamente commits o `push`; contradice la invocación explícita deseada.

## Verificación

Antes de darla por disponible se revisará la skill con escenarios de presión:

- pipeline fallido junto con un comentario válido de CodeRabbit;
- comentario técnicamente incorrecto junto con CI pendiente;
- `push` realizado pero reviewer todavía pendiente;
- estado aparentemente limpio sin confirmación final del reviewer.

La verificación comprobará que la skill mantiene el Goal activo en los tres
últimos casos y que solo completa el objetivo cuando todos los criterios se
cumplen.
