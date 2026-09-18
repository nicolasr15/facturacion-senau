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
src/lib/notas.ts          igual que factura.ts pero para nota crédito (91) y nota débito (92): CUDE, billingReference, discrepancyResponse
src/lib/dian.ts           firma XAdES-EPES y transporte (signXml, sendBill, getStatus) contra @dian-kit/core
src/lib/store.ts          acceso a D1 (tabla documents): idempotencia, numeración atómica, reintentos, conciliación
migrations/0001_documents.sql
migrations/0002_notes.sql relaja UNIQUE(order_id) a UNIQUE(order_id, document_type) + columnas de notas (ref_*, issued_at)
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

**`POST /documents/:order_id/void`** — anula la factura de un pedido: emite una nota crédito (tipo 91) de anulación total, referenciando la factura **aceptada** de ese `order_id` (la busca sola en `documents`; no hace falta mandarle número/CUFE). `409` si no hay ninguna factura aceptada todavía para ese pedido (nada que anular). Es el único camino de producción para notas crédito — pensado para llamarse justo después de anular un pedido en `senau-tickets` (`voidOrder`).

```jsonc
{ "reason_code": "2", "reason": "Anulación del pedido O-2026-000123" }   // ambos opcionales; default reason_code "2" (anulación de factura)
```

**`POST /notes`** — nota crédito o débito "cruda", con todos los datos explícitos (comprador, líneas, `billing_reference`, motivo). **Solo para el script de generación del set de pruebas de habilitación** (ver "Notas crédito y débito" abajo) — en producción se usa `/documents/:order_id/void`.

```jsonc
{
  "note_type": "91",                                    // "91" nota crédito, "92" nota débito
  "request": { /* misma forma que POST /documents */ },
  "billing_reference": { "id": "SETP990000001", "cufe": "…", "issue_date": "2026-10-03T21:14:05-05:00" },
  "reason_code": "1",                                    // crédito: 1 devolución parcial · 2 anulación · 3 rebaja · 4 ajuste precio. débito: 1 intereses · 2 incremento precio · 3 otros
  "reason": "Devolución parcial de 2 entradas"
}
```

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

**Fase 1 — Factura tipo 01. Código listo.** `src/lib/factura.ts` mapea `DocumentRequest` al `DianDocument` de dian-kit (comprador, líneas, totales, hora de Colombia) y llama a `generateCufe()` + `buildInvoiceXml()` — nombres de campos tomados del código fuente en GitHub (ver Fase 0), sin confirmar contra el paquete instalado de verdad. Confirmado por el contador y ya implementado: el código de responsabilidad fiscal del comprador persona natural (`"R-99-PN"`), que la boletería va EXCLUIDA de IVA — no exenta al 0% (`taxScheme NO_APLICA` en vez de `IVA`, ver cabecera de `factura.ts`) — y el código de responsabilidad fiscal de Senau SAS como emisor (`NO_APLICA`/"ZZ", verificado contra las casillas reales del RUT de la empresa). También confirmado y ya implementado: la dirección del comprador va fija en "No informada" (el campo de calle es texto libre; ciudad/departamento siguen siendo los del emisor por defecto porque son campos con código DANE obligatorio — ver `config.ts`).

**Fase 2 — Transporte y habilitación. Código listo, falta ejecutarlo contra la DIAN de verdad.** `src/lib/dian.ts` ya firma (XAdES-EPES vía `signXml`) y transmite (`sendBill`/`sendBillSync`, `getStatus`) contra el ambiente de pruebas (`DIAN_ENV=2`); `src/index.ts` guarda el XML firmado y el CUFE en D1 antes de enviar (auditoría, y para poder reenviar el mismo documento si el envío queda a medias). Falta enviar el set de pruebas de habilitación real — requiere el certificado, el software registrado y la numeración autorizada (ver "Datos que hay que conseguir en la DIAN" arriba).

**Fase 3 — Integración. Hecho.** `src/lib/facturacion.ts` en `senau-tickets` arma la petición (`buildInvoiceRequest`) y nunca deja que un fallo de este Worker afecte la compra. El checkout de `senau-tickets` ya tiene un selector real de tipo de documento (CC/CE/TI/PP, `src/lib/doc-types.ts`), así que `id_type`/`id_number` ya no se infieren de un heurístico — se traducen directo a los códigos DIAN (ver `idTypeFor()`). `senau-tickets/src/lib/payments.ts` llama a `scheduleInvoice()` al aprobarse el pago (webhook de Bold o conciliación) — se había desconectado en un rediseño del flujo de pagos (2026-09-18, ver "Notas crédito y débito" abajo) y se reconectó junto con `issueVoidCreditNote`.

