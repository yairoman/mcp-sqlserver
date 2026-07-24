# Reglas T-SQL — cuerpo de la base de conocimiento

Cada regla salió de un problema real medido en código productivo. Ninguna es genérica de
manual: si está aquí es porque alguien la violó y costó algo.

**Los casos están anonimizados a propósito.** Se conserva la magnitud (filas, GB, %) porque es
lo que justifica la severidad; se eliminan nombres de empresa, base, esquema y objeto. Ver la
política en `SKILL.md`.

Marcas: **[obs]** observado en código auditado · **[gen]** anti-patrón general aún no visto aquí.

---

# Nivel 1 · Órdenes de magnitud

Explican la mayor parte del problema de rendimiento medido. Si solo se adopta una parte del
estándar, que sea esta.

## R-01 · Nunca envuelvas una columna en una función dentro de `WHERE` o `JOIN` [obs]

**Severidad:** crítica · **Impacto:** ×100 o más

El índice correcto suele **ya existir**; la función sobre la columna lo anula. En un caso
extremo observado: 16 `REPLACE` anidados sobre una columna de texto, en tablas de 288 K–764 K
filas, 13 veces por llamada.

```sql
-- ANTI-PATRÓN
WHERE ISNULL(DET.IsVerified, 0) = 0                      -- scan forzado
WHERE LTRIM(RTRIM(REPLACE(REPLACE(...(e.Nombre)...)))) LIKE @c
WHERE YEAR(f.Fecha) = 2026

-- CORRECTO
WHERE DET.IsVerified = 0                                 -- columna NOT NULL DEFAULT 0
WHERE f.Fecha >= '20260101' AND f.Fecha < '20270101'     -- rango, no función

-- Para texto normalizado: columna calculada PERSISTIDA + índice
ALTER TABLE dbo.Tabla ADD NombreNorm AS (UPPER(REPLACE(...))) PERSISTED;
CREATE INDEX IX_Tabla_NombreNorm ON dbo.Tabla (NombreNorm);
WHERE t.NombreNorm LIKE @c
```

> **Mnemotécnica:** la función va del lado del **valor**, nunca del lado de la **columna**.

Caso hermano: `ISNULL()` sobre una columna que el esquema ya declara `NOT NULL`. No cambia
resultados, pero esconde los casos reales. Detectar cruzando con `sys.columns.is_nullable`.

## R-02 · No llames un procedimiento dentro de un bucle fila por fila [obs]

**Severidad:** crítica

Observado: un `WHILE` invoca un procedimiento de guardado una vez por fila. Cada llamada hacía
58 parseos de cadena, 3 búsquedas que escanean tablas completas ~13 veces, y 13 DML sobre 3
bases. El costo crece de forma catastrófica con N.

```sql
-- ANTI-PATRÓN
WHILE (@Cont <= @Tope)
BEGIN
    EXEC dbo.GuardarAlgo @Parametros = @Texto, ...       -- N round-trips
    SET @Cont = @Cont + 1
END

-- CORRECTO: materializa el lote y procesa en una pasada
INSERT INTO destino (col1, col2)
SELECT o.col1, o.col2 FROM #lote o WHERE ...;

-- Si hay que llamar a un SP, que acepte un parámetro de tabla (TVP)
EXEC dbo.GuardarAlgoLote @Filas = @tvp;
```

Si el bucle es inevitable: sácalo de la transacción, saca del bucle todo lo invariante, y haz
commit por lotes en vez de mantener una transacción global.

## R-03 · Los triggers deben ser set-based, siempre [obs]

**Severidad:** crítica · **No es lentitud: es pérdida de datos**

Observado en un trigger de integración: `SELECT @OldID = ID FROM INSERTED`. Eso toma **una fila
arbitraria**. En cualquier `INSERT`/`UPDATE` multi-fila, el resto se pierde en silencio.

```sql
-- ANTI-PATRÓN
SELECT @OldID = OperationID FROM INSERTED               -- ¡solo 1 fila!
INSERT INTO Integracion (OldID) VALUES (@OldID)

-- CORRECTO
INSERT INTO Integracion (OldID)
SELECT i.OperationID
FROM inserted i
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.OperationID = i.OperationID);
```

