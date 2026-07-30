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

**Y el caso contrario, que es una trampa doble.** Si la columna **sí** es nullable, ese
`ISNULL()` puede ser lo que sostiene la corrección: `ISNULL(col, 0) NOT IN (6)` incluye las
filas con `NULL`, mientras que `col NOT IN (6)` las descarta —`NULL NOT IN (…)` es UNKNOWN—.
Quitarlo sin más cambia el resultado. La forma sargable equivalente es explícita:

```sql
-- col es NULLABLE: estas dos NO son equivalentes
WHERE ISNULL(col, 0) NOT IN (6, @otro)          -- incluye las filas NULL
WHERE col NOT IN (6, @otro)                     -- las descarta en silencio

-- Equivalente sargable, siempre que el centinela (0) no sea un valor real de la columna
WHERE (col IS NULL OR col NOT IN (6, @otro))
```

La segunda mitad de la trampa: **puede no servir de nada**. Medido en un caso real donde el
`seek` iba por otra columna del índice compuesto y el estado quedaba como predicado residual:
**309.297 lecturas lógicas con la forma sargable frente a 309.329 con el `ISNULL`**, sobre el
mismo lote de 20.000 ejecuciones. Diferencia: 0,01 %. Se aplica por forma y por legibilidad,
no por rendimiento — y decirlo así en el informe evita prometer una mejora que no llega.

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

**Sub-caso: el catálogo materializado entero para cruzarlo contra nada.** Observado en una
pantalla de consulta: `SELECT ... INTO #temp` unía seis tablas de un catálogo geográfico
—ciudades, estados, países y sus tres tablas de idioma— **sin ninguna cláusula de filtro**, para
después hacerle un `LEFT JOIN` contra las filas de un solo registro. Medido: **159.534 filas**
volcadas a tempdb en cada apertura de la pantalla, para resolver una media de **12**.

La forma es fácil de reconocer y fácil de pasar por alto en revisión, porque el `WHERE 1=1` de
la subconsulta interior da la impresión de que hay filtro:

```sql
-- ANTI-PATRÓN: el filtro está fuera, sobre el resultado ya materializado
SELECT T.ID, T.Nombre INTO #Cat
FROM ( SELECT ... FROM dbo.Cat1 c JOIN dbo.Cat2 ... WHERE 1=1 ) AS T;

-- CORRECTO: filtrar por las claves que la consulta va a usar de verdad
SELECT c.ID, c.Nombre INTO #Cat
FROM dbo.Cat1 c JOIN dbo.Cat2 ...
WHERE c.ID IN (SELECT CatID FROM #Origen WHERE CatID > 0);
```

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

## R-29 · Un identificador sin validar en el `WHERE` de una escritura masiva [obs]

**Severidad:** crítica — *es bloqueo de instancia y pérdida de datos a la vez*

Cuando una columna usa `0` o `''` como centinela de «todavía sin asignar», ese valor **no es un
identificador: es un cajón**, y el cajón crece sin límite. Si un parámetro que puede llegar con
el centinela se usa tal cual en el `WHERE` de un `UPDATE` o un `DELETE`, la sentencia no afecta
a una entidad — afecta a todo lo que aún no tiene entidad.

Observado en un procedimiento de captura con envío en dos pasos. La rama «guardar y enviar»
llamaba a la rama «guardar» **antes** de crear el registro padre, de modo que el identificador
valía `'0'` en ese momento. El `UPDATE` de limpieza filtraba por él:

```sql
-- ANTI-PATRÓN: @IdPadre puede valer '0' o '' y nadie lo comprueba
IF ISNULL(@EsEnvio,0) <> 0
BEGIN
    UPDATE T SET Inactive = 1
    FROM dbo.TablaCaptura T
        LEFT JOIN #Detalle D ON D.CapturaID = T.CapturaID
    WHERE T.IdPadre = @IdPadre        -- '0' → el cajón entero
      AND D.CapturaID IS NULL

-- CORRECTO: el identificador tiene que designar algo
IF ISNULL(@EsEnvio,0) <> 0 AND ISNULL(@IdPadre,'0') NOT IN ('','0')
```

**Las dos consecuencias, medidas.** Sobre una tabla de 4,76 M filas y 1,88 GB, el valor
centinela concentraba **618.580 filas** frente a una media de **12 por identificador real**:

1. **Escalada de lock a tabla.** 618.580 locks de fila rebasan el umbral de escalada (~5.000):
   el motor los sustituye por un lock exclusivo sobre **la tabla completa**, retenido hasta el
   `COMMIT`. Con RCSI apagado, todo lector queda detrás. Verificar la política antes de
   descartarlo: `sys.tables.lock_escalation_desc` valía `TABLE`.
