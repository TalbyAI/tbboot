# Runtimes Custom humanos y declarativos

> Diseño derivado de los Issues [#44](https://github.com/TalbyAI/tbboot/issues/44)
> y [#45](https://github.com/TalbyAI/tbboot/issues/45), separados del alcance
> ejecutable del [Issue #17](https://github.com/TalbyAI/tbboot/issues/17).
>
> El Issue #8 y los ADR del repositorio siguen siendo la autoridad contractual.
> Este documento registra las decisiones de diseño aprobadas durante la sesión
> de brainstorming; no autoriza todavía la implementación.

## Decisión de alcance

El Issue #17 permanece centrado en Custom operations ejecutables mediante
`node` y `pwsh`, con su protocolo JSON, autorización, timeouts y control del
árbol de procesos.

Se crean dos trabajos independientes:

- #44: runtimes humanos `text` y `markdown`.
- #45: investigación de un runtime declarativo basado en package managers.

HTML queda fuera de #44 y no se añade al contrato actual.

## Issue #44: runtimes humanos

### Propósito

Permitir que un Custom step muestre instrucciones legibles por una persona
para instalar, verificar o retirar algo sin ejecutar un proceso. El operador
puede elegir manualmente entre las alternativas descritas por el contenido.

Los runtimes son `text` y `markdown`. Son nombres de presentación, pero forman
parte del campo `runtime` para mantener la forma común de `check`, `install` y
`uninstall`.

### Forma conceptual

```yaml
check:
  runtime: markdown
  confirm: true
  content: |
    ## Validación manual

    Comprueba en Azure Portal que existe la política requerida.

install:
  runtime: text
  content: |
    Instala Node 24 con fnm, nvm o el instalador oficial.
```

Cada operación humana requiere `content` y no admite `script`. `confirm` es
opcional y por defecto es `false`. No se ejecuta ningún proceso ni se aplica
timeout de runtime.

### Flujo de `check`

- Un `check` automático mantiene la semántica de #17.
- Un `check` humano con `confirm: false` imprime las instrucciones, genera un
  aviso advisory no bloqueante, omite el `install` del mismo Step y continúa
  con los Steps posteriores.
- Un `check` humano con `confirm: true` imprime las instrucciones y espera una
  confirmación interactiva. Una confirmación positiva satisface el check solo
  durante esa invocación; una negativa falla el Step según su opcionalidad.
- En modo no interactivo, un check humano que requiere confirmación no puede
  confirmarse: un Step obligatorio falla y un Optional step produce warning.

### Flujo de `install`

- Una instalación humana con `confirm: false` imprime las instrucciones,
  detiene la operación y explica que el operador debe realizar la instalación
  y volver a ejecutar tbboot desde el principio.
- Una instalación humana con `confirm: true` imprime las instrucciones y
  espera confirmación. Tras una confirmación positiva, tbboot ejecuta `check`
  de nuevo; si no queda satisfecho, el Step falla.
- Ninguna confirmación se persiste como trust o Installation record.

`uninstall` seguirá el mismo patrón cuando una futura operación humana de
retirada lo declare.

### Salida

- En modo humano, `text` y `markdown` se imprimen directamente sin renderizado
  adicional.
- En modo JSON, stdout sigue conteniendo exactamente un envelope JSON. El
  contenido de las instrucciones viaja dentro de la acción o diagnóstico
  correspondiente; no se mezcla texto adicional en stdout.
- tbboot no abre navegadores, crea archivos temporales ni renderiza Markdown en
  la terminal.

### Criterio de separación

Aunque comparte el modelo de lifecycle con #17, este runtime cambia la
semántica de ejecución: requiere interacción, estados advisory y transporte de
contenido documental. Mantenerlo separado reduce el riesgo de mezclar el
protocolo de procesos con la UX humana del operador.

## Issue #45: runtime de package managers

### Propósito de la investigación

Investigar si tbboot debe declarar instalaciones de herramientas mediante
package managers, sin exigir código Custom en Node o pwsh.

La forma siguiente es solo una hipótesis:

```yaml
install:
  runtime: package
  manager: npm
  package: vercel
  version: latest
```

El Issue #45 debe decidir si esto es:

1. un runtime declarativo con adaptadores para managers conocidos;
2. una invocación de procesos con ejecutable y argumentos estructurados; o
3. una capacidad que debe rechazarse o aplazarse por garantías insuficientes.

La investigación debe fijar managers, alcance global/local, versiones,
detección, lifecycle, autorización, red, credenciales, cancelación,
idempotencia, ownership y comportamiento específico de Windows x64 antes de
proponer implementación.

## Verificación del diseño

- La semántica de confirmación distingue explícitamente `check` advisory de
  `install` manual pendiente.
- HTML y package managers no se introducen accidentalmente en #17 o #44.
- Las salidas humana y JSON conservan el contrato de un único envelope.
- La confirmación no se convierte en trust persistente ni en una falsa prueba
  automática de instalación.