**Fase 3.5 — Notas crédito y débito. Hecho.** Ver sección propia más abajo.

**Fase 4 — Producción.** Certificado y numeración reales, `DIAN_ENV=1`, representación gráfica (PDF) enviada al comprador junto con la entrada (hoy no implementada: el correo de `senau-tickets` no incluye la factura, solo las entradas).

## Notas crédito y débito

`src/lib/notas.ts` construye nota crédito (tipo 91) y nota débito (tipo 92) con el mismo patrón que `factura.ts` — mismo `DianDocumentSchema`, mismo `generateCufe()` (internamente calcula CUDE en vez de CUFE según el tipo de documento), `buildCreditNoteXml()`/`buildDebitNoteXml()` en vez de `buildInvoiceXml()`. Nombres/formas verificados leyendo el código fuente de `sergioarojasm98/dian-kit` en GitHub (`packages/core/src/{constants/document-types.ts,schemas/common.schema.ts,security/cufe.ts,xml/builder.ts}` y `examples/credit-note.ts`) — sigue sin poder confirmarse contra un `npm install` real en esta sesión (mismo problema que con `factura.ts`).

**Por qué existen:**
- **Nota crédito**: único caso con uso real en producción — anular la factura de un pedido cancelado (`POST /documents/:order_id/void`, ver arriba). La DIAN no permite "anular" una factura aceptada sin más: el Decreto 1074/2015 art. 2.2.2.53.4 solo permite la anulación simple *antes* de que la operación se dé por completada; una vez aceptada (o simplemente una vez el pedido ya se cobró y entregó), la única vía es una nota crédito con `responseCode "2"` (anulación de factura) — confirmado también en un concepto de la propia DIAN: *"la anulación de la factura de venta podrá efectuarse cuando la operación económica que se soporta no se lleva a cabo"* y *"no es posible anular la factura... cuando la operación... se efectúa"*. `senau-tickets` tiene dos caminos para cancelar un pedido pagado (`src/lib/payments.ts`, `cancelOrder()`): `void` inmediato en Bold (mismo día, antes de 9 PM) o solicitud de `refund` (Bold la aprueba después). En los dos las entradas se invalidan de una vez, pero `issueVoidCreditNote()` NO se dispara en el mismo momento en los dos casos — importa cuándo Bold ya confirmó de verdad:
  - **`void`**: Bold ya respondió `ok` en el momento (`voidPayment()` es síncrono) — se emite la nota crédito ahí mismo, en `cancelOrder()`.
  - **`refund`**: `refundPayment()` solo *solicita* el reembolso; Bold puede rechazarlo después (el pedido queda `refund_pending` hasta que el cron `reconcileRefunds()` lo resuelve). Emitir la nota crédito ahí sería declararle a la DIAN una devolución que Bold todavía podría no aprobar — por eso se dispara en `reconcileRefunds()`, solo cuando Bold confirma `APPROVED` (`resolveRefund(..., true)`), no al pedirlo.

  También queda enganchada en el webhook `VOID_APPROVED` de Bold por si alguien anula el pago desde el panel de Bold en vez del botón de acá (idempotente: si ya se procesó por `cancelOrder`, `voidOrder()` no vuelve a encontrar el pedido en `paid` y no se duplica).
- **Nota débito**: SIN uso de producción en Senau (no hay caso de negocio: no se cobran intereses ni se sube el precio de una boleta ya vendida). Existe solo para poder cumplir el set de pruebas de habilitación (ver abajo).

**Set de pruebas de habilitación (modalidad "Software propio"):** la DIAN exige enviar **60 facturas + 20 notas crédito + 20 notas débito** de prueba antes de habilitar el software (no 8/1/1 ni otras cifras menores que dan algunos proveedores externos como Alegra — esas parecen aplicar a otra modalidad). Se envían **por web service** (SOAP, el mismo canal que producción, ambiente `DIAN_ENV=2`) — no hace falta que salgan de compras simuladas reales en `senau-tickets`; un script que llame directo a `POST /documents` y `POST /notes` con datos ficticios es la vía normal y esperada. Ese script todavía no se escribió (no tiene sentido sin certificado real cargado) — cuando llegue el certificado, generarlo reutilizando `POST /notes` con `order_id` ficticios distintos por documento (la idempotencia es por `order_id` + tipo).