2. **Pérdida silenciosa de datos.** La sentencia inactivó filas que nadie pidió inactivar. Se
   detectó porque el `UPDATE` defectuoso ponía `Inactive = 1` **sin** rellenar `InactiveDate`,
   mientras que una baja de usuario sí la rellena: **618.528 de 618.580** filas del cajón tenían
   esa firma, y ninguna quedó activa.

> Esa asimetría es oro para el diagnóstico. **Cuando una tabla lleve una bandera de baja y su
> fecha, comprobar siempre si hay filas con la bandera puesta y la fecha vacía**: separan lo que
> hizo una persona de lo que hizo un `UPDATE` mal filtrado.

```sql
-- DETECCIÓN 1: ¿alguna columna de relación tiene un cajón de centinelas?
SELECT IdPadre, Filas = COUNT(*)
FROM dbo.TablaCaptura WITH (NOLOCK)
GROUP BY IdPadre
ORDER BY COUNT(*) DESC;

-- DETECCIÓN 2: la firma del UPDATE mal filtrado
SELECT Bandera_sin_fecha = SUM(CASE WHEN Inactive = 1 AND InactiveDate IS NULL     THEN 1 ELSE 0 END),
       Bandera_con_fecha = SUM(CASE WHEN Inactive = 1 AND InactiveDate IS NOT NULL THEN 1 ELSE 0 END)
FROM dbo.TablaCaptura WITH (NOLOCK);

-- DETECCIÓN 3: tablas que escalarían a nivel de tabla
SELECT name, lock_escalation_desc FROM sys.tables WHERE lock_escalation_desc = 'TABLE';
```

El arreglo es una condición, no una reescritura: **valida el identificador antes de escribir
con él**. Y si el centinela es intencionado, entonces el predicado necesita además la columna
que sí acota el alcance — un cajón compartido nunca es el alcance de una operación de usuario.

Relacionada con R-12 (determinismo) por la misma raíz: un valor que se da por bueno sin
comprobarlo. Y con R-04: cuanto más larga sea la transacción, más dura el lock escalado.

## R-32 · Un predicado que no cubre el prefijo de ninguna clave [obs]

**Severidad:** alta · **Impacto:** ×12 medido, y crece con la tabla

La columna no va envuelta en ninguna función (R-01), la consulta es de tres tablas y el `JOIN`
parece trivial. Aun así hay un scan. El motivo es más simple y se pasa por alto justo por eso:
**se filtra por la segunda columna de una clave compuesta sin aportar la primera**.

```sql
-- La tabla: 5.975.400 filas, 16 índices, PK clustered (colA, colB)
-- Ninguno de los 16 encabeza por colB.

-- ANTI-PATRÓN
SELECT TOP 1 d.col1, c.col2
FROM   dbo.Hechos h WITH (NOLOCK)                  -- no aporta NINGUNA columna a la salida
JOIN   dbo.Detalle d ON d.col1 = h.colB
JOIN   dbo.Cabecera c ON c.id = d.id
WHERE  h.colB = @b                                 -- ← falta colA: no hay prefijo buscable
ORDER BY c.id;

-- CORRECTO
WHERE  h.colA = @a AND h.colB = @b                 -- ← seek por el PK
```

Medido: **25.919 lecturas lógicas para devolver 1 fila**, contra unas pocas con el predicado
completo. En reloj de pared, **389 ms → 32 ms**, resultado idéntico. Coste estimado del plan:
20,6.

**Dos señales que lo delatan sin abrir el plan.** Un número de índices alto sobre la tabla
(aquí 16) invita a suponer que "alguno servirá", y es precisamente lo que impide mirar cuál
encabeza por la columna del filtro. Y un `JOIN` cuya tabla **no aporta ninguna columna al
`SELECT`**: es un `EXISTS` disfrazado (R-21), y su coste no lo paga la salida sino el acceso.

```sql
-- DETECCIÓN: ¿alguna clave empieza por la columna que filtro?
SELECT i.name, c.name AS PrimeraColumnaDeLaClave
FROM   sys.indexes i
JOIN   sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN   sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE  i.object_id = OBJECT_ID('dbo.Hechos')
  AND  ic.key_ordinal = 1 AND ic.is_included_column = 0;
```

**El paralelismo lo estaba escondiendo, y eso es lo que hay que entender.** El scan costaba lo
bastante para calificar a paralelismo y repartirse en 8 hilos: 171,7 ms de media durante
1.072 ejecuciones. Al subir el `cost threshold` de la instancia a 50 —un cambio correcto, ver
R-25— la sentencia dejó de calificar y pasó a plan serial: **381,1 ms, 2,2× más lenta**, sin que
nadie hubiera tocado el código. Query Store guardaba los dos planes con sus ventanas de fechas.

