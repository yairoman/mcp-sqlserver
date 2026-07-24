# Checklist de code review — T-SQL

Una página. Para revisar cualquier procedimiento, función, vista o trigger antes de aprobarlo.
Cada punto enlaza con su regla en [`reglas.md`](reglas.md).

## Consultas

- [ ] Ninguna columna aparece envuelta en función dentro de `WHERE` o `JOIN` — `ISNULL`, `REPLACE`, `CONVERT`, `LEFT`, `YEAR`… · **R-01**
- [ ] No hay `ISNULL()` sobre columnas que el esquema declara `NOT NULL` · **R-01**
- [ ] No hay funciones escalares invocadas en la lista del `SELECT` ni en predicados · **R-14**
- [ ] Las funciones de tabla usadas son **inline**, no multi-statement · **R-15**
- [ ] Todo `TOP` tiene su `ORDER BY` · **R-12**
- [ ] `UNION` está justificado; si no se necesita deduplicar, es `UNION ALL` · **R-17**
- [ ] No hay `LIKE` sin comodines (usar `=`) · higiene
- [ ] Las comparaciones con `NULL` usan `IS NULL`, no `=` · **R-07**
- [ ] Todo `CONVERT`/`CAST` a `varchar` lleva longitud explícita · higiene
- [ ] Los tipos de parámetro coinciden con los de la columna (sin `CONVERT_IMPLICIT`) · **R-22**
- [ ] Ninguna regla de negocio depende de `LIKE '%texto%'` sobre nombres traducibles · higiene

## Estructura de la consulta

- [ ] No se une a un grano más fino que el de la salida · **R-20**
- [ ] Ningún `GROUP BY` largo está haciendo de `DISTINCT` sobre un fan-out evitable · **R-20**
- [ ] Las subconsultas correlacionadas del `SELECT` no son `EXISTS` disfrazados · **R-21**
- [ ] Los predicados no son *catch-all* (`col = ISNULL(@p, col)`, `CASE @p WHEN…`) · **R-06**

## Procesamiento

- [ ] No hay cursores ni bucles `WHILE` que puedan resolverse por conjuntos · **R-02**
- [ ] Ningún `EXEC` a otro procedimiento ocurre **dentro de un bucle** · **R-02**
- [ ] Los parámetros complejos viajan como **TVP**, no como cadena delimitada · **R-18**
- [ ] Lo invariante está fuera del bucle (IDs de catálogo, configuración) · **R-02**

## Tablas temporales

- [ ] No se usa `SELECT ... INTO #temp` en consultas largas · **R-05**
- [ ] Las tablas temporales se crean con `CREATE TABLE` y constraints **sin nombre** · **R-05**
- [ ] Las temporales grandes se indexan **después** de la carga masiva · **R-16**
- [ ] Si hay `ORDER BY`, está en el `SELECT` que devuelve, no en el que carga el temporal · **R-13**
- [ ] No se usan table variables en consultas grandes · **R-19**

## Transacciones y errores

- [ ] La transacción cubre **solo** lo que debe ser atómico · **R-04**
- [ ] Ningún `EXEC` externo ni logging dentro de la transacción · **R-04**
- [ ] `SET XACT_ABORT ON` presente en todo procedimiento que abre transacción · **R-26**
- [ ] Se usa `SAVE TRANSACTION` + `XACT_STATE()` si el código puede correr anidado · **R-10**
- [ ] Ningún `CATCH` termina sin `;THROW;` — o justifica por escrito por qué no · **R-11**
- [ ] El orden de escritura de tablas respeta el orden canónico del resto de objetos · **R-27**

## Concurrencia e integridad

- [ ] `NOLOCK` no aparece en ninguna lectura que decida un `INSERT`/`UPDATE` · **R-09**
- [ ] Los hints son consistentes: no hay sentencias sueltas sin hint en un objeto que sí los usa · **R-09**
- [ ] Ningún ID se genera con `MAX(id) + 1` · **R-08**
- [ ] Las operaciones que deben ser idempotentes están respaldadas por una restricción `UNIQUE` · **R-08**

## Triggers

- [ ] Es **set-based**: no asigna variables desde `inserted`/`deleted` · **R-03**
- [ ] Usa `inserted`/`deleted` directamente, sin re-leer la tabla base · **R-03**
- [ ] No actualiza la tabla que lo dispara — o se documenta y se acota con un filtro · **R-03**
- [ ] Maneja correctamente el caso de **0 filas afectadas** · **R-03**

## Esquema

- [ ] El índice nuevo no está ya cubierto por el prefijo de otro existente · **R-23**
- [ ] Se nombra por sus **columnas**, no por la persona o cliente solicitante · **R-23**
- [ ] Toda tabla con crecimiento sostenido tiene índice clustered · **R-24**
- [ ] Toda tabla de bitácora nace con su política de retención · **R-24**

## Higiene

- [ ] `SET NOCOUNT ON` al inicio del procedimiento
- [ ] Sin `SELECT *`
- [ ] Objetos calificados con esquema (`dbo.Tabla`)
- [ ] Columnas calificadas con su alias en joins de varias tablas
- [ ] El procedimiento no empieza por `sp_`

---

## Antes de aprobar una reescritura

Tres preguntas que van por encima de todo lo anterior:

1. **¿Se demostró la equivalencia con datos reales?** `EXCEPT` en las dos direcciones, sobre un
   lote que ejercite cada rama. Sin eso, no es una reescritura: es una reescritura *propuesta*.
2. **¿Algún patrón "malo" que se quitó sostenía la correctitud?** El caso clásico es el `UNION`
   cuya deduplicación alguien estaba usando a propósito.
3. **¿Lo que se decidió NO corregir quedó documentado?** Las inconsistencias de negocio se
   marcan y se explican; no se arreglan por iniciativa técnica.
