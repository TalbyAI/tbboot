# Diseño: cierre de aceptación del MVP de tbboot

## Contexto y autoridad

Este documento deriva del Issue #8 y de sus hijos #9–#21. El Issue #8
continúa siendo la fuente autoritativa de requisitos, alcance, criterios de
aceptación y decisiones. Este diseño no añade requisitos de producto: organiza
la evidencia que falta y propone la mínima implementación necesaria para cerrar
la aceptación.

La sesión parte de un MVP ya implementado. El objetivo es distinguir:

- comportamiento que ya cumple el contrato;
- comportamiento implementado pero con evidencia insuficiente;
- huecos reales de implementación que deben corregirse;
- trabajo posterior que queda fuera del cierre de #8.

## Objetivo

Completar una revalidación reproducible del MVP de Windows x64 y cubrir los
casos que no quedaron demostrados por los hijos:

1. ejecutar una matriz de trazabilidad de las 25 user stories de #8;
2. añadir evidencia de un Custom externo escrito en TypeScript erasable;
3. cubrir el fallo de un paso requerido después de efectos previos y su
   reconciliación posterior;
4. intentar una prueba de cancelación en el límite real del proceso en
   Windows, separándola claramente de la prueba determinista existente;
5. mostrar la cobertura de líneas, ramas y funciones en la salida de tests,
   conservar las líneas no cubiertas y publicarlas como resumen y artefacto del
   pipeline.

## Auditoría actual

La línea base actual es:

| Evidencia | Resultado |
| --- | ---: |
| Suite de producción (pre-cierre) | 109 pasados, 1 omitido, 0 fallos |
| Prototipo #9 | 78 pasados |
| Prototipo #10 | 11 pasados |
| Prototipo #11 | 19 pasados |
| Prototipo #12 | 12 pasados |
| `npm run typecheck` | correcto |
| `npm run check` | correcto |
| `npm run build` | correcto |
| `npm pack --dry-run --json` | correcto |
| Smoke test de binario instalado desde el paquete | no realizado |

El único omitido de producción corresponde a la comprobación dependiente de un
sistema de archivos sensible a mayúsculas/minúsculas.

Los hijos 9–12 conservan prototipos ejecutables y sus suites pasan. Los hijos
13–20 están integrados en la forma de producción y tienen pruebas asociadas.
El hijo #21 consolidó la matriz de aceptación y la documentación, pero dejó
explícitamente sin demostrar el Ctrl+C real de la consola de Windows.

## Cobertura medida

Node 24 ya proporciona cobertura nativa del test runner. Sin añadir
dependencias, la línea base se obtiene con:

```text
node --experimental-test-coverage --test "test/**/*.test.ts"
```

La salida actual es una tabla ASCII con líneas, ramas, funciones y rangos de
líneas no cubiertas:

| Archivo | Líneas | Ramas | Funciones |
| --- | ---: | ---: | ---: |
| `src/catalog.ts` | 89.78% | 66.15% | 100% |
| `src/cli.ts` | 95.41% | 68.57% | 100% |
| `src/contract.ts` | 94.96% | 75.00% | 100% |
| `src/custom.ts` | 89.05% | 75.14% | 88.33% |
| `src/doctor.ts` | 94.81% | 85.39% | 95.77% |
| `src/git.ts` | 85.95% | 86.13% | 100% |
| `src/install.ts` | 85.35% | 71.43% | 91.30% |
| `src/shared.ts` | 100% | 85% | 100% |
| **Total** | **90.75%** | **78.89%** | **95.21%** |

Node también enumera los rangos no cubiertos. Por ejemplo, todavía existen
rangos en `src/custom.ts`, `src/install.ts` y `src/catalog.ts` que
corresponden a ramas de error, limpieza, plataformas alternativas o casos que
no forman parte de la aceptación mínima.

Esta cobertura será una señal diagnóstica y un mecanismo de visibilidad; no se
introducirá inicialmente un umbral artificial que convierta todas las ramas
históricas o específicas de otras plataformas en una nueva condición de
aceptación.

## Matriz de user stories de #8

