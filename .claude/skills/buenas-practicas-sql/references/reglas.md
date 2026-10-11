# Reglas T-SQL — cuerpo de la base de conocimiento

Cada regla salió de un problema real medido en código productivo. Ninguna es genérica de
manual: si está aquí es porque alguien la violó y costó algo.

**Los casos están anonimizados a propósito.** Se conserva el orden de magnitud en palabras
(«millones de filas», «decenas de segundos») porque es lo que justifica la severidad; se eliminan
las cifras exactas y los nombres de empresa, base, esquema y objeto. Ver la política en `SKILL.md`.

Marcas: **[obs]** observado en código auditado · **[gen]** anti-patrón general aún no visto aquí.

---

# Nivel 1 · Órdenes de magnitud

Explican la mayor parte del problema de rendimiento medido. Si solo se adopta una parte del
estándar, que sea esta.

## R-01 · Nunca envuelvas una columna en una función dentro de `WHERE` o `JOIN` [obs]

**Severidad:** crítica · **Impacto:** ×100 o más

El índice correcto suele **ya existir**; la función sobre la columna lo anula. En un caso
extremo observado: más de una decena de `REPLACE` anidados sobre una columna de texto, en tablas
de cientos de miles de filas, más de una decena de veces por llamada.

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
**cientos de miles de lecturas lógicas con la forma sargable y prácticamente las mismas con el
`ISNULL`**, sobre el mismo lote de decenas de miles de ejecuciones. Diferencia: despreciable. Se
aplica por forma y por legibilidad, no por rendimiento — y decirlo así en el informe evita
prometer una mejora que no llega.

**Sub-caso: la forma sargable de una fecha desplazada un año no es exactamente equivalente.**
Medido en un procedimiento de unas decenas de ejecuciones al mes y **varias horas cada una**
(decenas de horas de CPU al mes, decenas de miles de millones de lecturas) que filtraba tres
tablas con:

```sql
WHERE year(auditstarted) > 1900
  AND dateadd(YY, -1, CAST(auditstarted AS DATE)) < @Today
```

La reescritura sargable es `auditstarted >= '19010101' AND auditstarted < DATEADD(YEAR, 1, @Today)`.
Es equivalente **salvo el 29 de febrero**: `DATEADD(YEAR, -1, '29-feb-bisiesto')` devuelve el
28 de febrero, y la desigualdad puede diferir para filas cuya fecha sea 28/29 de febrero cuando
`@Today` cae en esos días. Dos consecuencias prácticas: la prueba de equivalencia (`EXCEPT` en
ambas direcciones) se ejecuta con `@Today` = hoy **y** con `@Today` = 29 de febrero del último
bisiesto; y si aparecen filas, cuál de las dos semánticas es la correcta es decisión de negocio,
que se documenta con etiqueta `N-xx` y no se resuelve en el parche.

## R-02 · No llames un procedimiento dentro de un bucle fila por fila [obs]

**Severidad:** crítica

Observado: un `WHILE` invoca un procedimiento de guardado una vez por fila. Cada llamada hacía
decenas de parseos de cadena, varias búsquedas que escanean tablas completas más de una decena
de veces, y más de una decena de DML sobre varias bases. El costo crece de forma catastrófica
con N.

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

**Sub-caso: con réplica síncrona, el bucle no solo quema CPU — multiplica los viajes de ida y
vuelta.** En una instancia con Always On en `SYNCHRONOUS_COMMIT`, cada `COMMIT` espera a que la
secundaria endurezca el log. Un bucle que hace varios `UPDATE` sueltos más un `INSERT` de bitácora
por iteración paga **una espera de red por cada uno**, porque cada sentencia suelta es su propia
transacción implícita.

Medido en una instancia así: `HADR_SYNC_COMMIT` era **una fracción pequeña pero constante** de
todas las esperas —millones de tareas, miles de segundos acumulados— es decir **unos milisegundos
por commit**. Un bucle con diez escrituras por iteración paga decenas de milisegundos de red por
iteración antes de hacer trabajo útil.

Esto cambia la prioridad del arreglo: agrupar las escrituras del bucle en operaciones de conjunto
al cierre del lote **quita CPU y latencia a la vez**, y no toca la lógica de negocio — suele ser el
cambio más barato de justificar de todo el rediseño. Comprobar siempre el modo de la réplica antes
de estimar la ganancia:

```sql
SELECT DB_NAME(drs.database_id) AS bd, ar.availability_mode_desc, ar.failover_mode_desc,
       drs.log_send_queue_size, drs.redo_queue_size
FROM sys.dm_hadr_database_replica_states drs
JOIN sys.availability_replicas ar ON ar.replica_id = drs.replica_id;
```

**Dos formas más de fila a fila, medidas en Query Store de producción.**

*(1) La función escalar en el `WHERE` se ejecuta por cada fila candidata, no por cada ejecución.*
Un procedimiento con miles de ejecuciones al mes devolvía **un puñado de filas en total** y
costaba **decenas de horas de CPU y decenas de miles de millones de lecturas**. Su `WHERE` llevaba
`AND dbo.fnEstaExcluido(@param, t.col) = 0`; la función —dos `SELECT` de existencia sobre una
tabla de excepciones— se ejecutó **miles de millones de veces** en el mes (decenas de horas de
CPU adicionales). En SQL Server 2016 una función escalar no se inlinea nunca y además serializa
el plan. La función devolvía 0 si y solo si no existía fila de dos tipos concretos para el par:
eso es exactamente un `NOT EXISTS (... WHERE tipo IN (a, b))`, que el optimizador ejecuta como
*anti semi join* **una vez por sentencia**. La equivalencia se demuestra leyendo la función (sin
efectos laterales, `ISNULL(…, 0)` en ambas ramas) y se verifica evaluando ambas formas sobre
**todos** los pares de la tabla y contando desacuerdos: debe dar 0.

*(2) `WHILE` con `INSERT INTO #t EXEC OtraBase.dbo.proc` por elemento.* Un procedimiento de
sincronización cargaba los pares (cliente, sitio) en una temporal y llamaba a un procedimiento
de otra base por cada uno: miles de ejecuciones del orquestador, **más de cien millones de
llamadas** al interior, decenas de horas de CPU. Cada llamada costaba una fracción de
milisegundo. La detección no está en el procedimiento que se ejecuta poco, sino en
`count_executions` de la **sentencia interior** en Query Store, que es donde aparece el número
real.

**Sub-caso medido — la repetición no está en el bucle, está entre lotes.** Un consumidor de cola
que agrupa por entidad *dentro* de cada corrida, pero cuyo productor inserta un movimiento por
cada documento asignado a la entidad: minutos después la misma entidad vuelve a entrar.
Medido en el historial: decenas de miles de movimientos para miles de entidades distintas, **casi
una decena de revisiones por entidad**, decenas en el peor caso, la mitad de las llamadas de cada
día repetidas sobre una entidad ya revisada ese día. La revisión era idempotente —calcula desde
el estado actual—, así que las repeticiones producían el mismo resultado. Se detecta con
`COUNT(*)` contra `COUNT(DISTINCT entidad)` por día en la tabla de movimientos. El arreglo es de
una sentencia (marcar procesados todos los pendientes de la entidad al revisarla), pero cambia
*cuándo* se recalcula: lo decide el dueño funcional.

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

**Variante engañosa, vista decenas de veces en varias bases: el trigger sí cuenta las filas, pero
no lo usa.** Un molde de auditoría `InsDelUpd*` empieza con `SELECT @Count = COUNT(*) FROM
inserted` —solo para decidir si la acción es I, U o D— y después hace `SELECT @OldID = id,
@Nombre = nombre FROM deleted` y escribe **una** fila en una tabla de auditoría de otra base.
Con un `UPDATE` de N filas, la auditoría guarda una y pierde N−1, sin error. Ver `@Count` en un
trigger no significa que esté protegido: hay que comprobar si se usa como guarda
(`IF @Count > 1 RAISERROR`) o como selector. Cuando el mismo molde se repite en decenas de
triggers es estilo del equipo, y se corrige con una plantilla set-based
(`INSERT INTO auditoria SELECT … FROM deleted`), no trigger a trigger.

## R-04 · Transacciones cortas: nunca envuelvan trabajo externo [obs]

**Severidad:** crítica

Observado: un `BEGIN TRAN` que abarca cientos de líneas, incluyendo un bucle completo con
llamadas a otros procedimientos y escrituras en varias bases distintas. Los locks se acumulan
durante toda la corrida sobre tablas de más de diez millones de filas.

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
decidirla SQL Server y pasa a decidirla un servidor web. Medido en Query Store: **decenas de
segundos de espera por bloqueo**, dos madrugadas consecutivas a la misma hora, mismo `query_id`.

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
sin pasar por revisión de código. Caso medido: un despachador de un par de cientos de líneas
abría transacción antes de su bucle y dentro ejecutaba hasta **decenas de scripts de decenas de
KB cada uno**, varios de ellos con cursores propios.

Y de ahí sale la señal que conviene interiorizar: **la duración deja de estar acotada por el
volumen.** Medido sobre las marcas de tiempo reales de las filas encoladas, en un mismo día:

| Corrida | Filas encoladas | Ventana de la transacción |
|---|---|---|
| Primera | miles | **casi una hora** |
| Segunda | — | más de media hora |
| Tercera | **una decena** | tres cuartos de hora |

Tres cuartos de hora de locks acumulados para encolar una decena de filas. Un `BEGIN TRAN` cuyo
coste no correlaciona con el trabajo útil no se ajusta: se acota, moviendo el `COMMIT` dentro del
bucle para que la unidad atómica sea una iteración y no la corrida entera.

> Antes de defender una transacción global, pregunta qué exige realmente ser atómico. «Todas las
> notificaciones o ninguna» casi nunca es un requisito de negocio: es lo que salió de poner el
> `BEGIN TRAN` en la primera línea.

## R-05 · `SELECT ... INTO #temp` en una consulta larga bloquea la instancia entera [obs]

**Severidad:** crítica

`SELECT INTO` crea el objeto dentro de la transacción de la consulta y **sostiene bloqueos
sobre las tablas de sistema de tempdb durante toda su ejecución**. Si la consulta se degrada,
esa sesión bloquea a cualquier otra sesión de la **instancia** —no de la base— que cree un
objeto temporal.

Observado en un procedimiento de menú de alta frecuencia: `SELECT` con decenas de joins
escribiendo directo a `#temp`. Señal a nivel servidor: `PAGELATCH_EX` y `LATCH_EX` con cientos
de millones de esperas acumuladas.

```sql
-- ANTI-PATRÓN
SELECT ...decenas de joins... INTO #Resultado FROM ...

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
después hacerle un `LEFT JOIN` contra las filas de un solo registro. Medido: **más de cien mil
filas** volcadas a tempdb en cada apertura de la pantalla, para resolver una media de **una
decena**.

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

**Sub-caso: el catch-all que no compara con una columna, sino que decide si una tabla filtro
participa.** La forma es distinta de las tres de arriba y por eso se cuela en revisión:

```sql
FROM dbo.VistaDePermisos v                       -- más de un millón de filas para el cliente grande
INNER JOIN dbo.TablaGrande t ON t.k1 = v.k1 AND t.k2 = v.k2
LEFT  JOIN #Filtro f ON t.k2 = f.id AND t.k1 = f.k1
WHERE  v.cliente = @cliente
  AND (@lista = '' OR f.id IS NOT NULL)          -- ← el catch-all
```

`#Filtro` trae unas decenas de filas de media y el `LEFT JOIN` + `IS NOT NULL` **ya es un
`INNER JOIN` semántico**. Pero el `OR` obliga a un plan único que sirva también para «sin filtro»,
así que `#Filtro` nunca puede ser el **lado conductor**: el plan arranca por la vista, arrastra el
universo entero del cliente y descarta al final. El daño no es un plan mal *sniffed*, es que el
filtro pequeño que ya está en la mano no se puede usar.

Medido sobre la misma instancia, misma salida de un puñado de filas, las dos formas aisladas:

| Forma | Lecturas lógicas | CPU | Duración |
|---|---:|---:|---:|
| Con el catch-all | **cientos de miles** | segundos | segundos |
| Ramas separadas, `#Filtro` conduciendo | **unas decenas** | un milisegundo | milisegundos |
| La segunda consulta del mismo objeto, con catch-all | **millones** | segundos | segundos |
| La misma, con ramas separadas | **unas decenas** | un par de milisegundos | milisegundos |

Cuatro y cinco órdenes de magnitud. El reparto de llamadas remata el caso: **la gran mayoría** de
las ejecuciones —casi todas— pasaba lista concreta de elementos, es decir **la gran mayoría
pagaba el plan de la minoría**.

Dos señales que delatan este sub-caso en revisión, ambas baratas de comprobar:

- Un `LEFT JOIN` a una tabla temporal cuyo `WHERE` incluye `IS NOT NULL` sobre esa misma tabla:
  es un `INNER JOIN` escrito al revés, y casi siempre hay un `OR` guardándolo.
- La consulta acumula recompilaciones sin mejorar. En el caso medido, **miles de compilaciones**
  del plan principal, con dos planes cacheados y **los dos malos** (cientos de miles de lecturas
  medias cada uno): no había un plan bueno que forzar, porque el problema era la forma de la
  consulta.

**Sub-caso medido — la proporción de señal de `SOS_SCHEDULER_YIELD` no mide presión de CPU.** Una
auditoría usó como control secundario «casi toda la espera de `SOS_SCHEDULER_YIELD` es señal», leído
como cola de CPU; la siguiente midió la utilización real con el anillo del scheduler
(`RING_BUFFER_SCHEDULER_MONITOR`, `ProcessUtilization` y `SystemIdle` por minuto) y el servidor estaba
por debajo de un cuarto de su capacidad en todo momento. La razón es estructural: esa espera se
produce cuando una tarea agota su cuanto y cede el scheduler voluntariamente, y el tiempo hasta que
vuelve es, por definición, casi todo señal. Dice cuánto trabajo largo de CPU hay, no si faltan
núcleos. El *signal wait* que sí informa es el de las esperas de bloqueo e I/O; para saturación de
CPU, el anillo del scheduler o los contadores del sistema operativo.