> **No revertir el parámetro.** Devuelve la cifra a su sitio y vuelve a gastar 8 núcleos en una
> consulta que devuelve una fila. El arreglo es el predicado; con él, la sentencia deja de
> depender de cómo esté configurado el paralelismo.

**Cómo se demuestra la equivalencia cuando el `JOIN` sobrante es un filtro de existencia.**
Añadir la columna que falta **restringe** el conjunto, así que las dos versiones **sí difieren**
en la consulta aislada — medido: 1 fila contra 0. Comparar ahí da un falso negativo y frena una
reescritura correcta. Hay que comparar **a nivel del resultado observable**: en el caso medido,
el único consumidor de la tabla temporal ya filtraba por las dos columnas, de modo que la
diferencia nunca alcanzaba ningún dato. La comprobación se hace en dos niveles —productor y
consumidor— y se registran los dos.

Y no era un caso de laboratorio: **1.567.526 valores de `colB` aparecían bajo más de un `colA`**.
Cuando la divergencia es masiva, verificar solo el productor no es conservador: es equivocarse.

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

**Sub-caso: el `COMMIT` interno que no confirma nada.** Un procedimiento que se llama a sí mismo
—o que llama a otro que abre transacción— deja el `COMMIT` interno corriendo con
`@@TRANCOUNT > 1`. Ese `COMMIT` **sólo decrementa el contador**: no confirma, no libera un solo
lock. Todo se sostiene hasta el `COMMIT` que lleva `@@TRANCOUNT` a 0.

Observado: la rama «guardar y enviar» de un procedimiento abría transacción, generaba un HTML
llamando a otro procedimiento y después se invocaba a sí misma; la llamada interna abría su
propia transacción, ejecutaba 36 pasadas sobre una tabla de 61,6 M filas y hacía `COMMIT`. Leído
de arriba abajo el código parece cerrar pronto. En realidad **nada se libera** hasta el commit
externo, unas 100 líneas después.

> Al medir la ventana de bloqueo de un procedimiento, no cuentes hasta el `COMMIT` que ves:
> cuenta hasta el que deja `@@TRANCOUNT` en 0. Si el objeto puede ejecutarse anidado, son sitios
> distintos.

Corolario para el `ROLLBACK`: en esa misma estructura, un `ROLLBACK` del `CATCH` interno revierte
la transacción **externa** completa. El flujo externo continúa creyendo que su transacción sigue
viva y su `COMMIT` falla con error 3902 (*COMMIT sin BEGIN correspondiente*). `SAVE TRANSACTION`
es la respuesta a esto, igual que arriba.

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

**La trampa: el `ORDER BY` puede costar más que el no-determinismo.** `TOP 1` sin `ORDER BY`
permite al motor **parar en la primera fila**; añadirlo le obliga a producir y ordenar el
conjunto entero antes de descartarlo. Medido: sobre un `TOP 1` que atravesaba un *fan-out* de
~590 filas de detalle por llamada, añadir `ORDER BY` para hacerlo determinista pasó de
sub-segundo a **timeout por encima de 30 s** en un lote de 20.000 ejecuciones.

Antes de "arreglar" un `TOP 1`, comprueba **cuántas filas puede devolver de verdad**. En ese
mismo caso, las 46.455 entidades con actividad mapeaban a **exactamente un** valor cada una: el
no-determinismo era teórico. Cuando ese es el escenario, la respuesta correcta no es un
`ORDER BY` caro sino una **restricción de datos** que garantice la unicidad —o dejarlo
documentado como riesgo conocido, con la cifra que lo acota—. Un arreglo que multiplica el
coste por treinta no es un arreglo.

**Y el escenario opuesto, medido: cuando la ambigüedad sí existe, el daño no se ve mirando una
tabla.** El caso anterior decía que midieras la ambigüedad antes de arreglar. Aquí está la otra
mitad de por qué: el mismo procedimiento resolvía **dos veces** el mismo identificador de
catálogo, a partir de la misma columna origen, con **dos reglas de desempate distintas**, y
escribía cada resultado en una tabla distinta dentro de la misma transacción.

```sql
-- Tabla A  (no determinista)
SELECT TOP (1) … , destino = msl.SourceItemID
FROM   dbo.Detalle d
LEFT JOIN dbo.Mapeo msl ON msl.origen = d.origen AND msl.catalogo = @cat AND msl.Inactive = 0
…                                              -- sin ORDER BY: el plan elige

-- Tabla B  (determinista, pero con OTRA regla)
… ROW_NUMBER() OVER (PARTITION BY … ORDER BY msl.SourceItemID ASC) AS rn
WHERE rn = 1                                   -- siempre el mínimo
```

