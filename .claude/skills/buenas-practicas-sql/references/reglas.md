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

**El sub-caso peor: la llamada HTTP dentro de la transacción.** «Trabajo externo» suele leerse
como *otro procedimiento*, y el que de verdad hace daño es la salida a la red. Caso medido: un
procedimiento de cola abre `BEGIN TRANSACTION` y dentro invoca un envoltorio que hace
`sp_OACreate 'MSXML2.ServerXMLHTTP'` y un `POST` **síncrono**. La duración del lock deja de
decidirla SQL Server y pasa a decidirla un servidor web. Medido en Query Store: **20.517 ms y
18.861 ms de espera por bloqueo**, dos madrugadas consecutivas a la misma hora, mismo `query_id`.

Y el detalle que convierte el problema crónico en incidente: el objeto COM se instanciaba **sin
llamar a `setTimeouts`**, de modo que el peor caso no estaba acotado por nada. Mientras el
servicio responda en segundos, el síntoma es un job lento de madrugada; el día que no responda,
la transacción queda abierta reteniendo locks hasta que alguien mate la sesión.

> Si la llamada externa no puede salir de la transacción hoy, **acota el peor caso**:
> `sp_OAMethod @obj, 'setTimeouts', NULL, 5000, 5000, 15000, 15000`. No arregla el diseño —
> sustituye «indefinido» por un número conocido, que es lo que permite dormir.

```sql
-- DETECCIÓN: salida a la red dentro de un módulo (revisar si hay transacción alrededor)
SELECT OBJECT_NAME(object_id) AS objeto
FROM sys.sql_modules
WHERE definition LIKE '%sp_OACreate%' OR definition LIKE '%ServerXMLHTTP%';
-- Y el interruptor que lo habilita, a nivel de instancia:
SELECT name, value_in_use FROM sys.configurations
WHERE name IN ('Ole Automation Procedures', 'clr enabled');
```

**El otro sub-caso: la transacción envuelve código que no puedes leer.** Cuando lo que va dentro
del `BEGIN TRAN` es `sp_executesql` sobre un script **guardado como fila de una tabla**, la
duración del lock no la decide el procedimiento: la decide el contenido de esa tabla, que cambia
sin pasar por revisión de código. Caso medido: un despachador de 211 líneas abría transacción
antes de su bucle y dentro ejecutaba hasta **39 scripts de 10 a 82 KB cada uno**, 9 de ellos con
cursores propios.

Y de ahí sale la señal que conviene interiorizar: **la duración deja de estar acotada por el
volumen.** Medido sobre las marcas de tiempo reales de las filas encoladas, en un mismo día:

| Corrida | Filas encoladas | Ventana de la transacción |
|---|---|---|
| 09:00 | 3.445 | **3.328 s** (55 min) |
| 11:00 | — | 2.318 s (38 min) |
| 17:00 | **10** | 2.714 s (45 min) |

Tres cuartos de hora de locks acumulados para encolar diez filas. Un `BEGIN TRAN` cuyo coste no
correlaciona con el trabajo útil no se ajusta: se acota, moviendo el `COMMIT` dentro del bucle
para que la unidad atómica sea una iteración y no la corrida entera.

> Antes de defender una transacción global, pregunta qué exige realmente ser atómico. «Todas las
> notificaciones o ninguna» casi nunca es un requisito de negocio: es lo que salió de poner el
> `BEGIN TRAN` en la primera línea.

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

### El otro camino al mismo desenlace: `AND` liga más fuerte que `OR`

El centinela no es la única forma de que una escritura se salga de su alcance. La segunda es
puramente sintáctica y **no se ve leyendo el código en diagonal**, porque las condiciones correctas
están todas ahí — solo que no todas son obligatorias.

```sql
-- ANTI-PATRÓN [obs]: cuatro condiciones y una disyunción, sin un solo paréntesis
UPDATE T SET col1 = 2, col2 = ISNULL(o.col3, '0')
FROM dbo.Tabla T
    INNER JOIN dbo.Otra o ON T.OtraID = o.OtraID
WHERE T.EsHistorico = 0
  AND T.LoteGUID    = @Lote          -- ← el lote
  AND T.Inactive    = 0              -- ← la marca de baja
  AND ISNULL(o.col4, 0) > 0
   OR (o.TipoID = 45 OR o.TipoNombre = 'PREFIJO%')   -- ← desde aquí NADA de lo anterior aplica
```

El motor lo evalúa como `(A AND B AND C AND D) OR (E OR F)`. Toda fila que cumpla `E` entra
**sin** pasar por el lote ni por la marca de baja. Medido en el caso real, sobre una tabla de
**1.249.450 filas** con 48 lotes:

| Alcance del `UPDATE` | Filas |
|---|---:|
| Previsto — un lote, solo activas | **4.992** |
| Real — la rama `OR` sin filtrar | **58.910** |
| De ellas, con `Inactive = 1` | **32.338** |
| Lotes alcanzados | **48 de 48** |

Doce veces el alcance previsto, en un proceso diario, **sobrescribiendo columnas en vez de insertar
filas** — así que no deja rastro propio y no hay forma de saber cuántas veces ocurrió. La firma que
sí queda: filas marcadas como inactivas con columnas que solo ese `UPDATE` escribe.

> **Regla práctica:** en el `WHERE` de un `UPDATE` o un `DELETE`, **cualquier `OR` va entre
> paréntesis, sin excepción**. No es estilo: es la diferencia entre una condición alternativa y una
> puerta trasera que se salta todos los filtros de alcance. Y al revisar, no basta con comprobar que
> los filtros de alcance *están* — hay que comprobar que son *obligatorios*.

**El agravante que lo mantuvo invisible.** En el mismo `WHERE`, la condición `o.TipoNombre =
'PREFIJO%'` usa `=` contra una cadena con comodín: coincide con **0 filas** donde `LIKE` coincidiría
con **39.988**. Los dos defectos se tapan mutuamente. El de precedencia ampliaba el alcance de la
escritura; el del operador apagaba la única condición que habría hecho útil esa ampliación, de modo
que el resultado nunca fue lo bastante raro como para que alguien lo mirara. **Cuando encuentres uno
de los dos, busca el otro en la misma cláusula.**

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

**El sub-caso que no se arregla con un `UNIQUE`: la lectura sucia dispara un efecto externo
irreversible.** Los duplicados de arriba se pueden neutralizar con una restricción. Esto no.

Patrón medido, en una cola de envío de correo de **3,16 M filas**:

1. Un job escribe las notificaciones dentro de una transacción larga —ver R-04— y aún no confirma.
2. El lector que alimenta al servicio de envío consulta la cola **con `(NOLOCK)`** y ve esas filas.
3. El servicio **envía el correo**.
4. Al intentar marcarlo como enviado, el `UPDATE` choca con el lock X del job y se bloquea.

El bloqueo del paso 4 es el síntoma visible y es lo que dispara la alerta. El defecto está en el
paso 3: si la transacción revierte, **el correo ya salió** y la fila que lo registraba desaparece.
El `UPDATE` termina afectando a 0 filas, en silencio, y la notificación vuelve a ser candidata en
la siguiente corrida. Quedan envíos sin rastro y con posibilidad de reenvío.

> Un `ROLLBACK` revierte lo que está dentro de la base. No revierte un correo, un fichero escrito
> ni una llamada a una API. Cuando una lectura sucia gobierna un efecto **fuera** del motor, no
> hay compensación posible: el hint tiene que salir.