Y la manera de comparar el coste del instrumento con el de la aplicación es en **núcleos**, no en
horas acumuladas desde arranques distintos: dos fotos del plan cache separadas por unas horas dan el
delta de CPU y el de ejecuciones, y de ahí sale el ritmo (CPU por hora, intervalo entre
ejecuciones); Query Store da el consumo de la aplicación en las mismas 24 h. En el caso medido el
colector salía a media unidad de CPU permanente —más que las bases principales juntas— y su
frecuencia no había cambiado entre una auditoría y la siguiente.

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

**Las dos consecuencias, medidas.** Sobre una tabla de millones de filas y un par de GB, el valor
centinela concentraba **cientos de miles de filas** frente a una media de **una decena por
identificador real**:

1. **Escalada de lock a tabla.** Cientos de miles de locks de fila rebasan el umbral de escalada
   (~5.000): el motor los sustituye por un lock exclusivo sobre **la tabla completa**, retenido
   hasta el `COMMIT`. Con RCSI apagado, todo lector queda detrás. Verificar la política antes de
   descartarlo: `sys.tables.lock_escalation_desc` valía `TABLE`.
2. **Pérdida silenciosa de datos.** La sentencia inactivó filas que nadie pidió inactivar. Se
   detectó porque el `UPDATE` defectuoso ponía `Inactive = 1` **sin** rellenar `InactiveDate`,
   mientras que una baja de usuario sí la rellena: **prácticamente todas** las filas del cajón
   tenían esa firma, y ninguna quedó activa.

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
**más de un millón de filas** con decenas de lotes:

| Alcance del `UPDATE` | Filas |
|---|---:|
| Previsto — un lote, solo activas | **miles** |
| Real — la rama `OR` sin filtrar | **decenas de miles** |
| De ellas, con `Inactive = 1` | **más de la mitad** |
| Lotes alcanzados | **todos** |

Un orden de magnitud por encima del alcance previsto, en un proceso diario, **sobrescribiendo
columnas en vez de insertar filas** — así que no deja rastro propio y no hay forma de saber
cuántas veces ocurrió. La firma que sí queda: filas marcadas como inactivas con columnas que solo
ese `UPDATE` escribe.

> **Regla práctica:** en el `WHERE` de un `UPDATE` o un `DELETE`, **cualquier `OR` va entre
> paréntesis, sin excepción**. No es estilo: es la diferencia entre una condición alternativa y una
> puerta trasera que se salta todos los filtros de alcance. Y al revisar, no basta con comprobar que
> los filtros de alcance *están* — hay que comprobar que son *obligatorios*.

**El agravante que lo mantuvo invisible.** En el mismo `WHERE`, la condición `o.TipoNombre =
'PREFIJO%'` usa `=` contra una cadena con comodín: coincide con **ninguna fila** donde `LIKE`
coincidiría con **decenas de miles**. Los dos defectos se tapan mutuamente. El de precedencia
ampliaba el alcance de la escritura; el del operador apagaba la única condición que habría hecho
útil esa ampliación, de modo que el resultado nunca fue lo bastante raro como para que alguien lo
mirara. **Cuando encuentres uno de los dos, busca el otro en la misma cláusula.**

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

**Severidad:** alta · **Impacto:** un orden de magnitud medido, y crece con la tabla

La columna no va envuelta en ninguna función (R-01), la consulta es de tres tablas y el `JOIN`
parece trivial. Aun así hay un scan. El motivo es más simple y se pasa por alto justo por eso:
**se filtra por la segunda columna de una clave compuesta sin aportar la primera**.

```sql
-- La tabla: millones de filas, más de una decena de índices, PK clustered (colA, colB)
-- Ninguno de ellos encabeza por colB.

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

Medido: **decenas de miles de lecturas lógicas para devolver una fila**, contra unas pocas con el
predicado completo. En reloj de pared, **de cientos de milisegundos a decenas**, resultado
idéntico. Coste estimado del plan: entre el umbral de paralelismo por defecto y el recomendado.

**Dos señales que lo delatan sin abrir el plan.** Un número de índices alto sobre la tabla
(aquí más de una decena) invita a suponer que "alguno servirá", y es precisamente lo que impide
mirar cuál encabeza por la columna del filtro. Y un `JOIN` cuya tabla **no aporta ninguna columna
al `SELECT`**: es un `EXISTS` disfrazado (R-21), y su coste no lo paga la salida sino el acceso.

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
bastante para calificar a paralelismo y repartirse en varios hilos: algo más de cien milisegundos
de media durante más de un millar de ejecuciones. Al subir el `cost threshold` de la instancia a
50 —un cambio correcto, ver R-25— la sentencia dejó de calificar y pasó a plan serial: **cientos
de milisegundos, más del doble de lenta**, sin que nadie hubiera tocado el código. Query Store
guardaba los dos planes con sus ventanas de fechas.

> **No revertir el parámetro.** Devuelve la cifra a su sitio y vuelve a gastar varios núcleos en
> una consulta que devuelve una fila. El arreglo es el predicado; con él, la sentencia deja de
> depender de cómo esté configurado el paralelismo.

**Cómo se demuestra la equivalencia cuando el `JOIN` sobrante es un filtro de existencia.**
Añadir la columna que falta **restringe** el conjunto, así que las dos versiones **sí difieren**
en la consulta aislada — medido: una fila contra ninguna. Comparar ahí da un falso negativo y
frena una reescritura correcta. Hay que comparar **a nivel del resultado observable**: en el caso
medido, el único consumidor de la tabla temporal ya filtraba por las dos columnas, de modo que la
diferencia nunca alcanzaba ningún dato. La comprobación se hace en dos niveles —productor y
consumidor— y se registran los dos.

Y no era un caso de laboratorio: **más de un millón de valores de `colB` aparecían bajo más de un
`colA`**. Cuando la divergencia es masiva, verificar solo el productor no es conservador: es
equivocarse.

**La variante silenciosa: la columna está en el índice, pero como `INCLUDE`.** El predicado sí
aporta el prefijo de la clave —una columna de tipo— y el optimizador hace un *Index Seek*, así
que el plan parece sano. Pero la columna del `JOIN` es columna incluida, no de clave: el seek
devuelve **todas** las filas del tipo (más de un millón, medidas) y el `= P.valor` se aplica
después como filtro bitmap antes de un *Hash Match*. Medido: **cientos de milisegundos de CPU y
miles de lecturas por llamada para devolver cero filas**, decenas de miles de llamadas en pocos
días, cerca de un tercio del coste de un procedimiento de miles de líneas; y cientos de miles de
ejecuciones al mes en producción. La detección de arriba se completa con una segunda pregunta:
¿la columna del `JOIN` es **clave** o **incluida**? (`ic.is_included_column`). El arreglo es un
índice con la columna como segunda clave; la sentencia no cambia y no necesita verificación de
equivalencia.

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

**Bug de duplicados.** Observado: decenas de lecturas con `(NOLOCK)`; varias eran
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

Patrón medido, en una cola de envío de correo de **millones de filas**:

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
propia transacción, ejecutaba decenas de pasadas sobre una tabla de decenas de millones de filas
y hacía `COMMIT`. Leído de arriba abajo el código parece cerrar pronto. En realidad **nada se
libera** hasta el commit externo, bastante más abajo en el código.

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
`@@ERROR` vale 0 y el despachador reporta éxito. Medido: **una parte** de los scripts de un
catálogo tenían `TRY/CATCH` propio. El job terminaba informando de que todo se había ejecutado
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
cientos de filas de detalle por llamada, añadir `ORDER BY` para hacerlo determinista pasó de
sub-segundo a **timeout de decenas de segundos** en un lote grande de ejecuciones.

Antes de "arreglar" un `TOP 1`, comprueba **cuántas filas puede devolver de verdad**. En ese
mismo caso, todas las entidades con actividad mapeaban a **exactamente un** valor cada una: el
no-determinismo era teórico. Cuando ese es el escenario, la respuesta correcta no es un
`ORDER BY` caro sino una **restricción de datos** que garantice la unicidad —o dejarlo
documentado como riesgo conocido, con la cifra que lo acota—. Un arreglo que multiplica el
coste por más de un orden de magnitud no es un arreglo.

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

Mientras el mapeo sea 1:1 las dos coinciden y **nadie lo nota nunca**. Medido, no lo era: **una
parte apreciable de los valores de origen tenían más de un destino activo**, uno de ellos con
**más de un centenar**, todos con el mismo tipo y el mismo catálogo —añadir un filtro no
desambigua—. Consecuencia ya presente en los datos: **una fracción pequeña pero real de los
registros tenía un valor distinto en cada tabla**, y para un único origen la tabla A había
llegado a escribir **varios identificadores diferentes** según el registro.

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

Observado: un procedimiento de más de dos mil líneas con **varios** bloques `BEGIN TRAN` y
**cero** apariciones de `XACT_ABORT`. Declaraba `SET ARITHABORT ON` dos veces seguidas y
`SET NOCOUNT ON` —alguien pensó en las opciones de sesión— pero no la que importaba. Es el patrón
habitual: no se omite por criterio, se omite porque no está en la plantilla con la que se copió
el objeto.

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
encadena una decena de `EXEC` anidados; los hijos **sí** lo activan.

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
forzaba la respuesta negativa aunque la entidad tuviera trabajo válido cargado. Sobre **más de
cien mil entidades**, **miles** respondían que no por esa condición y **casi todas ellas**
habrían cambiado de respuesta con el filtro aplicado — un **porcentaje pequeño pero real** del
padrón. El defecto era anterior al ticket (la condición nunca filtró ni el primer estado), pero
el ticket la dejó contradiciendo su propio enunciado.

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
nada** — y en el caso observado `D` recorría una tabla de decenas de millones de filas para eso.
De las consultas del procedimiento, **casi la mitad** no influían en el resultado.

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

**Tercera observación: la rutina de respaldo existe, y su lista no incluye las bases que llegaron
después.** Tras cerrarse el hallazgo anterior con una rutina externa que respaldaba el log cada
pocas horas, la siguiente auditoría midió la cobertura por diferencia —bases en `FULL` sin un
respaldo de log en las últimas 24 h— y aparecieron dos: las que habían entrado al grupo de
disponibilidad por un sembrado manual el mismo día en que se configuró la rutina, y que no estaban
en su lista. Días con `log_reuse_wait = LOG_BACKUP`, el log al borde del 100 % y crecimientos
configurados en pasos de decenas de GB replicados síncronamente. Dos lecciones: «hay respaldos» se
comprueba por diferencia, no por existencia (`sys.databases` en `FULL` menos `msdb.dbo.backupset`
con `type = 'L'` en 24 h, y `log_reuse_wait_desc` como confirmación); y un respaldo de log tomado
fuera de la rutina forma parte de la cadena, así que el puente se deja en la misma carpeta y con el
mismo patrón de nombre, o rompe la restauración que la rutina supone.

## R-36 · `READPAST` en una escritura salta filas en silencio [obs]

**Severidad:** alta

`READPAST` en una lectura de cola es idiomático: sirve para que varios trabajadores tomen lotes
distintos sin pisarse. En una **escritura** cambia de significado y casi nadie lo nota: el motor
no espera a las filas bloqueadas ni falla — **las omite**, y la sentencia informa un
`@@ROWCOUNT` menor sin ningún aviso.

Caso observado, en un procedimiento de cola disparado periódicamente por un planificador externo
sobre una tabla de **decenas de miles de filas**:

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

**La variante sin guard: la fila no detiene la cola, desaparece.** Medido en un proceso por lotes
que escribe el estado «en proceso» en la tabla física *antes* de llamar al procedimiento hijo, y
cierra las filas al terminar por `JOIN` con una tabla temporal que solo contiene el lote en curso.
Si el lote muere a medias —job detenido a mano, failover, error dentro del propio `CATCH`— la fila
queda en el estado intermedio, la selección siguiente exige el estado inicial, y ningún módulo de
la base la vuelve a mirar: una fila llevaba varios días así, sin `SPID`, sin fecha, sin error, y
sin aparecer en ningún reporte de pendientes. La vigilancia de arriba aplica igual; el arreglo es
un paso de recuperación al inicio del proceso («intermedio con más de N horas y sin sesión activa
vuelve a inicial»), y como cambia el reparto de trabajo, lo decide el dueño funcional.

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
> filas**. En un caso observado la tabla de linkeo los tenía (unas cuantas filas más que claves
> distintas) y el join habría duplicado inserciones. Usa `OUTER APPLY ... TOP 1` cuando no
> puedas garantizar unicidad.

**Sub-caso medido — la UDF aparece dos veces en el plan cache, y la segunda es la que asusta.**
Una consulta de una base de reporting llamaba a una función escalar declarada en **otra base**
desde su lista de `SELECT`. En `sys.dm_exec_query_stats` conviven dos filas:

| Fila | Ejecuciones | CPU total | Lecturas |
|---|---:|---:|---:|
| La consulta padre | **1** | minutos | más de cien millones |
| El cuerpo de la UDF | **decenas de miles** | minutos | más de cien millones |

**Una sola ejecución de la consulta padre se abrió en decenas de miles de ejecuciones de la
función, en unos minutos**, a unos miles de lecturas cada una. Las lecturas de la segunda fila
son prácticamente las mismas de la primera: no son costes que se sumen, es el mismo trabajo
visto desde dentro.

> Al ordenar el plan cache por CPU, una fila con un número de ejecuciones desproporcionado
> respecto a las demás y un texto que parece un fragmento suelto —`SELECT TOP 1 @variable = …`—
> casi siempre es el cuerpo de una UDF escalar. Buscar ese `@variable` en `sys.sql_modules`
> identifica la función; `sys.objects.type_desc = 'SQL_SCALAR_FUNCTION'` lo confirma.

Comprueba el compat level antes de estimar la ganancia: con 130 no hay inlining y la reescritura
es la única salida.

**Tercera reproducción, y la lección es que compat 160 tampoco garantiza el inlining.** El mismo
patrón volvió a aparecer en otra instancia, con cifras que se parecen hasta dar algo de
vértigo: **decenas de miles** de ejecuciones del cuerpo de la función en **unos minutos** —varios
cientos por segundo— y más de cien millones de lecturas, frente a **una** ejecución de la
consulta padre con prácticamente las mismas lecturas y minutos de CPU. Otra vez las lecturas de
la función son prácticamente las de la consulta que la llama.

Lo nuevo: la base padre estaba a **compat 160**. El *inlining* automático estaba disponible y
aun así **no se aplicó** — las decenas de miles de ejecuciones separadas son la prueba. El
inlining tiene una lista larga de descalificadores, y aquí concurrían dos candidatos: la función
estaba declarada en **otra base** y su cuerpo era un `SELECT TOP 1 @variable = …`.

> No des el inlining por hecho por leer el compat level. Confírmalo:
> `SELECT name, is_inlineable FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id`.
> Si vale `0`, subir la versión no va a arreglar nada y la reescritura sigue siendo la salida.

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
apoyo tenía **decenas de referencias** en el esquema — cifra que asusta y frena la reescritura
hasta que se mira de cerca: entre ellas había sufijos `_BkUp`, `_notused`, `_Test`,
`_Preliminary`, `_prueba` y varias con fecha en el nombre. **El alcance real de un cambio así
casi siempre es mucho menor que el que devuelve el catálogo**; sepáralo con
`sys.dm_exec_procedure_stats` y Query Store antes de dimensionar el trabajo.

**El descarte que ahorra semanas: no son los índices.** Las cinco tablas que recorría la cadena
eran pequeñas —ninguna pasaba de decenas de miles de filas— y tenían los índices exactos que los
predicados necesitaban. El coste no estaba en lo que valía una llamada, sino en cuántas se
hacían. Antes de proponer un índice, comprueba el tamaño de lo que se recorre: si es pequeño y
está indexado, el problema es el número de invocaciones y ningún índice lo va a arreglar.

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

Medido sobre datos reales, con `EXCEPT` en ambas direcciones y **0 diferencias** en miles de
casos:

| Versión | Filas resueltas | Duración | Por fila |
|---|---:|---:|---:|
| escalar | miles | decenas de segundos | milisegundos |
| de conjunto | decenas de miles | **menos de un segundo** | microsegundos |

Un orden de magnitud más filas en un tiempo dos órdenes de magnitud menor.

> ⚠️ **No es un reemplazo transparente.** Una función escalar se invoca `dbo.F(x) = 1`; una
> inline, `OUTER APPLY dbo.F_v2(x)`. **No se intercambia con `sp_rename`**: hay que editar cada
> llamador, y cada edición necesita su propio respaldo y su propia verificación. Convertir la
> función quita la serialización del plan; la ganancia grande está en dejar de llamarla una vez
> por fila. Son dos cambios distintos y conviene no confundirlos al estimar.

**Sub-caso medido — el inlining está activo y no alcanza a ninguna.** Base en compat 160 con
`TSQL_SCALAR_UDF_INLINING = 1`, y las cinco funciones escalares de un procedimiento con
`is_inlineable = 0` en `sys.sql_modules`: variables de tabla, `SELECT TOP 1 … ORDER BY`, ramas
`IF`. Se ejecutan fila a fila, y además **anidadas tres niveles**: una función por entidad llama
en el `ON` de un `JOIN` a otra por actividad, que llama en tres `INSERT` a otra por documento.
`sys.dm_exec_function_stats` lo cuenta por separado: miles de llamadas de decenas de
milisegundos, decenas de miles de unos milisegundos y millones de microsegundos. Antes de asumir
que 2019+ resuelve las UDF escalares, consultar `is_inlineable`; si es 0, la regla aplica igual
que en 2016. Y una función de cifrado de otra base en la lista del `SELECT`, **ocho veces por
fila**, es la misma regla con otro nombre.

**Sub-caso medido — `is_inlineable = 1` tampoco lo garantiza: la incorporación se decide en cada
sentencia llamadora.** Base en compat 160, `TSQL_SCALAR_UDF_INLINING = ON` y una función escalar con
`is_inlineable = 1` en `sys.sql_modules`; aun así la función aparecía **como módulo propio** en Query
Store y en el plan cache, con su propio conteo de ejecuciones y sus propias lecturas —segundos de CPU
por llamada—, lo que solo puede ocurrir si se ejecuta sin incorporar. El llamador la invocaba en la
lista del `SELECT` de un `INSERT` sobre una variable de tabla. La comprobación definitiva no es la
columna del catálogo sino la presencia del cuerpo de la función como objeto separado en
`sys.query_store_query.object_id` o en `sys.dm_exec_query_stats`: si está, no se incorporó, valga lo
que valga `is_inlineable`. Y el coste unitario de la llamada era de esquema: filtraba una tabla de
millones de filas por una columna por la que no empezaba ningún índice, así que cada llamada recorría
un índice de cientos de MB. El índice arregla el coste unitario; la incorporación, si algún día
ocurre, es un extra con el que no hay que contar.

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

**Sub-caso medido — la convención existe, y justo por eso el hueco no se ve.** Un procedimiento de
miles de líneas creaba una veintena de tablas temporales y les añadía media docena de índices, todos
colocados con criterio: después de poblar la tabla y sobre las columnas por las que se filtra. Una
sola se quedó sin ninguno, y era la que participaba en el `JOIN` de la sentencia más cara del módulo.
En revisión, un objeto donde la práctica está aplicada correctamente en seis sitios no levanta
sospecha en el séptimo: la ausencia se lee como decisión. La comprobación que lo cierra es mecánica,
y conviene hacerla siempre que un plan muestre `Table Scan` sobre un `#temp`: listar las temporales
del módulo, listar los índices que se les crean, y restar.

