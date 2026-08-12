# AGENTS.md

## Agent skills

### Issue tracker

Issues y especificaciones viven en GitHub Issues; usar `gh`. See `docs/agents/issue-tracker.md`.

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

- Nunca hacer `push` automáticamente.
- Nunca aprobar pull requests automáticamente.
- Nunca escribir directamente sobre la rama `main`.
- Estas acciones solo se permiten cuando el usuario las solicite explícitamente.
- Si se necesita hacer un commit mientras la rama actual es `main`, crear primero
  una rama cuyo nombre se derive del issue o trabajo en curso y hacer allí el
  commit. Por defecto, crearla sin esperar aprobación para no bloquear el
  trabajo e informar después del nombre; si el usuario pide revisar el nombre,
  ofrecérselo para aprobación antes de crearla.
