/**
 * Entrada del Worker.
 *
 *  - fetch:     API interna (service binding desde senau-tickets)
 *  - queue:     consumidor de la cola de emisión (firma + envío a la DIAN)
 *  - scheduled: cron de reintentos para `failed` con intentos disponibles
 */

import type { DocumentRequest, EmisionMessage, Env } from "./types";
import type { CertificateData } from "@dian-kit/core";
import { loadConfig } from "./lib/config";
import { assertValidNow, loadCertificateData } from "./lib/cert";
import * as store from "./lib/store";
import * as factura from "./lib/factura";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return json({ error: "no autorizado" }, 401);

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["documents", id?, "retry"?]

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
      const { record, created } = await store.createQueued(env.DB, req);
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
    const number =
      record.number ??
      (await store.nextNumber(env.DB, config.numbering.prefix, config.numbering.start, config.numbering.end));

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
      const unsigned = factura.build({ request, number, config });
      signed = await dian.sign(unsigned.xml, cert);
      cufe = unsigned.cufe;
      // Se guarda antes de enviar: si el envío queda a medias, el cron concilia por CUFE.
      await store.setNumberAndXml(env.DB, documentId, number, signed, cufe);
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