> **Y una señal de detección que no cuesta nada: `avg_rowcount` igual a cero.** En Query Store, una
> sentencia cara cuya media de filas devueltas o afectadas es cero está haciendo trabajo que no
> produce salida. No prueba que sobre —puede ser correcta y no encontrar coincidencias en estos
> datos—, pero es el filtro más barato para encontrar cómputo desperdiciado: ordenar por duración y
> mirar esa columna. En el caso medido, la sentencia que consumía la mayor parte del procedimiento
> llevaba días sin marcar una sola fila, en decenas de ejecuciones y con planes distintos.

## R-17 · `UNION` deduplica; usa `UNION ALL` salvo que necesites lo contrario [obs]

Observado en una vista de permisos: `UNION` de dos ramas de decenas de millones de filas cada
una = un sort de deduplicación de decenas de millones de filas por cada referencia, y la vista
se referencia varias veces.

> ⚠️ **El cambio no es automático.** Solo es equivalente si los conjuntos son disjuntos.
> Verifícalo con datos antes de cambiarlo, o duplicarás filas.

Caso real de por qué importa: en un procedimiento auditado, una rama del `UNION` **dependía**
de la deduplicación para colapsar filas hermanas que proyectaban el mismo padre. Cambiarlo a
`UNION ALL` habría duplicado entradas visibles al usuario. La equivalencia se demostró primero
y el `DISTINCT` se hizo explícito en esa rama.

## R-18 · No pases parámetros como cadenas «clave=valor» [obs]

Observado: decenas de llamadas a un parser por cada invocación de un procedimiento, cada una
re-escaneando la misma cadena de miles de caracteres. Multiplicado por N filas del bucle.

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

**Sub-caso medido — compat 150+ no salva la table variable, y conviene no prometerlo.** La
*deferred compilation* llegó en compat 150, pero corrige menos de lo que su nombre sugiere:
difiere la compilación hasta la primera ejecución y estima **una sola vez**, con la cardinalidad
de esa primera vez. No hay estadísticas, no hay recompilación por cambio de volumen, y no hay
nada que corrija la estimación en las ejecuciones siguientes.

Medido en una base a **compat 160**, es decir con todo activado:

| Métrica | Valor |
|---|---:|
| Ejecuciones | decenas |
| CPU media | **minutos** por ejecución |
| Duración media | minutos |
| Lecturas medias | **millones** por ejecución |
| CPU total | más de una hora — la sentencia más cara de toda la instancia |

Era un `INSERT INTO @tabla (…)`. La CPU es **varias veces** la duración: plan paralelo (ver
R-34, sub-caso de la firma inversa). Una inserción en table variable no necesita varios hilos;
se fue a paralelo porque la estimación estaba equivocada por órdenes de magnitud, y el
paralelismo multiplicó el coste de un plan que ya era el equivocado.

> Al estimar la ganancia de subir el compat level, **no cuentes las table variables como
> resueltas**. La tabla temporal `#` sigue siendo el arreglo: es lo único que aporta
> estadísticas. Si la variable es un parámetro con valores de tabla y no se puede cambiar,
> `OPTION (RECOMPILE)` en la sentencia que la consume es el parche, no el arreglo.

## R-20 · No unas a un grano más fino que el de la salida [obs]

Si unes a granularidad de detalle y luego colapsas con un `GROUP BY` de N columnas sin
agregados, estás multiplicando filas para volver a dividirlas.

Señal: un `GROUP BY` largo sin `SUM`/`COUNT`/`MAX` está haciendo de `DISTINCT`, y casi siempre
delata un fan-out innecesario aguas arriba.

Arreglo: busca la tabla que **ya** está al grano de salida y conduce la consulta desde ella;
convierte el resto en `EXISTS`. Caso observado: unir a una tabla de decenas de millones de filas
por 5 columnas incluyendo la de detalle, cuando existía una tabla de unos cientos de filas ya al
grano correcto. El `GROUP BY` de 19 columnas desapareció con ella.

**Contraejemplo medido: el arreglo no es automático.** El mismo movimiento —conducir desde la
tabla pequeña y convertir el detalle en `EXISTS`— aplicado a un `TOP 1` que resolvía un
identificador salió **peor**: **un tercio más de lecturas lógicas y de CPU** que la versión
original, sobre un lote idéntico de miles de ejecuciones. El motivo: conducir desde una tabla de
decenas de filas obliga a **decenas de sondas semi-join por llamada**, mientras que la forma
original hacía un solo `seek` por la clave y recorría secuencialmente un *fan-out* acotado que
un índice ya cubría.

> La regla aplica cuando el fan-out se **colapsa** después (un `GROUP BY` que hace de
> `DISTINCT`). Cuando la consulta ya se corta sola —`TOP 1`, `EXISTS`— el fan-out está acotado
> y darle la vuelta puede multiplicar el trabajo. **Mide antes de reescribir, y mide con
> lecturas lógicas:** el reloj de pared no distingue estas dos formas bajo carga concurrente.

**Cómo saber, objetivamente, que una consulta se le ha ido de las manos al optimizador.** No
hace falta contar `JOIN`s a ojo: el plan lo declara. `StatementOptmEarlyAbortReason = TimeOut`
significa que el optimizador **agotó su presupuesto de búsqueda** y entregó el mejor plan que
tenía a mano, no el mejor plan. Medido en un `INSERT` que unía ~25 tablas con `CROSS APPLY`,
`UNION ALL` y un `GROUP BY` de 30 columnas: compilar costaba **cientos de milisegundos y más de
diez MB**, y en ejecución gastaba **decenas de milisegundos de CPU sobre un transcurrido apenas
mayor, con solo unos cientos de lecturas lógicas** —es cómputo, no E/S— con un *grant* de
memoria de decenas de MB para devolver del orden de una fila.

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
> compilación se amortiza si el plan se reutiliza (cientos de milisegundos repartidos entre más
> de mil ejecuciones es menos de un milisegundo por ejecución); comprueba cuántos planes tiene la
> consulta antes de culpar a la compilación.

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
`uniqueidentifier` en una tercera de varios GB y millones de filas. Unirlas obliga a convertir
en cada fila. Coste medido sobre el mismo corte de datos: **varias veces más lento** con
conversión que entre las dos tablas que sí comparten tipo.

Lo que convierte esto en un hallazgo de modelo y no solo de rendimiento: **no existía ninguna
clave foránea entre las tres**. La relación se sostenía por convención. Se verificó con una
muestra de decenas de miles de filas que la conversión empareja **casi todo** — el resto eran
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
> deadlocks. En un entorno medido, el ring buffer cubría **minutos** y el archivo **un par de
> semanas** —una fracción del uptime— porque casi todos sus eventos eran errores de seguridad.
> Un result set vacío ahí **no significa que no hubo deadlocks**. Antes de concluir nada, mide
> la ventana real: R-28.

Mitigadores cuando el reordenamiento no es viable: acortar la transacción (R-04), índices que
conviertan scans en seeks (menos filas bloqueadas), y `UPDLOCK` en el patrón
leer-para-actualizar dentro de la misma transacción.

---
# Nivel 4 · Esquema e instancia

## R-23 · Un índice de más también cuesta [obs]

Observado: una tabla de cabecera con **decenas de índices**; otra con más de una decena, varios
casi idénticos. Cada `INSERT` mantiene todas esas estructuras — y los escritores lentos son
exactamente quienes bloquean a los lectores.

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
antes de crear nada. Y valida su cifra de impacto contra la selectividad real (R-40).

