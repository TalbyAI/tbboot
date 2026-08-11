# La identidad del source depende de su proveedor

Los sources pueden proceder de mecanismos con garantías de identidad distintas. Un source Git obtiene su identidad del repositorio y su referencia; un source local o de red puede usar una versión declarada en sus archivos y esa declaración se acepta como fuente de confianza. El modelo debe conservar esta diferencia mediante proveedores de source, empezando el prototipo con carpetas locales y dejando Git para una fase posterior.

**Consecuencias**: no se impone una estrategia universal de identidad antes de conocer los proveedores reales, pero las operaciones de instalación deberán poder informar qué mecanismo y versión resolvieron.
