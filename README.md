# facturacion-senau

Worker de Cloudflare que emite ante la DIAN una **Factura Electrónica de Venta (tipo 01)** por cada pedido pagado en `senau-tickets`. Es un servicio interno: no tiene interfaz pública, solo recibe pedidos de la tiquetera por service binding, los firma (XAdES-EPES), los transmite a la DIAN (SOAP) y guarda el resultado.

**¿Por qué factura normal y no el documento equivalente de espectáculos (tipo 27)?** El Artículo 15 de la Resolución DIAN 165 de 2023 —el que crea la boleta de espectáculos como documento equivalente— dice textualmente: *"Los sujetos que expidan los documentos equivalentes de que trata este artículo, en todos los casos podrán expedir la factura electrónica de venta en las operaciones que se indican para cada uno de los citados documentos."* Es una opción explícita de la norma, no un atajo. Se tomó porque `@dian-kit/core` soporta el tipo 01 de forma nativa (estructura UBL + CUFE ya resueltos por la librería), mientras que el tipo 27 no está soportado y su estructura/fórmula de CUDE exactas están enterradas en un anexo técnico de 1546 páginas que no se pudo verificar por completo. Esto no cambia nada de lo demás: PULEP sigue siendo obligatorio para el evento, y la contribución parafiscal del 10% (boletas ≥ 3 UVT) sigue aplicando igual — son trámites independientes de qué documento se use para facturar.

**Estado: implementación completa, sin verificar contra un `npm install` real ni contra la DIAN.** `src/lib/factura.ts` (construcción del XML UBL + CUFE), `src/lib/dian.ts` (firma XAdES-EPES + `SendBillSync`/`GetStatus`), `src/lib/store.ts` (D1: idempotencia, numeración atómica, reintentos, conciliación de `sending`) y `src/index.ts` (API interna, cola, cron) están escritos contra la forma real de `@dian-kit/core` (investigada en su código fuente en GitHub — ver "Fase 0" abajo), con pruebas end-to-end (`npm test`, 14/15 en verde; la única omitida necesita `npm install` real). `senau-tickets` ya llama a este Worker por service binding en cada pedido pagado (`senau-tickets/src/lib/facturacion.ts` y `payments.ts`). Lo que falta no es código sino: (1) correr `npm install` de verdad y confirmar que `@dian-kit/core` firma dentro de Workers (Fase 0, nunca ejecutado en esta sesión por falta de red), y (2) los trámites con la DIAN y las confirmaciones de un contador — ver "Preguntas abiertas". Empieza por `CLAUDE.md` y `docs/brief-facturacion-electronica.md`.

```
senau-tickets  ──service binding──▶  facturacion-senau  ──SOAP/WS-Security──▶  DIAN
  (pago OK)        POST /documents        cola + reintentos                 SendBillSync
                   GET  /documents/:id    D1: documents                     GetStatus
```

## Por qué un Worker aparte

- La clave privada del certificado de firma solo vive aquí (secrets de este Worker). La tiquetera, que es la superficie pública y recibe pagos, nunca la toca.
- El webhook de Bold no espera a la DIAN: la tiquetera entrega el pedido y sigue; la firma y el envío ocurren en la cola.
- El builder de facturas y la adaptación de `@dian-kit/core` a Workers son genéricos y reutilizables fuera de Senau.

## Estructura

```
CLAUDE.md                 instrucciones para el agente que desarrolle el repo
docs/brief-…md            contexto legal, técnico y decisiones (leer primero)
src/index.ts              entrada del Worker: API interna, consumidor de cola, cron de reintentos
src/types.ts              contratos: petición de la tiquetera, registro en D1, respuestas
src/lib/config.ts         lee vars/secrets → configuración tipada (emisor, software, numeración)
src/lib/cert.ts           arma el CertificateData de @dian-kit/core desde secrets PEM (node-forge)
src/lib/factura.ts        arma el DianDocument y llama a @dian-kit/core (generateCufe, buildInvoiceXml)
src/lib/dian.ts           firma XAdES-EPES y transporte (signXml, sendBill, getStatus) contra @dian-kit/core
src/lib/store.ts          acceso a D1 (tabla documents): idempotencia, numeración atómica, reintentos, conciliación
migrations/0001_documents.sql
scripts/extract-cert.mjs  .p12 → PEM (clave PKCS#8 + cert) para cargar como secrets (Node, sin bash/openssl)
scripts/set-secrets.mjs   carga los secrets en Wrangler (Node, sin bash)
test/d1.ts                emula D1Database sobre node:sqlite, para probar store.ts sin Cloudflare
test/run.ts               pruebas end-to-end (Node + node:sqlite emulando D1)
```

## Contrato de la API interna

Solo accesible por service binding desde `senau-tickets` (no tiene ruta pública). Todas las respuestas son JSON.

**`POST /documents`** — encola la emisión de un documento para un pedido pagado. Idempotente por `order_id`.

