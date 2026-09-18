# Brief para desarrollo — Facturación electrónica para Senau Tickets

> Documento de contexto para entregar a un desarrollador o agente que vaya a implementar la emisión de documentos tributarios electrónicos para las ventas de `senau-tickets`. Reúne el contexto de negocio, el marco legal aplicable, las opciones de implementación evaluadas y el detalle técnico necesario para tomar una decisión y ejecutarla sin tener que repetir la investigación.
>
> **Decisión tomada**: la emisión vive en este repo (`facturacion-senau`) como un Worker independiente; `senau-tickets` solo le entrega los pedidos pagados y muestra el estado. Ver sección 9 (arquitectura) y sección 10 (integración).
>
> **⚠️ Actualización posterior (17 de septiembre de 2026, mismo día): cambió el tipo de documento.** Este brief investigó y recomendó el "Documento Equivalente Electrónico — Boleta de ingreso a espectáculos públicos" (tipo 27) como el documento correcto — eso sigue siendo cierto como lectura por defecto de la norma. Pero el Artículo 15 de la Resolución DIAN 165 de 2023 (la misma que crea ese documento equivalente) permite explícitamente expedir en su lugar una **factura electrónica de venta normal (tipo 01)**, y se decidió tomar esa opción porque `@dian-kit/core` la soporta nativamente (evita reconstruir a mano la estructura y el CUDE del tipo 27, que no están resueltos por ninguna librería). El resto de este documento (contexto legal, PULEP, arquitectura de dos Workers) sigue vigente sin cambios — lo único que cambió es qué documento se emite. Ver `README.md` y `src/lib/factura.ts` del repo para el detalle de la decisión y lo que falta confirmar.
>
> Última actualización: 17 de septiembre de 2026.

---

## 1. Resumen ejecutivo

Senau SAS va a vender boletas para su primer concierto (mínimo 100 boletas) a través de `senau-tickets`, una tiquetera propia construida en Cloudflare Worker + D1, con pagos por Bold. Por ley colombiana, esas ventas deben soportarse con un documento tributario electrónico desde la primera boleta vendida — no hay período de gracia por ser empresa nueva.

**El documento que corresponde no es la factura electrónica de venta genérica, sino un documento específico para boletería de espectáculos públicos** ("Documento Equivalente Electrónico — Boleta de ingreso a espectáculos públicos"), que además requiere haber registrado el evento en PULEP (Ministerio de Cultura) para obtener un código de evento.

Hay tres caminos de implementación viables, evaluados en la sección 5. El más alineado con cómo está construido el proyecto (TypeScript, todo en Cloudflare) es desarrollar la emisión con software propio, apoyándose en un SDK open-source ya existente (`dian-kit`) en vez de partir de cero, con ajustes puntuales para correr en el runtime de Cloudflare Workers. Se decidió hacerlo en un Worker y repo separados de la tiquetera para aislar la clave de firma, no bloquear el webhook de pagos y poder reutilizar la parte genérica (tipo de documento 27) fuera de Senau.

---

## 2. Contexto de negocio

- **Empresa**: SENAU SAS, NIT 902.105.968-8, constituida el 2 de septiembre de 2026, con RUT expedido el 15 de septiembre de 2026 (Cámara de Comercio de Medellín, matrícula 2185674812). Actividad económica principal registrada: CIIU 9007 — actividades de espectáculos musicales en vivo.
- **Producto**: `senau-tickets`, tiquetera propia de la banda Senau. Stack: Cloudflare Worker + D1 (SQLite), sin dependencias en tiempo de ejecución (todo TypeScript sobre APIs estándar de Workers). Pagos con **Bold**. Correo transaccional con **Resend**.
- **Dominios**: `tickets.senau.music` (tienda) y `panel-tickets.senau.music` (administración/escáner), separados por Host.
- **Flujo de pago relevante**: al confirmarse el pago (webhook `SALE_APPROVED` de Bold, verificado por firma HMAC), el sistema emite las entradas (QR firmado) y envía un correo de confirmación vía Resend. Ese es el punto natural donde debe engancharse la emisión del documento tributario — mismo trigger, justo después de marcar el pedido como pagado.
- **Archivo clave en la tiquetera**: `src/lib/payments.ts` — orquesta lo que pasa cuando Bold confirma un pago (aplicar el evento, conciliar, enviar correos). Ahí debe añadirse una llamada delgada hacia este Worker (no la emisión en sí).
- **Urgencia**: el primer evento apunta a un mínimo de 100 boletas, lo que descarta cualquier alternativa 100% manual (ver sección 5).

