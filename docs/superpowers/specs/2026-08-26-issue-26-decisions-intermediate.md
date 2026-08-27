# Issue #26: decisiones intermedias sobre extensibilidad

> Checkpoint no normativo de la sesión de brainstorming. No es todavía la
> nota final de diseño, no sustituye a la Issue #26 ni contiene un plan de
> implementación.

## Contexto

La Issue #26 explora una arquitectura para añadir nuevos `Step types`, definir
nuevos `runtimes` y extenderla en el futuro a `Source providers` y extensiones
de terceros. El diseño parte del contrato actual de `tbboot`, los ADR 0001,
0002, 0003, 0004, 0006, 0007, 0008, 0009, 0010, 0011, 0013, 0014 y 0015, y el
trabajo previo de las Issues #11 y #17.

## Decisiones tomadas

### Alcance y estrategia

1. El primer consumidor de la extensibilidad serán nuevos `Step types`
   mantenidos por el equipo. La arquitectura dejará una frontera futura para
   extensiones de terceros, pero no intentará resolver su distribución en el
   primer paso.
2. La primera validación debe usar la solución más simple: registro estático
   directo en el host. El descubrimiento dinámico, la carga desde módulos o
   paquetes y cualquier instalador de extensiones quedan para iteraciones
   futuras.
3. No se modifican todavía `src/`, `schemas/` ni la implementación productiva.
   Tampoco se construye todavía el prototipo de la Issue #26.

### Separación de dominios

4. Habrá una infraestructura común para descubrimiento, metadatos,
   compatibilidad, confianza y autorización, pero registros y contratos
   separados para:

   - `Step types`;
   - `runtimes`;
   - `Source providers`.

5. No se diseñará un “plugin universal” con una API única que mezcle los tres
   dominios. Un mismo paquete futuro podría contribuir a varios registros,
   pero cada contribución tendrá un contrato y una política de permisos
   independiente.

### `Step types`

6. Los nuevos tipos seguirán un ciclo común de `check`, `install` y
   `uninstall`, con capacidades declaradas. El host conservará la semántica de
   `Step`, `Optional step`, planificación, diagnósticos, cancelación y
   reconciliación.
7. El `StepTypeDefinition` proporcionará el schema del tipo y sus
   implementaciones. El host validará los campos comunes y aplicará el schema
   específico registrado para el objeto Step completo.
8. No se exigirá un subobjeto `config`. La definición de cada tipo podrá
   extender la forma común a primer nivel, manteniendo la forma existente de
   `File`, `File Fragment` y `Custom`.
9. La validación declarativa será mediante JSON Schema. Se podrá añadir un
   validador de código, inicialmente Zod, para reglas semánticas que no se
   puedan expresar de forma práctica en JSON Schema. JSON Schema seguirá
   siendo el contrato portable; Zod no será obligatorio para conocer la forma
   de un Step externo.
10. Los `Step types` incorporados se registrarán mediante el mismo mecanismo
    que los futuros tipos externos. Sus implementaciones podrán seguir siendo
    internas y no tendrán que ejecutarse mediante procesos externos.
11. La definición de un `Step type` declarará si permite comportamiento
    arbitrario de usuario. El host usará esa información para distinguir una
    confianza a nivel de tipo de una autorización a nivel de instancia.

### Ejecución de Steps

12. Un `Step type` podrá ofrecer una implementación `in-process`, una
    implementación `out-of-process` o ambas.
13. La Recipe seleccionará el `Step type`, no el modo de ejecución. El
    `StepTypeDefinition` declarará los modos disponibles y la política del
    host/usuario elegirá el modo permitido.
14. Una Recipe no podrá forzar que código no confiable se cargue `in-process`.
    Si el modo permitido no está disponible, el preflight fallará según la
    opcionalidad del Step; no habrá fallback silencioso a un modo con más
    privilegios.
15. Las implementaciones in-process podrán recibir servicios del host. Las
    implementaciones out-of-process usarán el protocolo común o una futura
    interfaz de capacidades. La autorización no es un sandbox ni implica
    elevación automática de privilegios.
16. Ambas formas de ejecución producirán el mismo resultado lógico y seguirán
    el mismo ciclo de vida. El adaptador de ejecución no redefinirá la
    semántica de `missing`, `drift`, `error`, timeout o cancelación.

### Versionado y schema

17. Mientras tbboot permanezca por debajo de 1.0, los documentos seguirán
    usando `schemaVersion: 1`, aunque cambie la forma del contrato.
18. Las versiones `0.x` no prometerán compatibilidad entre documentos o
    definiciones producidos por versiones anteriores y posteriores. No se
    crearán migraciones pre-1.0 por defecto.