**El coste que no se ve: un índice muerto sigue influyendo en los planes a través de sus
estadísticas.** El optimizador usa cualquier estadística que cubra una columna para estimar
cardinalidad, la use o no el plan final. Así que un índice con un puñado de seeks en meses no
solo cuesta escrituras: su histograma —vencido, porque nada lo recompila, ver R-40— puede ser la
fuente de la estimación de un predicado en consultas que ni lo tocan.

Medido: un índice sobre una columna bandera, un puñado de seeks, histograma de **dos pasos**
construido sobre una muestra mínima de las filas hace **meses**. La estimación del predicado
sobre esa columna salía de ahí. Es un argumento adicional para retirarlo, y uno para no crear
índices «por si acaso»: cada uno añade una estadística más que mantener y una fuente más de
estimaciones malas.

## R-24 · Ninguna tabla grande debe ser un HEAP, y ninguna bitácora debe crecer sin límite [obs]

Observado: las tablas más grandes del entorno eran heaps sin índice clustered — una bitácora de
decenas de GB, otras de decenas de millones de filas. Sufren *forwarded records*: un salto de
I/O extra por lectura, permanente, que solo se limpia con `REBUILD`. Y el espacio de filas
borradas no se recupera. Ninguna tenía política de retención.

> Toda tabla con crecimiento sostenido lleva índice clustered (normalmente por fecha, o por la
> clave de acceso natural). Toda tabla de bitácora **nace** con su política de archivado
> definida — no después.

Detección: `sys.dm_db_partition_stats` sin fila con `index_id = 1`. Antes de convertir, medir
`forwarded_record_count` con `sys.dm_db_index_physical_stats(..., 'DETAILED')` fuera de horario
pico.

**Sub-caso medido — el heap que ocupa decenas de veces lo que contiene, y la división que lo
delata.** En una base de cientos de GB, la segunda tabla más grande ocupaba **decenas de GB con
unos cientos de miles de filas**: millones de páginas **casi vacías**. No tenía columnas LOB. La
comprobación que lo destapa es una división, no una DMV:

```sql
SELECT Filas, Paginas, BytesPorFila = Paginas * 8192.0 / Filas
```

**Diez veces el máximo de 8.060 bytes que cabe en una fila de SQL Server.** Es aritméticamente
imposible que sean datos: solo pueden ser páginas que el heap nunca devolvió tras borrados
anteriores. Confirmación con `avg_page_space_used_in_percent` en modo `SAMPLED` — el modo
`LIMITED` devuelve `NULL` en esa columna y no sirve.

El coste no es solo disco: contar esos cientos de miles de filas tardó **decenas de segundos**,
porque el motor recorre millones de páginas. Un `REBUILD` las deja en una fracción mínima. Tres
heaps del mismo entorno sumaban **decenas de GB de aire** y millones de *forwarded records*; el
conjunto eran cientos de heaps con más de cien GB.

> **La consecuencia que rompe planes de trabajo:** una poda por antigüedad sobre un heap **no
> libera ni un byte** sin `ALTER TABLE ... REBUILD` después. Las filas desaparecen y el archivo
> mide lo mismo. Si un plan de reducción de datos no incluye ese paso, su estimación de ahorro es
> ficción.

Y antes de planificar el corte, **verifica que la columna de fecha está poblada**: en la misma
base, una bitácora de **decenas de millones de filas** tenía su única columna de fecha en `NULL`
en **todas** ellas. Cortar por ella no habría borrado nada. Una sola consulta lo descarta:

```sql
SELECT COUNT(*) AS Total,
       SUM(CASE WHEN Fecha IS NULL THEN 1 ELSE 0 END) AS Nulas,
       MIN(Fecha) AS Minima, MAX(Fecha) AS Maxima
FROM   dbo.Bitacora;
```

Esa misma consulta destapó, en otra tabla del dominio, fechas de **1900** y de **milenios en el
futuro** conviviendo: un corte por antigüedad habría borrado las primeras —probablemente
registros válidos sin fecha poblada— y conservado las segundas para siempre.

**Y no des por hecho que el peso está donde están las filas.** La mayor de todas —decenas de
GB— tenía unos millones de filas y **casi todo su peso en unidades de asignación LOB**: decenas
de KB de HTML por fila. Con `allocation_units.type = 2` se separa en una consulta lo que es fila
de lo que es LOB, y cambia por completo qué técnica de borrado conviene: ahí el coste está en
mover el LOB, no en el log de transacciones.

**El heap más caro puede ser pequeño.** Una tabla de cientos de miles de filas y **unas decenas
de MB sin ningún índice** —ni agrupado ni no agrupado— era borrada por dos columnas **millones
de veces al mes** por un orquestador que se ejecuta una vez por muestra: decenas de milisegundos
cada `DELETE`, **días de CPU** en escanear unas decenas de MB. Sus tablas hermanas estaban
agrupadas por esas dos columnas, y una de ellas tenía **más de una decena de índices**, varios
con una docena de columnas de clave y con cero lecturas: el mismo equipo indexa de más y de
menos según la tabla. La detección es `sys.indexes` con `index_id = 0` cruzado con
`count_executions` de las sentencias que la tocan en Query Store, no el tamaño.

**Y la magnitud en una instancia entera**, para calibrar: **miles de heaps y cientos de GB** en
decenas de bases, incluidos una bitácora de decenas de GB (casi todo LOB), una tabla de decenas
de millones de filas con fragmentación alta y la clave primaria como índice **no agrupado**, un
histórico de decenas de millones de filas leído por el procedimiento de horas por ejecución, y
una base de importación que era **más de un centenar de heaps y decenas de GB** sin un solo
índice agrupado. `IndexOptimize` no toca heaps: nada de eso se desfragmenta nunca por
mantenimiento.

**Sub-caso medido — el sondeo sobre un heap: miles de páginas por cero filas, cada pocos segundos.**
El objeto de negocio con más CPU acumulada de una instancia entera no era un procedimiento complejo
sino una consulta correcta —tres igualdades y un `ORDER BY` por la identidad— que una aplicación
lanzaba cada pocos segundos para preguntar «¿hay algo pendiente para este par de identificadores?»
sobre una tabla de cientos de miles de filas **sin ningún índice**, ni agrupado ni no agrupado. La
práctica totalidad de las filas estaba en el estado final y solo unas decenas en el pendiente, así
que cada pregunta recorría toda la tabla para devolver, de media, **cero filas**. La firma en Query
Store es inconfundible y barata de buscar: ejecuciones altas, lecturas medias en los miles y
`avg_rowcount` igual a cero. El índice vale precisamente porque la respuesta es vacía: un seek que no
encuentra nada cuesta dos o tres páginas. Y no conviene hacerlo filtrado por el estado si ese estado
llega en una variable local leída de una tabla de configuración —el optimizador no empareja un índice
filtrado con una variable sin `OPTION (RECOMPILE)`—; un índice normal con el estado como primera
columna da el mismo resultado sin esa dependencia.

Segundo heap del mismo caso, la variante que se degrada sola: una cola de comandos cuyo resultado se
escribe en un `varchar(max)` tras cada ejecución, con **casi una cuarta parte de sus registros
reenviados**; el `IF EXISTS` por estado que la sondeaba cada minuto leía el doble de páginas de las
que la tabla ocupaba, porque pagaba cada reenvío. Un índice por el estado resuelve el sondeo; solo la
clave agrupada evita que cada `UPDATE` vuelva a reenviar.

## R-25 · La configuración por defecto de la instancia no es la correcta [obs]

Observado: `cost threshold for parallelism = 5` —el default de fábrica desde 1998— y
`MAXDOP = 0`. Con eso se paraleliza hasta lo trivial y una sola consulta puede acaparar todos
los schedulers: **una parte notable de las esperas del servidor**. También Change Tracking con
365 días de retención, que resultó ser el mayor consumidor de CPU de la instancia.

> Al montar cualquier instancia, revisa: `cost threshold for parallelism` (~50), `MAXDOP`
> (según cores/NUMA), `optimize for ad hoc workloads`, y la retención de Change Tracking.

Comprueba además los cuatro valores que cambian el diagnóstico de cualquier análisis:
compat level, RCSI, edición y si hay Always On. Están en `SKILL.md`.

**Sub-caso medido — Change Tracking, por segunda vez y en otra instancia.** La retención de 365
días volvió a aparecer, y otra vez como **el mayor consumidor de CPU de todo el servidor**:
**horas de CPU** en miles de ejecuciones y cientos de millones de lecturas, y con una advertencia
que multiplica la cifra: esas estadísticas cubrían **unos pocos días**, no el uptime completo,
porque el plan se había creado poco antes. Estaba habilitado en varias bases, con retenciones de
unos días, de una semana y de 365 días conviviendo sin criterio aparente.

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
copia de una base productiva; la copia heredó **decenas de tablas con Change Tracking, cientos
de MB de tablas laterales, millones de filas pendientes y la retención de 365 días**, cifras
idénticas a las del original. Desde ese momento la instancia paga **el doble** de limpieza:
horas de CPU y decenas de millones de lecturas en miles de ejecuciones, al **mismo ritmo exacto
de ejecuciones por hora** que el plan de la base original.

Nadie decidió 365 días para la copia. Nadie decidió nada: se clonó.

> Cuando aparezca una base nueva en una instancia —copia, restauración, refresco de entorno—
> revisa `sys.change_tracking_databases` **el mismo día**. Una copia hereda el coste permanente
> de limpieza de su origen, y ese coste no aparece atribuido a ninguna consulta de negocio.

**La técnica de fechado, que vale para cualquier regresión.** El plan de `sys.sp_add_ct_history`
correspondiente a la copia nació **minutos** después de crearse la base. Cruzar `creation_time`
del plan cache contra `create_date` de `sys.databases` fecha el cambio con precisión de minutos,
sin necesidad de que nadie recuerde qué se hizo:

```sql
SELECT name, create_date FROM sys.databases WHERE create_date >= DATEADD(day,-7,GETDATE());
```

**Sub-caso medido — el default que apaga la única captura nativa de bloqueo.**
`blocked process threshold (s)` viene de fábrica en `0`, y con ese valor el *blocked process
report* no existe. En una instancia con **horas** de espera por bloqueo acumuladas en semanas de
uptime y una espera individual de **más de una hora**, no había ni un solo registro de quién
bloqueaba a quién. Es la asimetría más común de estos entornos: el deadlock —raro, ruidoso, un
puñado de casos en semanas— tiene herramienta y job; el bloqueo prolongado —frecuente,
silencioso— no tiene nada.

```sql
SELECT name, value_in_use FROM sys.configurations
WHERE name = 'blocked process threshold (s)';
```

Al encenderlo, el umbral se elige **con la duración media medida**, no por costumbre. Con
`LCK_M_S` en decenas de milisegundos de media, un umbral de 5 s sería ruido puro; 15 s deja
pasar casi todo y captura la cola, que es la que produce incidentes.

**Sub-caso medido — corregir la configuración no rompe nada: destapa lo que la configuración
estaba tapando.** En otra instancia, `cost threshold` ya estaba subido a 50 y `MAXDOP` fijado en
la mitad de los schedulers. Una consulta empezó a tardar **más del doble** de un día para otro
sin que nadie tocara el código: pasó de un plan paralelo que usaba todos los schedulers —cientos
de milisegundos de media, más de mil ejecuciones— a uno serial del **doble de duración**, porque
su coste estimado quedó por debajo del umbral nuevo. Query Store conservaba los dos planes con
sus ventanas de fechas, que es la única razón por la que se pudo fechar el cambio.

La lectura correcta no es "el ajuste fue malo". El scan que había debajo (R-32) siempre estuvo
ahí; repartido en varios hilos nadie lo miraba. **El ajuste retiró la anestesia.**

> Al subir `cost threshold` en una instancia con historia, cuenta con que aparezcan consultas
> "nuevas" en los informes de lentitud. No son nuevas: son las que vivían del paralelismo.
> Arreglar el código y no revertir el parámetro — revertirlo devuelve la cifra a su sitio a
> costa de seguir gastando N núcleos en consultas que devuelven una fila.

**Sub-caso medido — la configuración *por base* no la revisa nadie, y se hereda.** Esta regla
nació mirando `sp_configure`, que son diez valores en un solo sitio. La configuración de base es
peor: son las mismas cinco opciones **multiplicadas por el número de bases**, y en una instancia
con decenas nadie las mira enteras nunca. Barrido de una instancia con decenas de bases, todas
online:

| Opción | Bases mal | Qué implica |
|---|---:|---|
| `PAGE_VERIFY` ≠ `CHECKSUM` | **una decena** | casi todas en `TORN_PAGE_DETECTION` —la opción de 2000, solo ve un sector escrito a medias— y **alguna en `NONE`**, sin ninguna detección. Riesgo de integridad, no de rendimiento |
| `AUTO_CREATE`/`UPDATE_STATISTICS` en `OFF` | una | El optimizador no estima: adivina. Todos los planes de esa base parten de información inventada |
| `AUTO_SHRINK` en `ON` | una | Y precisamente en una base de bitácora, cuyo trabajo es recibir escrituras: el peor sitio posible |
| Compat level por debajo del motor | varias | Y **casi todas ellas con Query Store apagado** |

Dos cosas que hacen esto distinto de un descuido puntual. La primera: las bases afectadas **no
eran las dormidas** — algunas de ellas encabezaban el ranking de consumo de la propia instancia.
Nadie eligió dejarlas así; se restauraron, se copiaron o se migraron, y arrastraron el valor de
origen igual que la retención de Change Tracking del sub-caso anterior. La segunda: la
herramienta de auditoría de configuración **abortó con error 916** en la primera base sin
acceso, y devolvió cero hallazgos en lugar de un resultado parcial. Un barrido por catálogo
—`sys.databases`, que responde para todas— lo encontró completo.