```sql
-- DETECCIÓN: triggers que asignan variables desde inserted/deleted
SELECT OBJECT_NAME(t.parent_id) AS tabla, t.name
FROM sys.triggers t
JOIN sys.sql_modules m ON m.object_id = t.object_id
WHERE m.definition LIKE '%= %FROM%INSERTED%'
   OR m.definition LIKE '%= %FROM%DELETED%';
```

## R-04 · Transacciones cortas: nunca envuelvan trabajo externo [obs]

**Severidad:** crítica

Observado: un `BEGIN TRAN` que abarca 700 líneas, incluyendo un bucle completo con llamadas a
otros procedimientos y escrituras en 4 bases distintas. Los locks se acumulan durante toda la
corrida sobre tablas de 10.9 M y 16.5 M filas.

> Dentro de una transacción va **solo lo que debe ser atómico**. Fuera: preparación de datos,
> búsquedas, logging, llamadas a servicios y a otros procedimientos.

```sql
-- DETECCIÓN: objetos con transacciones que contienen EXEC (revisar a mano)
SELECT OBJECT_NAME(object_id) AS objeto
FROM sys.sql_modules
WHERE definition LIKE '%BEGIN TRAN%' AND definition LIKE '%EXEC%';
```

## R-05 · `SELECT ... INTO #temp` en una consulta larga bloquea la instancia entera [obs]

**Severidad:** crítica

`SELECT INTO` crea el objeto dentro de la transacción de la consulta y **sostiene bloqueos
sobre las tablas de sistema de tempdb durante toda su ejecución**. Si la consulta se degrada,
esa sesión bloquea a cualquier otra sesión de la **instancia** —no de la base— que cree un
objeto temporal.

Observado en un procedimiento de menú de alta frecuencia: `SELECT` con 53 joins escribiendo
directo a `#temp`. Señal a nivel servidor: `PAGELATCH_EX` y `LATCH_EX` con cientos de millones
de esperas acumuladas.

```sql
-- ANTI-PATRÓN
SELECT ...53 joins... INTO #Resultado FROM ...

-- CORRECTO: separa la creación del objeto del trabajo pesado
CREATE TABLE #Resultado (Col1 int NOT NULL, Col2 varchar(100) NOT NULL, ...);
INSERT INTO #Resultado (Col1, Col2, ...) SELECT ... FROM ...;
```

Efecto secundario valioso: con `CREATE TABLE` explícito y constraints **sin nombre**, el
temporal queda elegible para el caché de objetos temporales del motor. Un
`CONSTRAINT PK_x PRIMARY KEY` con nombre lo inhabilita; `PRIMARY KEY` a secas, no.

Segundo efecto: las sentencias que referencian un `#temp` creado con `SELECT INTO` **no pueden
compilarse hasta runtime**. A alta frecuencia, varias sesiones compilan el mismo objeto y se
serializan por *compile lock*.

## R-06 · Predicados *catch-all*: un plan para todos los parámetros [obs]

**Severidad:** crítica

```sql
-- ANTI-PATRÓN (todas las variantes)
WHERE @Reopened = (CASE @Reopened WHEN 0 THEN 0 WHEN 1 THEN ... END)
WHERE col = ISNULL(@p, col)
WHERE (@p IS NULL OR col = @p)
```

Un solo plan cacheado sirve a todas las combinaciones. Basta con que se compile para un caso
de 0 filas para que su reutilización en un caso grande dispare la duración. Es el patrón
**"funcionaba bien y de pronto se cayó"**.

Arreglo, en orden de preferencia:

1. Reescribir en forma `OR` explícita y separar las ramas en flujos distintos.
2. `OPTION (RECOMPILE)` en la consulta afectada — **midiendo** el coste de compilación, que en
   un SP de alta frecuencia no es despreciable.
3. SQL dinámico parametrizado.

Nunca `WITH RECOMPILE` a nivel de procedimiento.

Trampa relacionada: reasignar el parámetro al inicio (`SET @p = ISNULL(@p, ...)`) no ayuda —
el optimizador sigue usando el valor *sniffed* original.