Al diagnosticar, no te quedes en la cadena de bloqueo. Pregunta **quién leyó la fila antes de que
existiera** y qué hizo con ella.

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

**El sub-caso desde el otro lado: `@@ERROR` no ve lo que el llamado ya capturó.** Un despachador
que ejecuta código ajeno y comprueba el resultado así:

```sql
-- ANTI-PATRÓN: el control de error del llamador
EXECUTE sp_executesql @Script, @DefinicionParams, @param1 = @valor1;
IF @@ERROR <> 0
 BEGIN
    ROLLBACK TRAN MiTransaccion;
    ...
 END
```

Si el script ejecutado trae su propio `TRY/CATCH` y **no relanza**, el error muere ahí dentro:
`@@ERROR` vale 0 y el despachador reporta éxito. Medido: **12 de 39** scripts de un catálogo
tenían `TRY/CATCH` propio. El job terminaba informando de que todo se había ejecutado
correctamente, sin garantía alguna de que así fuera.

Dos fallos se suman aquí, y conviene separarlos:

- `@@ERROR` refleja **la última sentencia**, y sólo los errores que llegaron a la sesión. Ni ve
  lo capturado abajo, ni sobrevive a una sentencia intermedia.
- Sin `SET XACT_ABORT ON`, un error que aborta la sentencia pero no el lote deja el bucle
  corriendo **con la transacción abierta**. Si además el cliente corta, queda un head blocker
  dormido — R-26.

> Si ejecutas código que no controlas, envuélvelo en tu propio `TRY/CATCH` con
> `SET XACT_ABORT ON` y quédate con `ERROR_MESSAGE()`. `IF @@ERROR <> 0` después de un `EXEC` es
> una comprobación que **parece** existir. Y un `CATCH` que traga sin relanzar no sólo oculta el
> error a su autor: se lo oculta a todos sus llamadores.

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

## R-36 · `READPAST` en una escritura salta filas en silencio [obs]

**Severidad:** alta

`READPAST` en una lectura de cola es idiomático: sirve para que varios trabajadores tomen lotes
distintos sin pisarse. En una **escritura** cambia de significado y casi nadie lo nota: el motor
no espera a las filas bloqueadas ni falla — **las omite**, y la sentencia informa un
`@@ROWCOUNT` menor sin ningún aviso.

Caso observado, en un procedimiento de cola disparado por un planificador externo cada pocos
minutos sobre una tabla de **43.650 filas**:

```sql
-- El patrón, tal cual se encontró
UPDATE q SET estado = 2, fin = GETDATE()
FROM dbo.ColaProceso AS q (READPAST)      -- ← si la fila está bloqueada, no se actualiza
INNER JOIN #Lote AS l ON l.id = q.id;     --   y nadie se entera
```

Una fila marcada como *en vuelo* al inicio del proceso puede así **no llegar nunca a su estado
final**. Por sí solo eso ya es una fuga de datos de proceso; lo que lo vuelve grave es la
combinación con el guard que suele acompañar a estos procedimientos:

```sql
-- Al inicio del mismo procedimiento
IF EXISTS (SELECT TOP 1 1 FROM dbo.ColaProceso WITH (NOLOCK) WHERE estado = 1)
    RETURN;                                -- ← "ya hay trabajo en vuelo, no arranques"
```

**Una sola fila atascada en el estado intermedio detiene la cola completa, para siempre**, hasta
que una persona la corrija a mano. El proceso no falla, no registra error y su job sigue
reportando éxito: simplemente deja de hacer trabajo. Es un interbloqueo lógico que ninguna
herramienta de bloqueo detecta, porque no hay ningún lock esperando a nadie.

> `READPAST` en un `SELECT` de cola: correcto. En un `UPDATE` o `DELETE`: casi siempre un
> defecto. Y si el proceso tiene un guard de «trabajo en vuelo», **la vigilancia de filas
> atascadas es obligatoria**, no opcional.

```sql
-- DETECCIÓN: escrituras con READPAST (revisar a mano; el orden de las palabras varía)
SELECT OBJECT_NAME(object_id) AS objeto
FROM sys.sql_modules
WHERE definition LIKE '%READPAST%'
  AND (definition LIKE '%UPDATE%' OR definition LIKE '%DELETE%');

-- VIGILANCIA: filas ancladas en el estado intermedio
SELECT COUNT(*) AS atascadas, MIN(inicio) AS masAntigua
FROM dbo.ColaProceso
WHERE estado = 1 AND inicio < DATEADD(minute, -15, GETDATE());
```

El arreglo por defecto es quitar el `READPAST` de la escritura. Ojo: **cambia el comportamiento
de concurrencia** del proceso —pasa de saltar a esperar—, así que es una decisión del dueño
funcional, no del que audita. Cuando no se pueda tocar, la vigilancia de arriba convierte un
fallo silencioso e indefinido en una alerta de 15 minutos.

Relacionada con R-09 (`NOLOCK` en lecturas que deciden), R-11 (el error que nadie ve) y R-28
(la instrumentación también se audita).

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

**Sub-caso medido — la UDF aparece dos veces en el plan cache, y la segunda es la que asusta.**
Una consulta de una base de reporting llamaba a una función escalar declarada en **otra base**
desde su lista de `SELECT`. En `sys.dm_exec_query_stats` conviven dos filas:

| Fila | Ejecuciones | CPU total | Lecturas |
|---|---:|---:|---:|
| La consulta padre | **1** | 144.692 ms | 131.460.437 |
| El cuerpo de la UDF | **67.736** | 104.777 ms | 128.092.455 |

**Una sola ejecución de la consulta padre se abrió en 67.736 ejecuciones de la función, en unos
tres minutos**, a 1.891 lecturas cada una. Las 128 M de lecturas de la segunda fila son
prácticamente las mismas 131 M de la primera: no son costes que se sumen, es el mismo trabajo
visto desde dentro.

> Al ordenar el plan cache por CPU, una fila con un número de ejecuciones desproporcionado
> respecto a las demás y un texto que parece un fragmento suelto —`SELECT TOP 1 @variable = …`—
> casi siempre es el cuerpo de una UDF escalar. Buscar ese `@variable` en `sys.sql_modules`
> identifica la función; `sys.objects.type_desc = 'SQL_SCALAR_FUNCTION'` lo confirma.

Comprueba el compat level antes de estimar la ganancia: con 130 no hay inlining y la reescritura
es la única salida.

**Sub-caso medido — la cadena: una llamada, cuatro consultas.** La función escalar del caso
anterior llamaba a su vez a **otras dos funciones escalares**:

```
FuncionPrincipal(@id)
  +-- FuncionA(@id)      1 consulta  (2 tablas)
  +-- FuncionB(@id)      2 consultas (2 tablas cada una)
  +-- su propia consulta 1 consulta  (4 tablas)
```

Hasta **4 consultas por invocación**, y la invocación ocurre una vez por fila. Al medir el
anidamiento con `sys.sql_expression_dependencies` apareció además que una de las funciones de
apoyo tenía **54 referencias** en el esquema — cifra que asusta y frena la reescritura hasta que
se mira de cerca: entre ellas había sufijos `_BkUp`, `_notused`, `_Test`, `_Preliminary`,
`_prueba` y cinco con fecha en el nombre. **El alcance real de un cambio así casi siempre es
mucho menor que el que devuelve el catálogo**; sepáralo con `sys.dm_exec_procedure_stats` y Query
Store antes de dimensionar el trabajo.