Mientras el mapeo sea 1:1 las dos coinciden y **nadie lo nota nunca**. Medido, no lo era: **244
de 1.306 valores de origen tenían más de un destino activo**, uno de ellos hasta **163**, todos
con el mismo tipo y el mismo catálogo —añadir un filtro no desambigua—. Consecuencia ya presente
en los datos: **61.444 de 3.398.789 registros (1,81 %) tenían un valor distinto en cada tabla**,
y para un único origen la tabla A había llegado a escribir **cuatro identificadores diferentes**
según el registro (724.847 · 18.829 · 59 · 15).

> La lección de detección: un `TOP 1` no determinista **no se delata en la tabla que escribe**,
> porque cada fila parece correcta por separado. Se delata al **cruzar dos escrituras del mismo
> dato**. Si un objeto resuelve el mismo identificador más de una vez, comprueba que todas las
> resoluciones usan la misma regla — y si no, compara las tablas resultantes antes de suponer
> que da igual.

```sql
-- DETECCIÓN 1: ¿el mapeo es realmente 1:1?
SELECT COUNT(*) AS Origenes,
       SUM(CASE WHEN Destinos > 1 THEN 1 ELSE 0 END) AS Ambiguos,
       MAX(Destinos) AS MaxDestinos
FROM  (SELECT origen, COUNT(DISTINCT destino) AS Destinos
       FROM dbo.Mapeo WHERE catalogo = @cat AND Inactive = 0
       GROUP BY origen) x;

-- DETECCIÓN 2: ¿las dos escrituras del mismo dato coinciden?
SELECT COUNT(*) AS Comparados,
       SUM(CASE WHEN a.destino <> b.destino THEN 1 ELSE 0 END) AS Discrepan
FROM dbo.TablaA a JOIN dbo.TablaB b ON b.k1 = a.k1 AND b.k2 = a.k2;
```

**Y el arreglo no lo elige quien optimiza.** Unificar la regla es trivial; decidir *cuál* de los
N destinos es el correcto es negocio (R-29 y la nota de cierre de este catálogo). Entregar un
script que elija por su cuenta es peor que no entregarlo: deja miles de filas «corregidas» hacia
un valor que nadie validó.

## R-13 · `ORDER BY` en un `SELECT ... INTO #temp` se pierde [obs]

El orden de lectura de una tabla temporal **no está garantizado**. Si el `ORDER BY` se aplica
al `INSERT` y los `SELECT` finales no reordenan, el resultado es no determinista — y además se
paga el coste del sort sin obtener su beneficio.

Observado como consecuencia de una refactorización que movió una consulta a `#temp` sin mover
el `ORDER BY` al final. El defecto sobrevivió sin detectarse porque *a veces* el orden salía
bien.

## R-26 · `SET XACT_ABORT ON` en todo procedimiento con transacciones [obs]

Observado: un procedimiento de 2.183 líneas con **tres** bloques `BEGIN TRAN` y **cero**
apariciones de `XACT_ABORT`. Declaraba `SET ARITHABORT ON` dos veces seguidas y `SET NOCOUNT ON`
—alguien pensó en las opciones de sesión— pero no la que importaba. Es el patrón habitual: no
se omite por criterio, se omite porque no está en la plantilla con la que se copió el objeto.

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

**Sub-caso medido — la asimetría padre/hijo, que convierte el `CATCH` en un destructor de
evidencia.** Lo peligroso no es que falte `XACT_ABORT` en todas partes; es que esté en **unos
objetos sí y en otros no**. Observado: un orquestador sin `XACT_ABORT` que abre transacción y
encadena diez `EXEC` anidados; los hijos **sí** lo activan.

```sql
-- El orquestador (SIN XACT_ABORT)
BEGIN CATCH
    ROLLBACK TRANSACTION Trans_X          -- ← incondicional, y con nombre
    SET @msg = 'Error: ' + ERROR_MESSAGE();
    EXEC dbo.RegistrarFallo @msg;         -- ← esta línea NUNCA se alcanza
    ...
END CATCH
```

Cuando un hijo revienta con su `XACT_ABORT ON`, la transacción llega al `CATCH` del padre **ya
deshecha**. El `ROLLBACK` incondicional encuentra `@@TRANCOUNT = 0` y lanza el **error 3903**,
que **escapa del propio `CATCH`**. El resultado es doble y silencioso: el cliente recibe el 3903
en lugar del error real, y la llamada que registraría el fallo nunca se ejecuta. Un `CATCH` así
no es un `CATCH` vacío (R-11): es peor, porque parece que registra.