**Confirmado ("CONTADOR"):** las notas crédito/débito NO necesitan una numeración autorizada por la DIAN aparte de la de la factura — un consecutivo interno propio administrado por el software basta (solo facturas de venta y documentos soporte están sujetos a autorización de rangos). `notas.ts` reutiliza la numeración de la factura por defecto (igual que el ejemplo oficial de `dian-kit`), lo cual ya cumple la norma sin cambios; el mecanismo `DIAN_NOTES_NUMBERING_*` en `wrangler.toml`/`config.ts` queda solo por si en algún momento se prefiere un prefijo propio por razones administrativas, no porque haga falta.

## Preguntas abiertas

El brief (`docs/brief-facturacion-electronica.md`) describe el contexto original con el tipo 27; la decisión vigente es tipo 01 (ver arriba). Preguntas que sí afectan el código de este repo, todas para confirmar con un contador o con `npm install` real:

- Nombres exactos de los campos de `generateCufe()`/`buildInvoiceXml()`/`PartySchema`/`InvoiceLineSchema` en `@dian-kit/core` (esta sesión no tuvo acceso a npm para verificarlos contra el paquete instalado; están tomados de leer su código fuente en GitHub).
- ~~Código de responsabilidad fiscal (`fiscalResponsibilities`) para un comprador persona natural~~ — resuelto: `"R-99-PN"` confirmado por el contador, es el estándar del anexo técnico de la DIAN para personas naturales consumidor final.
- ~~Tarifa/código de IVA de las líneas (boletas de espectáculos en vivo)~~ — resuelto: EXCLUIDA de IVA (Ley 1493/2011), no exenta al 0% — confirmado por el contador e implementado (`taxScheme NO_APLICA` en vez de `IVA`, ver `src/lib/factura.ts`).
- ~~Si la dirección por defecto del comprador (ciudad del venue) es válida para facturar a un comprador identificado sin dirección propia capturada~~ — resuelto: la calle del comprador va fija en "No informada" (procedimiento formal correcto para datos ausentes, confirmado por el contador); ciudad/departamento siguen usando los del emisor por defecto porque el schema exige un código DANE válido ahí, no admite texto libre. Ver `src/lib/config.ts`.
- ~~El checkout de `senau-tickets` no tenía selector de tipo de documento~~ — resuelto: ahora captura CC/CE/TI/PP explícitamente (`senau-tickets/src/lib/doc-types.ts`) y `senau-tickets/src/lib/facturacion.ts` los traduce directo a los códigos DIAN, sin heurística (el heurístico solo sigue aplicando como respaldo para pedidos de antes de esa migración, que quedaron con `buyer_doc_type` en null).
- ~~Código de responsabilidad fiscal de Senau SAS como emisor (según su RUT)~~ — resuelto: el RUT real de Senau SAS tiene marcadas las casillas 05, 07, 14, 16, 42 y 55 (renta régimen ordinario, retención en la fuente, informante de exógena, obligado a facturar bienes/servicios EXCLUIDOS de IVA —confirma independientemente el punto de arriba—, obligado a llevar contabilidad, informante de beneficiarios finales). Ninguna es 13/15/23/47/48 (gran contribuyente, autorretenedor, agente de retención IVA, régimen simple, responsable de IVA), que son los únicos códigos de este catálogo con un valor `O-xx` propio en el anexo técnico 1.9 de factura electrónica — así que `FiscalResponsibility.NO_APLICA` ("ZZ"), que ya era el default en el código, es el correcto. Ver `src/lib/factura.ts`.
- ~~Si las notas crédito/débito necesitan numeración autorizada por la DIAN aparte de la factura~~ — resuelto: NO la necesitan, un consecutivo interno propio basta (ver "Notas crédito y débito" arriba).
- ~~Por qué `senau-tickets/src/lib/payments.ts` dejó de llamar a `scheduleInvoice()`~~ — resuelto: se había desconectado al reescribir el flujo de pagos (2026-09-18), se reconectó junto con `issueVoidCreditNote`.