**El descarte que ahorra semanas: no son los índices.** Las cinco tablas que recorría la cadena
sumaban **127 MB** y ninguna llegaba a 79.000 filas, con los índices exactos que los predicados
necesitaban. El coste no estaba en lo que valía una llamada, sino en cuántas se hacían. Antes de
proponer un índice, comprueba el tamaño de lo que se recorre: si es pequeño y está indexado, el
problema es el número de invocaciones y ningún índice lo va a arreglar.

**La receta de reescritura, verificada.** Resolver cada concepto como conjunto una sola vez y
unir por la izquierda:

```sql
WITH ConjuntoA AS ( … ),          -- lo que resolvía FuncionA, para todas las claves
     ConjuntoB AS ( … )           -- lo que resolvía FuncionB
SELECT t.Clave,
       Resultado = CASE WHEN a.Clave IS NOT NULL THEN 0
                        WHEN EXISTS ( … predicado principal … ) THEN 1
                        ELSE 0 END
FROM   dbo.Tabla t
       LEFT JOIN ConjuntoA a ON a.Clave = t.Clave
       LEFT JOIN ConjuntoB b ON b.Clave = t.Clave;
```

Medido sobre datos reales, con `EXCEPT` en ambas direcciones y **0 diferencias** en 3.000 casos:

| Versión | Filas resueltas | Duración | Por fila |
|---|---:|---:|---:|
| escalar | 3.000 | 26.950 ms | 8,98 ms |
| de conjunto | 71.218 | **568 ms** | 0,008 ms |

23,7 veces más filas en 47 veces menos tiempo.

> ⚠️ **No es un reemplazo transparente.** Una función escalar se invoca `dbo.F(x) = 1`; una
> inline, `OUTER APPLY dbo.F_v2(x)`. **No se intercambia con `sp_rename`**: hay que editar cada
> llamador, y cada edición necesita su propio respaldo y su propia verificación. Convertir la
> función quita la serialización del plan; la ganancia grande está en dejar de llamarla una vez
> por fila. Son dos cambios distintos y conviene no confundirlos al estimar.

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

**Sub-caso medido — la misma clave lógica declarada con tres tipos, y sin una sola FK que lo
sujete.** Un identificador de negocio estaba definido como `varchar(36)` en dos tablas y como
`uniqueidentifier` en una tercera de 10,83 GB y 7,6 M de filas. Unirlas obliga a convertir en cada
fila. Coste medido sobre el mismo corte de datos: **14,5 s** con conversión frente a **5,0 s**
entre las dos tablas que sí comparten tipo.

Lo que convierte esto en un hallazgo de modelo y no solo de rendimiento: **no existía ninguna
clave foránea entre las tres**. La relación se sostenía por convención. Se verificó con una
muestra de 20.000 filas que la conversión empareja el **99,8 %** — el 0,2 % restante eran
huérfanos que ninguna restricción impedía.

```sql
SELECT COUNT(*) AS Muestra,
       SUM(CASE WHEN p.Clave IS NOT NULL THEN 1 ELSE 0 END) AS ConPadre
FROM   (SELECT TOP (20000) Clave FROM dbo.Hija) h
       LEFT JOIN dbo.Padre p ON p.Clave = CAST(h.Clave AS varchar(36));
```

> Antes de unir dos tablas por un identificador "obvio", comprueba el tipo en **todas** las tablas
> de la cadena, no solo en las dos que estás mirando. `validate_data_types` lo resuelve de una
> pasada. Y si la unión no está respaldada por una FK, mide primero cuántas filas emparejan: la
> convención puede llevar años rota sin que nadie lo note.

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

**Sub-caso medido — el heap que ocupa 50× lo que contiene, y la división que lo delata.** En una
base de 305 GB, la segunda tabla más grande ocupaba **24,82 GB con 326.677 filas**: 3.252.900
páginas al **1,88 % de ocupación**. No tenía columnas LOB. La comprobación que lo destapa es una
división, no una DMV:

```sql
SELECT Filas, Paginas, BytesPorFila = Paginas * 8192.0 / Filas
```

**81.528 bytes por fila, diez veces el máximo de 8.060 que cabe en una fila de SQL Server.** Es
aritméticamente imposible que sean datos: solo pueden ser páginas que el heap nunca devolvió tras
borrados anteriores. Confirmación con `avg_page_space_used_in_percent` en modo `SAMPLED` — el modo
`LIMITED` devuelve `NULL` en esa columna y no sirve.

El coste no es solo disco: contar esas 326.677 filas tardó **27 segundos**, porque el motor
recorre las 3.252.900 páginas. Un `REBUILD` las deja en ~61.000. Tres heaps del mismo entorno
sumaban **38,38 GB de aire** y 5.407.300 *forwarded records*; el conjunto eran 432 heaps con
125,66 GB.

> **La consecuencia que rompe planes de trabajo:** una poda por antigüedad sobre un heap **no
> libera ni un byte** sin `ALTER TABLE ... REBUILD` después. Las filas desaparecen y el archivo
> mide lo mismo. Si un plan de reducción de datos no incluye ese paso, su estimación de ahorro es
> ficción.

Y antes de planificar el corte, **verifica que la columna de fecha está poblada**: en la misma
base, una bitácora de **87.368.562 filas** tenía su única columna de fecha en `NULL` en el
**100 %** de ellas. Cortar por ella no habría borrado nada. Una sola consulta lo descarta:

```sql
SELECT COUNT(*) AS Total,
       SUM(CASE WHEN Fecha IS NULL THEN 1 ELSE 0 END) AS Nulas,
       MIN(Fecha) AS Minima, MAX(Fecha) AS Maxima
FROM   dbo.Bitacora;
```

Esa misma consulta destapó, en otra tabla del dominio, fechas de **1900** y de **8202**
conviviendo: un corte por antigüedad habría borrado las primeras —probablemente registros válidos
sin fecha poblada— y conservado las segundas para siempre.

**Y no des por hecho que el peso está donde están las filas.** La mayor de todas —48 GB— tenía
2,79 M de filas y **42,79 GB en unidades de asignación LOB**: 17 KB de HTML por fila. Con
`allocation_units.type = 2` se separa en una consulta lo que es fila de lo que es LOB, y cambia
por completo qué técnica de borrado conviene: ahí el coste está en mover el LOB, no en el log de
transacciones.

## R-25 · La configuración por defecto de la instancia no es la correcta [obs]

Observado: `cost threshold for parallelism = 5` —el default de fábrica desde 1998— y
`MAXDOP = 0`. En un servidor de 8 cores eso paraleliza hasta lo trivial y deja que una sola
consulta acapare los 8 schedulers: **13.5 % de las esperas del servidor**. También Change
Tracking con 365 días de retención, que resultó ser el mayor consumidor de CPU de la instancia.

> Al montar cualquier instancia, revisa: `cost threshold for parallelism` (~50), `MAXDOP`
> (según cores/NUMA), `optimize for ad hoc workloads`, y la retención de Change Tracking.

Comprueba además los cuatro valores que cambian el diagnóstico de cualquier análisis:
compat level, RCSI, edición y si hay Always On. Están en `SKILL.md`.

**Sub-caso medido — Change Tracking, por segunda vez y en otra instancia.** La retención de 365
días volvió a aparecer, y otra vez como **el mayor consumidor de CPU de todo el servidor**:
**9.161.864 ms** —2 h 33 min— en 11.304 ejecuciones y 107.469.831 lecturas, y con una advertencia
que multiplica la cifra: esas estadísticas cubrían **3 días**, no el uptime completo, porque el
plan se había creado tres días antes. Estaba habilitado en 4 bases, con retenciones de 3, 7 y 365
días conviviendo sin criterio aparente.