---

# Nivel 2 · Corrección — bugs silenciosos

No se manifiestan como lentitud sino como datos incorrectos, duplicados o errores que nadie ve.
Son los más peligrosos porque no hay síntoma.

## R-07 · Comparar con `NULL` usando `=` siempre es falso [obs]

Observado: `AND TS.labID = null`. Esa rama del filtro **nunca se ejecutó** desde que se
escribió. Al corregirla, el comportamiento del proceso cambia.

```sql
-- ANTI-PATRÓN
WHERE t.labID = null                    -- siempre UNKNOWN → nunca verdadero
WHERE c.Inactive = @Inactive            -- si @Inactive es NULL, vacía el resultado

-- CORRECTO
WHERE t.labID IS NULL
WHERE (@Inactive IS NULL OR c.Inactive = @Inactive)
```

Hermano: `NOT IN` con una subconsulta que puede devolver `NULL` produce conjunto vacío. Usar
`NOT EXISTS`.

## R-08 · Nunca generes IDs con `MAX(id) + 1` [obs]

**Bug de concurrencia.** Observado dentro de un trigger, sin serializar. Dos ejecuciones
concurrentes obtienen el mismo id → violación de clave o registros pisados.

```sql
-- ANTI-PATRÓN
SELECT @id = MAX(id) + 1 FROM tabla
INSERT INTO tabla (id, ...) VALUES (@id, ...)

-- CORRECTO: que la tabla genere el id
IDENTITY  -- o  CREATE SEQUENCE + NEXT VALUE FOR

-- Si no puedes cambiar el esquema, serializa
SELECT @base = ISNULL(MAX(id), 0) FROM tabla WITH (UPDLOCK, HOLDLOCK);
```

## R-09 · `NOLOCK` jamás en lecturas que deciden una escritura [obs]

**Bug de duplicados.** Observado: más de 60 lecturas con `(NOLOCK)`; varias eran
`IF NOT EXISTS` que decidían si se insertaba un registro. Una lectura sucia ahí produce
duplicados.

> `NOLOCK` solo en catálogos estables y reportes tolerantes a inexactitud. **Nunca** donde el
> resultado gobierne un `INSERT`/`UPDATE`. Refuerza con una restricción `UNIQUE` que haga la
> operación idempotente.

Contexto que suele acompañar: `READ_COMMITTED_SNAPSHOT` apagado. Los `NOLOCK` son un parche a
su ausencia; la alternativa correcta muchas veces ni se ha evaluado. Al proponer habilitar
RCSI, presupuesta su costo: *version store* en tempdb dimensionado por la transacción más
larga, y +14 bytes por fila en las filas versionadas. No es gratis — es mejor.

**`NOLOCK` parcial es peor que ninguno**: basta una sentencia sin hint para entrar en la cadena
de bloqueo. Contar hints contra número de tablas del objeto.

## R-10 · No abras transacciones con nombre dentro de un trigger o SP anidado [obs]

Observado: dos triggers hacen `BEGIN TRAN <nombre>` y en el `CATCH` hacen
`ROLLBACK TRAN <nombre>`. Cuando ya hay una transacción externa abierta (`@@TRANCOUNT > 1`),
ese `ROLLBACK` falla con **error 6401** y aborta todo el lote.

```sql
-- CORRECTO en código que puede correr anidado
DECLARE @sp sysname = 'sp_MiOperacion';
IF @@TRANCOUNT > 0 SAVE TRANSACTION @sp; ELSE BEGIN TRANSACTION;
BEGIN TRY
    ...
END TRY
BEGIN CATCH
    IF XACT_STATE() = 1 ROLLBACK TRANSACTION @sp;
    ;THROW;
END CATCH
```

## R-11 · Un `CATCH` vacío es un error que nadie verá jamás [obs]

Observado: varios `BEGIN CATCH` que solo hacen `ROLLBACK`, o que registran en bitácora y
siguen. Los fallos de integración desaparecen sin rastro.

> Todo `CATCH` termina en `;THROW;` **o** registra **y** relanza. Si el negocio exige continuar
> ante el fallo, que sea una decisión explícita y comentada, no el efecto secundario de un
> `CATCH` vacío.

