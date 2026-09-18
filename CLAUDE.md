# Instrucciones para el agente que desarrolle este repo

Este repo es el Worker de **emisión de documentos tributarios electrónicos** (DIAN, Colombia) para las ventas de boletería de Senau SAS. Es un proyecto nuevo: lo que hay es un esqueleto con la arquitectura decidida, los contratos y los puntos donde falta el trabajo real.

## Antes de escribir código

1. Lee completo `docs/brief-facturacion-electronica.md`. Contiene el contexto legal e investigación original con el tipo 27 (documento equivalente de espectáculos) — útil para entender el marco general, pero la **decisión vigente cambió**: se factura con tipo 01 (factura electrónica de venta normal), no con el tipo 27. Ver el porqué en la cabecera de `README.md` y de `src/lib/factura.ts` (Artículo 15, Resolución DIAN 165/2023: expedir factura electrónica en vez del documento equivalente es una opción explícita de la norma).
2. Lee `README.md` (cómo corre el proyecto, contrato de la API interna, plan por fases).
3. Lee `src/types.ts` (contratos) y los `TODO` en `src/lib/*.ts`.
4. `npm install` real y `npm run typecheck` — confirma contra el paquete instalado los nombres de campos usados en `src/lib/factura.ts` (`generateCufe`, `buildInvoiceXml`, `PartySchema`, `InvoiceLineSchema`) y en `src/lib/dian.ts` (`signXml`, `sendBill`/`sendBillSync`, `getStatus`, `getStatusZip`). Ya están implementados (no son solo esqueleto), pero los nombres/formas exactas de esas funciones se sacaron de leer el código fuente de dian-kit en GitHub, sin acceso a npm en la sesión donde se escribieron — no asumas que ya están verificados contra el paquete real instalado.
5. Confirma con un contador antes de emitir en producción: código de responsabilidad fiscal del comprador persona natural (`fiscalResponsibilities`, hoy con el default `"R-99-PN"` sin confirmar), tarifa/código de IVA de las boletas de espectáculos en vivo, y si la dirección por defecto del comprador (`DEFAULT_BUYER_CITY_CODE`/`DEPT_CODE`) es válida o hace falta pedir ciudad en el checkout de `senau-tickets` (hoy solo captura cédula, correo y nombre).

## Reglas del proyecto

- **TypeScript estricto, ESM, Cloudflare Workers.** Nada de `fs`, `path`, `process.env`; toda configuración viene de `env` (vars y secrets de Wrangler).
- **La clave privada nunca se parsea desde `.p12` en tiempo de ejecución.** Se importa desde secrets en PEM/PKCS#8 con `crypto.subtle.importKey` (ver `src/lib/cert.ts` y `scripts/extract-cert.sh`).
- **Ningún fallo de la DIAN puede propagarse como error a `senau-tickets`.** La API interna responde rápido; la emisión real ocurre en el consumidor de cola con reintentos. Un documento fallido queda en estado `failed` con el motivo, visible y reintentable.
- **Idempotencia:** el mismo `order_id` nunca produce dos documentos. La tabla `documents` tiene `UNIQUE(order_id)`; una segunda petición devuelve el existente.
- **No romper el contrato de `src/types.ts` sin actualizar el README** (es lo que consume la tiquetera).
- **Sin datos reales en tests.** Usa el ambiente de pruebas de la DIAN (`DIAN_ENV=2`) y el rango de numeración de pruebas.
- Mantén el estilo del repo hermano `senau-tickets`: sin dependencias de runtime innecesarias, seguridad por defecto, pruebas end-to-end con `tsx test/run.ts`.

## Orden de trabajo sugerido (ver "Plan por fases" en el README)

Fase 0 (spike de compatibilidad con Workers) va **antes** de cualquier otra cosa: si `@dian-kit/core` no empaqueta o no firma dentro de Workers, la arquitectura cambia y no vale la pena avanzar en el resto hasta saberlo.

## Definición de hecho

- `npm run typecheck` y `npm test` en verde. (Hecho en esta sesión sin `npm install` real — ver punto 4 arriba.)
- Una factura tipo 01 de prueba aceptada por la DIAN en ambiente de habilitación (`isValid: true`), con su CUFE guardado en D1. (Pendiente: requiere certificado, software y numeración reales de la DIAN.)
- `senau-tickets` crea un documento automáticamente al confirmarse el pago y puede consultar su estado por service binding (contrato del README). (Hecho: `senau-tickets/src/lib/facturacion.ts` + `payments.ts`.)
- README actualizado con lo que quedó pendiente. (Hecho.)