> `PAGE_VERIFY CHECKSUM` es instantáneo y de metadatos, pero **solo protege lo que se escriba a
> partir de ese momento**: las páginas ya en disco no llevan checksum hasta que se reescriben.
> Prometer que el `ALTER` cierra el riesgo es falso. Cubrir el resto exige `DBCC CHECKDB` y, en
> la práctica, reconstrucción de índices — eso se decide y se planifica aparte.

```sql
-- Barrido de configuración por base. Una consulta, todas las bases, sin entrar en ninguna.
SELECT name, page_verify_option_desc, is_auto_shrink_on,
       is_auto_create_stats_on, is_auto_update_stats_on,
       compatibility_level, is_query_store_on, is_read_committed_snapshot_on
FROM   sys.databases
WHERE  database_id > 4
ORDER  BY name;
```

---

## R-28 · La instrumentación de diagnóstico también se audita [obs]

Un buzón de diagnóstico compartido tiene la retención que le deja **su emisor más ruidoso**, no
la que su dueño cree. `system_health` es el caso canónico: captura deadlocks, pero también
errores de seguridad, conectividad y esperas largas. Si algo satura una de esas categorías, se
lleva por delante a todas las demás.

Medido en un entorno real: **millones de eventos en semanas**, de los que **la inmensa mayoría**
eran errores de impersonación repetitivos. Consecuencias, todas verificadas:

| Efecto | Magnitud medida |
|---|---|
| Ventana del ring buffer en memoria | **un cuarto de hora** |
| Retención del archivo (techo de 1 GB en archivos rotativos) | **una fracción del uptime** |
| Deadlocks visibles en el ring buffer | **ninguno**, habiendo ocurrido un puñado en el periodo |
| Coste de lectura del conjunto de `.xel` | **decenas de segundos**, supera el timeout de un cliente |

El daño no es el ruido: es que **el vacío se lee como ausencia**. Un analizador de deadlocks
contra esa fuente devuelve cero filas y alguien concluye «no hubo deadlocks», cuando lo correcto
es «la evidencia ya rotó».

Dos parientes del mismo error, medidos en otra auditoría:

- **Una cifra viva se lee como de la sentencia en curso.** `sys.dm_exec_requests.logical_reads`,
  `cpu_time` y `total_elapsed_time` son el acumulado del **lote entero** desde `start_time`: en
  un job step que encadena procedimientos y bucles, es todo lo hecho desde que arrancó el job.
  Caso medido: cientos de millones de lecturas «sobre» una sentencia que en Query Store promedia
  unas decenas de miles. La culpable era otra que ya había terminado su turno. La atribución por
  sentencia sale de `sys.dm_exec_query_stats` por `plan_handle` + offset, o de Query Store; nunca
  del request vivo.
- **Query Store también tiene un techo, y al tocarlo enmudece.** Con `max_storage_size_mb`
  alcanzado pasa a `READ_ONLY` sin error ni aviso, y la métrica de cualquier paquete deja de
  moverse. Comprobar `current_storage_size_mb` contra `max_storage_size_mb` en
  `sys.database_query_store_options` antes de apoyar una verificación en él: en el caso medido
  estaba a tres cuartos de su techo y con `stale_query_threshold_days = 30` a punto de purgar la
  única historia de producción disponible.

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
conjunto. Sin él, esta misma consulta es la que tarda decenas de segundos.

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
  un hecho, y anotar el número de ejecuciones capturadas: unas decenas de ejecuciones no
  describen una hora punta.
- **El instrumento se mide a sí mismo.** Filtrar Query Store —o el plan cache— por un literal
  que aparece en la consulta buscada hace que **la propia consulta de monitoreo coincida con su
  filtro**. Caso real: una consulta de diagnóstico se auto-capturó y atribuyó sus **miles de
  lecturas lógicas** de barrido sobre las vistas internas a la sentencia que pretendía medir,
  inflando la cifra dos órdenes de magnitud. Antes de publicar una medición sacada así,
  **imprime el texto de lo capturado y compruébalo**; y excluye el propio instrumento
  (`AND qt.query_sql_text NOT LIKE '%query_store%'`) o usa marcadores mutuamente excluyentes.
- **Un monitor por muestreo tiene un suelo de detección, y casi nunca es el de su intervalo.**
  Si la regla de disparo exige que el síntoma aparezca en **N muestras consecutivas**, el umbral
  real no es el intervalo sino `(N-1) × intervalo`. Caso medido: un job de vigilancia de bloqueos
  corría cada **pocos minutos** y solo alertaba con `contador > 1` —es decir, dos fotos seguidas—,
  así que su suelo efectivo era **un intervalo completo**, no la resolución del muestreo. En un
  par de semanas registró **un par de episodios**, ambos ruido (una base de pruebas y el
  IntelliSense de una sesión de SSMS), mientras Query Store registraba esperas por lock **a
  diario**. El instrumento no fallaba: empezaba a medir justo donde terminaban los eventos reales,
  de un segundo a varios minutos. Antes de leer un historial vacío como «no pasó nada», **calcula
  el suelo del instrumento y compáralo con la duración de lo que buscas**. Y desconfía de la
  conclusión intermedia: un monitor que solo alerta por ruido acaba ignorado, lo que deja el
  hueco sin cubrir *y* sin que nadie lo note.
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
  todo el conjunto (de un orden de magnitud y más, con el I/O multiplicado por varias veces)
  eran del Object Explorer**, y aparecían en cabeza precisamente porque nadie navegaba ese
  servidor antes de migrarlo. Publicadas sin filtrar habrían descrito una degradación mucho peor
  que la real. Excluye siempre `AND qt.query_sql_text NOT LIKE '%msparam%'`, y separa lo que
  tiene `object_id` —código del negocio, procedimientos y funciones— del ad-hoc, que es donde se
  esconden las herramientas. La regla general: **antes de dar por buena una consulta de la lista
  de peores, lee su texto**. Un ranking de Query Store no distingue quién ejecutó qué.
- **Una media sobre una población que crece deriva sola.** Es la trampa más silenciosa de un
  antes/después, porque produce una mejora que nadie ha hecho. Al comparar dos ventanas se filtra
  por un mínimo de ejecuciones (`>= 100`) para quitar ruido — y ese conjunto **se agranda con el
  tiempo**, según cada consulta acumula ejecuciones. Medido: en **unas horas**, sin tocar la
  configuración, la población comparable creció **en más de la mitad** y la duración media
  ponderada bajó **en torno a una cuarta parte**. Una «mejora» que era aritmética de población:
  las consultas que entraron eran más baratas que la media. **Lo que sí se mantuvo fue el factor:
  prácticamente idéntico entre ambas mediciones.** Regla: en cualquier comparación antes/después,
  **la métrica de seguimiento es el cociente de cada consulta contra sí misma, no el agregado en
  milisegundos**. El cociente se normaliza solo; el absoluto solo es comparable contra su propia
  población, que ya no existe. Y si la comparación se apoya en Query Store, anota su **fecha de
  caducidad**: la ventana «antes» desaparece cuando cumple la retención, así que o se exporta a
  una tabla propia o la medición deja de poder rehacerse.
- **Query Store es por base; las esperas son de la instancia. No refutes una con la otra.** Error
  cometido y corregido en una investigación real: se midió que solo **una fracción ínfima** de las
  ejecuciones de la base auditada usaba plan paralelo y se concluyó «el paralelismo está
  descartado». El dato era correcto y la conclusión falsa — un delta de esperas de unas horas
  sobre la **instancia** mostró `CXCONSUMER`+`CXSYNC_PORT`+`CXPACKET` en **cerca de tres cuartos
  de toda la espera real**. Venía de otra base, de decenas, que no se había mirado. Antes de
  descartar un mecanismo con evidencia de Query Store, comprueba que **el alcance de la evidencia
  cubre el alcance de la afirmación**; si la señal es de instancia, la refutación también tiene
  que serlo.
- **Un porcentaje de ejecuciones no mide un porcentaje de coste.** El corolario del punto anterior,
  y lo que hacía engañosa esa fracción. En la base culpable, **una fracción ínfima de las
  ejecuciones** (miles entre millones) consumía **más de la mitad del CPU** de esa base: una
  docena de sentencias, encabezadas por una de **cientos de millones de lecturas lógicas por
  ejecución** que en **un par de ejecuciones** se llevó cerca de una hora de CPU. Ordena siempre
  por **coste total** —`avg_cpu_time * count_executions`—, nunca por número de ejecuciones. Y no
  confundas el arreglo: subir `cost threshold for parallelism` impide que se paralelice **lo
  trivial**, no lo que cuesta órdenes de magnitud más que el umbral. Esas sentencias seguirán
  yendo en paralelo, y con razón; lo que hay que arreglar es la sentencia.
- **Un job informa hacia atrás; una alerta avisa en el momento.** Los contadores
  `SQLServer:Locks / Number of Deadlocks/sec / _Total` y
  `SQLServer:General Statistics / Processes blocked` sirven como condición de rendimiento en una
  alerta de Agent. Lo que **no** funciona es alertar sobre el mensaje de error 1205: la víctima
  de deadlock no se escribe en el log de errores por defecto, así que esa alerta no se dispara
  nunca.
- **El caso inverso: aquí el ruido se lee como señal.** `sys.dm_os_wait_stats` devuelve mezcladas
  las esperas reales y las de tareas de fondo que simplemente esperan trabajo. Medido en una
  instancia: **las cinco esperas mayores sumaban la gran mayoría del total y ninguna era
  contención** —`HADR_*`, `BROKER_TRANSMITTER`, `LOGMGR_QUEUE`—, tapando por completo el
  paralelismo que sí importaba. Leído sin filtrar, el diagnóstico habría sido «esta instancia
  espera por Always On». Filtra siempre con la lista de exclusión conocida antes de ordenar por
  porcentaje, y añade dos columnas que la lectura ingenua olvida: el **signal wait** de cada
  espera —el porcentaje de tiempo que la tarea ya estaba lista y solo esperaba CPU— y el número
  de tareas, que distingue «muchas esperas cortas» de «una espera eterna».
- **Los totales del plan cache no cubren el uptime.** `sys.dm_exec_query_stats` acumula desde
  `creation_time` de **cada plan**, no desde el arranque del servidor. En una misma foto convivían
  una fila con días de historia y otra con unos minutos. Sirve para ordenar por magnitud; sumar
  sus totales y presentarlos como «el consumo del periodo» es un error. Incluye `creation_time`
  en toda consulta al plan cache que vaya a un informe.

**Sub-caso medido — el instrumento no sólo tapa la evidencia: a veces *es* el consumo.** Hasta
aquí esta regla trataba la instrumentación como fuente que se degrada. También hay que auditar
lo que **cuesta**. Medido: el mayor consumidor de CPU de toda una instancia no era ninguna
consulta de negocio, sino **una métrica de un colector de monitorización** que interrogaba el
historial de respaldos **cada pocos segundos**:

| | Medido en pocos días |
|---|---:|
| Ejecuciones | decenas de miles |
| CPU | **decenas de horas** |
| Lecturas lógicas | **miles de millones** |
| Lecturas por ejecución | cientos de miles |
| Duración media | segundos |

La tabla consultada ocupaba **decenas de MB**: las lecturas por ejecución significan recorrerla
**decenas de veces por ejecución**. La causa era doble y ninguna mitad se arregla sola — la
consulta agrupaba el historial y lo volvía a cruzar consigo mismo sin índice que soportara el
predicado, y el historial llevaba **años** acumulándose porque nadie lo purgaba nunca.

> Al ordenar el plan cache por CPU, **no descartes las filas sin base de datos atribuida**. Las
> tareas del motor y los colectores externos aparecen con `dbid` nulo y por eso se caen de
> cualquier informe organizado por base — que es justo donde se esconden los mayores consumidores
> (ver también el sub-caso de Change Tracking en R-25).
>
> Y aplica a la instrumentación el mismo criterio que a cualquier proceso: **la frecuencia se
> justifica con la velocidad a la que cambia el dato**. Un indicador sobre el último respaldo no
> cambia cada pocos segundos; bajarlo a unos minutos divide su coste por decenas sin perder
> información.

Segunda reproducción, en otra instancia y por otra vía: el colector no apareció en el ranking de
CPU sino en el de **esperas**. `MSQL_XP` —la espera de un procedimiento almacenado extendido— era
la **segunda del servidor**: horas de espera en pocos días de uptime, en cientos de miles de
tareas. Ninguna consulta de negocio la explicaba. El origen estaba en los `usecounts` del plan
cache, no en `dm_exec_query_stats`: `xp_instance_regread` con **decenas de miles** de usos y un
recolector leyendo configuración de red del registro con **otras decenas de miles**. La sesión
viva que lo confirmó ejecutaba `SELECT 'sqlserver_database_io' AS [measurement]`, firma de un
colector tipo Telegraf.

> `MSQL_XP`, `PREEMPTIVE_OS_*` y `OLEDB` altos y sin dueño aparente **apuntan casi siempre a un
> agente externo**, no al motor. Y el rastro no está en `dm_exec_query_stats` —muchas de esas
> llamadas no generan estadísticas de consulta— sino en `sys.dm_exec_cached_plans` ordenado por
> `usecounts`, cruzado con `sys.dm_exec_sql_text`. Un `usecounts` de cinco cifras sobre un
> fragmento que nadie reconoce es el colector.

```sql
-- Qué está martilleando la instancia sin aparecer en ningún ranking por base
SELECT TOP (20) cp.usecounts, cp.objtype, DB_NAME(st.dbid) AS BaseDeDatos,
       LEFT(REPLACE(REPLACE(st.text, CHAR(13), ' '), CHAR(10), ' '), 120) AS Fragmento
FROM   sys.dm_exec_cached_plans cp
CROSS APPLY sys.dm_exec_sql_text(cp.plan_handle) st
ORDER  BY cp.usecounts DESC;
```