Que reaparezca en un entorno distinto no es casualidad: **365 días no es una decisión, es lo que
queda cuando nadie toca el valor al habilitar la característica.** Revísalo por instancia, no por
base.

```sql
SELECT DB_NAME(database_id) AS BaseDeDatos, is_auto_cleanup_on,
       retention_period, retention_period_units_desc
FROM   sys.change_tracking_databases;
```

La huella en el plan cache es reconocible: consultas con `databaseName` nulo sobre
`internal_table_name`, `start_time` o `sys.syscommittab`. No tienen dueño aparente porque son
tareas internas del motor, y por eso se pasan por alto en cualquier informe ordenado por base.

**Sub-caso medido — clonar una base clona su configuración de Change Tracking.** Tercera
aparición de los 365 días, y esta vez con el mecanismo de propagación a la vista. Se creó una
copia de una base productiva; la copia heredó **72 tablas con Change Tracking, 759 MB de tablas
laterales, 18.177.132 filas pendientes y la retención de 365 días**, cifras idénticas a las del
original hasta el tercer dígito. Desde ese momento la instancia paga **el doble** de limpieza:
5.762,8 s de CPU y 68.676.119 lecturas en 6.789 ejecuciones, al **mismo ritmo exacto de 144
ejecuciones/hora** que el plan de la base original.

Nadie decidió 365 días para la copia. Nadie decidió nada: se clonó.

> Cuando aparezca una base nueva en una instancia —copia, restauración, refresco de entorno—
> revisa `sys.change_tracking_databases` **el mismo día**. Una copia hereda el coste permanente
> de limpieza de su origen, y ese coste no aparece atribuido a ninguna consulta de negocio.

**La técnica de fechado, que vale para cualquier regresión.** El plan de `sys.sp_add_ct_history`
correspondiente a la copia nació **14 minutos** después de crearse la base (12:45:36 → 12:59:04).
Cruzar `creation_time` del plan cache contra `create_date` de `sys.databases` fecha el cambio con
precisión de minutos, sin necesidad de que nadie recuerde qué se hizo:

```sql
SELECT name, create_date FROM sys.databases WHERE create_date >= DATEADD(day,-7,GETDATE());
```

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
- **Un monitor por muestreo tiene un suelo de detección, y casi nunca es el de su intervalo.**
  Si la regla de disparo exige que el síntoma aparezca en **N muestras consecutivas**, el umbral
  real no es el intervalo sino `(N-1) × intervalo`. Caso medido: un job de vigilancia de bloqueos
  corría cada **5 min** y solo alertaba con `contador > 1` —es decir, dos fotos seguidas—, así que
  su suelo efectivo eran **5 minutos**, no 5 segundos ni 5 minutos de resolución. En 14 días
  registró **2 episodios**, ambos ruido (una base de pruebas y el IntelliSense de una sesión de
  SSMS), mientras Query Store registraba esperas por lock **a diario**. El instrumento no fallaba:
  empezaba a medir justo donde terminaban los eventos reales, de 1 s a 5 min. Antes de leer un
  historial vacío como «no pasó nada», **calcula el suelo del instrumento y compáralo con la
  duración de lo que buscas**. Y desconfía de la conclusión intermedia: un monitor que solo alerta
  por ruido acaba ignorado, lo que deja el hueco sin cubrir *y* sin que nadie lo note.
- **El par bloqueador-bloqueado no se reconstruye a posteriori sin haberlo capturado.** Query Store
  registra **quién esperó**, nunca quién retuvo el lock; identificar al causante desde ahí es
  inferencia por coincidencia temporal, no prueba. Lo que lo nombra con evidencia es el blocked
  process report (`blocked process threshold (s)`, apagado en `0` por defecto) **más una sesión de
  Extended Events que lo recoja**: el umbral solo emite el evento, y sin consumidor no queda rastro
  en ninguna parte. Activar uno sin el otro produce la peor situación posible — la impresión de que
  hay monitoreo donde no lo hay.
- **Y la variante que no es tuya: la herramienta del que mira.** El sub-caso anterior se corrige
  excluyendo el propio instrumento; éste no, porque el ruido lo mete **otra persona con SSMS
  abierto**. El Object Explorer y los diálogos de propiedades emiten consultas de catálogo
  parametrizadas —firma inconfundible: parámetros `@_msparam_n` y lecturas sobre alias como
  `clmns`, `tbl`, `sch`— que Query Store registra como carga igual que las del negocio. Caso
  medido al comparar un antes/después de migración: **las dos consultas con peor regresión de
  todo el conjunto (×10,71 y ×38,69, con el I/O multiplicándose de 931 a 5.909 y de 400 a 4.968)
  eran del Object Explorer**, y aparecían en cabeza precisamente porque nadie navegaba ese
  servidor antes de migrarlo. Publicadas sin filtrar habrían descrito una degradación mucho peor
  que la real. Excluye siempre `AND qt.query_sql_text NOT LIKE '%msparam%'`, y separa lo que
  tiene `object_id` —código del negocio, procedimientos y funciones— del ad-hoc, que es donde se
  esconden las herramientas. La regla general: **antes de dar por buena una consulta de la lista
  de peores, lee su texto**. Un ranking de Query Store no distingue quién ejecutó qué.
- **Una media sobre una población que crece deriva sola.** Es la trampa más silenciosa de un
  antes/después, porque produce una mejora que nadie ha hecho. Al comparar dos ventanas se filtra
  por un mínimo de ejecuciones (`>= 100`) para quitar ruido — y ese conjunto **se agranda con el
  tiempo**, según cada consulta acumula ejecuciones. Medido: en **3 horas**, sin tocar la
  configuración, la población comparable pasó de **301 a 482 consultas** y la duración media
  ponderada bajó de **0,975 ms a 0,733 ms**. Un 25 % de «mejora» que era aritmética de población:
  las consultas que entraron eran más baratas que la media. **Lo que sí se mantuvo fue el factor:
  ×1,76 → ×1,74.** Regla: en cualquier comparación antes/después, **la métrica de seguimiento es
  el cociente de cada consulta contra sí misma, no el agregado en milisegundos**. El cociente se
  normaliza solo; el absoluto solo es comparable contra su propia población, que ya no existe.
  Y si la comparación se apoya en Query Store, anota su **fecha de caducidad**: la ventana
  «antes» desaparece cuando cumple la retención, así que o se exporta a una tabla propia o la
  medición deja de poder rehacerse.
- **Query Store es por base; las esperas son de la instancia. No refutes una con la otra.** Error
  cometido y corregido en una investigación real: se midió que solo el **0,016 %** de las
  ejecuciones de la base auditada usaba plan paralelo y se concluyó «el paralelismo está
  descartado». El dato era correcto y la conclusión falsa — un delta de esperas de 3 h sobre la
  **instancia** mostró `CXCONSUMER`+`CXSYNC_PORT`+`CXPACKET` en **11.001.672 ms de 14.840.213, el
  74 % de toda la espera real**. Venía de otra base, de 49, que no se había mirado. Antes de
  descartar un mecanismo con evidencia de Query Store, comprueba que **el alcance de la evidencia
  cubre el alcance de la afirmación**; si la señal es de instancia, la refutación también tiene
  que serlo.
