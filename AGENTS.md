# AGENTS.md

## Agent skills

### Issue tracker and derived design artifacts

Las GitHub Issues son la fuente autoritativa de requisitos, alcance, criterios
de aceptación, restricciones, decisiones aprobadas y elementos fuera de
alcance. Usar `gh` para las operaciones sobre issues. See
`docs/agents/issue-tracker.md`.

### Publicación de contenido complejo en trackers externos

Cuando se vaya a publicar contenido de varias líneas o con estructura Markdown,
HTML, JSON, tablas, listas o bloques de código en un comentario, issue, pull
request, work item u otro recurso de GitHub o Azure DevOps:

- Preparar primero el contenido en un archivo temporal y revisarlo completo.
- Publicarlo usando la opción basada en archivo de la CLI correspondiente, como
  `--body-file` en `gh` o su equivalente en Azure DevOps.
- Volver a leer el recurso remoto y verificar que su contenido coincide con el
  archivo antes de dar la publicación por terminada.

### Archivos temporales

Cuando una tarea indique que se debe crear un archivo temporal, crear una
carpeta única dentro de la carpeta temporal del sistema, fuera del repositorio
actual, y guardar allí el archivo. Eliminar únicamente esa carpeta temporal
cuando ya no sea necesaria.

Superpowers puede crear y commitear documentos de diseño y planes de
implementación bajo `docs/superpowers/`. Son artefactos derivados y revisables:

- el diseño registra la solución conceptual obtenida mediante la entrevista;
- el plan deriva su secuencia de implementación del diseño aprobado.

Estos artefactos pueden desarrollar detalles de implementación, pero no pueden
cambiar silenciosamente el Issue. Si la investigación o el diseño cambian el
alcance, los requisitos, los criterios de aceptación, las restricciones, los
elementos fuera de alcance, el comportamiento observable, la compatibilidad,
la seguridad, la persistencia u otra decisión con impacto duradero, actualizar
el Issue correspondiente antes de continuar y registrar allí el hallazgo o la
decisión relevante usando `gh`.

Las decisiones internas de implementación —como estructura de archivos,
extracción de helpers, organización de pruebas o nombres— no requieren
actualizar el Issue salvo que revelen un cambio en las categorías anteriores.

El Issue registra los requisitos y decisiones resultantes, no un enlace directo
al diseño ni al plan. El diseño y el plan pueden identificar el Issue del que
derivan, pero el Issue debe seguir siendo comprensible de forma independiente.

Los archivos HTML del árbol de documentación son visualizaciones enriquecidas
de documentos conceptuales existentes. Son artefactos de presentación y no son
autoritativos en ningún sentido. Deben identificar el documento conceptual o
Issue que representan. Si una visualización HTML difiere de su fuente
conceptual, prevalecen la fuente conceptual y el Issue.

Cuando se detecte un cambio significativo en el diseño, actualizar primero el
Issue y después revisar el diseño y regenerar el plan cuando sea necesario.

### Triage labels

Se usan `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` y `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Repositorio single-context: `CONTEXT.md` y `docs/adr/`. See `docs/agents/domain.md`.

### Prototype isolation

Los prototipos experimentales deben vivir en `prototypes/<prototype-name>/`.
Cada prototipo debe mantener dentro de esa carpeta su fixture, implementación,
comprobaciones y notas, sin mezclar archivos del experimento con la forma de
producción del repositorio.

### Protección de ramas y pull requests

- Hacer `push` solo cuando el usuario lo solicite explícitamente o durante la
  persecución de un objetivo activo con Goal dedicado a corregir hallazgos de
  CodeRabbit. En ese caso, hacer `push` únicamente a la rama del pull request y
  solo de commits creados dentro del objetivo para esas correcciones.
- Aprobar pull requests o escribir directamente sobre la rama `main` requiere
  siempre una solicitud explícita del usuario.
- Las ramas y commits locales fuera de `main` se permiten cuando forman parte de
  la tarea solicitada; no crear ramas ni commits para trabajo fuera de ese
  alcance.
- Si no existe issue, usar el formato `task/<short-description>`; si existe issue, usar `issue/<number>-<short-description>`.
- Si la tarea solicitada requiere un commit mientras la rama actual es `main`,
  crear primero una rama cuyo nombre se derive del issue o trabajo en curso y
  hacer allí el commit.