## R-12 · Determinismo: `TOP` sin `ORDER BY`, variables desde `SELECT` [obs]

Observado: decenas de `SELECT TOP 1 ...` sin `ORDER BY` —el motor puede devolver una fila
distinta si cambia el plan— y `SELECT @var = col FROM tabla` sin garantía de una sola fila, que
se queda con una arbitraria.

> Si usas `TOP`, pon `ORDER BY`. Si asignas una variable desde una tabla que *debería* tener una
> fila, hazlo explícito y valida.

## R-13 · `ORDER BY` en un `SELECT ... INTO #temp` se pierde [obs]

El orden de lectura de una tabla temporal **no está garantizado**. Si el `ORDER BY` se aplica
al `INSERT` y los `SELECT` finales no reordenan, el resultado es no determinista — y además se
paga el coste del sort sin obtener su beneficio.

Observado como consecuencia de una refactorización que movió una consulta a `#temp` sin mover
el `ORDER BY` al final. El defecto sobrevivió sin detectarse porque *a veces* el orden salía
bien.

## R-26 · `SET XACT_ABORT ON` en todo procedimiento con transacciones [gen]

Sin `XACT_ABORT`, un **timeout del cliente** aborta la ejecución **sin revertir la
transacción**: la sesión queda con `@@TRANCOUNT > 0`, los bloqueos retenidos, y el pool de
conexiones puede reutilizar esa sesión con la transacción todavía abierta. Es la causa clásica
del bloqueo "fantasma": el *head blocker* aparece **dormido** (`sleeping` / `awaiting command`)
y nadie entiende qué está ejecutando — no está ejecutando nada; está reteniendo.

`TRY/CATCH` **no** cubre este caso: un timeout de cliente no dispara el `CATCH`.

```sql
-- CORRECTO: plantilla mínima de procedimiento transaccional
CREATE PROCEDURE dbo.MiProc AS
SET NOCOUNT ON;
SET XACT_ABORT ON;          -- error grave O timeout → rollback automático, siempre
BEGIN TRY
    BEGIN TRAN;
    ...
    COMMIT;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    ;THROW;
END CATCH
```

```sql
-- DETECCIÓN del síntoma: head blockers dormidos con transacción abierta
SELECT s.session_id, s.status, s.host_name, s.program_name,
       s.last_request_end_time,
       DATEDIFF(SECOND, s.last_request_end_time, GETDATE()) AS SegundosInactivo
FROM sys.dm_exec_sessions s
JOIN sys.dm_tran_session_transactions t ON t.session_id = s.session_id
WHERE s.status = 'sleeping';

-- DETECCIÓN de la causa: procedimientos con BEGIN TRAN sin XACT_ABORT
SELECT OBJECT_NAME(object_id) AS objeto
FROM sys.sql_modules
WHERE definition LIKE '%BEGIN TRAN%'
  AND definition NOT LIKE '%XACT_ABORT%';
```

Complementa a R-04 (transacción corta) y R-10 (`SAVE TRANSACTION` para anidados): la
transacción corta minimiza la ventana; `XACT_ABORT` garantiza que la ventana se cierre incluso
cuando el cliente desaparece.

---

# Nivel 3 · Diseño y eficiencia

## R-14 · Nada de funciones escalares en un `SELECT` [obs]

Observado: funciones de linkeo que no son *lookups* —cada una es un `SELECT TOP 1` con 3 joins
y 2 subconsultas— invocadas ×6 por fila.

En SQL Server 2016 **no existe el inlining de UDF escalares** (llegó en 2019): cada llamada se
ejecuta por fila y **serializa el plan**, matando el paralelismo de toda la consulta.

Forma correcta: convertirla en `JOIN` / `OUTER APPLY`, precalculando en variables los valores
constantes (IDs de catálogo) una sola vez.

> ⚠️ **Cuidado al convertir.** Si la tabla destino tiene duplicados, un `LEFT JOIN` **multiplica
> filas**. En un caso observado la tabla de linkeo los tenía (4 013 filas para 4 000 claves
> distintas) y el join habría duplicado inserciones. Usa `OUTER APPLY ... TOP 1` cuando no
> puedas garantizar unicidad.