```jsonc
{
  "order_id": "O-2026-000123",          // id del pedido en senau-tickets
  "paid_at": "2026-10-03T21:14:05Z",
  "buyer": { "name": "Ana Pérez", "email": "ana@example.com",
             "id_type": "13", "id_number": "1037…" },   // obligatorios: factura electrónica exige identificar al comprador
  "event": { "id": "EV-1", "name": "Senau en vivo — Medellín",
             "venue": "Teatro X, Medellín", "starts_at": "2026-11-15T20:00:00-05:00",
             "pulep_code": "PULEP-XXXX" },   // opcional: solo para trazabilidad interna, ya no viaja en el XML de la factura
  "lines": [ { "description": "Entrada General", "quantity": 2,
               "unit_price": 60000, "zone": "General", "courtesy": false } ],
  "totals": { "subtotal": 120000, "service_fee": 8000, "total": 128000, "currency": "COP" }
}
```

Respuesta `202`: `{ "document_id": "D-…", "status": "queued" }` (o `200` con el existente si ya había uno para ese `order_id`).

**`GET /documents/:id`** — estado actual.

```jsonc
{ "document_id": "D-…", "order_id": "O-…", "status": "accepted",
  "number": "SETP990000012", "cufe": "…", "dian_status_code": "00",
  "error": null, "attempts": 1, "updated_at": "…" }
```

Estados: `queued` → `sending` → `accepted` | `rejected` | `failed`. `rejected` es un rechazo de la DIAN (no se reintenta solo; hay que corregir); `failed` es un error nuestro o de red (se reintenta).

**`POST /documents/:id/retry`** — vuelve a encolar un `failed` o `rejected` (tras corregir).

Autenticación: además del service binding, cada petición debe traer `X-Internal-Key` igual al secret `INTERNAL_KEY` (defensa en profundidad si algún día se expone por HTTP).

## Puesta en marcha

Requisitos: Node 22+, cuenta de Cloudflare (misma que `senau-tickets`).

```bash
npm install
cp .dev.vars.example .dev.vars        # y rellena
npx wrangler d1 create facturacion-senau   # copia database_id a wrangler.toml
npx wrangler queues create facturacion-senau-emision   # las colas no se crean solas al desplegar
npx wrangler queues create facturacion-senau-dlq
npm run db:migrate:local
npm run typecheck
npm test
npm run dev
```

Producción: `npm run db:migrate`, `npm run secrets`, `npm run deploy`. Luego en `senau-tickets/wrangler.toml` añade el service binding:

```toml
[[services]]
binding = "FACTURACION"
service = "facturacion-senau"
```

### Certificado de firma