El nombre agrava lo mismo: `ROLLBACK TRANSACTION <nombre>` solo es válido si esa transacción es
la más externa. Si cualquier llamador envuelve el procedimiento en la suya, falla con el
**error 6401** — que es R-10 vista desde el otro extremo.

```sql
-- DETECCIÓN: ROLLBACK incondicional dentro de un CATCH
SELECT OBJECT_NAME(object_id) AS objeto
FROM   sys.sql_modules
WHERE  definition LIKE '%BEGIN CATCH%'
  AND  definition LIKE '%ROLLBACK%'
  AND  definition NOT LIKE '%XACT_STATE%';

-- Y el contraste que importa: padres sin XACT_ABORT que llaman a hijos que sí lo tienen
SELECT OBJECT_NAME(m.object_id) AS padre
FROM   sys.sql_modules m
WHERE  m.definition LIKE '%BEGIN TRAN%'
  AND  m.definition NOT LIKE '%XACT_ABORT%'
  AND  EXISTS (SELECT 1 FROM sys.sql_expression_dependencies d
               JOIN sys.sql_modules h ON h.object_id = d.referenced_id
               WHERE d.referencing_id = m.object_id
                 AND h.definition LIKE '%XACT_ABORT%');
```

`IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;` —sin nombre— resuelve los tres casos a la vez:
transacción viva (`1`), condenada (`-1`) e inexistente (`0`).

## R-30 · Un filtro nuevo se aplica a todas las condiciones hermanas, no solo a la que motivó el ticket [obs]

**Severidad:** crítica · **Impacto:** resultados incorrectos, sin síntoma

Cuando un cambio introduce un criterio de exclusión —«ignorar los registros inactivos»— hay que
aplicarlo a **todas** las condiciones del objeto que responden a la misma pregunta de negocio.
Aplicarlo solo a la consulta que se estaba mirando deja el objeto en contradicción consigo
mismo, y el comentario del ticket certifica una intención que el código no cumple.

```sql
-- ANTI-PATRÓN: el mismo objeto, dos criterios distintos para el mismo concepto

-- Consulta 1 — sí recibió el filtro nuevo
SELECT @Plantilla = ...
FROM dbo.Cabecera c
WHERE c.EntidadID = @EntidadID
  AND ISNULL(c.EstadoID, 0) NOT IN (6)
  AND ISNULL(c.EstadoID, 0) <> @EstadoInactivo;      -- ← el ticket llegó hasta aquí

-- Consulta 2 — misma pregunta de negocio, sin filtro alguno
IF ... OR EXISTS (SELECT 1 FROM dbo.Cabecera c
                  WHERE c.EntidadID = @EntidadID
                    AND NOT EXISTS (SELECT 1 FROM dbo.Detalle d
                                    WHERE d.CabeceraID = c.CabeceraID))
    SELECT 0;                                         -- ← una cabecera inactiva y vacía manda aquí
```

Caso medido: una cabecera cancelada o inactiva **sin detalle** activaba la segunda condición y
forzaba la respuesta negativa aunque la entidad tuviera trabajo válido cargado. Sobre **143.246
entidades**, **3.546** respondían que no por esa condición y **3.410** habrían cambiado de
respuesta con el filtro aplicado — el **2,4 %** del padrón. El defecto era anterior al ticket
(la condición nunca filtró ni el primer estado), pero el ticket la dejó contradiciendo su
propio enunciado.

> Al revisar un cambio que añade un criterio, no leas solo el diff: **busca en todo el objeto
> las demás condiciones que hablan del mismo concepto**. Si el ticket dice «excluir X», tienen
> que excluir X todas, o el informe debe decir por qué no.

```sql
-- DETECCIÓN: objetos donde un estado aparece filtrado en unas condiciones y no en otras.
-- Punto de partida, no veredicto: hay que leer el objeto.
SELECT o.name AS objeto,
       (LEN(m.definition) - LEN(REPLACE(m.definition, 'EstadoID', ''))) / 8  AS MencionesColumna,
       (LEN(m.definition) - LEN(REPLACE(m.definition, 'NOT IN', '')))  / 6  AS FiltrosNegativos
FROM sys.sql_modules m
JOIN sys.objects o ON o.object_id = m.object_id
WHERE m.definition LIKE '%EstadoID%'
ORDER BY MencionesColumna DESC;
```

Complementa a R-07: allí la comparación con `NULL` desactiva una rama; aquí la rama funciona,
pero contesta a una pregunta distinta de la que contestan sus hermanas.

