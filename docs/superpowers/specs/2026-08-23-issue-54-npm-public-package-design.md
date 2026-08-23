# Diseño: primera publicación npm pública de tbboot

## Autoridad y alcance

Este documento deriva del Issue #54. El Issue #54 mantiene la autoridad sobre
el contrato operativo de distribución y el Issue #8 mantiene la autoridad
sobre el comportamiento funcional del MVP. El trabajo prepara el repositorio
para una publicación manual; no publica el paquete ni modifica configuración
de la cuenta npm.

## Objetivo

Preparar `@talby/tbboot@0.1.0` como paquete público instalable en Node.js
`>=24.12 <25`, con documentación utilizable, licencia MIT y una comprobación
reproducible del contenido del tarball en CI.

## Diseño aprobado

`package.json` será la única fuente de metadata npm: nombre público, versión,
licencia, descripción, enlaces del repositorio, keywords, allowlist `files` y
`publishConfig.access: "public"`. La allowlist incluirá el código de `src`, el
schema runtime, `README.md` y `LICENSE`; npm añadirá el `package.json` requerido.
No se añadirán scripts de lifecycle de instalación o publicación.

`README.md` documentará instalación global, local y mediante `npx`,
prerrequisitos, compatibilidad Windows x64, uso desde un Consumer repository,
los comandos principales, límites del MVP, riesgos de Custom steps y el canal
de feedback de GitHub. `LICENSE` contendrá la licencia MIT.

Un script local `scripts/check-pack.mjs` ejecutará `npm pack --dry-run --json` y
fallará si el tarball contiene algo distinto de la allowlist acordada. CI
invocará `npm run check:pack`; nunca publicará.

## Alternativas descartadas

- Ejecutar solo `npm pack --dry-run`: no comprueba por sí mismo la lista exacta.
- Añadir un flujo de release o publicar desde CI: contradice la publicación
  manual e interactiva exigida por el Issue #54.

## Verificación

Se actualizará `package-lock.json` y se ejecutarán typecheck, validaciones de
formato, build, la suite completa y la comprobación del paquete. También se
usará `npm pack --dry-run` para inspeccionar el resultado sin publicar ni
crear artefactos dentro del repositorio.

## Archivos previstos

| Archivo | Cambio |
| --- | --- |
| `package.json` | Metadata pública, allowlist y script de empaquetado |
| `package-lock.json` | Metadata sincronizada |
| `README.md` | Documentación pública mínima |
| `LICENSE` | Licencia MIT |
| `scripts/check-pack.mjs` | Validación exacta del contenido del tarball |
| `.github/workflows/ci.yml` | Ejecución de `npm run check:pack` sin publicar |

## Fuera de alcance

Quedan fuera la publicación en npm, la configuración de 2FA, tokens,
trusted publishing, etiquetas Git, verificación desde el registro y cualquier
cambio al contrato funcional del MVP.