19. Esta política deberá quedar explícita en el ADR correspondiente al
    versionado de documentos, sin cambiar todavía la implementación.
20. La versión del schema YAML y la versión de la API de una extensión son
    conceptos distintos. Una extensión tendrá su propia identidad y versión,
    además de declarar la versión de API del host que necesita.

### `runtimes`

21. La resolución de `runtimes` se hará mediante un registro separado del de
    `Step types`. Un Step declarará un requisito de runtime; el resolver
    consultará disponibilidad, compatibilidad, capacidades e identidad.
22. Si hay varios candidatos, se elegirá el primero disponible y compatible en
    el orden declarado.
23. El modelo de definición de runtime será híbrido:

    - un descriptor declarativo será el camino normal;
    - se podrán sobrescribir o implementar manualmente algunos o todos los
      aspectos cuando un runtime lo necesite;
    - `node` y `pwsh` servirán como casos incorporados registrados con el mismo
      concepto.

24. El host seguirá siendo responsable del protocolo lógico, validación del
    resultado, timeout y cancelación. El runtime resolverá su disponibilidad,
    versión, capacidades e invocación.
25. Un runtime declarativo podrá describir comando, probe de versión, rango,
    capacidades y protocolo. Un adaptador manual podrá cubrir diferencias como
    los wrappers actuales de Node y PowerShell.

### Validación, confianza y autorización

26. La infraestructura compartida no será por sí sola una autoridad de
    confianza. El registro aporta identidad, versión, huella, capacidades y
    disponibilidad; el host y la política del usuario deciden si se autoriza.
27. La confianza en el código de una extensión y la autorización del `Source`
    son gates distintos.
28. Las capacidades solicitadas por una extensión también participan en la
    decisión de autorización.
29. Los `Step types` built-in se consideran confiables y quedan autoaprobados.
    Esta regla no se aplica a `Custom`.
30. `Custom` requiere autorización por instancia/Step, porque permite que el
    Source aporte scripting arbitrario. La autorización existente por Source y
    `Source revision` se mantiene para esos handlers.
31. Un `Step type` que declare que permite comportamiento arbitrario no podrá
    recibir automáticamente la confianza de tipo de los tipos declarativos;
    sus instancias deberán pasar por autorización explícita.
32. El diseño futuro podrá añadir huellas de código, firmas, políticas de
    capacidades y sandboxing. Ninguno de esos mecanismos se implementa ahora.

### Resultado y estado

33. El host controlará el ciclo de instalación y conservará la identidad,
    Source, revisión, Recipe, Step y orden de la `Installation record`.
34. La Installation record podrá incluir estado opaco específico del tipo,
    limitado al `Step type` y gestionado por el host. El executor no escribirá
    directamente su propio estado fuera de ese contrato.
35. El resultado lógico común seguirá la forma existente de Custom:
    `{ status, changed, message?, details? }`, con `ok`, `missing`, `drift` y
    `error`.

### Confirmaciones posteriores de la sesión

36. La autorización de un Step con comportamiento arbitrario se asociará a la
    identidad del tipo, su versión o huella, el `Source revision` y una huella
    canónica de la instancia concreta del Step.
37. El estado específico será un valor JSON opaco asociado al tipo y
    persistido bajo control del host.
38. La API mínima será un `StepTypeDefinition` que agrupe schema, validador
    semántico opcional, capacidades, modos de ejecución y executor con
    `check`, `install` y `uninstall` opcionales.
39. Todo `Step type`, `runtime` y futura extensión declarará sus capacidades.
    El host las validará contra la política desde el principio; el enforcement
    técnico será progresivo y dependerá de la frontera de ejecución, los
    servicios acotados y un futuro sandbox cuando exista.
40. Los built-in conservan IDs cortos reservados y las extensiones usan IDs con
    namespace. El registro rechaza IDs duplicados y no aplica “last write wins”.
41. La unidad mínima de registro es un `StepTypeDefinition` que reúne schema,
    validador semántico opcional, capacidades, clasificación de comportamiento
    arbitrario, modos de ejecución y executor.
42. Los `RuntimeDefinition` usan un descriptor declarativo por defecto, con
    hooks manuales opcionales. El runtime no puede sobrescribir las invariantes
    del host sobre resultados, timeout, cancelación, seguridad o privilegios.
43. Un `RuntimeRequirement` común puede vivir en la definición del tipo o en
    una operación/Step cuando el tipo exponga esa selección.
44. El host solo descubre runtimes; no los instala automáticamente.
45. Cada `RuntimeDefinition` valida su selector de versión. Los runtimes
    incorporados pueden empezar con la sintaxis de rango actual.
46. Un `Source provider` registrado separa validación de locator, normalización
    de identidad, selector, resolución de `Source revision` y materialización.