## R-31 · Una condición que ya es cierta dentro de su propia rama: el bloque que nunca decide [obs]

**Severidad:** alta · **Impacto:** reglas de negocio que no se evalúan

Un `OR` que incluye una condición ya garantizada por la rama en la que está es siempre cierto.
Todo lo demás del `OR` se vuelve decorativo, y la rama contraria, inalcanzable.

```sql
-- ANTI-PATRÓN (estructura observada textualmente)
IF NOT EXISTS (A) OR EXISTS (B)
    SELECT 0
ELSE
    BEGIN
        IF EXISTS (C) OR EXISTS (D) OR EXISTS (A)    -- ← A ya es TRUE por definición del ELSE
            SELECT 1
        ELSE
            SELECT 0                                  -- ← inalcanzable
    END
```

Entrar al `ELSE` significa `NOT(NOT A OR B)`, es decir `A AND NOT B`. Con `A` garantizado, el
`OR` de tres términos es una constante: el bloque siempre devuelve 1. `C` y `D` **nunca deciden
nada** — y en el caso observado `D` recorría una tabla de 75,7 M filas para eso. De siete
consultas del procedimiento, **tres** no influían en el resultado.

El razonamiento es seguro porque `EXISTS` devuelve siempre TRUE o FALSE, nunca UNKNOWN: no hay
zona gris de lógica trivaluada donde esconderse.

> El daño real no es el trabajo desperdiciado: es que alguien **añada o corrija una regla de
> negocio dentro de un bloque que no se evalúa** y no entienda por qué no pasa nada. Un bloque
> muerto atrae mantenimiento como si estuviera vivo.

Detección: no hay consulta que lo encuentre. Se detecta leyendo cada `IF`/`ELSE` anidado y
preguntándose qué es verdad, por construcción, al entrar en esa rama. Verificación barata antes
de borrar: reproducir la lógica vieja y la nueva como expresiones `CASE` sobre un lote real y
contrastarlas con `EXCEPT` en las dos direcciones (ver skill `analisis-bd`).

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

**Contraejemplo medido: el arreglo no es automático.** El mismo movimiento —conducir desde la
tabla pequeña y convertir el detalle en `EXISTS`— aplicado a un `TOP 1` que resolvía un
identificador salió **peor**: **409.086 lecturas lógicas y 482,9 ms de CPU frente a 309.329 y
394,2 ms** de la versión original, sobre un lote idéntico de 20.000 ejecuciones. El motivo:
conducir desde una tabla de 52 filas obliga a **52 sondas semi-join por llamada**, mientras que
la forma original hacía un solo `seek` por la clave y recorría secuencialmente un *fan-out*
acotado que un índice ya cubría.

> La regla aplica cuando el fan-out se **colapsa** después (un `GROUP BY` que hace de
> `DISTINCT`). Cuando la consulta ya se corta sola —`TOP 1`, `EXISTS`— el fan-out está acotado
> y darle la vuelta puede multiplicar el trabajo. **Mide antes de reescribir, y mide con
> lecturas lógicas:** el reloj de pared no distingue estas dos formas bajo carga concurrente.

**Cómo saber, objetivamente, que una consulta se le ha ido de las manos al optimizador.** No
hace falta contar `JOIN`s a ojo: el plan lo declara. `StatementOptmEarlyAbortReason = TimeOut`
significa que el optimizador **agotó su presupuesto de búsqueda** y entregó el mejor plan que
tenía a mano, no el mejor plan. Medido en un `INSERT` que unía ~25 tablas con `CROSS APPLY`,
`UNION ALL` y un `GROUP BY` de 30 columnas: compilar costaba **648 ms y 13.032 KB**, y en
ejecución gastaba **43,4 ms de CPU sobre 54,5 ms transcurridos con solo 401 lecturas lógicas**
—es cómputo, no E/S— con un *grant* de memoria de ~54 MB para devolver del orden de una fila.

```sql
-- DETECCIÓN sobre Query Store (ajustar el objeto)
WITH XMLNAMESPACES (DEFAULT 'http://schemas.microsoft.com/sqlserver/2004/07/showplan'),
PX AS (SELECT p.plan_id, CAST(p.query_plan AS XML) AS px
       FROM sys.query_store_query q
       JOIN sys.query_store_plan p ON p.query_id = q.query_id
       WHERE q.object_id = OBJECT_ID('dbo.MiProc'))
SELECT plan_id,
       px.value('(/ShowPlanXML/BatchSequence/Batch/Statements/StmtSimple/QueryPlan/@CompileTime)[1]','int') AS CompileTime_ms,
       px.value('(/ShowPlanXML/BatchSequence/Batch/Statements/StmtSimple/@StatementOptmEarlyAbortReason)[1]','varchar(50)') AS AbortoTemprano
FROM PX;
```