## R-15 · Funciones de tabla: inline, no multi-statement [obs]

Observado: una función de tabla multi-statement (`RETURNS @tabla TABLE`) invocada con
`CROSS APPLY` por fila. El optimizador le asigna cardinalidad fija (1 fila en compat < 120, 100
después) sin importar cuántas devuelva, y elige planes pésimos.

```sql
-- ANTI-PATRÓN
RETURNS @Resultado TABLE (...) AS BEGIN ... INSERT ... RETURN END

-- CORRECTO: una sola sentencia
RETURNS TABLE AS RETURN (SELECT ...);
```

## R-16 · Indexa las tablas temporales grandes según cómo se consultan [obs]

Observado: una tabla temporal central recibía ~20 `UPDATE`/`JOIN` sucesivos que filtraban por
tres columnas, pero su único índice era por otras dos. Cada pasada era un scan completo.

> Crea los índices **después** de la carga masiva —antes penalizaría el `INSERT`— y solo sobre
> las columnas por las que realmente se filtra.

Contrapeso: crear índices sobre un `#temp` dentro del procedimiento **inhabilita el caché de
objetos temporales**. Compensa si el temporal es grande; con unos cientos de filas, no.

## R-17 · `UNION` deduplica; usa `UNION ALL` salvo que necesites lo contrario [obs]

Observado en una vista de permisos: `UNION` de 36.7 M + 19.6 M filas = un sort de
deduplicación de 56.3 M filas por cada referencia, y la vista se referencia 3 veces.

> ⚠️ **El cambio no es automático.** Solo es equivalente si los conjuntos son disjuntos.
> Verifícalo con datos antes de cambiarlo, o duplicarás filas.

Caso real de por qué importa: en un procedimiento auditado, una rama del `UNION` **dependía**
de la deduplicación para colapsar filas hermanas que proyectaban el mismo padre. Cambiarlo a
`UNION ALL` habría duplicado entradas visibles al usuario. La equivalencia se demostró primero
y el `DISTINCT` se hizo explícito en esa rama.

## R-18 · No pases parámetros como cadenas «clave=valor» [obs]

Observado: 58 llamadas a un parser por cada invocación de un procedimiento, cada una
re-escaneando la misma cadena de 8 000 caracteres. Multiplicado por N filas del bucle.

> Forma correcta: parámetros de tabla (**TVP**). Si no puedes cambiar la firma, haz **un solo**
> parse a una tabla temporal y lee de ahí.

> ⚠️ **Trampa de versión.** `STRING_SPLIT` existe desde 2016, pero **no expone el ordinal hasta
> SQL 2022**. Si el orden importa —o si pueden venir claves repetidas— no sirve: usa un split
> posicional.

## R-19 · Table variables: estimación fija de 1 fila [obs]

En compat level < 150 no hay *deferred compilation*: una table variable estima **1 fila**,
siempre, y no tiene estadísticas. En una consulta grande eso produce *nested loops* donde hacía
falta un *hash join*.

Peor aún si se consulta desde un predicado no sargable:

```sql
-- ANTI-PATRÓN: table variable + CASE, imposible de filtrar temprano
AND 1 = CASE WHEN @Modo = 0 AND t.ID IN (SELECT ID FROM @lista) THEN 0 ELSE 1 END

-- CORRECTO: tabla temporal con PK (sin nombre) + NOT EXISTS
CREATE TABLE #Excluidos (ID int NOT NULL PRIMARY KEY);
...
AND NOT EXISTS (SELECT 1 FROM #Excluidos x WHERE x.ID = t.ID)
```

Y calcula **solo la lista que aplica**, no todas las variantes por si acaso.

## R-20 · No unas a un grano más fino que el de la salida [obs]

Si unes a granularidad de detalle y luego colapsas con un `GROUP BY` de N columnas sin
agregados, estás multiplicando filas para volver a dividirlas.

Señal: un `GROUP BY` largo sin `SUM`/`COUNT`/`MAX` está haciendo de `DISTINCT`, y casi siempre
delata un fan-out innecesario aguas arriba.