- **Un porcentaje de ejecuciones no mide un porcentaje de coste.** El corolario del punto anterior,
  y lo que hacía engañoso el 0,016 %. En la base culpable, el **0,065 % de las ejecuciones**
  (6.671 de 10.273.280) consumía el **53,6 % del CPU** de esa base: doce sentencias, encabezadas
  por una de **326.997.111 lecturas lógicas por ejecución** que en **2 ejecuciones** se llevó
  2.907 s de CPU. Ordena siempre por **coste total** —`avg_cpu_time * count_executions`—, nunca
  por número de ejecuciones. Y no confundas el arreglo: subir `cost threshold for parallelism`
  impide que se paralelice **lo trivial**, no lo que cuesta órdenes de magnitud más que el umbral.
  Esas sentencias seguirán yendo en paralelo, y con razón; lo que hay que arreglar es la sentencia.
- **Un job informa hacia atrás; una alerta avisa en el momento.** Los contadores
  `SQLServer:Locks / Number of Deadlocks/sec / _Total` y
  `SQLServer:General Statistics / Processes blocked` sirven como condición de rendimiento en una
  alerta de Agent. Lo que **no** funciona es alertar sobre el mensaje de error 1205: la víctima
  de deadlock no se escribe en el log de errores por defecto, así que esa alerta no se dispara
  nunca.
- **El caso inverso: aquí el ruido se lee como señal.** `sys.dm_os_wait_stats` devuelve mezcladas
  las esperas reales y las de tareas de fondo que simplemente esperan trabajo. Medido en una
  instancia: **las cinco esperas mayores sumaban el 80,2 % del total y ninguna era contención**
  —`HADR_*`, `BROKER_TRANSMITTER`, `LOGMGR_QUEUE`—, tapando por completo el paralelismo que sí
  importaba. Leído sin filtrar, el diagnóstico habría sido «esta instancia espera por Always On».
  Filtra siempre con la lista de exclusión conocida antes de ordenar por porcentaje, y añade dos
  columnas que la lectura ingenua olvida: el **signal wait** de cada espera —el porcentaje de
  tiempo que la tarea ya estaba lista y solo esperaba CPU— y el número de tareas, que distingue
  «muchas esperas cortas» de «una espera eterna».
- **Los totales del plan cache no cubren el uptime.** `sys.dm_exec_query_stats` acumula desde
  `creation_time` de **cada plan**, no desde el arranque del servidor. En una misma foto convivían
  una fila con 3 días de historia y otra con unos minutos. Sirve para ordenar por magnitud; sumar
  sus totales y presentarlos como «el consumo del periodo» es un error. Incluye `creation_time`
  en toda consulta al plan cache que vaya a un informe.

**Sub-caso medido — el instrumento no sólo tapa la evidencia: a veces *es* el consumo.** Hasta
aquí esta regla trataba la instrumentación como fuente que se degrada. También hay que auditar
lo que **cuesta**. Medido: el mayor consumidor de CPU de toda una instancia no era ninguna
consulta de negocio, sino **una métrica de un colector de monitorización** que interrogaba el
historial de respaldos **cada 10 segundos**:

| | Medido en 66 h |
|---|---:|
| Ejecuciones | 23.759 |
| CPU | **80.377,8 s** (22,3 h) |
| Lecturas lógicas | **19.997.423.526** |
| Lecturas por ejecución | 841.820 |
| Duración media | 3.522,5 ms |

La tabla consultada ocupaba **67 MB (8.576 páginas)**: leer 841.820 páginas significa recorrerla
unas **98 veces por ejecución**. La causa era doble y ninguna mitad se arregla sola — la consulta
agrupaba el historial y lo volvía a cruzar consigo mismo sin índice que soportara el predicado, y
el historial llevaba **2.236 días** acumulándose porque nadie lo purgaba nunca.

> Al ordenar el plan cache por CPU, **no descartes las filas sin base de datos atribuida**. Las
> tareas del motor y los colectores externos aparecen con `dbid` nulo y por eso se caen de
> cualquier informe organizado por base — que es justo donde se esconden los mayores consumidores
> (ver también el sub-caso de Change Tracking en R-25).
>
> Y aplica a la instrumentación el mismo criterio que a cualquier proceso: **la frecuencia se
> justifica con la velocidad a la que cambia el dato**. Un indicador sobre el último respaldo no
> cambia cada 10 segundos; bajarlo a 5 minutos divide su coste por 30 sin perder información.

**Sub-caso medido — las esperas acumuladas no pueden fechar una regresión.** `sys.dm_os_wait_stats`
suma desde el arranque del servicio. Con **63 días** de uptime, buscar en ella una degradación de
dos días es inútil: la señal queda diluida por un factor de 30. Lo que sí funciona, y no cuesta
nada:

- **Dos capturas separadas.** Consultar `sys.dm_os_wait_stats` dos veces y restar. En una ventana
  de 31,06 s medida así, `CXPACKET`+`CXCONSUMER` daban el **84 %** de la espera total y los
  bloqueos **0 ms** — un reparto irreconocible frente al acumulado de 63 días. Igual con
  `sys.dm_io_virtual_file_stats`, que también es acumulada.
- **Query Store agregado por día.** Es lo único que fecha una regresión con precisión. Comparar
  **laborables contra laborables** —el fin de semana distorsiona la media por sentencia, porque el
  poco volumen que queda es batch pesado— dio en el caso medido **1,10 ms → 1,89 ms** por
  sentencia (×1,72) y señaló el día exacto. Y contrastar una segunda base descartó de un plumazo
  la causa de instancia: la vecina no se había movido.

---

## R-33 · Reducir volumen no es optimizar: mide quién lee la tabla antes de prometer rendimiento [obs]

Un plan de poda se justifica solo. Lo que **no** se justifica solo es la frase que suele
acompañarlo: «y además la aplicación irá más rápida».

Caso medido: base de **305,72 GB usados**, plan de poda de **119,59 GB** entre reconstrucción de
heaps, vaciado de bitácoras y corte por antigüedad. Antes de comprometer la ventana se miró
`sys.dm_db_index_usage_stats`, con 57 días acumulados:

| Tabla candidata | GB | Búsquedas | Escaneos | Escrituras |
|---|---:|---:|---:|---:|
| la mayor de la base | 48,00 | **0** | **0** | 2.506 |
| la segunda | 24,82 | **0** | 2 *(del propio análisis)* | 5.044 |
| la tercera | 12,87 | **0** | 2 *(del propio análisis)* | 3.365 |
| una bitácora de proceso | 3,78 | **0** | 1 *(del propio análisis)* | **263.185** |
| la que la aplicación **sí** usa | 22,18 | **19.642.060** | **0** | 3.365 |

**Las tablas donde estaba todo el espacio recuperable no las leía nadie.** Se escribía en ellas y
nunca se consultaban. Y la tabla que la aplicación sí castigaba —19,6 millones de búsquedas— se
accede siempre **por búsqueda**, no por escaneo.

> El coste de una búsqueda en un índice es **logarítmico** respecto al número de filas; el de un
> escaneo es **lineal**. Quitar el 44,6 % de las filas de una tabla no cambia la profundidad de su
> árbol: esas 19,6 millones de búsquedas cuestan exactamente lo mismo después de podar. **Toda la
> ganancia de rendimiento de una reducción de datos se concentra en lo que hace escaneos.** Si
> nada escanea la tabla, la ganancia es cero.

```sql
SELECT  t.name, i.index_id, i.type_desc,
        ISNULL(us.user_seeks,0)   AS Busquedas,
        ISNULL(us.user_scans,0)   AS Escaneos,
        ISNULL(us.user_updates,0) AS Escrituras,
        us.last_user_scan, us.last_user_seek
FROM    sys.tables t
        JOIN sys.indexes i ON i.object_id = t.object_id AND i.index_id IN (0,1)
        LEFT JOIN sys.dm_db_index_usage_stats us
               ON us.object_id = i.object_id AND us.index_id = i.index_id
              AND us.database_id = DB_ID()
WHERE   t.name IN (…las candidatas a poda…);
```

