# Prototipo Flue del Issue #74

Este experimento implementa el flujo local mínimo del Issue #74. Todo el
código vive en esta carpeta y no cambia el código productivo de `tbboot`.

## Ejecución determinista

```powershell
Set-Location prototypes/issue-74-flue-implementation-flow
npm install
npm test
npm run check
npm run fixture
```

`--fixture --dry-run` usa el Issue #65 incluido, agentes y checks
deterministas, y no requiere GitHub, modelo, API key, push ni creación de PR.
Genera los informes bajo `runs/`, que está ignorado por Git.

## Ejecución local con Flue

```powershell
Copy-Item .env.example .env
# Edita .env y sustituye el placeholder por tu clave real.
node src/cli.ts --issue 65
```

El archivo `.env` se coloca junto a `package.json`, queda ignorado por Git y
se carga automáticamente al lanzar `src/cli.ts` mediante `loadEnvFile`. Una
variable `OPENROUTER_API_KEY` ya presente en el entorno tiene prioridad.

El host obtiene el Issue con `gh`, hace preflight sobre el checkout base,
crea worktrees temporales y ejecuta Implementer, Verifier y Reviewer mediante
`start()`/`init()`. Verifier y Reviewer son agentes independientes con
worktrees distintos y se ejecutan en paralelo.

El modelo es `openrouter/openai/gpt-5.6-luna` con `xhigh`. OpenRouter usa
`OPENROUTER_API_KEY`; los créditos de OpenRouter son independientes de una
suscripción de ChatGPT/Codex. El coste depende del contexto, razonamiento y
reintentos; la tarifa observada para Luna es aproximadamente $0.20/M tokens de
entrada y $1.20/M tokens de salida, con el razonamiento contado como salida.

La API `local()` (usada aquí como `local({ cwd })`) solamente establece el
directorio de trabajo del sandbox de desarrollo local: no es una frontera de
seguridad (not a security boundary). No se usa sandbox remoto,
persistencia duradera, router general ni registro de plugins.

## Aprobaciones y publicación

El flujo se detiene en gates HITL antes de crear worktrees, antes del commit y,
si se solicita explícitamente, antes de publicar. Por defecto no publica nada.
Los informes incluyen `report.json`, `checks.json`, `diff.patch`,
`verifier.md`, `reviewer.md` y `pr-body.md`.

Una parada o un resultado `needs-changes` conserva los worktrees para no
eliminar cambios sin confirmación; un resultado final `ready-for-review` limpia
los worktrees temporales después de generar los informes.

`--publish` es opt-in y requiere aprobación interactiva; únicamente permite
`git push` y crear un PR draft con `gh pr create --draft`. El prototipo nunca
aprueba, fusiona ni cierra PRs o Issues.
