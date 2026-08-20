# Issue #17: Custom Steps con Node y pwsh

> Diseño derivado de GitHub Issue #17 y de los ADR 0010, 0011, 0013 y 0015.

## Objetivo

Ejecutar `Custom Steps` externos o inline mediante Node o PowerShell 7 (`pwsh`)
usando el protocolo JSON común, integrados con `doctor`, `install`,
`install --dry-run` y `uninstall`. El cambio conserva el plan y el envelope
existentes para File y File Fragment steps.

## Alcance

- Runtimes soportados: `node` y `pwsh`.
- Operaciones: `check` obligatorio, `install` opcional y `uninstall` opcional
  solo cuando existe `install`.
- Cada operación usa exactamente un `script` relativo a la Recipe o un
  `content` inline.
- El proceso recibe una petición JSON por stdin, devuelve exactamente un
  resultado JSON por stdout y usa stderr para logs.
- El directorio de trabajo del proceso es la raíz del Consumer repository.
- Los scripts se canonicalizan con enlaces y deben permanecer dentro de la
  raíz canonical del Source.
- La autorización se concede por Source y revisión: `--allow-custom` es
  temporal y el perfil local conserva `trust.yaml`.
- `doctor` ejecuta `check`; `install` ejecuta `install` cuando existe y luego
  `check`; `uninstall` ejecuta `uninstall` en orden inverso.
- Los Steps opcionales convierten fallos, runtime no disponible, falta de
  autorización y timeouts en warnings. Los obligatorios bloquean la operación.
- `install --dry-run` valida definición, autorización, runtime y rutas, pero no
  inicia procesos ni escribe archivos o estado.
- Timeout y Ctrl+C terminan el árbol completo. Ctrl+C conserva los efectos ya
  completados y devuelve código 130.

Quedan fuera los runtimes `text`/`markdown`, candidatos múltiples de runtime,
Package steps, sandboxing, elevación de privilegios y rollback.

## Diseño técnico

### Runner y runtimes

`src/custom.ts` concentrará la lógica reutilizable:

- detectar el ejecutable y comprobar el rango por defecto de Node (`>=24.12 <25`)
  y pwsh (`>=7.6 <8`);
- validar el timeout configurado en segundos;
- construir invocaciones sin shell y con argumentos separados;
- envolver `content` para Node y pwsh, y ejecutar `script` externo;
- enviar una única petición JSON y validar el envelope `{ status, changed,
  message?, details? }`;
- distinguir `missing`, `drift`, `error`, salida inválida, exit code no cero,
  spawn failure y timeout;
- cancelar con `AbortSignal`; en Windows usar `taskkill /PID /T /F` y esperar
  el cierre del proceso.

Los defaults serán 60 segundos para `check` y 30 minutos para `install` y
`uninstall`. `selector`, cuando aparezca, usará la forma de rango fija
`>=<versión> <límite-superior>` ya usada por el prototipo; el runner elegirá el
ejecutable disponible cuya versión satisfaga ese rango. Sin selector se usan
los rangos por defecto. No se añadirá un gestor de versiones.

### Preflight y acciones

Los descriptores de `doctor` admitirán tanto artifacts como Custom Steps. Un
Custom action se incluirá en el envelope con su Source, Recipe y Step. El
preflight comprobará estáticamente:

- forma ya validada por el schema;
- contención canonical del `script` dentro del Source;
- autorización de la revisión;
- disponibilidad y compatibilidad del runtime;
- que la operación no use simultáneamente `script` y `content`.

La autorización no es un sandbox: un proceso autorizado conserva los permisos
normales de tbboot.

`doctor` ejecutará `check` después de pasar el preflight. En `install`, las
validaciones estáticas se completan antes de cualquier escritura; las
operaciones Custom se ejecutan en el orden efectivo del plan, y cada `install`
se verifica con `check`. En dry-run las acciones Custom quedan diferidas con
`custom-check-deferred` y no se ejecuta ningún proceso.

Los resultados Custom se traducirán al envelope común:

| Resultado | Step requerido | Step opcional |
| --- | --- | --- |
| `ok` | acción completada | acción completada |
| `missing` | error `custom-missing` | warning `custom-missing` |
| `drift` | error `custom-drift` | warning `custom-drift` |
| `error` o fallo del runner | error `custom-error` | warning `custom-error` |

`install --force` no modifica estas reglas.

### Autorización

El perfil se resolverá desde `USERPROFILE` en Windows y `HOME` como fallback,
en `<profile>/.tbboot/trust.yaml`. La entrada identifica la Source normalizada,
la revisión resuelta y la huella correspondiente cuando aplique. `--allow-custom
<source>` concede autorización solo a la invocación actual. El valor será una
ruta local normalizada o un locator Git normalizado, y se comparará con la
identidad del Source. En modo interactivo, si no existe autorización, se pedirá
una vez por Source y la aceptación se guardará en el perfil; en modo no
interactivo no se preguntará.

### Installation record y uninstall

La Installation record reutilizará el efecto `custom` ya previsto por el
schema, con `uninstallSupported` como única información adicional necesaria.
Un Custom completado se registra después de su verificación. Uninstall lee los
efectos en orden inverso, vuelve a resolver la Recipe para recuperar el handler
y ejecuta `uninstall` cuando está declarado. Si no existe, emite
`uninstall-unsupported`, conserva el efecto y continúa. Un fallo obligatorio o
una cancelación detiene los Steps restantes sin rollback.

### CLI y salida

`src/cli.ts` añadirá `uninstall`, `--force` y opciones repetibles
`--allow-custom`. La salida humana y JSON seguirá usando el envelope común; el
stdout JSON contendrá un único documento y stderr quedará reservado para logs.
La señal Ctrl+C se propagará mediante un `AbortController`, y el proceso
terminará con 130 cuando la cancelación proceda del usuario.

## Verificación

- Tests unitarios del runner para protocolo, validación de resultados, rutas,
  timeout, cancelación y selección de runtime.
- Tests end-to-end para Custom inline/externo, Node/pwsh disponible o ausente,
  autorización requerida, optionalidad, dry-run, state y uninstall.
- Typecheck y checks de Biome/Markdown durante el trabajo.
- Suite completa al final.