| # | Área | Estado de la auditoría | Evidencia o trabajo pendiente |
| ---: | --- | --- | --- |
| 1 | Versionado y contrato JSON | Implementada | `src/contract.ts`, `schemas/contract-v1.json`, tests de contrato |
| 2 | Diagnóstico sin mutación | Implementada | `doctor.e2e.test.ts`, matriz #21 |
| 3 | Selección determinista de Git | Implementada | `git.ts`, pruebas de Git y prototipo #10 |
| 4 | Lockfile y reproducibilidad | Implementada | `git.ts`, `install.ts`, pruebas de lockfile |
| 5 | Resolución de runtimes | Implementada | `doctor.ts`, pruebas de runtime |
| 6 | Runtime Node externo | Implementada | `custom.ts`, pruebas de Custom |
| 7 | Runtime PowerShell externo | Implementada | `custom.ts`, pruebas de Custom |
| 8 | Protocolo JSONL de Custom | Implementada | tests de protocolo, timeouts y resultados inválidos |
| 9 | Timeout requerido | Implementada | pruebas E2E de timeout requerido |
| 10 | Timeout opcional | Implementada | pruebas E2E de warning opcional |
| 11 | Descendientes y limpieza | Implementada | pruebas de proceso y limpieza |
| 12 | Trust explícito | Implementada | `test/custom.test.ts`, `test/mvp-acceptance.e2e.test.ts` |
| 13 | Instalación local | Implementada | `install.ts`, pruebas de instalación |
| 14 | Ownership de artefactos | Implementada | pruebas de ownership y symlink |
| 15 | Uninstall | Implementada | pruebas de uninstall y reconciliación |
| 16 | Catálogos | Implementada | `catalog.ts`, pruebas de catálogo |
| 17 | Errores estructurados | Implementada | contrato y pruebas de errores |
| 18 | Read-only boundaries | Implementada | matriz E2E de #21 |
| 19 | Ciclo de vida completo | Implementada | matriz E2E de #21 |
| 20 | Salida y códigos de proceso | Implementada | CLI E2E y contrato |
| 21 | Compatibilidad Windows x64 | Implementada | CI sobre Windows x64 |
| 22 | Evidencia de documentación | Implementada | `docs/acceptance/mvp-windows-x64.md` |
| 23 | Compatibilidad de los hijos | Implementada | suites de prototipos y producción |
| 24 | Cancelación por Ctrl+C real | Evidencia parcial | la prueba actual usa `process.emit("SIGINT")`; falta separar y probar el límite OS |
| 25 | Fallo requerido con estado parcial y recuperación | Evidencia parcial | existe cancelación/reconciliación, pero falta el caso requerido seguido de una segunda instalación |
| — | Custom TypeScript erasable | Evidencia insuficiente | el prototipo #11 lo demuestra; falta el ciclo en la CLI de producción |

La clasificación de las filas 24, 25 y TypeScript no cambia el contrato del
Issue #8: identifica únicamente evidencia que debe añadirse para afirmar que el
contrato ya implementado se cumple en producción.

## Diseño aprobado para el cierre

### 1. Evidencia de Custom TypeScript erasable

Añadir a la matriz E2E un handler Custom externo con TypeScript que use
únicamente sintaxis erasable. El test debe ejecutar mediante la CLI de
producción el ciclo mínimo de comprobación, instalación y desinstalación, y
validar:

- entrada JSON por stdin;
- salida JSONL por stdout;
- diagnóstico por stderr sin contaminar el protocolo;
- resultado exitoso y efectos observables;
- ausencia de una etapa de transpilación o dependencia nueva.

La prueba será representativa del contrato del runtime, no un test exhaustivo del
compilador TypeScript.

### 2. Fallo requerido, estado parcial y reconciliación

Añadir una prueba E2E que:

1. complete al menos un efecto anterior;
2. haga fallar un Custom requerido;
3. confirme código de salida no cero y estado parcial persistido;
4. confirme que los pasos posteriores no se ejecutan;
5. vuelva a ejecutar la instalación con el mismo plan corregido;
6. confirme reconciliación sin duplicar ni reescribir innecesariamente el efecto
   ya aplicado.

Si esta prueba revela un defecto real en la persistencia o reconciliación, se
corregirá en el punto común del flujo de instalación y se añadirán regresiones.
No se implementará rollback: el contrato actual persiste el progreso y
reconcilia en una ejecución posterior.

### 3. Cancelación en Windows

