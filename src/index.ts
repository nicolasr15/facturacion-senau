/**
 * Entrada del Worker.
 *
 *  - fetch:     API interna (service binding desde senau-tickets)
 *  - queue:     consumidor de la cola de emisión (firma + envío a la DIAN)
 *  - scheduled: cron de reintentos para `failed` con intentos disponibles
 */

import type { DocumentRequest, EmisionMessage, Env, RawNoteRequest, VoidRequest } from "./types";
import type { CertificateData } from "@dian-kit/core";
import { loadConfig, numberingFor } from "./lib/config";
import { assertValidNow, loadCertificateData } from "./lib/cert";
import * as store from "./lib/store";
import * as factura from "./lib/factura";
import * as notas from "./lib/notas";
import * as dian from "./lib/dian";

// El certificado se parsea una vez por instancia del Worker (los secrets no cambian en caliente).
let certificatePromise: Promise<CertificateData> | null = null;
function certificate(env: Env): Promise<CertificateData> {
  certificatePromise ??= loadCertificateData(env.SIGNING_KEY_PEM, env.SIGNING_CERT_PEM).catch((e) => {
    certificatePromise = null; // que el siguiente intento vuelva a probar
    throw e;
  });
  return certificatePromise;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  const key = req.headers.get("x-internal-key") ?? "";
  return env.INTERNAL_KEY.length > 0 && timingSafeEqual(key, env.INTERNAL_KEY);
}

/** Validación mínima de forma del cuerpo; la de negocio está en factura.validateRequest. */
function parseRequest(body: unknown): DocumentRequest {
  const b = body as Partial<DocumentRequest>;
  if (!b || typeof b !== "object") throw new Error("Cuerpo inválido");
  if (typeof b.order_id !== "string" || !b.order_id) throw new Error("order_id requerido");
  if (!b.buyer || typeof b.buyer.email !== "string") throw new Error("buyer.email requerido");
  if (!b.buyer || typeof b.buyer.id_number !== "string" || !b.buyer.id_number) {
    throw new Error("buyer.id_number requerido (factura electrónica exige identificar al comprador)");
  }
  if (!b.event) throw new Error("event requerido");
  if (!Array.isArray(b.lines)) throw new Error("lines requerido");
  if (!b.totals || typeof b.totals.total !== "number") throw new Error("totals.total requerido");
  return b as DocumentRequest;
}