Arreglo: busca la tabla que **ya** está al grano de salida y conduce la consulta desde ella;
convierte el resto en `EXISTS`. Caso observado: unir a una tabla de 75 M filas por 5 columnas
incluyendo la de detalle, cuando existía una tabla de 557 filas ya al grano correcto. El
`GROUP BY` de 19 columnas desapareció con ella.

## R-21 · Subconsulta correlacionada en el `SELECT` que en realidad es un `EXISTS` [obs]

```sql
-- ANTI-PATRÓN (visto textualmente)
ISNULL((SELECT TOP 1 CASE WHEN Col IS NULL THEN 0 ELSE 1 END
        FROM Tabla WHERE ... AND Col IS NULL), 1)

-- El WHERE ya filtró por IS NULL, así que el CASE solo puede devolver 0.
-- CORRECTO
CASE WHEN EXISTS (SELECT 1 FROM Tabla WHERE ... AND Col IS NULL) THEN 0 ELSE 1 END
```

Se evalúan por fila. Antes de optimizar una subconsulta correlacionada, comprueba si la tabla
que consulta **ya está unida**: muchas veces la respuesta es una columna que tienes a mano.

## R-22 · Conversión implícita de tipo [gen]

Un parámetro `nvarchar` contra una columna `varchar` (o al revés) fuerza `CONVERT_IMPLICIT` y
mata el seek. Es el caso más común en aplicaciones .NET/EF, que envían `NVARCHAR` por defecto.

Detección: buscar `CONVERT_IMPLICIT` en el plan, o comparar los tipos de parámetro y columna.

## R-27 · Orden de acceso consistente entre procedimientos [gen]

Dos procesos que escriben las mismas tablas **en orden inverso** son un deadlock esperando su
carga. El motor elige una víctima y el error 1205 parece aleatorio — pero la causa es
estructural y determinista.

> Define un orden canónico de escritura (por ejemplo: maestro → detalle → bitácora) y
> respétalo en **todos** los objetos. Documentarlo cuesta un párrafo; depurarlo sin él cuesta
> semanas, porque cada deadlock parece distinto.

```sql
-- DETECCIÓN retroactiva: los deadlocks recientes ya están capturados en la
-- sesión system_health de Extended Events, sin configurar nada
SELECT CAST(target_data AS xml).query('
         RingBufferTarget/event[@name="xml_deadlock_report"]') AS Deadlocks
FROM sys.dm_xe_session_targets t
JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
WHERE s.name = 'system_health' AND t.target_name = 'ring_buffer';
```

En el XML: los nodos `<process>` muestran qué objetos esperaba cada víctima y en qué orden —
ahí se lee directamente el cruce de órdenes.

Mitigadores cuando el reordenamiento no es viable: acortar la transacción (R-04), índices que
conviertan scans en seeks (menos filas bloqueadas), y `UPDLOCK` en el patrón
leer-para-actualizar dentro de la misma transacción.

---

# Nivel 4 · Esquema e instancia

## R-23 · Un índice de más también cuesta [obs]

Observado: una tabla de cabecera con **37 índices**; otra con 16, varios casi idénticos. Cada
`INSERT` mantiene las 37 estructuras — y los escritores lentos son exactamente quienes bloquean
a los lectores.

Casos concretos que se repiten:

- **Índice redundante:** su clave es **prefijo** de otro índice. Coste en cada escritura, cero
  beneficio de lectura.
- **Índice duplicado exacto:** misma clave y mismos `INCLUDE` que otro, con distinto nombre.
  Suele haber más de un par.
- **Índices nombrados por la persona o el cliente que pidió la consulta.** Delatan origen
  ad-hoc y nadie se atreve a borrarlos porque nadie sabe qué cubren.

> Antes de crear un índice, verifica que no exista uno cuyo prefijo ya lo cubra. Nómbralo por
> **sus columnas**, nunca por una persona o un cliente.