---

## 3. Marco legal aplicable (resumen, no es asesoría legal)

Este resumen se hizo revisando el RUT real de Senau SAS y normativa pública de la DIAN. **Se recomienda que un contador o abogado tributarista confirme la interpretación antes de poner esto en producción**, especialmente el tipo de documento exacto y el plazo de habilitación.

- **RUT de Senau SAS**: en la casilla de "Responsabilidades, Calidades y Atributos" quedó registrado el código **16 — Obligación facturar por ingresos bienes**, asignado por la propia DIAN al momento de crear el RUT. Esto confirma que la sociedad está obligada a expedir factura o documento equivalente desde su primera operación.
- **Estatuto Tributario, art. 615**: obliga a facturar a "todas las personas o entidades que tengan la calidad de comerciantes" — sin el umbral de ingresos que sí aplica a personas naturales. Como sociedad (persona jurídica), Senau SAS no tiene margen de espera por monto de ventas.
- **Estatuto Tributario, art. 616-1**: reconoce la "boleta de ingreso a espectáculos públicos" como **documento equivalente** a la factura, distinto de la factura electrónica de venta genérica.
- **Ley 1493 de 2011** ("ley del espectáculo público"): regula los espectáculos públicos de las artes escénicas — conciertos incluidos — y es el marco bajo el cual aplica este documento equivalente específico.
- **Resolución DIAN 000042 de 2020**: desarrolla el sistema de facturación electrónica en general (proveedores tecnológicos, anexo técnico de factura electrónica de venta, validación previa, sanciones).
- **Resolución DIAN 000165 de 2023**: convierte varios documentos equivalentes en obligatoriamente electrónicos — entre ellos, la boleta de espectáculos públicos —, con un calendario de implementación por grupos durante 2024.
- **Vigencia**: la versión electrónica de este documento es obligatoria desde el **1 de noviembre de 2024**, para todos los organizadores de eventos y cines, sin distinción por tamaño de empresa ni tratamiento especial para negocios nuevos. Conclusión práctica: no hay "período de gracia" por ser Senau SAS una empresa recién constituida — la obligación ya está plenamente vigente para todo el sector.
- **Concepto DIAN 20297**: confirma que vender boletas por internet, a través de una página web, **no obliga** a usar factura electrónica de venta genérica — es válido seguir usando el documento equivalente de boletería, siempre que cumpla los requisitos propios de ese documento.
- **Concepto DIAN 1169 (013246) de 2025**: aclara que un contribuyente puede desarrollar su propio software para facturar/emitir electrónicamente ("software propio"), sin necesitar ninguna certificación adicional más allá de pasar el proceso de habilitación técnica ante la DIAN.
- **Sanciones**: el art. 652-1 del Estatuto Tributario contempla sanciones por no facturar o facturar sin cumplir los requisitos cuando se está obligado a hacerlo.

---

## 4. El documento a emitir

**Tipo**: Documento Equivalente Electrónico — Boleta de ingreso a espectáculos públicos.
**Código de tipo de documento**: 27 (según catálogo de proveedores tecnológicos DIAN).
**Códigos de operación asociados**: 271 (espectáculo público de artes escénicas, estándar), 272 (mismo, por mandato), 273 (otros espectáculos públicos, estándar), 274 (otros espectáculos públicos, por mandato). Para Senau (conciertos, artes escénicas, venta directa) el aplicable es previsiblemente **271**.
**Anexo técnico de referencia**: [Anexo Técnico Documento Equivalente Electrónico V1.0 (DIAN)](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Documento-Equivalente-Electronico-V1-0-final.pdf) — define la extensión `EventInformation` sobre la estructura base UBL para este tipo de documento equivalente.

