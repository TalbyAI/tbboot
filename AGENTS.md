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