```sql
-- DETECCIÓN: índices que solo cuestan (0 lecturas, N escrituras)
SELECT OBJECT_NAME(i.object_id) AS tabla, i.name,
       s.user_seeks + s.user_scans + s.user_lookups AS lecturas,
       s.user_updates AS escrituras
FROM sys.indexes i
JOIN sys.dm_db_index_usage_stats s
  ON s.object_id = i.object_id AND s.index_id = i.index_id AND s.database_id = DB_ID()
WHERE i.type_desc = 'NONCLUSTERED' AND i.is_primary_key = 0
  AND (s.user_seeks + s.user_scans + s.user_lookups) = 0
  AND s.user_updates > 0
ORDER BY s.user_updates DESC;
```

**Antes de cualquier `DROP`**, comprueba que el servidor lleva tiempo suficiente arriba para
haber visto el ciclo completo de carga. Un índice con 0 lecturas tras dos días no prueba nada:

```sql
SELECT DATEDIFF(DAY, sqlserver_start_time, GETDATE()) AS DiasArriba FROM sys.dm_os_sys_info;
```

`sys.dm_db_missing_index_details` sugiere **columnas**, no índices: consolida solapamientos
antes de crear nada.

## R-24 · Ninguna tabla grande debe ser un HEAP, y ninguna bitácora debe crecer sin límite [obs]

Observado: las tablas más grandes del entorno eran heaps sin índice clustered — una bitácora de
49 GB, otra de 70 M filas, otra de 90 M. Sufren *forwarded records*: un salto de I/O extra por
lectura, permanente, que solo se limpia con `REBUILD`. Y el espacio de filas borradas no se
recupera. Ninguna tenía política de retención.

> Toda tabla con crecimiento sostenido lleva índice clustered (normalmente por fecha, o por la
> clave de acceso natural). Toda tabla de bitácora **nace** con su política de archivado
> definida — no después.

Detección: `sys.dm_db_partition_stats` sin fila con `index_id = 1`. Antes de convertir, medir
`forwarded_record_count` con `sys.dm_db_index_physical_stats(..., 'DETAILED')` fuera de horario
pico.

## R-25 · La configuración por defecto de la instancia no es la correcta [obs]

Observado: `cost threshold for parallelism = 5` —el default de fábrica desde 1998— y
`MAXDOP = 0`. En un servidor de 8 cores eso paraleliza hasta lo trivial y deja que una sola
consulta acapare los 8 schedulers: **13.5 % de las esperas del servidor**. También Change
Tracking con 365 días de retención, que resultó ser el mayor consumidor de CPU de la instancia.

> Al montar cualquier instancia, revisa: `cost threshold for parallelism` (~50), `MAXDOP`
> (según cores/NUMA), `optimize for ad hoc workloads`, y la retención de Change Tracking.

Comprueba además los cuatro valores que cambian el diagnóstico de cualquier análisis:
compat level, RCSI, edición y si hay Always On. Están en `SKILL.md`.

---

## Higiene — sin caso propio, pero se revisan siempre

| Patrón | Arreglo |
|---|---|
| **[obs]** Falta `SET NOCOUNT ON` | Añadirlo al inicio de todo procedimiento |
| **[obs]** `SELECT *` | Enumerar columnas |
| **[obs]** Columna sin calificar en un join de N tablas | Compila hoy; se rompe al añadir esa columna a otra tabla |
| **[obs]** Regla de negocio por `LIKE '%texto%'` contra nombres traducibles | Columna bandera en el modelo. Se rompe en silencio al traducir |
| **[gen]** `CONVERT(varchar, x)` sin longitud | Trunca a 30 caracteres en silencio |
| **[gen]** Objetos sin calificar con esquema | `dbo.Tabla`, no `Tabla` |
| **[gen]** Procedimiento con prefijo `sp_` | Renombrar: provoca búsqueda previa en `master` |
| **[gen]** Vistas anidadas sobre vistas | Aplanar. El optimizador expande todo |
| **[gen]** `COUNT(*) > 0` para probar existencia | `EXISTS`: corta en la primera coincidencia |
| **[gen]** Cursor | Reescribir set-based. Si es inevitable: `LOCAL FAST_FORWARD` |
| **[gen]** `LIKE` sin comodines | Usar `=` |