**Sub-caso medido — las esperas acumuladas no pueden fechar una regresión.** `sys.dm_os_wait_stats`
suma desde el arranque del servicio. Con **meses** de uptime, buscar en ella una degradación de
dos días es inútil: la señal queda diluida por un factor de decenas. Lo que sí funciona, y no
cuesta nada:

- **Dos capturas separadas.** Consultar `sys.dm_os_wait_stats` dos veces y restar. En una ventana
  de medio minuto medida así, `CXPACKET`+`CXCONSUMER` **dominaban** la espera total y los
  bloqueos eran **cero** — un reparto irreconocible frente al acumulado de meses. Igual con
  `sys.dm_io_virtual_file_stats`, que también es acumulada.
- **Query Store agregado por día.** Es lo único que fecha una regresión con precisión. Comparar
  **laborables contra laborables** —el fin de semana distorsiona la media por sentencia, porque el
  poco volumen que queda es batch pesado— dio en el caso medido **casi el doble por sentencia** y
  señaló el día exacto. Y contrastar una segunda base descartó de un plumazo la causa de
  instancia: la vecina no se había movido.

**Dos trampas de lectura que producen cifras falsas sin dar ningún error.** Ambas cometidas y
corregidas en la misma investigación:

- **`sys.dm_exec_procedure_stats` incluye el costo de los módulos anidados.** Mide el módulo en su
  frontera, así que las lecturas de un procedimiento envoltorio son la **suma** de sus hijos, no un
  costo aparte. Sumar padre e hijos para calcular el peso sobre la instancia duplica el número. En
  el caso medido, el envoltorio daba miles de millones de lecturas y sus dos hijos, sumados,
  exactamente la misma cifra. La pista que lo delata: padre e hijos comparten `execution_count` y
  `last_execution_time`. Para saber qué sentencia concreta cuesta, hay que bajar a
  `sys.dm_exec_query_stats` unido por `plan_handle`, que **no** incluye lo anidado.
- **`EstimateRows` de un operador de scan no es la cardinalidad de la tabla.** Es la estimación de
  filas *de salida* tras los predicados empujados al operador. Leerlo como tamaño de tabla da
  cifras plausibles y equivocadas: en el caso medido, un `Index Scan` estimaba menos de un tercio
  de las filas de una tabla de **cerca de un millón**, y otro apenas una décima parte de una de
  **cientos de miles**. Para volumen real, `sys.dm_db_partition_stats`; el plan sirve para saber
  **cómo** se accede, no cuánto hay.

Corolario de método: cuando una DMV y un conteo directo discrepan, gana el conteo. Y si no hay
permiso para el conteo, la cifra del plan se publica **como estimación**, dicho con esas palabras.

---

## R-33 · Reducir volumen no es optimizar: mide quién lee la tabla antes de prometer rendimiento [obs]

Un plan de poda se justifica solo. Lo que **no** se justifica solo es la frase que suele
acompañarlo: «y además la aplicación irá más rápida».

Caso medido: base de **cientos de GB usados**, plan de poda de **más de un tercio** entre
reconstrucción de heaps, vaciado de bitácoras y corte por antigüedad. Antes de comprometer la
ventana se miró `sys.dm_db_index_usage_stats`, con semanas acumuladas:

| Tabla candidata | Tamaño | Búsquedas | Escaneos | Escrituras |
|---|---:|---:|---:|---:|
| la mayor de la base | decenas de GB | **0** | **0** | miles |
| la segunda | decenas de GB | **0** | un par *(del propio análisis)* | miles |
| la tercera | una decena de GB | **0** | un par *(del propio análisis)* | miles |
| una bitácora de proceso | unos GB | **0** | uno *(del propio análisis)* | **cientos de miles** |
| la que la aplicación **sí** usa | decenas de GB | **millones** | **0** | miles |

**Las tablas donde estaba todo el espacio recuperable no las leía nadie.** Se escribía en ellas y
nunca se consultaban. Y la tabla que la aplicación sí castigaba —millones de búsquedas— se
accede siempre **por búsqueda**, no por escaneo.

> El coste de una búsqueda en un índice es **logarítmico** respecto al número de filas; el de un
> escaneo es **lineal**. Quitar casi la mitad de las filas de una tabla no cambia la profundidad
> de su árbol: esos millones de búsquedas cuestan exactamente lo mismo después de podar. **Toda
> la ganancia de rendimiento de una reducción de datos se concentra en lo que hace escaneos.** Si
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
| `CXPACKET` + `CXCONSUMER` | **más de una décima parte** |
| `LATCH_EX` | unos pocos puntos |
| `SOS_SCHEDULER_YIELD` | en torno al uno por ciento *(casi toda ella es señal)* |
| **`PAGEIOLATCH_SH`** | **cien veces menos que el paralelismo** |

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
medidas en Query Store sobre una ventana de unos días.

| Sentencia | Ejec. | Duración media | CPU media | Lecturas lógicas | Duración máx. |
|---|---:|---:|---:|---:|---:|
| Alta (un `INSERT` de **una fila**) | decenas | **decenas de segundos** | fracciones de ms | una decena | más de un minuto |
| Búsqueda | un centenar | **decenas de segundos** | fracciones de ms | un puñado | más de un minuto |
| Búsqueda | decenas | más de diez segundos | fracciones de ms | un puñado | más de un minuto |
| Búsqueda | decenas | más de diez segundos | fracciones de ms | un puñado | más de un minuto |
| Validación previa | más de un centenar | casi diez segundos | fracciones de ms | un puñado | cerca de dos minutos |
| Vista previa | más de un centenar | un par de segundos | fracciones de ms | un puñado | decenas de segundos |

**La relación duración/CPU llega a decenas de miles a uno.** El razonamiento es aritmético y no
admite matices: una sentencia que toca un puñado de páginas y gasta fracciones de milisegundo de
procesador **no puede** tardar decenas de segundos por mérito propio. Todo ese tiempo es espera.
Y el tamaño no interviene: el `INSERT` de una fila que tardaba decenas de segundos escribía en
una tabla de **unos pocos MB y decenas de miles de filas**.

En ese entorno **RCSI estaba apagado en todas las bases revisadas**, así que la espera compatible
con este perfil es el bloqueo: un lector necesita bloqueo compartido y se detiene detrás de
cualquier escritura larga sobre la misma tabla. Todas las tablas comprobadas, sin excepción,
tenían `lock_escalation = TABLE`, de modo que una escritura que supera ~5.000 bloqueos
individuales detiene a **todos** los lectores, no sólo a los de las filas afectadas.

**La CPU baja del servidor no es prueba de salud — es el síntoma.** En la misma ventana: media
del **orden del diez por ciento**, máximo por debajo de la mitad, y **cero minutos** por encima
del 80 % en cientos de muestras. Un servidor ocioso con usuarios quejándose es exactamente lo
que produce una cadena de bloqueo: nadie trabaja porque casi todos esperan.

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
decenas de segundos y ocurre unas decenas de veces al día es invisible para ellas: en el caso
medido, un muestreo de medio minuto registró **0 ms** de espera por bloqueo y
`get_blocking_chains` salió limpio, con el problema plenamente activo. Query Store conserva
duración **y** CPU por sentencia, así que la firma sobrevive al hecho — es la única forma de
diagnosticar esto a posteriori.

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

### La firma inversa: CPU ≫ duración es paralelismo, y casi siempre es paralelismo mal ganado

La misma división leída al revés diagnostica el problema opuesto, y conviene tenerla a mano
porque se calcula con las mismas dos columnas. Si **CPU media > duración media**, el trabajo se
repartió entre varios hilos: es la única forma de gastar más procesador que tiempo de reloj. El
cociente aproxima el DOP efectivo.

Eso no es un defecto por sí solo —para eso existe el paralelismo—, pero es sospechoso cuando la
sentencia no debería necesitarlo. Dos casos medidos en la misma instancia, ambos con el mismo
cociente:

| Sentencia | CPU media | Duración media | CPU/Duración |
|---|---:|---:|---:|
| `INSERT INTO @tabla (…)` | minutos | minutos | **más del doble** |
| `IF EXISTS (SELECT TOP 1 1 …)` | segundos | alrededor de un segundo | **más del doble** |

Una comprobación de existencia que abre hilos paralelos y consume segundos de procesador
—decenas de miles de lecturas medias, miles de ejecuciones, más de una hora de CPU acumulada— no
tiene un problema de paralelismo: tiene un predicado sin índice, y el optimizador tiró de núcleos
para compensar el recorrido. Subir el `cost threshold` la quitaría del informe sin arreglar nada
(R-25).

> El paralelismo aparece arriba en cualquier ranking de esperas —`CXCONSUMER`, `CXPACKET`,
> `CXSYNC_PORT`— y ahí se lee como si fuera la causa. Casi nunca lo es. Es el sistema
> obedeciendo a una estimación de cardinalidad equivocada. **Busca la consulta que nunca debió
> ir a paralelo antes de tocar `MAXDOP`.**

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

Medido en una migración de dos versiones mayores, decenas de bases restauradas en un fin de
semana, con la instancia nueva medida pocos días después:

| | Medido |
|---|---:|
| Bases de usuario con el compat del motor **anterior** | **casi todas** |
| Estadísticas con más de 30 días (base principal, tablas >10.000 filas) | **casi todas** |
| Con más de 180 días | más de una cuarta parte |
| Con muestreo inferior al 5 % | cerca de una de cada diez |
| **Con más modificaciones pendientes que filas tiene la tabla** | **varias decenas** |
| Antigüedad máxima | **meses** |
| Esperas `WAIT_ON_SYNC_STATISTICS_REFRESH` acumuladas desde el restore | miles · **varios minutos** |
| Bases en `FULL` con `log_reuse_wait_desc = 'LOG_BACKUP'` | **varias** |

Casos concretos: una tabla de **millones de filas con el doble de modificaciones pendientes** y
dos meses sin actualizar; otra, también de millones de filas, con más modificaciones pendientes
que filas —renovación completa— muestreada con una **fracción mínima** hace **meses**.

### La firma que lo delata: menos lecturas y más tiempo

Es lo que hace esta regla útil, porque contradice la intuición. Comparando **las mismas consultas**
—mismo `query_id`— antes y después, con peso fijo:

| Base | Consultas | Duración | CPU | Lecturas lógicas |
|---|---:|---|---|---|
| Principal | cientos | **casi el doble** | una mitad más | **una cuarta parte menos** |
| Secundaria | más de un centenar | **un tercio más** | un tercio más | **más de una cuarta parte menos** |

Menos páginas leídas y más tiempo no describe hardware peor: describe **hardware mejor ejecutando
planes peores**. Si el almacenamiento fuera el problema subirían las lecturas o la espera de
disco; aquí `PAGEIOLATCH_SH` promediaba **fracciones de milisegundo** sobre más de un millón de
esperas.

> **El control que separa «plan peor» de «CPU más lenta».** Aísla las consultas cuyo I/O **no
> cambió** (±5 %): si las páginas son las mismas, el plan es equivalente y lo único que queda es
> el coste por unidad de trabajo. En el caso medido, con el plan controlado el CPU subía solo
> **entre un sexto y un tercio** de media y la mayoría de consultas no cambiaba —cerca de la
> mitad en cada base—, así que el casi-doble **no** se explica por el servidor: viene de las
> consultas cuyo plan sí cambió. Sin este control, el informe habría culpado al hardware nuevo.

### El compat level no es neutral, y aquí se mide

Dejarlo en el nivel antiguo evita regresiones de plan —para eso existe— pero desactiva, por
diseño, todo lo que se acaba de pagar. Con compat < 150 no hay *inlining* de funciones escalares
(R-14) ni compilación diferida de table variables (R-19); con compat < 160 no hay optimización de
planes sensibles a parámetros (R-06), ni *CE feedback*, ni *DOP feedback*.

Eso deja de ser teórico en cuanto se cuenta el código: **cientos de funciones escalares y decenas
de TVF multi-sentencia frente a un puñado de TVF inline** en una sola base — y **varios de los
objetos más degradados de la migración eran funciones escalares**, una de ellas con **más de un
millón de ejecuciones diarias**. Es exactamente el patrón que el compat nuevo resuelve sin tocar
una línea de T-SQL.

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
Subir el compat con histogramas de meses es evaluar un optimizador nuevo con datos falsos: el
resultado no es interpretable, ni bueno ni malo. Y entre medias, el CU — una instancia recién
migrada suele estar en **RTM**, que es la peor versión posible sobre la que adoptar funciones
nuevas.

**Lo que sí es un regalo: Query Store viaja dentro del backup.** Es la única razón por la que una
migración se puede medir en lugar de opinar. Si la base lo tenía activo en el servidor viejo, el
historial llega con ella y permite comparar el mismo `query_id` antes y después del cambio de
motor. Corolario operativo: **activar Query Store es un requisito previo de la migración**, no una
mejora posterior — en las bases que no lo tenían, no existe línea base y ya no se puede fabricar.

> **El `query_id` no es un ancla fiable entre el origen y el destino.** Medido tras un restore:
> la misma sentencia de un mismo procedimiento —mismo texto, mismo `object_id`, mismo
> `context_settings_id`— quedó con **dos** `query_id`: el que trajo el backup, con cientos de
> miles de ejecuciones y ninguna desde la hora del restore, y uno nuevo bajo el que corren las
> ejecuciones del destino. Un script de control que filtre por el primero mide una media
> congelada y devuelve el mismo número antes y después de cualquier parche. Localiza la sentencia
> por `query_hash` + `object_id` y agrupa por `query_id`, ordenando por `last_execution_time`:
> manda la fila viva. Y recuerda que cualquier cambio de texto —el propio parche— produce un hash
> nuevo: relocaliza después de desplegar.

