# La identidad del source depende de su proveedor

Los Sources pueden proceder de mecanismos con locators distintos, pero comparten una regla de identidad: proveedor más locator normalizado. El selector no forma parte de la identidad. El proveedor local usa la ruta normalizada de la carpeta; Git usa el repositorio y su `path` interno opcional. Cuando el proveedor admite selector, lo resuelve por separado a una Source revision exacta.

**Consecuencias**: dos selectores para el mismo locator se refieren al mismo Source y deben resolverse como restricciones compatibles; el lockfile registra por separado el selector solicitado y la revisión resuelta.