**Trampa de método, y no es menor: tus propias consultas de análisis contaminan estas
estadísticas.** En el caso medido, los únicos escaneos registrados sobre cuatro de las cinco
tablas llevaban marca de tiempo dentro de la ventana en que se ejecutaron los `COUNT(*)` del
propio análisis. Sin mirar `last_user_scan` se habría concluido que la aplicación sí las lee.
Compara siempre la hora contra la de tu sesión antes de interpretar el número.

**Lo que una reducción de datos sí compra**, y suele bastar para justificarla: tiempo de backup y
restore, `DBCC CHECKDB`, duración del ciclo de refresco de los entornos no productivos, y coste
de disco. Todo ello es operación, no experiencia de usuario. Preséntalo como lo que es.

Y antes de dar por bueno el diagnóstico, comprueba **dónde está de verdad el consumo**: en el
mismo entorno, el mayor consumidor de CPU del servidor era la limpieza de Change Tracking
(R-25) y el segundo una función escalar en un `SELECT` (R-14). Ninguno de los dos mejora un
gramo al reducir volumen de datos.

**La comprobación de dos minutos que decide la conversación entera.** Antes que el uso de
índices, antes que cualquier conteo: mira cuánto pesa la espera por lectura de página.

| Espera medida en el entorno del caso | % del total |
|---|---:|
| `CXPACKET` + `CXCONSUMER` | **12,14 %** |
| `LATCH_EX` | 4,39 % |
| `SOS_SCHEDULER_YIELD` | 1,15 % *(99,85 % de ella es señal)* |
| **`PAGEIOLATCH_SH`** | **0,12 %** |

> Reducir el tamaño de una base reduce E/S. Si la instancia **no espera por E/S**, la reducción no
> se nota. `PAGEIOLATCH_*` cien veces por debajo del paralelismo es la prueba, y llega por un
> camino independiente del uso de índices: dos evidencias distintas apuntando a lo mismo.

El recíproco también vale, y es la única forma de rescatar el argumento: si `PAGEIOLATCH_*` sí
pesa, la reducción de volumen vuelve a la mesa. Mídelo antes de decidir, no después.

Un `SOS_SCHEDULER_YIELD` casi enteramente de **señal** —la tarea ya estaba lista y esperaba
turno de CPU— apunta a presión de CPU, que se ataca por consultas y no por hardware.

---

## R-34 · Una consulta lenta con CPU casi nula no es lenta: está esperando [obs]

Es la regla que evita el diagnóstico equivocado más caro: buscar la consulta que "consume
mucho" cuando el problema es que **no consume nada**.

Observado: seis sentencias de los procedimientos de búsqueda y alta de una aplicación web,
medidas en Query Store sobre una ventana de tres días.

| Sentencia | Ejec. | Duración media | CPU media | Lecturas lógicas | Duración máx. |
|---|---:|---:|---:|---:|---:|
| Alta (un `INSERT` de **una fila**) | 35 | **23.707,7 ms** | 0,6 ms | 11 | 69.256,3 ms |
| Búsqueda | 124 | **22.141,2 ms** | 0,4 ms | 6 | 103.383,6 ms |
| Búsqueda | 60 | 14.948,7 ms | 0,2 ms | 7 | 97.501,4 ms |
| Búsqueda | 60 | 14.183,8 ms | 0,3 ms | 9 | 97.225,7 ms |
| Validación previa | 179 | 9.293,9 ms | 0,3 ms | 6 | 114.401,7 ms |
| Vista previa | 168 | 1.806,8 ms | 0,2 ms | 8 | 19.959,9 ms |

**La relación duración/CPU llega a 55.000×.** El razonamiento es aritmético y no admite
matices: una sentencia que toca 6 páginas y gasta 0,4 ms de procesador **no puede** tardar
22 segundos por mérito propio. Todo ese tiempo es espera. Y el tamaño no interviene: el
`INSERT` de una fila que tardaba 23,7 s escribía en una tabla de **4 MB y 95.422 filas**.

En ese entorno **RCSI estaba apagado en las 8 bases revisadas**, así que la espera compatible
con este perfil es el bloqueo: un lector necesita bloqueo compartido y se detiene detrás de
cualquier escritura larga sobre la misma tabla. Todas las tablas comprobadas —13 de 13— tenían
`lock_escalation = TABLE`, de modo que una escritura que supera ~5.000 bloqueos individuales
detiene a **todos** los lectores, no sólo a los de las filas afectadas.

**La CPU baja del servidor no es prueba de salud — es el síntoma.** En la misma ventana: media
del **13 %**, máximo 53 %, y **cero minutos** por encima del 80 % en 256 muestras. Un servidor
ocioso con usuarios quejándose es exactamente lo que produce una cadena de bloqueo: nadie
trabaja porque casi todos esperan.

```sql
-- DETECCIÓN, después del hecho y sin haber capturado el bloqueo.
-- Ejecutar en la base sospechosa. Devuelve sentencias que esperan en vez de trabajar.
SELECT TOP (20)
       p.query_id, OBJECT_NAME(q.object_id) AS Objeto,
       SUM(rs.count_executions) AS Ejecuciones,
       CAST(SUM(rs.avg_duration    * rs.count_executions)
            / SUM(rs.count_executions) / 1000.0 AS decimal(18,1)) AS DuracionMediaMs,
       CAST(SUM(rs.avg_cpu_time    * rs.count_executions)
            / SUM(rs.count_executions) / 1000.0 AS decimal(18,1)) AS CpuMediaMs,
       CAST(SUM(rs.avg_logical_io_reads * rs.count_executions)
            / SUM(rs.count_executions) AS bigint)                 AS LecturasMedia,
       CAST(SUM(rs.avg_duration * rs.count_executions)
            / NULLIF(SUM(rs.avg_cpu_time * rs.count_executions),0) AS decimal(18,0)) AS Ratio
FROM   sys.query_store_plan AS p
JOIN   sys.query_store_query AS q  ON q.query_id = p.query_id
JOIN   sys.query_store_runtime_stats AS rs ON rs.plan_id = p.plan_id
JOIN   sys.query_store_runtime_stats_interval AS rsi
       ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
WHERE  rsi.start_time >= DATEADD(day, -3, GETDATE())
GROUP  BY p.query_id, q.object_id
HAVING SUM(rs.count_executions) >= 20
   AND SUM(rs.avg_duration * rs.count_executions)
       > 100 * SUM(rs.avg_cpu_time * rs.count_executions)
ORDER  BY DuracionMediaMs DESC;
```

**Por qué Query Store y no las DMV de sesión.** `sys.dm_exec_requests` y cualquier consulta de
cadenas de bloqueo sólo ven **el instante** en que se ejecutan. Un bloqueo intermitente que dura
20 s y ocurre unas decenas de veces al día es invisible para ellas: en el caso medido, un
muestreo de 31 s registró **0 ms** de espera por bloqueo y `get_blocking_chains` salió limpio,
con el problema plenamente activo. Query Store conserva duración **y** CPU por sentencia, así que
la firma sobrevive al hecho — es la única forma de diagnosticar esto a posteriori.