**Campos requeridos** (a confirmar el detalle exacto contra el anexo técnico y/o el manual de un proveedor al momento de implementar):
- Razón social y NIT del vendedor (Senau SAS).
- Numeración consecutiva interna.
- Fecha y hora de expedición.
- Descripción del servicio (entrada al evento, localidad/zona si aplica).
- Valor total de la operación.
- Nombre del software generador (si aplica).
- **Código PULEP** del evento (ver sección 6).
- Nombre del evento, lugar/venue, localidad o silla asignada si aplica.
- Marca de "cortesía" cuando la entrada es gratuita/de invitación.

**Firma y transporte**: como toda la familia de documentos electrónicos de la DIAN, requiere firma digital avanzada **XAdES-EPES** sobre XML **UBL 2.1**, y transmisión por **SOAP/WS-Security** a los servicios web de la DIAN (no es una API REST/JSON simple). Ver detalle técnico en la sección 7.

---

## 5. Opciones de implementación evaluadas

| Opción | Costo | Automatización | Estado de la investigación |
|---|---|---|---|
| **Portal gratuito DIAN** ("Facturación Gratuita DIAN") | $0 | Nula — un documento a la vez, por formulario web; el módulo de "plantillas" solo prellena campos repetidos, no permite cargar en bulk pedidos con datos distintos. | No se pudo confirmar si el servicio gratuito soporta este tipo específico de documento equivalente (espectáculos públicos) — el sitio de la DIAN trata "Facturación Gratuita" y "Documento Equivalente Electrónico" como secciones separadas. **Pendiente de confirmar directamente con la DIAN.** |
| **Proveedor tecnológico con API (ej. Factus, Plemsi, MisFacturas)** | Bajo (Plemsi desde ~$19.000 COP/mes por 100 documentos; MisFacturas con API desde ~$58.000 COP/mes) | Alta si el proveedor soporta el tipo de documento — se integra en `src/lib/payments.ts` igual que Resend. | **Factus no soporta este tipo de documento** (solo factura de venta, nómina electrónica y documento soporte, según su glosario de API). **MisFacturas sí lista "Boleta de ingreso a espectáculos públicos" como uno de sus 12 tipos de documento equivalente electrónico**, pero su manual de API público revisado no la menciona explícitamente entre los tipos con integración documentada (solo POS, servicios públicos, transporte, peajes) — **hay que confirmar con su soporte si su API cubre este tipo exacto antes de contratar**. |
| **Software propio** (emitir directamente contra los servicios de la DIAN) | $0 recurrente (solo costo de desarrollo) | Total — se integra igual en `payments.ts`, sin depender de un tercero ni pagar por documento. | Legalmente confirmado sin restricciones adicionales (Concepto DIAN 1169/2025). Técnicamente viable en TypeScript apoyándose en el SDK open-source `dian-kit` (ver sección 8), con adaptaciones para correr en Cloudflare Workers (ver sección 9). Es la opción más alineada con cómo está construido el resto del proyecto. |

**Recomendación de la investigación** (no vinculante — decisión de negocio de Nicolás/Senau): dado que ya hay un SDK TypeScript activo y con licencia MIT que implementa la parte más pesada (UBL, XAdES-EPES, CUFE/CUDE, SOAP), la ruta de software propio deja de ser "construir todo desde cero" y pasa a ser "adaptar y extender una base existente" — lo cual reduce bastante el esfuerzo frente a lo que parecía al principio de esta investigación, y elimina cualquier costo recurrente por documento o dependencia de que un proveedor externo soporte el tipo de documento correcto.

---

## 6. Requisito conexo: registro en PULEP

