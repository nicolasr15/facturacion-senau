/**
 * Firma XAdES-EPES y transporte SOAP/WS-Security contra la DIAN, vía @dian-kit/core.
 *
 * Servicios web (anexo técnico, sección 9):
 *   - SendBillSync   → envía un documento y recibe validación síncrona
 *   - GetStatus      → consulta estado por CUFE (trackId)
 *   - GetStatusZip   → consulta estado por zip (lotes)
 *   - SendTestSetAsync → set de pruebas del proceso de habilitación (opción `method`/`testSetId`)
 *
 * Ambientes: config.environment "2" = habilitación/pruebas, "1" = producción.
 *
 * Firmas usadas (transcritas del código fuente de dian-kit, packages/core/src/security/signer.ts
 * y transport/types.ts — confirmar con `npm run typecheck` al instalar):
 *   signXml({ xml, certificate: CertificateData, signingTime? })      → { signedXml }
 *   sendBill({ signedXml, supplierNit, documentNumber, auth: { certificate }, environment,
 *              method?, testSetId?, timeoutMs? })                    → DianSendResponse
 *   getStatus({ trackId, auth: { certificate }, environment, timeoutMs? }) → DianStatusResponse
 *   sendBill comprime el XML en zip internamente (fflate); recibe el XML plano.
 *
 * ── Compatibilidad con Workers (Fase 0) — pendiente de ejecutar de verdad ──
 * signXml() llama internamente `xadesjs.Application.setEngine("NodeJS", webcrypto)`
 * con el `webcrypto` de `node:crypto`. Con `nodejs_compat` Workers expone
 * `node:crypto` (incluido `webcrypto`), y las dependencias de dian-kit son JS
 * puro (xmldom, node-forge, xmldsigjs, xmlbuilder2, fflate, zod). Todo apunta a
 * que empaqueta y firma, pero NO se pudo correr `wrangler dev` en la sesión que
 * escribió esto (sin acceso a npm). Validar con: `npm install && npx wrangler dev`
 * y un POST /documents de prueba con DIAN_ENV=2. Si falla por un módulo de Node
 * no soportado, el plan B es correr este mismo código como script de Node
 * (node:sqlite en vez de D1) — la lógica no cambia.
 */

import {
  DianTransportError,
  getStatus as dianGetStatus,
  getStatusZip,
  sendBill,
  signXml,
  type CertificateData,
  type DianSendResponse,
  type DianStatusResponse,
} from "@dian-kit/core";
import type { DianSendResult } from "../types";
import type { EmitterConfig } from "./config";

const TIMEOUT_MS = 25_000; // por debajo del límite del consumidor de cola

export async function sign(xml: string, certificate: CertificateData, signingTime = new Date()): Promise<string> {
  const { signedXml } = await signXml({ xml, certificate, signingTime });
  return signedXml;
}

function describeErrors(errors: Array<{ code: string; description: string }>): string {
  return errors.map((e) => `${e.code}: ${e.description}`).join(" | ");
}

/**
 * Mapea la respuesta de la DIAN a nuestro resultado. Reglas:
 *   - isValid → accepted.
 *   - Respuesta de la DIAN con errores de validación (reglas del anexo) → rejected:
 *     reintentar sin corregir el documento no sirve.
 *   - Error de transporte/red/timeout (DianTransportError) → failed: reintentable.
 */
function fromDian(r: DianSendResponse | DianStatusResponse, cufe: string | null): DianSendResult {
  const errors = r.errors ?? [];
  const description = errors.length ? `${r.statusDescription} — ${describeErrors(errors)}` : r.statusDescription;
  return {
    isValid: r.isValid,
    statusCode: r.statusCode ?? "",
    statusDescription: description ?? "",
    errors,
    cufe: ("trackId" in r && r.trackId) || cufe,
    raw: r.rawResponse,
    rejected: !r.isValid,
  };
}

function fromError(e: unknown): DianSendResult {
  const kind = e instanceof DianTransportError ? "transporte" : "inesperado";
  return {
    isValid: false,
    statusCode: "",
    statusDescription: `Error de ${kind}: ${(e as Error).message ?? String(e)}`,
    errors: [],
    cufe: null,
    raw: String(e),
    // Error de red/SOAP → failed (reintentable). Cualquier otra excepción
    // también se trata como failed para que quede visible y reintentable.
    rejected: false,
  };
}

/**
 * true si la DIAN respondió (no fue error de red) "no válido" pero sin errores de
 * regla: típicamente "documento no encontrado" al consultar por CUFE — hay que
 * reenviarlo, no marcarlo rechazado.
 */
export function isUnknownToDian(r: DianSendResult): boolean {
  return !r.isValid && r.statusCode !== "" && r.errors.length === 0;
}

export async function sendBillSync(
  signedXml: string,
  documentNumber: string,
  cufe: string,
  config: EmitterConfig,
  certificate: CertificateData,
): Promise<DianSendResult> {
  try {
    const response = await sendBill({
      signedXml,
      supplierNit: config.supplier.nit,
      documentNumber,
      auth: { certificate },
      environment: config.environment,
      timeoutMs: TIMEOUT_MS,
    });
    return fromDian(response, cufe);
  } catch (e) {
    return fromError(e);
  }
}

export async function getStatus(cufe: string, config: EmitterConfig, certificate: CertificateData): Promise<DianSendResult> {
  try {
    const response = await dianGetStatus({
      trackId: cufe,
      auth: { certificate },
      environment: config.environment,
      timeoutMs: TIMEOUT_MS,
    });
    return fromDian(response, cufe);
  } catch (e) {
    return fromError(e);
  }
}

// Para lotes / set de pruebas de habilitación, si hace falta más adelante.
export { getStatusZip };