> Antes de concluir «bloqueo», descarta las otras tres causas de duración ≫ CPU. Son pocas y se
> distinguen rápido:
>
> | Causa alternativa | Cómo se descarta |
> |---|---|
> | Cliente que no consume el resultado (`ASYNC_NETWORK_IO`) | Mira `avg_rowcount`: aquí devolvía **0 o 1 fila**. Este efecto necesita result sets grandes |
> | Consulta remota o por *linked server* | Las lecturas remotas **no** cuentan como lecturas lógicas. Comprueba si la sentencia referencia un servidor vinculado; las del caso eran todas locales |
> | Espera por concesión de memoria | `RESOURCE_SEMAPHORE` y `Memory Grants Pending`: ambos estaban en **0** |

Y la consecuencia operativa: si `blocked process threshold` está en `0` —el valor de fábrica—
nada de esto queda registrado en ninguna parte (R-25). Encenderlo **no arregla nada**, pero es lo
único que convierte esta inferencia en el `session_id` y la sentencia del bloqueador real.
Relacionada con R-04 (transacción corta), R-09 (`NOLOCK` como síntoma de RCSI apagado), R-26
(*head blocker* dormido) y R-29 (escalado a bloqueo de tabla).

---

## R-35 · Una migración de versión mueve los datos, no la puesta a punto [obs]

Un `RESTORE` en una instancia nueva reproduce las páginas, no el trabajo de años que se hizo
sobre ellas. Lo que **viaja** dentro del backup y lo que **se queda** son dos listas distintas, y
ninguna de las dos es la que se supone:

| Viaja con el backup | Se queda en el servidor viejo | Se resetea a valores de fábrica |
|---|---|---|
| Estadísticas **y su `modification_counter`** | Jobs de respaldo y mantenimiento | `sp_configure` de la instancia |
| `compatibility_level` **del motor anterior** | Sesiones de Extended Events | `blocked process threshold` |
| Query Store, con su historial completo | Alertas y operadores | Trazas y colectores |
| Banderas de base (`AUTO_SHRINK`, RCSI, `AUTO_UPDATE_STATISTICS_ASYNC`) | Plan cache | |

La trampa está en la primera columna: **lo que viaja parece que está bien porque está**. Las
estadísticas llegan intactas —incluido su contador de modificaciones— y por eso nadie las
actualiza. El compat level llega intacto, y por eso la instancia nueva ejecuta con el optimizador
de la vieja.

Medido en una migración de dos versiones mayores, 49 bases restauradas en un fin de semana, con
la instancia nueva medida a las 63 h:

| | Medido |
|---|---:|
| Bases de usuario con el compat del motor **anterior** | **43 de 45** |
| Estadísticas con más de 30 días (base principal, tablas >10.000 filas) | **2.190 de 2.331** |
| Con más de 180 días | 639 |
| Con muestreo inferior al 5 % | 197 |
| **Con más modificaciones pendientes que filas tiene la tabla** | **39** |
| Antigüedad máxima | **241 días** |
| Esperas `WAIT_ON_SYNC_STATISTICS_REFRESH` acumuladas en 63 h | 10.985 · **195.966 ms** |
| Bases en `FULL` con `log_reuse_wait_desc = 'LOG_BACKUP'` | **6** |

Casos concretos: una tabla de **14.392.961 filas con 28.924.023 modificaciones pendientes** y 59
días sin actualizar; otra de **8.439.849 filas** con la misma cifra de modificaciones —renovación
completa— muestreada al **1,6 %** hace **241 días**.

### La firma que lo delata: menos lecturas y más tiempo

Es lo que hace esta regla útil, porque contradice la intuición. Comparando **las mismas consultas**
—mismo `query_id`— antes y después, con peso fijo:

| Base | Consultas | Duración | CPU | Lecturas lógicas |
|---|---:|---|---|---|
| Principal | 301 | 0,553 → **0,975 ms** (×1,76) | 0,616 → 0,903 ms | 45,1 → **33,5 (−26 %)** |
| Secundaria | 140 | 0,041 → **0,053 ms** (×1,29) | 0,036 → 0,048 ms | 4,7 → **3,4 (−28 %)** |

Menos páginas leídas y más tiempo no describe hardware peor: describe **hardware mejor ejecutando
planes peores**. Si el almacenamiento fuera el problema subirían las lecturas o la espera de
disco; aquí `PAGEIOLATCH_SH` promediaba **0,48 ms** sobre 1.055.821 esperas.

> **El control que separa «plan peor» de «CPU más lenta».** Aísla las consultas cuyo I/O **no
> cambió** (±5 %): si las páginas son las mismas, el plan es equivalente y lo único que queda es
> el coste por unidad de trabajo. En el caso medido, con el plan controlado el CPU subía solo un
> **17–33 %** de media y la mayoría de consultas no cambiaba —16 de 37 y 9 de 20—, así que el
> ×1,76 **no** se explica por el servidor: viene de las consultas cuyo plan sí cambió. Sin este
> control, el informe habría culpado al hardware nuevo.

### El compat level no es neutral, y aquí se mide

Dejarlo en el nivel antiguo evita regresiones de plan —para eso existe— pero desactiva, por
diseño, todo lo que se acaba de pagar. Con compat < 150 no hay *inlining* de funciones escalares
(R-14) ni compilación diferida de table variables (R-19); con compat < 160 no hay optimización de
planes sensibles a parámetros (R-06), ni *CE feedback*, ni *DOP feedback*.

Eso deja de ser teórico en cuanto se cuenta el código: **176 funciones escalares y 46 TVF
multi-sentencia frente a 9 TVF inline** en una sola base — y **cuatro de los objetos más
degradados de la migración eran funciones escalares**, una de ellas con **1.130.562 ejecuciones
diarias**. Es exactamente el patrón que el compat nuevo resuelve sin tocar una línea de T-SQL.

```sql
-- DETECCIÓN 1 · el estado que el restore trajo intacto y nadie revisó
SELECT DB_NAME() AS Base, COUNT(*) AS Total,
       SUM(CASE WHEN sp.modification_counter > sp.rows THEN 1 ELSE 0 END)  AS ModsSuperanFilas,
       SUM(CASE WHEN DATEDIFF(day, sp.last_updated, GETDATE()) > 30  THEN 1 ELSE 0 END) AS MasDe30Dias,
       SUM(CASE WHEN 100.0 * sp.rows_sampled / NULLIF(sp.rows,0) < 5 THEN 1 ELSE 0 END) AS MuestreoBajo5Pct,
       MAX(DATEDIFF(day, sp.last_updated, GETDATE()))                      AS DiasMaximo
FROM   sys.stats s
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE  sp.rows > 10000 AND OBJECTPROPERTY(s.object_id, 'IsUserTable') = 1;

-- DETECCIÓN 2 · lo que se quedó por el camino, en una sola foto
SELECT compatibility_level, is_auto_shrink_on, is_query_store_on,
       is_auto_update_stats_async_on, is_read_committed_snapshot_on,
       recovery_model_desc, log_reuse_wait_desc, name
FROM   sys.databases WHERE database_id > 4 ORDER BY compatibility_level, name;
```

**El orden de la remediación no es negociable.** Estadísticas primero, compat level al final.
Subir el compat con histogramas de 241 días es evaluar un optimizador nuevo con datos falsos: el
resultado no es interpretable, ni bueno ni malo. Y entre medias, el CU — una instancia recién
migrada suele estar en **RTM**, que es la peor versión posible sobre la que adoptar funciones
nuevas.

**Lo que sí es un regalo: Query Store viaja dentro del backup.** Es la única razón por la que una
migración se puede medir en lugar de opinar. Si la base lo tenía activo en el servidor viejo, el
historial llega con ella y permite comparar el mismo `query_id` antes y después del cambio de
motor. Corolario operativo: **activar Query Store es un requisito previo de la migración**, no una
mejora posterior — en las bases que no lo tenían, no existe línea base y ya no se puede fabricar.