function parseRawNoteRequest(body: unknown): RawNoteRequest {
  const b = body as Partial<RawNoteRequest>;
  if (!b || typeof b !== "object") throw new Error("Cuerpo inválido");
  if (b.note_type !== "91" && b.note_type !== "92") throw new Error('note_type debe ser "91" o "92"');
  if (!b.billing_reference?.id || !b.billing_reference?.cufe || !b.billing_reference?.issue_date) {
    throw new Error("billing_reference.{id,cufe,issue_date} requeridos");
  }
  if (!b.reason_code) throw new Error("reason_code requerido");
  if (!b.reason) throw new Error("reason requerido");
  const request = parseRequest(b.request);
  return { note_type: b.note_type, request, billing_reference: b.billing_reference, reason_code: b.reason_code, reason: b.reason };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return json({ error: "no autorizado" }, 401);

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // POST /notes — nota crédito/débito "cruda" (datos explícitos), SOLO para el
    // script de generación del set de pruebas de habilitación DIAN. El único
    // camino de producción es POST /documents/:order_id/void (más abajo).
    if (parts[0] === "notes" && parts.length === 1 && request.method === "POST") {
      let req: RawNoteRequest;
      try {
        req = parseRawNoteRequest(await request.json());
        factura.validateRequest(req.request);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      const { record, created } = await store.createQueued(env.DB, req.request, req.note_type, {
        documentId: "",
        number: req.billing_reference.id,
        cufe: req.billing_reference.cufe,
        issueDate: req.billing_reference.issue_date,
        reasonCode: req.reason_code,
        reason: req.reason,
      });
      if (created) await env.EMISION.send({ document_id: record.id });
      return json(store.toView(record), created ? 202 : 200);
    }

    if (parts[0] !== "documents") return json({ error: "no encontrado" }, 404);

    // POST /documents
    if (parts.length === 1 && request.method === "POST") {
      let req: DocumentRequest;
      try {
        req = parseRequest(await request.json());
        factura.validateRequest(req);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      const { record, created } = await store.createQueued(env.DB, req, "01");
      if (created) await env.EMISION.send({ document_id: record.id });
      return json(store.toView(record), created ? 202 : 200);
    }

    // GET /documents/:id
    if (parts.length === 2 && request.method === "GET") {
      const record = await store.findById(env.DB, parts[1]!);
      return record ? json(store.toView(record)) : json({ error: "no encontrado" }, 404);
    }

    // POST /documents/:id/retry
    if (parts.length === 3 && parts[2] === "retry" && request.method === "POST") {
      const id = parts[1]!;
      const ok = await store.requeue(env.DB, id);
      if (!ok) return json({ error: "no está en failed/rejected" }, 409);
      await env.EMISION.send({ document_id: id });
      const record = await store.findById(env.DB, id);
      return json(record ? store.toView(record) : { document_id: id, status: "queued" }, 202);
    }

    // POST /documents/:order_id/void — anula la factura de un pedido: emite una
    // nota crédito (91) de anulación total (responseCode "2" por defecto),
    // referenciando la factura ACEPTADA de ese pedido. Único camino de
    // producción para notas crédito (ver senau-tickets `voidOrder`).
    if (parts.length === 3 && parts[2] === "void" && request.method === "POST") {
      const orderId = parts[1]!;
      let body: VoidRequest = {};
      try {
        const raw = await request.text();
        if (raw) body = JSON.parse(raw) as VoidRequest;
      } catch {
        return json({ error: "cuerpo inválido" }, 400);
      }

      const original = await store.findByOrderAndType(env.DB, orderId, "01");
      if (!original || original.status !== "accepted" || !original.number || !original.cufe || !original.issued_at) {
        return json({ error: "no hay factura ACEPTADA para este pedido (nada que anular todavía)" }, 409);
      }

      const originalRequest = JSON.parse(original.request_json) as DocumentRequest;
      const reasonCode = body.reason_code ?? "2"; // "2" = anulación de factura
      const reason = body.reason ?? `Anulación del pedido ${orderId}`;

      const { record, created } = await store.createQueued(env.DB, originalRequest, "91", {
        documentId: original.id,
        number: original.number,
        cufe: original.cufe,
        issueDate: original.issued_at,
        reasonCode,
        reason,
      });
      if (created) await env.EMISION.send({ document_id: record.id });
      return json(store.toView(record), created ? 202 : 200);
    }

    return json({ error: "método no permitido" }, 405);
  },

  async queue(batch: MessageBatch<EmisionMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await emit(msg.body.document_id, env);
        msg.ack();
      } catch (e) {
        // Error inesperado fuera de emit(): reintento por la cola.
        console.error("emision", msg.body.document_id, e);
        msg.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const config = loadConfig(env);

    // 1) Reintentar `failed` con intentos disponibles.
    const retryable = await store.listRetryable(env.DB, config.maxAttempts);
    for (const r of retryable) await env.EMISION.send({ document_id: r.id });

    // 2) Conciliar `sending` viejos: el consumidor murió entre enviar y guardar
    //    la respuesta, o hubo timeout. Se le pregunta a la DIAN por el CUFE.
    const cutoff = new Date(Date.now() - config.staleSendingMinutes * 60_000).toISOString();
    const stale = await store.listStaleSending(env.DB, cutoff);
    if (stale.length === 0) return;
    const cert = await certificate(env);
    for (const r of stale) {
      if (!r.cufe) {
        // Nunca llegó a construirse: volver a encolar tal cual.
        if (await store.requeue(env.DB, r.id, ["sending"])) await env.EMISION.send({ document_id: r.id });
        continue;
      }
      const result = await dian.getStatus(r.cufe, config, cert);
      if (result.isValid) {
        await store.finish(env.DB, r.id, "accepted", {
          cufe: r.cufe,
          dian_status_code: result.statusCode,
          error: null,
          dian_response: result.raw,
        });
      } else if (dian.isUnknownToDian(result)) {
        // La DIAN no lo tiene: el envío no llegó. Reenviar con el mismo número/CUFE.
        if (await store.requeue(env.DB, r.id, ["sending"])) await env.EMISION.send({ document_id: r.id });
      } else if (result.statusCode !== "") {
        await store.finish(env.DB, r.id, "rejected", {
          dian_status_code: result.statusCode,
          error: result.statusDescription,
          dian_response: result.raw,
        });
      }
      // statusCode "" = error de red al consultar: se deja en `sending` y se reintenta en el próximo cron.
    }
  },
};

/**
 * Emite un documento: reclama, numera, construye, firma, envía y persiste.
 * Nunca lanza por fallos de la DIAN: los registra en la fila (accepted/rejected/failed).
 */
async function emit(documentId: string, env: Env): Promise<void> {
  const claimed = await store.claimForSending(env.DB, documentId);
  if (!claimed) return; // ya lo tomó otro consumidor o ya terminó

  const record = await store.findById(env.DB, documentId);
  if (!record) return;
  const config = loadConfig(env);

  try {
    const request = JSON.parse(record.request_json) as DocumentRequest;
    const numbering = numberingFor(record.document_type, config);
    const number = record.number ?? (await store.nextNumber(env.DB, numbering.prefix, numbering.start, numbering.end));

    const cert = await certificate(env);
    assertValidNow(cert);

    // Si ya se firmó en un intento anterior se reenvía EXACTAMENTE el mismo XML:
    // reconstruirlo cambiaría la hora y por tanto el CUFE, y si la DIAN sí había
    // recibido el primero, el mismo número con otro CUFE sería un rechazo.
    let signed: string;
    let cufe: string;
    if (record.xml && record.cufe) {
      signed = record.xml;
      cufe = record.cufe;
    } else {
      let unsigned: { xml: string; cufe: string; issueDate: string; issueTime: string };
      if (record.document_type === "01") {
        unsigned = factura.build({ request, number, config });
      } else {
        if (!record.ref_number || !record.ref_cufe || !record.ref_issue_date) {
          throw new Error(`Nota ${record.document_type} sin referencia a la factura original (ref_number/ref_cufe/ref_issue_date)`);
        }
        unsigned = notas.build({
          noteType: record.document_type,
          request,
          number,
          config,
          billingReference: {
            id: record.ref_number,
            uuid: record.ref_cufe,
            issueDate: new Date(record.ref_issue_date),
          },
          discrepancyResponse: {
            referenceId: record.ref_number,
            responseCode: record.note_reason_code ?? "2",
            description: record.note_reason ?? "Anulación de factura",
          },
        });
      }
      signed = await dian.sign(unsigned.xml, cert);
      cufe = unsigned.cufe;
      // Se guarda antes de enviar: si el envío queda a medias, el cron concilia por CUFE.
      await store.setNumberAndXml(env.DB, documentId, number, signed, cufe, `${unsigned.issueDate}T${unsigned.issueTime}`);
    }

    const result = await dian.sendBillSync(signed, number, cufe, config, cert);
    await store.finish(env.DB, documentId, result.isValid ? "accepted" : result.rejected ? "rejected" : "failed", {
      cufe,
      dian_status_code: result.statusCode,
      error: result.isValid ? null : result.statusDescription,
      dian_response: result.raw,
    });
  } catch (e) {
    await store.finish(env.DB, documentId, "failed", { error: (e as Error).message });
  }
}