Conservar la prueba existente basada en `process.emit("SIGINT")`, porque valida
la propagación determinista del aborto dentro de la CLI. Añadir una prueba
separada que intente enviar la cancelación en el límite del proceso usando las
capacidades disponibles del runner de Windows y compruebe:

- salida 130;
- terminación del Custom activo y sus descendientes;
- ausencia de ejecución de Steps posteriores;
- reconciliación del estado observable.

La prueba no llamará “Ctrl+C real” a un `child.kill("SIGINT")` o a un
`process.emit`. Si el entorno Node/PowerShell no permite generar de forma
fiable un evento de control de consola sin un helper nativo, se conservará la
prueba determinista, se documentará la limitación explícitamente y se dejará el
helper nativo como trabajo técnico separado, sin introducirlo en este cierre.

### 4. Cobertura local y en CI

Añadir el script mínimo:

```json
"test:coverage": "node --experimental-test-coverage --test \\"test/**/*.test.ts\\""
```

La cobertura se ejecutará en una sola combinación canónica de la matriz de CI,
para no multiplicar el tiempo y el tamaño de artefactos. El resto de
combinaciones seguirá ejecutando `npm test`.

En la combinación canónica:

1. PowerShell mostrará la tabla ASCII en vivo y la guardará en
   `coverage/summary.txt`, conservando el código de salida de Node;
2. un paso con `if: always()` copiará la tabla final a
   `GITHUB_STEP_SUMMARY`;
3. otro paso con `if: always()` publicará `coverage/summary.txt` como
   artefacto descargable;
4. el fallo de los tests seguirá haciendo fallar el job.

No se añadirá c8, nyc, Istanbul ni un HTML en esta iteración. La tabla ASCII del
log, el resumen del job y el artefacto contienen los rangos de líneas no
cubiertos y permiten revisar el detalle sin una dependencia adicional. Si esa
presentación resulta insuficiente después de usarla, se podrá añadir HTML en un
trabajo posterior.

El flujo resultante es:

```text
CLI E2E
  -> Node test runner
  -> tabla ASCII de cobertura
       -> log del CI
       -> GITHUB_STEP_SUMMARY
       -> coverage/summary.txt descargable
```

## Archivos previstos

| Archivo | Cambio previsto |
| --- | --- |
| `package.json` | añadir `test:coverage` |
| `.github/workflows/ci.yml` | ejecutar cobertura en una combinación, resumirla y subir el artefacto |
| `test/mvp-acceptance.e2e.test.ts` | añadir TS erasable, fallo/reconciliación y prueba de proceso si es viable |
| `test/support.ts` | modificar sólo si hace falta un helper mínimo reutilizable |
| `docs/acceptance/mvp-windows-x64.md` | registrar comandos, evidencia de cobertura y limitación de Ctrl+C |
| `src/*` | modificar sólo si una prueba nueva demuestra un defecto de producción |

No se prevén nuevas dependencias ni una reestructuración de la arquitectura.

## Criterios de aceptación del trabajo

- `npm run test:coverage` ejecuta la suite con la versión de Node soportada,
  imprime la tabla ASCII y mantiene el código de salida de la suite.
- La tabla contiene cobertura de líneas, ramas, funciones y líneas no
  cubiertas.
- La suite de producción conserva 0 fallos y el único omitido queda explicado.
- La CLI de producción completa el ciclo del Custom TypeScript erasable.
- El fallo requerido deja estado parcial observable y una segunda ejecución
  reconcilia sin efectos duplicados.
- La cancelación determinista se mantiene; la prueba de proceso de Windows se
  añade sólo si el entorno la hace fiable y la limitación queda diferenciada.
- El pipeline muestra la cobertura en el log, en el resumen del job y en un
  artefacto descargable, incluso cuando los tests fallan.
- Siguen pasando typecheck, validaciones de Markdown/Biome, build, suite
  completa y empaquetado.

## Fuera de alcance

Quedan fuera de este cierre:

- Issues #42, #44 y #45;
- umbral de cobertura del 100% o eliminación de todas las ramas específicas de
  plataformas no ejercitadas;
- generación HTML o publicación en un servicio externo de cobertura;
- rediseño de runners, sandboxing, rollback global o ejecución paralela;
- nuevos requisitos de producto no expresados en #8–#21;
- un helper nativo de Windows para fabricar eventos de consola, salvo que la
  investigación durante la implementación demuestre que es imprescindible para
  el criterio aprobado.