> Y el que puede detener una base mientras se discute lo demás: comprobar
> `log_reuse_wait_desc = 'LOG_BACKUP'` el primer día. Si los jobs de respaldo de log no se
> recrearon, el log de cada base en `FULL` crece sin truncarse hasta llenar la unidad. Se
> comprueba en cinco minutos y fue el hallazgo de consecuencia más brusca del caso medido.

**Segunda observación, peor que la primera: no es que los jobs no se recrearan, es que no hay
ninguno.** Medido en un entorno restaurado desde producción para analizarlo: cero jobs de respaldo
en el Agent, cero pasos de job que contengan `BACKUP`, y el último respaldo registrado es el del
propio restore. Todas las bases en `FULL` con el log al borde del 100 %, sobre un volumen
compartido con espacio para semanas, no meses. Tres cosas que conviene tener presentes cuando
aparece esta forma:

- **Con un grupo de disponibilidad no hay atajo.** El AG exige recovery `FULL`, así que pasar a
  `SIMPLE` —la salida habitual en un entorno no productivo— no es una opción. La única salida es
  respaldar el log.
- **El mantenimiento acelera el problema.** Cada reconstrucción de índice genera log que no se
  puede truncar: la operación que mantiene sanas las tablas es también la que más acerca el
  volumen a llenarse. Un entorno con mantenimiento semanal y sin respaldos tiene fecha de caída.
- **Comprobar si la suite de mantenimiento instalada trae el procedimiento de respaldo.** Es
  frecuente encontrar el optimizador de índices y el ejecutor de comandos sin él, y entonces
  "hay suite de mantenimiento" se lee como "hay respaldos" sin serlo. Se verifica con una consulta
  a `sys.objects` en `master`.

Y el primer respaldo de log pesa lo que el log tiene usado: hay que comprobar el espacio del
destino antes de programarlo, y que ese destino no sea el mismo volumen que se quiere aliviar.

Relacionada con R-25 (configuración por defecto), R-28 (medir antes de concluir), R-06, R-14 y
R-19 (lo que el compat level habilita).

---

## R-37 · Una reescritura equivalente puede costar decenas de veces más: mídela, no la razones [obs]

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
-- REESCRITURA "LIMPIA": equivalente, y decenas de veces más lenta
WHERE (t.Bandera = 0 OR NOT EXISTS (SELECT 1 FROM dbo.Historial h WHERE ...))
```

Medido sobre la misma instancia, misma salida de un puñado de filas, dos ejecuciones cada una:

| Forma | Duración |
|---|---|
| Original, condición dentro | cientos de milisegundos |
| Solo el predicado de fecha hecho sargable | **algo menos que la original** |
| Condición fuera, reformulada con `OR` | **varios segundos, en las dos ejecuciones** |

El `OR` impide resolver el `NOT EXISTS` como semi-join y el plan se degrada. Dato que remata el
caso: **todas las configuraciones tenían `Bandera = 1`**, así que la rama nueva no aportaba nada
ni funcionalmente. Se descartó el cambio y se conservó la forma original.

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

Caso medido: un despachador ejecutaba **decenas de scripts** guardados como filas, de decenas de
KB cada uno. Todos escribían en dos tablas de millones de filas.

| Lo que preguntas | Lo que responde | Lo que es verdad |
|---|---|---|
| `sys.dm_sql_referencing_entities` sobre el despachador | **0 filas** | Lo llama un job programado |
| `sys.sql_modules` con `LIKE '%TablaCritica%'` | **1 objeto** | Decenas de scripts la escriben |
| Búsqueda de `DELETE` en el esquema | nada | Casi la mitad de los scripts tienen `DELETE` |
| Revisión de código sobre el repositorio | nada | Más de un MB de T-SQL ejecutable |

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

## R-39 · Un job que no cabe en su propio intervalo no falla: deja de ejecutarse [obs]

**Severidad:** alta — el proceso se degrada en silencio y ningún panel lo señala.

Cuando un job del Agent tarda más que su intervalo de programación, el Agent **descarta el
arranque siguiente**: no lo encola, no lo solapa, no registra nada. El job sigue en verde, con
cero fallos, mientras el proceso que debía correr cada pocos minutos pasa a correr una de cada
varias veces.

Caso medido: un job de asignación programado con un intervalo de **pocos minutos**, últimas
decenas de ejecuciones:

| Métrica | Valor |
|---|---:|
| Duración media | algo por debajo del intervalo |
| Duración máxima | **casi media hora** |
| Tiempo total consumido | varias horas |
| Fallos registrados | **0** |

**La media miente y la distribución es el diagnóstico.** Una media algo por debajo del intervalo
se lee como «ajustado pero dentro». No lo es. De las últimas ejecuciones, **la mayoría terminó
en segundos** y **unas pocas tardaron unos veinte minutos**. No es un job lento: es el mismo
código resolviéndose de dos maneras. Un reparto bimodal así solo tiene dos explicaciones, y hay
que separarlas antes de tocar nada:

| Explicación | Cómo se distingue |
|---|---|
| *Parameter sniffing* / plan alterno | Las ejecuciones lentas procesan un volumen **parecido** a las rápidas. Query Store conserva los dos planes con sus ventanas |
| Volumen real variable | Las lentas procesan mucho más. La duración correlaciona con las filas |

Sin instrumentar el número de filas por ejecución no se puede decidir, y el arreglo es distinto
en cada caso. Ese registro es el primer paso, no la optimización.

> **Trampa aritmética de `sysjobhistory`.** `run_duration` es un entero con formato `HHMMSS`, no
> segundos: un valor como `2608` **no** son 2.608 s, son 26 min 08 s. Un `AVG(run_duration)` es
> una operación sin significado —promedia dígitos posicionales— y produce cifras que parecen
> razonables. Hay que convertir antes de agregar.

```sql
-- DETECCIÓN: jobs cuya duración compite con su propio intervalo.
-- Sustituye 300 por el intervalo real en segundos del job que revisas.
SELECT j.name,
       Ejecuciones = COUNT(*),
       MediaSeg    = AVG(h.run_duration/10000*3600 + (h.run_duration/100)%100*60 + h.run_duration%100),
       MaximaSeg   = MAX(h.run_duration/10000*3600 + (h.run_duration/100)%100*60 + h.run_duration%100),
       Excedidas   = SUM(CASE WHEN h.run_duration/10000*3600
                                 + (h.run_duration/100)%100*60
                                 +  h.run_duration%100 > 300 THEN 1 ELSE 0 END),
       Fallos      = SUM(CASE WHEN h.run_status = 0 THEN 1 ELSE 0 END)
FROM   msdb.dbo.sysjobhistory h
JOIN   msdb.dbo.sysjobs j ON j.job_id = h.job_id
WHERE  h.step_id = 0
GROUP  BY j.name
ORDER  BY MaximaSeg DESC;
```

**Y el límite de esa consulta, que hay que decir en el informe.** `sysjobhistory` la poda
`sp_jobhistory_row_limiter` según el máximo configurado en el Agent. En el caso medido
conservaba **unas pocas decenas de ejecuciones por job**, así que pedir tres días de historial
devolvía lo mismo que pedir uno. Cualquier afirmación sobre la frecuencia del problema está
acotada por esa ventana, no por el rango de fechas del `WHERE`. Si hace falta una serie más
larga: subir el límite del Agent o volcar `sysjobhistory` a una tabla propia.

`Excedidas = 0` y `Fallos = 0` no significan lo mismo. El segundo es el que miran los paneles;
el primero es el que dice si el proceso está corriendo al ritmo que alguien diseñó.

Relacionada con R-28 (la instrumentación que no registra el problema que debía registrar) y
R-06 (el plan único que sirve para un parámetro y no para el siguiente).

**Tres trampas hermanas, medidas en una instancia con decenas de jobs y más de un centenar de
fallos de paso en menos de tres semanas.**

1. **Cero fallos porque nunca corre.** Varios jobs de mantenimiento **habilitados sin schedule**.
   La base más afectada —una de las más ejecutadas de la instancia— tenía un índice casi
   totalmente fragmentado y varios heaps a medio fragmentar. Detección: `sysjobs.enabled = 1` sin
   fila en `sysjobschedules` con `sysschedules.enabled = 1`.
2. **La mayoría de los fallos con una sola causa.** Los jobs se clonaron de producción y el
   procedimiento de mantenimiento que invocan **no existía** en la instancia. Semanas después
   alguien creó una copia con otro nombre y reapuntó la mayoría de los jobs; los restantes
   siguieron fallando al 100 %. La copia, editada para no depender del ejecutor del *framework*,
   perdió el registro en tabla de lo que ejecuta. Un "arreglo a medias" deja tres cosas que
   buscar: los jobs que aún apuntan al original, los que quedaron sin schedule, y qué perdió la
   copia.
3. **Agrupar los fallos por causa antes de leerlos.** `job + step_id + LEFT(message, 140)` sobre
   `sysjobhistory` convirtió más de un centenar de fallos en un puñado de causas en una consulta.
   Diez jobs que fallan casi nunca son diez problemas.

Y la conversión de `run_duration` desde `HHMMSS` no es solo para promedios: sin ella, una poda
de **casi nueve horas** convertida correctamente da unas decenas de miles de segundos y parece
de nueve horas por casualidad; con el valor `HHMMSS` en bruto se lee como más de ochenta mil
segundos, casi un día.

---

## R-40 · La recomendación de índice del motor es aritmética sobre las estadísticas que haya [obs]

**Severidad:** media — pero se cobra creando índices que no sirven en tablas que ya no pueden con
los que tienen.

`sys.dm_db_missing_index_details` no miente: calcula. `avg_user_impact` sale del coste estimado
del plan, y el coste estimado sale de las estadísticas. Si las estadísticas son viejas o de
muestreo bajo, la recomendación es un número grande y correcto sobre premisas falsas.

**Caso medido.** La sugerencia con el *score* más alto de toda una base —`avg_total_user_cost`
moderado, `avg_user_impact` de **tres cuartas partes**, miles de seeks, score de millones—
proponía indexar una única columna bandera:

```sql
-- LO QUE PROPONE EL MOTOR
CREATE INDEX IX_... ON dbo.Tabla (Inactive)
    INCLUDE (col1, col2, col3, col4);
```

Un `GROUP BY` de un momento sobre esa columna:

| `Inactive` | Filas |
|---|---:|
| `0` | **casi todas** |
| `1` | una pequeña fracción |

El predicado `Inactive = 0` selecciona **casi toda la tabla**. Un índice sobre esa columna se
escanea igual: no hay nada que filtrar. Las estadísticas que sostenían el cálculo se habían
actualizado por última vez **muchos meses antes**, con una muestra mínima.

**Segundo sub-caso, en la misma sesión.** La segunda recomendación —impacto **casi total**—
proponía un índice sobre una columna que ya es la **segunda del clustered**. El join que se quería
arreglar usaba la clave completa `(col1, col2)`, es decir el clustered entero: el *seek* ya era
óptimo y no faltaba ningún índice. La sugerencia procedía de otra consulta distinta, con unos
cientos de seeks, que la DMV agrega sin distinguir.

```sql
-- DETECCIÓN: contrasta la recomendación con la selectividad real
-- 1. La recomendación y su score
SELECT DB_NAME(mid.database_id) AS bd, mid.statement, mid.equality_columns,
       migs.avg_user_impact, migs.avg_total_user_cost,
       CONVERT(int, migs.avg_total_user_cost * migs.avg_user_impact
               * (migs.user_seeks + migs.user_scans)) AS score
FROM sys.dm_db_missing_index_details mid
JOIN sys.dm_db_missing_index_groups mig ON mig.index_handle = mid.index_handle
JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.index_group_handle
ORDER BY score DESC;

-- 2. La selectividad real de cada columna propuesta, antes de creer nada
SELECT ColumnaPropuesta, COUNT(1) AS filas,
       CONVERT(decimal(5,1), 100.0 * COUNT(1) / SUM(COUNT(1)) OVER ()) AS pct
FROM dbo.Tabla WITH (NOLOCK) GROUP BY ColumnaPropuesta ORDER BY 2 DESC;

-- 3. La frescura de las estadísticas que produjeron ese número
SELECT s.name, sp.last_updated, sp.rows, sp.rows_sampled, sp.modification_counter
FROM sys.stats s CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE s.object_id = OBJECT_ID('dbo.Tabla');
```

> Tres comprobaciones antes de crear cualquier índice recomendado, en este orden: **la
> selectividad real** de las columnas propuestas —si la más selectiva cubre más del 90 % de la
> tabla, descarta—; **la fecha de las estadísticas** que produjeron el cálculo; y si **un índice
> existente —empezando por el clustered— ya cubre el predicado**.

El orden importa: actualizar las estadísticas primero hace desaparecer buena parte de la lista de
índices faltantes, y evita crear estructuras para corregir un error de estimación que se corrige
con `UPDATE STATISTICS`.

**Por qué la estadística mala no se arregla sola, aunque `AUTO_UPDATE_STATISTICS` esté activo.**
La auto-actualización no es un proceso de fondo: se dispara **al compilar** una consulta que use
esa estadística concreta. Si el índice apenas se consulta, nada la carga, nada comprueba que está
vencida, y se queda ahí indefinidamente por encima de su umbral.

Medido, con `is_auto_update_stats_on = true` en todas las bases:

| Estadística | Días | Muestreo | Pasos | Modificaciones | Umbral | Veces | Seeks del índice |
|---|---:|---:|---:|---:|---:|---:|---:|
| Sobre la columna bandera propuesta | meses | mínimo | **2** | decenas de miles | decenas de miles | **casi el doble** | decenas |
| La que usa el plan diagnosticado | meses | mínimo | 200 | decenas de miles | decenas de miles | por debajo | miles |

El umbral en compat 130+ es `MIN(500 + 0,20 × filas, SQRT(1000 × filas))`. Cálculo y detección:

```sql
SELECT OBJECT_NAME(s.object_id) AS tabla, s.name, sp.last_updated,
       DATEDIFF(DAY, sp.last_updated, GETDATE()) AS dias,
       CONVERT(decimal(5,1), 100.0*sp.rows_sampled/NULLIF(sp.rows,0)) AS pct_muestreo,
       sp.steps, sp.modification_counter,
       CONVERT(decimal(6,2), sp.modification_counter /
         NULLIF(CASE WHEN 500 + 0.20*sp.rows < SQRT(1000.0*sp.rows)
                     THEN 500 + 0.20*sp.rows ELSE SQRT(1000.0*sp.rows) END, 0)) AS veces_el_umbral