1. Obtén el certificado digital (`.p12`/`.pfx`) de una entidad de certificación acreditada por la ONAC. El certificado **gratuito de la DIAN no sirve aquí**: solo funciona con la herramienta gratuita de facturación de la propia DIAN, no con software propio como este.
2. `npm run extract-cert -- ruta/al/cert.p12` → genera `cert.key.pem` (PKCS#8) y `cert.crt.pem`. **No los subas al repo.**
3. `npm run secrets` los carga como `SIGNING_KEY_PEM` y `SIGNING_CERT_PEM`.

(`scripts/extract-cert.sh` y `scripts/set-secrets.sh` quedaron sin uso — eran bash y en Windows sin Git Bash/WSL con `bash` en el PATH fallan con "El sistema no puede ejecutar el programa especificado"; se pueden borrar.)

### Datos que hay que conseguir en la DIAN (fuera del código)

- Registro del software propio en el catálogo de participantes → `DIAN_SOFTWARE_ID` y `DIAN_SOFTWARE_PIN`.
- Autorización de numeración → `DIAN_NUMBERING_*` (prefijo, rango, fechas, clave técnica). En pruebas la DIAN da un rango `SETP`.
- Set de pruebas de habilitación: se envía con el mismo software; al aprobarse se elige la fecha de inicio y la DIAN actualiza el RUT.

Y fuera de la DIAN: **registro PULEP** del evento (Ministerio de Cultura) — obligatorio para poder montar el evento, pero ya no es un dato que viaje en el XML de la factura (solo aplicaba al documento equivalente tipo 27, descartado; ver arriba). Sigue siendo útil pasarlo en `event.pulep_code` solo para trazabilidad interna.

## Plan por fases

**Fase 0 — Spike de compatibilidad (bloqueante). Investigación hecha, ejecución real pendiente.**

Se investigó el código fuente de `@dian-kit/core` (GitHub, `sergioarojasm98/dian-kit`) sin poder instalarlo ni correr `wrangler dev` de verdad — el `npm install` estuvo bloqueado por la red de esa sesión y el shell del computador de Nicolás no arrancó ese día. Hallazgos (de código fuente, no de una prueba real):

- Dependencias de `@dian-kit/core`: `@xmldom/xmldom`, `fflate`, `node-forge`, `xadesjs`, `xml-core`, `xmlbuilder2`, `xmldsigjs`, `xpath`, `zod`. Todas JS puro, sin bindings nativos ni uso de `fs`/`child_process` en su lógica central — buena señal para Workers, no una confirmación.
- `xadesjs` (quien firma XAdES) no depende de un motor de Node hardcodeado: expone `Application.setEngine(nombre, motor)`, así que se le puede inyectar el `crypto` global de Workers en vez de dejar que intente cargar `@peculiar/webcrypto` (que ni siquiera está en las dependencias de dian-kit). Ya está cableado así en `src/lib/dian.ts`.
- `@dian-kit/core` **no soporta el tipo 27 nativamente** (solo 01, 91, 92, 102), pero sí expone piezas genéricas reutilizables — `signXml()`, `sha384()`, `sendBill()`, `getStatus()`, `getStatusZip()` — agnósticas al tipo de documento. Por eso `src/lib/dian.ts` ya está escrito contra esas funciones (con los nombres de export confirmados, pero la forma exacta de sus parámetros marcada como `TODO` porque no se pudo verificar contra el paquete real instalado).

**Para cerrar Fase 0 de verdad**, en una máquina con `npm install` normal:
1. `npm install` y `npx tsc --noEmit` — corrige los `TODO` de `src/lib/dian.ts` si las firmas de `signXml`/`sendBill`/`getStatus` no coinciden con lo que compila.
2. Un test mínimo de `wrangler dev` que llame a `sign()` con la clave de prueba que ya genera `test/run.ts` — si firma sin pedir un módulo de Node que Workers no tiene, Fase 0 queda resuelta a favor de esta arquitectura. Si falla, decidir entre reimplementar la firma sobre `xmldsigjs` directamente o aislarla en un servicio Node mínimo.

**Fase 1 — Factura tipo 01. Código listo.** `src/lib/factura.ts` mapea `DocumentRequest` al `DianDocument` de dian-kit (comprador, líneas, totales, hora de Colombia) y llama a `generateCufe()` + `buildInvoiceXml()` — nombres de campos tomados del código fuente en GitHub (ver Fase 0), sin confirmar contra el paquete instalado de verdad. Pendiente con un contador (no es código, ver "Preguntas abiertas"): el código de responsabilidad fiscal del comprador persona natural, la tarifa/código de IVA de las boletas, y si la dirección por defecto del comprador (`DEFAULT_BUYER_CITY_CODE`/`DEPT_CODE` en `wrangler.toml`) es aceptable o hay que pedir ciudad en el checkout de `senau-tickets`.

**Fase 2 — Transporte y habilitación. Código listo, falta ejecutarlo contra la DIAN de verdad.** `src/lib/dian.ts` ya firma (XAdES-EPES vía `signXml`) y transmite (`sendBill`/`sendBillSync`, `getStatus`) contra el ambiente de pruebas (`DIAN_ENV=2`); `src/index.ts` guarda el XML firmado y el CUFE en D1 antes de enviar (auditoría, y para poder reenviar el mismo documento si el envío queda a medias). Falta enviar el set de pruebas de habilitación real — requiere el certificado, el software registrado y la numeración autorizada (ver "Datos que hay que conseguir en la DIAN" arriba).

**Fase 3 — Integración. Hecho.** `senau-tickets` llama a este Worker por service binding (`[[services]] binding = "FACTURACION"`) desde `src/lib/payments.ts`, tanto al aprobar el webhook de Bold como al conciliar; `src/lib/facturacion.ts` arma la petición y nunca deja que un fallo de este Worker afecte la compra (ver pruebas en `senau-tickets/test/run.ts`). Pendiente: un selector de tipo de documento en el checkout de `senau-tickets` si la heurística que infiere cédula/documento extranjero no basta (ver ese repo).

**Fase 4 — Producción.** Certificado y numeración reales, `DIAN_ENV=1`, representación gráfica (PDF) enviada al comprador junto con la entrada (hoy no implementada: el correo de `senau-tickets` no incluye la factura, solo las entradas).

## Preguntas abiertas

El brief (`docs/brief-facturacion-electronica.md`) describe el contexto original con el tipo 27; la decisión vigente es tipo 01 (ver arriba). Preguntas que sí afectan el código de este repo, todas para confirmar con un contador o con `npm install` real:

- Nombres exactos de los campos de `generateCufe()`/`buildInvoiceXml()`/`PartySchema`/`InvoiceLineSchema` en `@dian-kit/core` (esta sesión no tuvo acceso a npm para verificarlos contra el paquete instalado; están tomados de leer su código fuente en GitHub).
- Código de responsabilidad fiscal (`fiscalResponsibilities`) para un comprador persona natural — `"R-99-PN"` es el default puesto en el código, sin confirmar.
- Tarifa/código de IVA de las líneas (boletas de espectáculos en vivo — probablemente excluidas, verificar).
- Si la dirección por defecto del comprador (ciudad del venue) es válida para facturar a un comprador identificado sin dirección propia capturada, o si conviene agregar el campo al checkout de `senau-tickets`.
- El checkout de `senau-tickets` captura nombre, correo, teléfono y un documento de identidad en un solo campo de texto libre (sin selector de tipo). `senau-tickets/src/lib/facturacion.ts` infiere el tipo (dígitos → cédula "13", cualquier otra cosa → "42") — confirmar si eso es suficiente o si hace falta pedir el tipo explícitamente.