> Y el que puede detener una base mientras se discute lo demás: comprobar
> `log_reuse_wait_desc = 'LOG_BACKUP'` el primer día. Si los jobs de respaldo de log no se
> recrearon, el log de cada base en `FULL` crece sin truncarse hasta llenar la unidad. Se
> comprueba en cinco minutos y fue el hallazgo de consecuencia más brusca del caso medido.

Relacionada con R-25 (configuración por defecto), R-28 (medir antes de concluir), R-06, R-14 y
R-19 (lo que el compat level habilita).

---

## R-37 · Una reescritura equivalente puede costar 48 veces más: mídela, no la razones [obs]

**Severidad:** media — pero se cobra en el momento peor, al entregar.

El catálogo insiste en demostrar que una reescritura **no cambia el resultado**. Esta regla es la
otra mitad: demostrar que **no cuesta más**. Son dos pruebas distintas y la segunda se olvida,
porque el cambio "se ve" mejor.

Caso medido. Un `NOT EXISTS` correlacionado llevaba dentro una condición de la tabla **externa**:

```sql
-- ORIGINAL
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.Historial h
    WHERE  h.col1 = t.col1
      AND  h.col2 = t.col2
      AND  t.Bandera = 1                      -- condición de la tabla EXTERNA, dentro
      AND  h.Fecha >= @Hoy AND h.Fecha < DATEADD(Day, 1, @Hoy))
```

Sacarla al predicado externo parece la limpieza obvia, y es **estrictamente equivalente** cuando
la columna es `NOT NULL` —conviene comprobarlo: con `NULL` permitido, `Bandera <> 1` es `UNKNOWN`
y el conjunto cambia—:

```sql
-- REESCRITURA "LIMPIA": equivalente, y 48 veces más lenta
WHERE (t.Bandera = 0 OR NOT EXISTS (SELECT 1 FROM dbo.Historial h WHERE ...))
```

Medido sobre la misma instancia, misma salida de 3 filas, dos ejecuciones cada una:

| Forma | Duración |
|---|---|
| Original, condición dentro | 179 ms |
| Solo el predicado de fecha hecho sargable | **154 ms** |
| Condición fuera, reformulada con `OR` | **7.311 ms / 7.540 ms** |

El `OR` impide resolver el `NOT EXISTS` como semi-join y el plan se degrada. Dato que remata el
caso: **las 85 configuraciones tenían `Bandera = 1`**, así que la rama nueva no aportaba nada ni
funcionalmente. Se descartó el cambio y se conservó la forma original.

> Una condición de la tabla externa dentro de un `EXISTS` no es un error: actúa como filtro de
> arranque y le permite al motor saltarse la sonda. Sacarla al `WHERE` con un `OR` es
> exactamente el movimiento que rompe el semi-join.

Método, que es lo que de verdad transfiere:

1. Ejecuta las dos formas **aisladas**, una detrás de otra, y anota la duración de cada una.
2. Desconfía de la primera medición: la caché favorece a la que corriste antes. Repite.
3. Si no puedes ver el plan —`SHOWPLAN` denegado es habitual en cuentas de solo lectura, error
   262—, la medición repetida sigue siendo prueba suficiente para **descartar** un cambio.
4. Un cambio descartado se documenta con su cifra. Es lo que evita que el siguiente lo reintente.

Relacionada con R-21 y R-32 (formas del semi-join), y con la regla transversal de `SKILL.md`:
ningún cambio de conjunto es mecánico.

---

## R-38 · Código ejecutable guardado como datos no existe para el motor [obs]

**Severidad:** media — alta cuando toca hacer un cutover.

Cuando la lógica vive en una **columna** y se ejecuta con `sp_executesql`, desaparece de toda la
instrumentación que usas para razonar sobre el esquema. No es una opinión de arquitectura: es una
lista concreta de cosas que dejan de funcionar.

Caso medido: un despachador ejecutaba **39 scripts** guardados como filas, de 10.453 a 81.543
caracteres cada uno. Los 39 escribían en dos tablas de 3,16 M y 7,7 M filas.

| Lo que preguntas | Lo que responde | Lo que es verdad |
|---|---|---|
| `sys.dm_sql_referencing_entities` sobre el despachador | **0 filas** | Lo llama un job cada hora |
| `sys.sql_modules` con `LIKE '%TablaCritica%'` | **1 objeto** | 39 scripts la escriben |
| Búsqueda de `DELETE` en el esquema | nada | 16 scripts tienen `DELETE` |
| Revisión de código sobre el repositorio | nada | ~1,2 MB de T-SQL ejecutable |

La consecuencia práctica muerde en el peor momento: **el mapa de dependencias previo a un
`sp_rename` sale limpio y es falso.** Y a diario, ese código no pasa por revisión, no tiene
historial, y cambia en producción con un `UPDATE`.

```sql
-- DETECCIÓN: columnas de texto que en realidad contienen T-SQL
SELECT TOP (50) OBJECT_NAME(c.object_id) AS tabla, c.name AS columna
FROM   sys.columns c
JOIN   sys.types  t ON t.user_type_id = c.user_type_id
WHERE  t.name IN ('varchar','nvarchar','text','ntext') AND c.max_length IN (-1, 8000)
ORDER  BY 1, 2;
-- Y sobre las candidatas, el conteo que lo confirma:
-- SELECT COUNT(*) FROM dbo.Tabla WHERE col LIKE '%SELECT%' AND col LIKE '%FROM%';
```

> Si no puedes sacar la lógica de la tabla, al menos **inventaríala**: cuántas filas, qué tablas
> tocan, cuáles escriben, cuáles traen cursores o `TRY/CATCH` propio. Ese inventario es el
> sustituto del mapa de dependencias que el motor no te va a dar, y se construye con `LIKE` sobre
> la columna en una sola consulta.

Al auditar un objeto que hace `sp_executesql` sobre contenido de tabla, el objeto **no es la
unidad de análisis**: lo es el objeto más su catálogo de scripts.

Relacionada con R-04 (la transacción que envuelve código que no puedes leer), R-11 (el `CATCH`
del llamado que anula el `@@ERROR` del llamador) y R-18 (parámetros como cadena).

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
| **[obs]** `=` **con** comodín: `col = 'PREFIJO%'` | El caso inverso al anterior, y el peligroso: compara por igualdad exacta contra una cadena que contiene `%`, así que solo coincide si el dato es literalmente `PREFIJO%`. **No da error, devuelve cero filas.** Medido: 0 coincidencias donde `LIKE` daba **39.988**, en una condición repetida 3 veces dentro del mismo objeto. Detección barata: `SELECT ... WHERE col LIKE 'x%'` contra `WHERE col = 'x%'` y comparar conteos. Mejor arreglo que `LIKE`: filtrar por el `int` del catálogo, que no depende de cómo se escriba el nombre |
| **[obs]** `DELETE`/`UPDATE` con `LEFT JOIN` y `WHERE col NOT IN (...)` | Doble fallo: cuando el `LEFT JOIN` no casa, `NULL NOT IN (...)` es `UNKNOWN` y la fila **no** se borra —el `LEFT JOIN` actúa como `INNER JOIN`—; y si la subconsulta devuelve un solo `NULL`, **no se borra nada en absoluto**, en silencio. Usar `NOT EXISTS` y decidir explícitamente qué pasa con las filas sin pareja |