47. La confianza en el código del `Source provider` y la confianza/autorización
    del Source son decisiones separadas. El provider debe devolver la identidad
    canónica del Source materializado para poder usarla como clave de confianza.
48. La identidad devuelta por un `Source provider` será estructurada y
    canónica —provider más locator normalizado— y el host derivará de ella las
    claves estables para confianza, lockfile y deduplicación.
49. Un provider remoto deberá declarar sus necesidades de red, credenciales o
    cache como capacidades; no recibirá esos recursos implícitamente.
50. El descubrimiento futuro de extensiones usará módulos o paquetes
    explícitamente registrados por el usuario o el host, no el escaneo
    automático de Sources ni un marketplace obligatorio.
51. Un Step type no registrado falla si es requerido y se omite con warning si
    es opcional; una instancia registrada pero inválida según su schema siempre
    es un error de validación.
52. Sigue abierta la representación del contenido materializado: el contrato
    no debe exigir necesariamente una carpeta local y puede devolver un objeto
    en memoria o un filesystem virtual.
53. El contrato público usará un filesystem virtual/`SourceContent`; un árbol
    en memoria será un backend posible, no una segunda forma que los
    consumidores deban distinguir.
54. La proyección a filesystem real será temporal y bajo demanda, únicamente
    cuando una implementación out-of-process necesite rutas reales.
55. `SourceContent` será de solo lectura y ofrecerá una interfaz mínima para
    leer, listar y consultar metadata de rutas relativas.
56. El provider proporcionará una huella y el host podrá verificarla cuando la
    política o el modo lo requieran.
57. El provider separará la resolución de una `Source revision` de la apertura
    de su contenido. También recibirá la convergencia de selectors para
    aplicar su propia semántica.
58. `SourceContent` tendrá inicialmente un backend minimalista controlado por
    tbboot. La comparación de librerías VFS queda como validación posterior y
    solo se hará si aparecen necesidades concretas de tamaño, lazy loading,
    overlays o compatibilidad con enlaces.
59. Los errores de provider conservarán detalles propios, pero el host
    normalizará fases y códigos mínimos para locator, resolución, revisión,
    contenido y fingerprint.
60. `SourceHandle` expondrá cleanup/lease y el host lo liberará en éxito, error
    y cancelación.
61. `SourceContent` expondrá rutas lógicas relativas normalizadas y seguras;
    los providers no propagarán libremente escapes o enlaces inseguros a los
    consumidores.
62. Un provider remoto declarará sus necesidades de credenciales y, en la
    arquitectura futura, recibirá acceso mediante un mecanismo explícito del
    host. Las referencias de Source no contienen secretos.
63. Queda permitida una caché persistente local del usuario para clones o
    contenidos resueltos, reutilizable solo con identidad, revisión y huella
    verificadas. Las firmas no se presuponen si el provider no las aporta.
64. La caché persistente tendrá comandos explícitos de gestión; su conjunto
    mínimo y su alcance quedan pendientes y no forman parte de la
    implementación actual.
65. Una extensión futura publicará un manifiesto con identidad, versión, API
    de host, contribuciones, capacidades, modos de ejecución y huella o firma.
    El registro/activación será explícito y el host validará el manifiesto
    antes de activar la extensión.
66. La compatibilidad de una extensión se resolverá antes de validar o
    ejecutar Recipes mediante el rango de API declarado y las reglas de
    major/minor del host.
67. La confianza persistente de una extensión se asociará a su identidad,
    versión de API, capacidades y huella o firma del artefacto, no solo a su
    nombre.
68. La caché expondrá inicialmente `cache list` y `cache prune`; el borrado
    total se resolverá mediante una opción explícita de prune y no mediante un
    segundo comando destructivo.
69. Si falta la extensión histórica de un efecto, `uninstall` emitirá warning,
    conservará el efecto y continuará; solo ejecutará el uninstall con la
    extensión exacta o compatible autorizada que produjo el efecto.
70. Los efectos de extensiones registrarán también identidad, versión y huella
    de la extensión, huella canónica del Step y estado opaco.
71. Cambiar la huella de una extensión la convierte en distinta para confianza
    y recuperación histórica, aunque conserve nombre y versión.
72. La selección de runtime fallida tendrá un error común y conservará el
    motivo por candidato: ausente, incompatible o probe fallido.
73. El registro creará un executor por instancia mediante
    `createExecutor(step, context)`, con `check`, `install` y `uninstall`
    opcionales.
74. El executor recibirá un `StepExecutionContext` con `SourceContent` de solo
    lectura, identidad del Source, Recipe, Step y servicios/capacidades
    declarados.