FROM sys.stats s CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE sp.rows > 100000 ORDER BY veces_el_umbral DESC;
```

> `steps = 2` sobre una columna bandera es la señal de que la estimación de ese predicado saldrá
> por densidad y será tan buena como la muestra: aquí, una fracción mínima de un millón de filas.

Y una trampa al validar en otro entorno: **si allí las estadísticas están frescas, el plan será
otro y la consulta original puede no parecer lenta.** El equipo concluirá, razonablemente, que no
hay nada que arreglar. Por eso el criterio de aceptación en un entorno que no reproduce las
condiciones tiene que ser estructural —comparar planes y lecturas lógicas— y nunca la duración.

Relacionada con R-23 (un índice de más también cuesta, y la advertencia de que la DMV sugiere
*columnas*, no índices), R-35 (estadísticas que el restore trajo intactas) y R-28 (auditar la
fuente antes de creerla).

---

## R-41 · Una verificación de equivalencia entre dos conjuntos vacíos pasa limpia [obs]

**Severidad:** alta — no rompe nada por sí misma, pero certifica como verificado algo que no lo
está, que es peor que no verificar.

`EXCEPT` en ambas direcciones es la garantía estándar para demostrar que una reescritura no cambia
el resultado. Tiene un modo de fallo silencioso: si **los dos lados devuelven cero filas**, ambas
direcciones dan cero diferencias y todos los indicadores salen en verde.

**Caso medido.** Comparando dos formas de una consulta con un lote de cientos de entradas de
filtro construido a partir de datos reales:

| | Filas v1 | Filas v2 | Solo en v1 | Solo en v2 |
|---|---:|---:|---:|---:|
| Primera pasada | **0** | **0** | 0 | 0 |

El lote se había tomado con `TOP ... ORDER BY clave ASC`, es decir las filas **más antiguas**,
y las dos formas llevaban un predicado de vigencia (`fecha_efectiva > @Hoy`) que las descartaba
todas. La prueba habría pasado por buena. Rehecha con el filtro de vigencia aplicado **al construir
el lote**, la misma comparación dio cientos de filas a cada lado, el mismo número de grupos y
cero diferencias — esa sí demuestra algo.

**Arreglo — dos partes.**

1. **Publica siempre el conteo de cada lado junto a las diferencias**, y trata `filas = 0` como
   fallo de la prueba, no como éxito:

```sql
SELECT (SELECT COUNT(1) FROM v1) AS filas_v1,
       (SELECT COUNT(1) FROM v2) AS filas_v2,
       (SELECT COUNT(1) FROM (SELECT * FROM v1 EXCEPT SELECT * FROM v2) a) AS solo_v1,
       (SELECT COUNT(1) FROM (SELECT * FROM v2 EXCEPT SELECT * FROM v1) b) AS solo_v2,
       CASE WHEN (SELECT COUNT(1) FROM v1) > 0
             AND (SELECT COUNT(1) FROM v2) > 0
             AND (SELECT COUNT(1) FROM (SELECT * FROM v1 EXCEPT SELECT * FROM v2) a) = 0
             AND (SELECT COUNT(1) FROM (SELECT * FROM v2 EXCEPT SELECT * FROM v1) b) = 0
            THEN 1 ELSE 0 END AS EsCorrecto;
```

2. **Diseña el lote para que ejercite las cuatro situaciones que pueden romper la equivalencia**,
   no solo coincidencias limpias. El lote que sí demostró algo se componía de: una mayoría de
   coincidencias reales; un grupo de entradas **duplicadas** de otras, que obligan a conservar la
   multiplicidad; unas cuantas con un valor **fuera del rango** del filtro; unas cuantas **sin
   coincidencia posible**, que es lo único que distingue un `LEFT JOIN + IS NOT NULL` de un
   `INNER JOIN`; y un grupo de la **segunda categoría** del `IN`. Resultado: el mismo número de
   filas y de grupos a cada lado, y la misma multiplicidad máxima idéntica en ambas formas.

> Un lote de coincidencias limpias no prueba nada. Si al construirlo no tuviste que pensar qué
> podría salir distinto, la prueba no está midiendo la equivalencia: está midiendo que dos
> consultas parecidas devuelven lo mismo sobre datos que no las diferencian.

Relacionada con R-37 (la otra mitad: demostrar que la reescritura no cuesta *más*), con la nota de
`analisis-bd` sobre el `DISTINCT` implícito de `EXCEPT` —que no ve la multiplicidad, y por eso el
lote lleva duplicados a propósito— y con la regla transversal de `SKILL.md`: ningún cambio de
conjunto es mecánico.

---

## R-42 · Una poda que desactiva la integridad de toda la base para borrar en unas pocas tablas [obs]

**Severidad:** crítica — bloqueo con alcance de instancia y pérdida de la integridad referencial,
las dos a la vez.

El guion de poda típico se escribe pensando en que "nada estorbe": desactiva claves foráneas y
triggers, borra a lo grande, y vuelve a activar. Cada una de esas tres decisiones tiene un coste
que no aparece hasta que se mide desde fuera del guion.

Caso medido: dos jobs manuales de poda sobre la base más grande de la instancia (cientos de GB,
más de mil tablas), ejecutados el mismo día, de **casi nueve horas** y **más de dos horas**:

```sql
EXEC sp_MSforeachtable 'ALTER TABLE ? NOCHECK CONSTRAINT ALL';   -- todas las tablas, Sch-M en cada una
EXEC sp_MSforeachtable 'ALTER TABLE ? DISABLE TRIGGER ALL';

DECLARE @TamanoLote INT = 50000;
WHILE @FilasBorradas > 0
BEGIN
    DELETE TOP (@TamanoLote) FROM dbo.Bitacora WHERE [fecha] < @Corte;   -- sin índice por [fecha]
    SET @FilasBorradas = @@ROWCOUNT;
END
-- … unas pocas tablas así …
EXEC sp_MSforeachtable 'ALTER TABLE ? WITH NOCHECK CHECK CONSTRAINT ALL';
EXEC sp_MSforeachtable 'ALTER TABLE ? ENABLE TRIGGER ALL';
```

| Qué hace | Qué cuesta, medido |
|---|---|
| `NOCHECK CONSTRAINT ALL` sobre todas las tablas | Un lock Sch-M por tabla, dos veces, y la integridad de **toda** la base desactivada durante casi nueve horas para borrar en unas pocas tablas |
| `DELETE TOP` con lotes diez veces por encima del umbral de escalado | El escalado a lock de **tabla** ocurre a partir de ~5.000 locks por sentencia: cada lote bloquea la tabla entera. Escrituras de **otras dos bases** sobre esta esperaron **unos diez minutos**; una sesión murió esperando |
| Poda por columna de fecha sin índice | La tabla mayor (millones de filas, heap de varios GB) se escaneaba entera **en cada lote**, con el lock de tabla puesto |
| `WITH NOCHECK CHECK CONSTRAINT ALL` al cerrar | Reactiva la FK sin comprobarla: queda `is_not_trusted = 1` para siempre. Después de la poda, **más de mil FK** de la base no confiables; el optimizador deja de usarlas para eliminar joins y asumir que la fila padre existe |

Y el detalle que delata que el guion no se leyó: un bloque de `DELETE` estaba **duplicado**.

**Forma correcta:**

- Si una FK estorba, se desactiva **esa** FK, y se reactiva con `WITH CHECK CHECK CONSTRAINT`
  (cuesta un escaneo de la hija: es el precio de que vuelva a ser confiable).
- Lote de **2.000–4.000** filas, y entre lotes `WAITFOR DELAY '00:00:00.200'` para dejar pasar a
  los demás. El lote grande no ahorra tiempo: lo convierte en tiempo de espera de otros.
- Índice por la columna del `WHERE` **antes** de podar, o la poda escanea la tabla entera N veces.
- Comprobación obligatoria después de cualquier poda:

```sql
-- DETECCIÓN: FK que una poda dejó sin confianza
SELECT OBJECT_NAME(parent_object_id) AS tabla, name
FROM   sys.foreign_keys
WHERE  is_not_trusted = 1 AND is_disabled = 0;

-- DETECCIÓN: jobs que desactivan la integridad de toda la base
SELECT j.name, s.step_id
FROM   msdb.dbo.sysjobs j JOIN msdb.dbo.sysjobsteps s ON s.job_id = j.job_id
WHERE  s.command LIKE '%sp_MSforeachtable%NOCHECK%' OR s.command LIKE '%sp_MSforeachtable%DISABLE TRIGGER%';
```

Un guion de poda ensayado en un entorno de pruebas es **el mismo** que se aplicará en
producción: corregir el ensayo es lo que evita el incidente.

Relacionada con R-04 (la transacción que envuelve trabajo que no debía), R-29 (la escritura
masiva sin validar su alcance) y R-24 (la bitácora que crece hasta que alguien la poda a lo bruto).

---

## R-43 · El mantenimiento de índices también es carga: un *rebuild* con *fallback* OFFLINE sobre una bitácora viva bloquea la aplicación [obs]

**Severidad:** alta — incidente real bajo carga, a la misma hora cada vez que corre el job.

Los *frameworks* de mantenimiento aceptan una lista de acciones por nivel de fragmentación:

```sql
@FragmentationMedium = 'INDEX_REORGANIZE,INDEX_REBUILD_ONLINE,INDEX_REBUILD_OFFLINE',
@FragmentationHigh   = 'INDEX_REBUILD_ONLINE,INDEX_REBUILD_OFFLINE'
```

La lista se lee «el primero que se pueda; si no, el siguiente». Cuando el *rebuild* ONLINE no
es posible —tipos LOB antiguos, edición sin ONLINE, opción no soportada para ese índice— cae a
OFFLINE, y OFFLINE toma un lock de esquema sobre la tabla durante todo el *rebuild*.

Caso medido: bitácora de aplicación de **millones de filas** con `INSERT` continuo. El job de
mantenimiento corre en días fijos, siempre a la misma hora. A la hora exacta del job, los
`INSERT` de la aplicación sobre esa tabla esperaron **más de cuarenta minutos** en total (Query
Store, categoría *Lock*), dentro de una base que acumuló **más de una hora** de esperas de lock
en dos días. El job coincidía además con el final de la ventana de backups.

**Forma correcta:**

- Donde ONLINE existe (Enterprise, Developer): **quitar el *fallback* OFFLINE**. Un índice que no
  admita ONLINE se queda sin reconstruir y el *framework* lo registra; es mejor que bloquear la
  aplicación.
- Donde no existe (Standard): todo *rebuild* es OFFLINE y el *fallback* no es una excepción, es
  el único camino. Ahí se excluyen las bitácoras del *rebuild* —solo `REORGANIZE`, que es online
  en todas las ediciones— y se mueve el job fuera de la ventana de escritura.
- La ventana del mantenimiento no coincide con la de backups ni con la de la aplicación. Tres
  procesos que compiten por el mismo I/O a la misma hora se reparten el bloqueo.

```sql
-- DETECCIÓN: jobs con fallback OFFLINE
SELECT j.name, s.step_id
FROM   msdb.dbo.sysjobs j JOIN msdb.dbo.sysjobsteps s ON s.job_id = j.job_id
WHERE  s.command LIKE '%INDEX_REBUILD_OFFLINE%';

-- DETECCIÓN: esperas de lock concentradas en la hora del job (Query Store, por hora)
SELECT DATEPART(HOUR, i.start_time) AS hora, SUM(w.total_query_wait_time_ms) / 1000 AS espera_seg
FROM   sys.query_store_wait_stats w
JOIN   sys.query_store_runtime_stats_interval i ON i.runtime_stats_interval_id = w.runtime_stats_interval_id
WHERE  w.wait_category_desc = 'Lock' AND i.start_time > DATEADD(DAY, -7, SYSUTCDATETIME())
GROUP  BY DATEPART(HOUR, i.start_time)
ORDER  BY espera_seg DESC;
```

Relacionada con R-24 (la bitácora que nunca debió ser tan grande) y R-39 (el job que se mide
por lo que hace, no por si termina en verde).

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
| **[obs]** `=` **con** comodín: `col = 'PREFIJO%'` | El caso inverso al anterior, y el peligroso: compara por igualdad exacta contra una cadena que contiene `%`, así que solo coincide si el dato es literalmente `PREFIJO%`. **No da error, devuelve cero filas.** Medido: 0 coincidencias donde `LIKE` daba **decenas de miles**, en una condición repetida varias veces dentro del mismo objeto. Detección barata: `SELECT ... WHERE col LIKE 'x%'` contra `WHERE col = 'x%'` y comparar conteos. Mejor arreglo que `LIKE`: filtrar por el `int` del catálogo, que no depende de cómo se escriba el nombre |
| **[obs]** `DELETE`/`UPDATE` con `LEFT JOIN` y `WHERE col NOT IN (...)` | Doble fallo: cuando el `LEFT JOIN` no casa, `NULL NOT IN (...)` es `UNKNOWN` y la fila **no** se borra —el `LEFT JOIN` actúa como `INNER JOIN`—; y si la subconsulta devuelve un solo `NULL`, **no se borra nada en absoluto**, en silencio. Usar `NOT EXISTS` y decidir explícitamente qué pasa con las filas sin pareja |
