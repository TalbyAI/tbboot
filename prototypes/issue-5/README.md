# Issue 5 prototype

This throwaway Windows fixture compares the proposed local declarative
semantics with a composition path built from existing tools.

The proposed implementation and tests live under `proposed/` and `test/`.
The comparison path is under `composition/`.

Run on Windows:

```powershell
Set-Location prototypes/issue-5
npm install
npm test
npm run compare
```

The fixture is throwaway. `doctor` and `install --dry-run` are read-only.
The composition path requires the external tools documented in
[`composition/README.md`](composition/README.md).

## Guía manual de comprobación

### Qué hace

El prototipo del Issue 5 compara una semántica declarativa local con una
composición de herramientas existentes. Lee el `manifest.yaml` del
consumer repository, descubre sus sources y recipes, y genera artifacts:
`.editorconfig`, `docs/project-guide.md` y dos managed blocks dentro de
`AGENTS.md`.

Antes de escribir, calcula el plan completo y valida inputs, targets,
colisiones y drift. Si encuentra un error, muestra un diagnóstico y no
escribe nada.

### Comprobación manual mínima

Desde PowerShell, prepara una copia temporal para no modificar el fixture:

```powershell
Set-Location prototypes/issue-5
npm install

$manualRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('tbboot-issue-5-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $manualRoot | Out-Null
Copy-Item -Recurse -Force fixture\consumer (Join-Path $manualRoot 'consumer')
Copy-Item -Recurse -Force fixture\source (Join-Path $manualRoot 'source')
$consumer = Join-Path $manualRoot 'consumer'
```

Comprueba el plan sin escribir:

```powershell
node proposed/cli.mjs doctor --root $consumer
node proposed/cli.mjs install --dry-run --root $consumer
```

El resultado debe terminar con código `0`, mostrar acciones `create` y dejar
sin crear `.editorconfig` ni `docs/project-guide.md`.

Aplica el plan y comprueba los artifacts:

```powershell
node proposed/cli.mjs install --root $consumer
Test-Path (Join-Path $consumer '.editorconfig')
Test-Path (Join-Path $consumer 'docs\project-guide.md')
Select-String -Path (Join-Path $consumer 'AGENTS.md') -Pattern 'managed-by: source/baseline','managed-by: source/review','Keep this unmanaged text'
```

Debe devolver `True`, `True` y encontrar los tres textos. Ejecuta la
instalación otra vez: debe devolver `0` y mostrar `noop`, sin cambiar los
archivos.

Para comprobar que protege cambios locales:

```powershell
Set-Content -LiteralPath (Join-Path $consumer '.editorconfig') -Value 'local change'
node proposed/cli.mjs install --root $consumer
```

Aquí el resultado esperado es código `1`, diagnóstico `[file-drift]` y el
texto `local change` debe conservarse.

### Cómo obtener el veredicto

La comprobación completa, incluida la comparación con la composition path, se
ejecuta así:

```powershell
npm test
npm run compare
Get-Content comparison-report.md
```

El resultado técnico de la comparación está al final, bajo `## Verdict`.
Revisa también `## Run status` y la columna `Checks` de `## Scenario matrix`.
Si aparece `chezmoi missing` o `not exercised`, la cobertura de la composition
path queda explícitamente sin ejercitar; no se debe presentar como una prueba
real de esa alternativa.

### Dictamen de cierre

El prototipo del Issue 5 se da por concluido. Su comparación cubre el núcleo
de archivos, fragmentos, preflight, drift e idempotencia; el producto objetivo
añadirá capacidades fuera de este experimento, como validación de comandos,
selección interactiva de sources, catálogos y dependencias.

El dictamen de producto es construir la herramienta en TypeScript sobre
Node.js. La falta de `chezmoi` limita la comparación técnica de este fixture,
pero no bloquea esta decisión de producto basada en el alcance final.

Al terminar la prueba manual, elimina la copia temporal:

```powershell
Remove-Item -LiteralPath $manualRoot -Recurse -Force
```