> Dos trampas de esta detección. La primera: `CAST(query_plan AS XML)` **falla** con el error
> 6335 si el plan supera los **128 niveles de anidamiento** — y una consulta capaz de eso ya te
> ha respondido la pregunta. Filtra por sentencia, no por objeto. La segunda: el tiempo de
> compilación se amortiza si el plan se reutiliza (648 ms entre 1.142 ejecuciones es 0,6 ms);
> comprueba cuántos planes tiene la consulta antes de culpar a la compilación.

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

> **Trampa medida:** «ya están capturados, sin configurar nada» es cierto y engañoso a la vez.
> `system_health` es un buzón compartido y su retención la fija el emisor más ruidoso, no los
> deadlocks. En un entorno medido, el ring buffer cubría **15 minutos** y el archivo **14 días**
> —contra 51 de uptime— porque el 95,3 % de sus eventos eran errores de seguridad. Un result
> set vacío ahí **no significa que no hubo deadlocks**. Antes de concluir nada, mide la ventana
> real: R-28.

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

**Sub-caso medido — el default que apaga la única captura nativa de bloqueo.**
`blocked process threshold (s)` viene de fábrica en `0`, y con ese valor el *blocked process
report* no existe. En una instancia con **7 h 38 min** de espera por bloqueo acumuladas en 51
días y una espera individual de **71,7 minutos**, no había ni un solo registro de quién
bloqueaba a quién. Es la asimetría más común de estos entornos: el deadlock —raro, ruidoso, 4
casos en 51 días— tiene herramienta y job; el bloqueo prolongado —frecuente, silencioso— no
tiene nada.

```sql
SELECT name, value_in_use FROM sys.configurations
WHERE name = 'blocked process threshold (s)';
```

Al encenderlo, el umbral se elige **con la duración media medida**, no por costumbre. Con
`LCK_M_S` en 27 ms de media, un umbral de 5 s sería ruido puro; 15 s deja pasar el 99 % y
captura la cola, que es la que produce incidentes.

**Sub-caso medido — corregir la configuración no rompe nada: destapa lo que la configuración
estaba tapando.** En otra instancia, `cost threshold` ya estaba subido a 50 y `MAXDOP` fijado en
4 sobre 8 schedulers. Una consulta empezó a tardar **2,2×** más de un día para otro sin que
nadie tocara el código: pasó de un plan paralelo a DOP 8 —171,7 ms de media, 1.072
ejecuciones— a uno serial de **381,1 ms**, porque su coste (20,6) quedó por debajo del umbral
nuevo. Query Store conservaba los dos planes con sus ventanas de fechas, que es la única razón
por la que se pudo fechar el cambio.

La lectura correcta no es "el ajuste fue malo". El scan que había debajo (R-32) siempre estuvo
ahí; repartido en ocho hilos nadie lo miraba. **El ajuste retiró la anestesia.**

> Al subir `cost threshold` en una instancia con historia, cuenta con que aparezcan consultas
> "nuevas" en los informes de lentitud. No son nuevas: son las que vivían del paralelismo.
> Arreglar el código y no revertir el parámetro — revertirlo devuelve la cifra a su sitio a
> costa de seguir gastando N núcleos en consultas que devuelven una fila.

---

## R-28 · La instrumentación de diagnóstico también se audita [obs]

Un buzón de diagnóstico compartido tiene la retención que le deja **su emisor más ruidoso**, no
la que su dueño cree. `system_health` es el caso canónico: captura deadlocks, pero también
errores de seguridad, conectividad y esperas largas. Si algo satura una de esas categorías, se
lleva por delante a todas las demás.

Medido en un entorno real: **12,7 millones de eventos en 51 días** (~249.000/día), de los que el
**95,3 %** eran errores de impersonación repetitivos. Consecuencias, todas verificadas:

| Efecto | Magnitud medida |
|---|---|
| Ventana del ring buffer en memoria | **15 min 50 s** |
| Retención del archivo (techo 1 GB, 100 MB × 10) | **14 días**, contra 51 de uptime |
| Deadlocks visibles en el ring buffer | **0**, habiendo ocurrido 4 en el periodo |
| Coste de lectura del conjunto de `.xel` | **> 30 s**, supera el timeout de un cliente |

El daño no es el ruido: es que **el vacío se lee como ausencia**. Un analizador de deadlocks
contra esa fuente devuelve cero filas y alguien concluye «no hubo deadlocks», cuando lo correcto
es «la evidencia ya rotó».