La boleta de espectáculos debe incluir un código de evento asignado por PULEP (Planilla Única de Liquidación de Espectáculos Públicos, plataforma del Ministerio de Cultura: https://pulep.mincultura.gov.co/). Esto es un trámite separado de la DIAN pero necesario para poder emitir el documento tributario correctamente, y probablemente Senau ya lo necesite de todas formas para el permiso del evento en sí (no solo para efectos tributarios). Pasos generales (a verificar contra los instructivos oficiales de PULEP antes del primer evento):

1. Registrarse como "productor" en PULEP.
2. Registrar el evento específico (fecha, lugar, aforo, etc.) para obtener su código.
3. Ese código debe quedar disponible en el sistema de `senau-tickets` para incluirlo en cada documento emitido de ese evento.

Referencias: [Instructivo PULEP — Registro como Productor](https://pulep.mincultura.gov.co/Documents/instructivos/registro_productor.pdf), [Instructivo PULEP — Registro de Evento](https://pulep.mincultura.gov.co/Documents/instructivos/registro_evento.pdf).

---

## 7. Detalle técnico — qué exige la DIAN para software propio

Confirmado contra el Anexo Técnico oficial (v1.0) y el Concepto DIAN 1169/2025:

- **Formato del documento**: XML siguiendo esquemas **UBL 2.1**.
- **Firma digital**: **XAdES-EPES** (XML Advanced Electronic Signature, perfil EPES) obligatoria sobre cada documento, usando un certificado digital calificado emitido por una entidad acreditada por ONAC. Es el mismo estándar que usa la factura electrónica de venta normal — no hay una versión simplificada para documentos equivalentes.
- **Certificados**: se requieren dos — uno para la conexión segura (transporte) y otro para firmar el XML del documento.
- **Transporte**: **SOAP sobre HTTPS con WS-Security**, no REST/JSON. Servicios web relevantes mencionados en el anexo: `SendBillSync` (envío del documento), `GetStatus` / `GetStatusZip` (consulta de estado), y `SendTestSetAsync` para el lote de pruebas del proceso de habilitación.
- **Registro del software en la DIAN**: para software propio hay que registrar el software en el catálogo de participantes de la DIAN, de donde salen un **ID de software** y un **PIN** que viajan en cada documento (el SDK de referencia los pide como `software.id` y `software.pin`).
- **Numeración**: hay que solicitar a la DIAN la **autorización de rangos de numeración** (prefijo, rango inicial/final, fechas de vigencia y **clave técnica**). El SDK los pide como `numbering.*`. Para el ambiente de pruebas la DIAN entrega un rango de prueba (prefijo típico `SETP`).
- **Habilitación**: el software (propio o de terceros) debe pasar por el "ambiente de producción en habilitación" de la DIAN — se envía un set de pruebas y, al aprobarse, se elige la fecha de inicio de emisión electrónica, que actualiza el RUT. No se exige ninguna certificación adicional aparte de pasar estas pruebas (Concepto 1169/2025).
- **CUFE/CUDE**: cada documento lleva un código único calculado como hash SHA-384 sobre los datos del documento, con reglas de truncamiento de valores que especifica la DIAN. Para documentos equivalentes se usa **CUDE**.

---

## 8. SDK de referencia para no partir de cero

Se encontró un SDK open-source activo que ya implementa la mayor parte de este stack técnico en TypeScript. Verificado directamente en su repositorio (README y `package.json` de cada paquete):

- **Repositorio**: [`sergioarojasm98/dian-kit`](https://github.com/sergioarojasm98/dian-kit). Monorepo con dos paquetes npm:
  - **`@dian-kit/core`** (v1.0.1): "Core logic for DIAN electronic invoicing: XML/UBL 2.1, digital signatures, CUFE/CUDE generation". Dependencias: `@xmldom/xmldom`, `fflate`, `node-forge`, `xadesjs`, `xml-core`, `xmlbuilder2`, `xmldsigjs`, `xpath`, `zod`. Todas son librerías JavaScript puras (sin binarios nativos).
  - **`@dian-kit/sdk-node`** (v1.0.1): capa de conveniencia para Node (`DianKit`), depende solo de `@dian-kit/core`.
- **Licencia**: MIT. **Estado**: activo — release 1.0.1 del 9 de abril de 2026, CI/CD, 215 tests.
- **API principal** (`DianKit`): se construye con `certificate` (buffer del `.p12`), `certificatePassword`, `environment` (`"1"` producción, `"2"` pruebas/habilitación), `supplier` (datos del emisor), `software` (`id`, `pin`, `providerNit`, `providerName`) y `numbering` (`authorizationNumber`, `prefix`, `startNumber`, `endNumber`, `startDate`, `endDate`, `technicalKey`). Luego `kit.createInvoice({...})` y `kit.send(doc)` → `{ isValid, statusCode, ... }`.
- **Tipos de documento que cubre hoy**: Factura Electrónica de Venta (01, CUFE), Documento Equivalente POS (102, CUDE), Nota Crédito (91), Nota Débito (92). **No cubre "Boleta de ingreso a espectáculos públicos" (tipo 27)**. La extensión a hacer: un builder de tipo 27 con la extensión `EventInformation`, siguiendo el mismo patrón del tipo 102 (que ya es un documento equivalente con CUDE, así que es el punto de partida más cercano).
- **Requisitos de runtime declarados**: Node.js ≥ 20 con `fetch` y `crypto.webcrypto`. No menciona Workers, Deno ni Bun.
- **Antecedente**: `xadesjs` (PeculiarVentures) — implementación pura TypeScript de XAdES sobre WebCrypto — fue archivado en agosto de 2025 y fusionado en el monorepo `xmldsigjs`; `dian-kit` lo usa como dependencia, así que conviene vigilar esa dependencia.

---

## 9. Arquitectura: Worker separado y consideraciones para Cloudflare Workers

**Decisión**: la emisión vive en un Worker propio (`facturacion-senau`) con su propia base D1 y sus propios secrets. `senau-tickets` no firma ni transmite nada.

Motivos:
- **Aislamiento de la clave de firma**: la clave privada del certificado solo existe en este Worker. La tiquetera, que recibe pagos y es la superficie pública, nunca la toca.
- **No bloquear el webhook de Bold**: firmar XML y esperar a la DIAN es trabajo de CPU y latencia externa. La tiquetera solo entrega el pedido y sigue con la emisión de entradas.
- **Reutilización**: el builder del tipo 27 y la adaptación a Workers son genéricos; como repo aparte se pueden versionar, publicar o contribuir upstream a `dian-kit`.

Comunicación entre Workers: **service binding** (`senau-tickets` → `facturacion-senau`) para llamadas internas sin salir a Internet, con reintentos por cola (Cloudflare Queues) o por cron para los documentos que fallen. La tiquetera consulta el estado por el mismo binding para mostrarlo en el panel.

Consideraciones técnicas específicas de Workers:
- **WebCrypto sí está** (`crypto.subtle`), que es lo que `xadesjs`/`xmldsigjs` usan por debajo. Buena base.
- **Certificado `.p12`**: no parsearlo en tiempo de ejecución. Extraer una sola vez (fuera del Worker, con `openssl`, ver `scripts/extract-cert.sh`) la clave privada y el certificado en PEM, y guardarlos como secrets de Wrangler. En tiempo de ejecución se importa la clave con `crypto.subtle.importKey` (PKCS#8), que sí es compatible con Workers. Esto además evita depender de `node-forge` para PKCS#12 en el runtime.
- **`nodejs_compat`**: activar el flag en `wrangler.toml` para que el bundler resuelva `node:buffer`, `node:crypto` y similares que las dependencias de `@dian-kit/core` puedan tocar. Es probable que `@dian-kit/core` empaquete y corra en Workers con esto; **hay que validarlo con un spike** antes de asumirlo (ver plan en README). Si alguna dependencia no corre, la alternativa es reimplementar esa pieza sobre `xmldsigjs` directamente, o correr solo la firma en un microservicio Node mínimo.
- **CPU time**: medir el tiempo de firma + armado SOAP con un documento real. Si se acerca al límite del plan de Workers, mover la emisión al consumidor de cola (ya previsto) en vez de hacerla en la petición HTTP.
- **Sin filesystem**: nada de `readFileSync`; toda configuración por variables y secrets.

---

## 10. Integración con `senau-tickets`

Del lado de la tiquetera el cambio es pequeño y vive en `src/lib/payments.ts`, justo después de que un pedido queda marcado como pagado (webhook `SALE_APPROVED` verificado o conciliación exitosa con la API de Bold), en el mismo punto donde hoy se dispara el correo con Resend:

1. Llamar por service binding a `POST /documents` de este Worker con los datos del pedido ya confirmados (id de pedido, comprador, valor, ítems, evento y código PULEP).
2. Guardar en la tiquetera solo la referencia (`document_id`) y el estado, para mostrarlo en el panel y permitir "Reintentar".
3. **Nunca bloquear la entrega de la entrada**: si este Worker no responde, el pedido queda con documento "pendiente" y se reintenta después (cola/cron). Mismo criterio que ya aplica la tiquetera con el correo.

Del lado de este Worker, el contrato de la API interna está descrito en el README y en `src/types.ts`.

---
## 11. Preguntas abiertas antes o durante el desarrollo

Estas son cosas que esta investigación no pudo cerrar del todo y que el desarrollador o Nicolás deberían confirmar:

1. ¿El portal gratuito de la DIAN soporta emitir "Documento Equivalente Electrónico — Boleta de espectáculos públicos", o solo factura de venta y notas? (Confirmar directamente con la DIAN o con la funcionaria que gestionó el RUT.)
2. ¿La API de MisFacturas cubre efectivamente este tipo de documento, o solo lo ofrecen por interfaz web? (Confirmar con su soporte antes de contratar el plan con API.)
3. ¿Cuál es el código de operación exacto que le corresponde a Senau dentro del tipo 27 (271 vs. 273)? Depende de si la venta se hace de forma directa o por mandato.
4. Plazo exacto, en días, entre completar la habilitación y poder emitir en producción — no encontré un número fijo documentado; en la práctica, otros proveedores mencionan procesos de habilitación de 3 a 10 días hábiles.
5. Trámite y tiempos de PULEP para el primer evento (para no dejarlo para última hora).
6. Confirmar con un contador si aplica el código de operación 271 o 273, y si hay algún tratamiento particular por ser Senau SAS una sociedad recién constituida (aunque toda la evidencia recogida indica que no lo hay).

---

## 12. Fuentes principales

- [RUT de Senau SAS (documento propio, no público)]
- [Anexo Técnico Documento Equivalente Electrónico V1.0 — DIAN](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Documento-Equivalente-Electronico-V1-0-final.pdf)
- [Documento Equivalente Electrónico — Micrositio DIAN](https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/documento-equivalente-electronico/)
- [Documento equivalente: boleta de ingreso a espectáculos públicos — Estela](https://blog.estela.com/colombia/documento-equivalente-boleta-de-ingreso-a-espectaculos-publicos)
- [Obligatoriedad boletas de espectáculos públicos (vigencia 1 nov 2024) — Estela](https://blog.estela.com/colombia/obligatoriedad-boletas-espectaculos-publicos)
- [Concepto DIAN 20297 — Facturación venta de boletas por internet — Accounter](https://accounter.co/normatividad/conceptos/facturacion-concepto-20297-facturacion-venta-boletas-por-internet-a-traves-de-una-pagina-web.html)
- [Requisitos técnicos software propio — Concepto DIAN 1169(013246) — CR Consultores](https://crconsultorescolombia.com/requisitos-tecnicos-para-el-software-propio-o-adquirido-en-la-habilitacion-como-facturador-electronico-dian-concepto-1169013246.php)
- [Documento Equivalente Electrónico — Centro de ayuda MisFacturas](https://soporte.misfacturas.com.co/hc/es-419/articles/24570295576340-Documento-Equivalente-Electr%C3%B3nico)
- [Introducción a Factus API](https://developers.factus.com.co/) y [glosario Factus](https://developers.factus.com.co/glosario)
- [Paquetes de Facturación Electrónica — Plemsi](https://plemsi.com/precios-facturacion-electronica/)
- [Tablas de códigos — Documentos Equivalentes Electrónicos — HKA](https://felcowiki.thefactoryhka.com.co/index.php/Tablas_de_c%C3%B3digos_de_propiedades_para_emisi%C3%B3n_de_Documentos_Equivalentes_Electr%C3%B3nicos_-_Indice_del_Manual_Integraci%C3%B3n_Directa_HKA_Documentos_Equivalentes_Electr%C3%B3nicos)
- [`dian-kit` — SDK open-source TypeScript](https://github.com/sergioarojasm98/dian-kit)
- [`xadesjs` (archivado, fusionado en xmldsigjs)](https://github.com/PeculiarVentures/xadesjs)
- [PULEP — Ministerio de Cultura](https://pulep.mincultura.gov.co/)
- [¿Quiénes están obligados a facturar? — Gerencie.com](https://www.gerencie.com/obligados-a-facturar.html)

---

*Este documento resume investigación hecha con fuentes públicas y el RUT real de Senau SAS, pero no reemplaza la revisión de un contador o abogado tributarista antes de poner esto en producción — especialmente en cuanto al tipo de documento exacto, el código de operación y los plazos de habilitación.*