75. `install` devolverá el estado JSON necesario para que el host lo persista
    y lo entregue después a `check`/`uninstall`.
76. `SourceProviderDefinition` separará schemas de locator/selector,
    normalización, resolución y apertura/materialización.
77. `RuntimeDefinition` tendrá un descriptor declarativo con identidad, versión
    de API, sonda de disponibilidad, selector de versión, capacidades,
    protocolo y lanzamiento; un adaptador manual podrá sobrescribir partes
    concretas.
78. Los Steps out-of-process usarán un protocolo lógico JSON común; cada
    runtime adaptará únicamente transporte, lanzamiento y detalles técnicos.
79. Las capacidades iniciales formarán un vocabulario pequeño y estable, como
    `source.read`, `consumer.read`, `consumer.write`, `process.execute`,
    `network`, `credentials.read` y `state.read/write`. Al principio se
    validarán como política, con enforcement progresivo en futuras fronteras
    de servicios o sandboxing.
80. La definición de un Step type declarará una lista ordenada de candidatos de
    runtime. Un Step concreto solo podrá aportar una selección cuando el tipo
    exponga explícitamente esa elección. El host escogerá el primer candidato
    disponible, compatible y autorizado.
81. `install` recibirá el estado previo si existe y devolverá el nuevo estado;
    `check` y `uninstall` recibirán el último estado persistido. El host solo
    persistirá cambios de estado explícitos.
82. La confianza de una extensión se asociará a su identidad, versión, API del
    host, contribuciones, capacidades declaradas y huella del artefacto; una
    firma podrá complementar esa identidad cuando exista. No bastará el nombre
    del paquete.
83. El estado opaco será un valor JSON propiedad del Step type, guardado dentro
    de un envoltorio del host con identidad de tipo, extensión, huella y huella
    canónica del Step.
84. Un `Source provider` validará locator y selector, normalizará la identidad,
    resolverá la `Source revision` y abrirá un `SourceHandle` con identidad
    canónica, revisión, huella, `SourceContent` de solo lectura y limpieza.
85. El candidato para un futuro prototipo será un `Template step` declarativo
    que lea archivos del `Source` y genere un artefacto gestionado, pudiendo
    probar ejecución in-process y out-of-process sin introducir scripting
    arbitrario.
86. Se actualizará el ADR 0014 para fijar schemaVersion 1 hasta la publicación
    de la versión 1.0 y se creará un único ADR nuevo para el límite de
    extensiones, registros y confianza. Los detalles operativos quedarán en la
    especificación.
87. No se construirá todavía el prototipo de #26. Solo se abrirá un spike
    ejecutable si queda una pregunta técnica concreta que no pueda validarse
    conceptualmente, como el backend de `SourceContent`.
88. El descubrimiento futuro de extensiones será explícito mediante un paquete
    o módulo declarado. El host leerá primero el manifiesto, validará
    compatibilidad y confianza y activará después su registro; no habrá
    escaneo automático ni activación desde un `Source`.
89. El orden seguro será: leer manifiesto, validar API y capacidades, aplicar
    confianza y política, activar el código de registro y validar Recipes.
90. La ejecución in-process requiere código confiable. La ejecución
    out-of-process aporta aislamiento operativo y control de fallos, pero no se
    considerará un sandbox por sí misma. El sandboxing real queda para una
    evolución futura.
91. `SourceContent` tendrá un contrato público de sistema de archivos virtual
    lógico, de solo lectura y con rutas relativas seguras. La implementación
    podrá usar inicialmente un árbol en memoria o una proyección temporal; la
    elección de librería queda para un spike si aparece una necesidad concreta.
92. La validación conceptual incluirá: built-in registrado como extensión,
    `Template step` in-process y out-of-process, fallback de runtimes,
    autorización de un `Custom` y un futuro `Source provider`.

## Alternativa recomendada hasta ahora

La dirección preferida es un registro estático de `StepTypeDefinition` y
`RuntimeDefinition`, con infraestructura común pero contratos separados. Los
tipos incorporados se registran como extensiones internas; cada tipo publica
JSON Schema y puede añadir validación Zod. El host mantiene el ciclo común,
selecciona el primer runtime compatible y elige entre adaptadores in-process y
out-of-process según el registro y la política de confianza.

## Pendiente de cerrar

- Revisión final de límites, riesgos y preguntas abiertas del diseño.

## Restricciones recordadas

- No marketplace ni instalador de extensiones.
- No carga de extensiones de terceros.
- No runtime productivo nuevo ni modificación de `node`/`pwsh`.
- No nuevo `Source provider`.
- No cambios en `File`, `File Fragment` o `Custom` durante este trabajo.
- No plan de implementación, commit ni push.