> Antes de confiar en cualquier fuente de diagnóstico, **mide su ventana real**. Y para lo que
> importe de verdad, **sesión dedicada**: un solo evento, archivo propio, `STARTUP_STATE = ON`.
> Capturando decenas de eventos al año en vez de cientos de miles al día, unos pocos cientos de
> MB son retención de años — y de paso el parseo deja de ser un problema.

```sql
SELECT TOP (1) f.file_name, f.object_name,
       CAST(f.event_data AS xml).value('(/event/@timestamp)[1]','datetime2(0)') AS MasAntiguo
FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL) AS f;
```

`TOP (1)` es deliberado: la función es de flujo y devuelve el primer evento sin recorrer el
conjunto. Sin él, esta misma consulta es la que supera los 30 s.

Dos corolarios que aplican a cualquier captura, no sólo a XE:

- **Lo que no se persiste, no existe.** Un procedimiento de diagnóstico que devuelve un result
  set y no escribe en ninguna parte produce evidencia que muere con la sesión. Comprobación
  barata de si alguna vez se usó su ruta de persistencia: `sys.synonyms` y las tablas de salida
  que crea. Si no están, nunca se invocó así.
- **Query Store en modo `AUTO` descarta lo trivial.** Es el modo por defecto y es razonable,
  pero tiene una consecuencia directa para el diagnóstico: **la ausencia de un statement en
  Query Store no prueba que no se haya ejecutado**. En un objeto auditado se capturaron cuatro
  de sus consultas y ninguna del bloque interno; concluir «ese bloque no corre» habría sido
  exactamente el error que describe esta regla. Comprobar siempre
  `sys.database_query_store_options.query_capture_mode_desc` antes de leer una ausencia como
  un hecho, y anotar el número de ejecuciones capturadas: 60 ejecuciones no describen una hora
  punta.
- **El instrumento se mide a sí mismo.** Filtrar Query Store —o el plan cache— por un literal
  que aparece en la consulta buscada hace que **la propia consulta de monitoreo coincida con su
  filtro**. Caso real: una consulta de diagnóstico se auto-capturó y atribuyó sus **9.309
  lecturas lógicas** de barrido sobre las vistas internas a la sentencia que pretendía medir,
  inflando la cifra dos órdenes de magnitud. Antes de publicar una medición sacada así,
  **imprime el texto de lo capturado y compruébalo**; y excluye el propio instrumento
  (`AND qt.query_sql_text NOT LIKE '%query_store%'`) o usa marcadores mutuamente excluyentes.
- **Un job informa hacia atrás; una alerta avisa en el momento.** Los contadores
  `SQLServer:Locks / Number of Deadlocks/sec / _Total` y
  `SQLServer:General Statistics / Processes blocked` sirven como condición de rendimiento en una
  alerta de Agent. Lo que **no** funciona es alertar sobre el mensaje de error 1205: la víctima
  de deadlock no se escribe en el log de errores por defecto, así que esa alerta no se dispara
  nunca.

---

## Higiene — sin caso propio, pero se revisan siempre

| Patrón | Arreglo |
|---|---|
| **[obs]** Falta `SET NOCOUNT ON` | Añadirlo al inicio de todo procedimiento |
| **[obs]** `SELECT *` | Enumerar columnas |
| **[obs]** Columna sin calificar en un join de N tablas | Compila hoy; se rompe al añadir esa columna a otra tabla |
| **[obs]** Regla de negocio por `LIKE '%texto%'` contra nombres traducibles | Columna bandera en el modelo. Se rompe en silencio al traducir |
| **[obs]** Identificador de catálogo resuelto por su literal y degradado con `ISNULL(@id, -1)` | El `-1` convierte «no encontrado» en «no excluyas nada». Una corrección de traducción desactiva el filtro **sin error y sin rastro**. O se registra el caso no encontrado, o el identificador es constante. Peor aún si conviven ambos criterios: en un objeto observado dos estados iban escritos a mano y un tercero se buscaba por nombre |
| **[gen]** `CONVERT(varchar, x)` sin longitud | Trunca a 30 caracteres en silencio |
| **[gen]** Objetos sin calificar con esquema | `dbo.Tabla`, no `Tabla` |
| **[gen]** Procedimiento con prefijo `sp_` | Renombrar: provoca búsqueda previa en `master` |
| **[gen]** Vistas anidadas sobre vistas | Aplanar. El optimizador expande todo |
| **[gen]** `COUNT(*) > 0` para probar existencia | `EXISTS`: corta en la primera coincidencia |
| **[gen]** Cursor | Reescribir set-based. Si es inevitable: `LOCAL FAST_FORWARD` |
| **[gen]** `LIKE` sin comodines | Usar `=` |
