import type { DocumentRecord, DocumentRequest, DocumentStatus, DocumentView } from "../types";

/** Acceso a la tabla `documents`. Todas las transiciones de estado pasan por aquí. */

function newId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "D";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export function toView(r: DocumentRecord): DocumentView {
  return {
    document_id: r.id,
    order_id: r.order_id,
    status: r.status,
    number: r.number,
    cufe: r.cufe,
    dian_status_code: r.dian_status_code,
    error: r.error,
    attempts: r.attempts,
    updated_at: r.updated_at,
  };
}

export async function findByOrder(db: D1Database, orderId: string): Promise<DocumentRecord | null> {
  return db.prepare("SELECT * FROM documents WHERE order_id = ?").bind(orderId).first<DocumentRecord>();
}

export async function findById(db: D1Database, id: string): Promise<DocumentRecord | null> {
  return db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocumentRecord>();
}

/**
 * Crea el registro en estado `queued`. Idempotente: si ya existe uno para el
 * pedido devuelve ese y `created: false`. Usa INSERT OR IGNORE + UNIQUE(order_id)
 * para que dos peticiones concurrentes no creen dos documentos.
 */
export async function createQueued(
  db: D1Database,
  req: DocumentRequest,
): Promise<{ record: DocumentRecord; created: boolean }> {
  const id = newId();
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO documents (id, order_id, status, attempts, request_json, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, ?, ?, ?)`,
    )
    .bind(id, req.order_id, JSON.stringify(req), now, now)
    .run();
  const record = await findByOrder(db, req.order_id);
  if (!record) throw new Error("No se pudo crear ni encontrar el documento");
  return { record, created: res.meta.changes === 1 };
}

/** Reserva el siguiente consecutivo de numeración de forma atómica. */
export async function nextNumber(
  db: D1Database,
  prefix: string,
  start: number,
  end: number,
): Promise<string> {
  // Fila única por prefijo; se crea la primera vez con el inicio del rango.
  await db
    .prepare("INSERT OR IGNORE INTO numbering (prefix, next) VALUES (?, ?)")
    .bind(prefix, start)
    .run();
  const row = await db
    .prepare(
      "UPDATE numbering SET next = next + 1 WHERE prefix = ? AND next <= ? RETURNING next - 1 AS n",
    )
    .bind(prefix, end)
    .first<{ n: number }>();
  if (!row) throw new Error(`Rango de numeración ${prefix} agotado (${start}-${end})`);
  return `${prefix}${row.n}`;
}

/** Marca `sending` solo si estaba `queued`/`failed` (compuerta anti-carrera). */
export async function claimForSending(db: D1Database, id: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE documents SET status = 'sending', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'failed')`,
    )
    .bind(new Date().toISOString(), id)
    .run();
  return res.meta.changes === 1;
}

/** Guarda número, XML firmado y CUFE ANTES de enviar (para poder conciliar/reenviar el mismo documento). */
export async function setNumberAndXml(db: D1Database, id: string, number: string, xml: string, cufe: string) {
  await db
    .prepare("UPDATE documents SET number = ?, xml = ?, cufe = ?, updated_at = ? WHERE id = ?")
    .bind(number, xml, cufe, new Date().toISOString(), id)
    .run();
}

export async function finish(
  db: D1Database,
  id: string,
  status: Extract<DocumentStatus, "accepted" | "rejected" | "failed">,
  fields: { cufe?: string | null; dian_status_code?: string | null; error?: string | null; dian_response?: string | null },
) {
  await db
    .prepare(
      `UPDATE documents SET status = ?, cufe = COALESCE(?, cufe), dian_status_code = COALESCE(?, dian_status_code),
       error = ?, dian_response = COALESCE(?, dian_response), updated_at = ? WHERE id = ?`,
    )
    .bind(
      status,
      fields.cufe ?? null,
      fields.dian_status_code ?? null,
      fields.error ?? null,
      fields.dian_response ?? null,
      new Date().toISOString(),
      id,
    )
    .run();
}

/**
 * Vuelve a `queued` un documento. Por defecto solo desde `failed`/`rejected`
 * (reintento manual); el cron pasa `["sending"]` para reenviar los que la DIAN
 * no conoce. Conserva `number` (el consecutivo ya reservado se reutiliza).
 * Si venía de `rejected` descarta el XML/CUFE para que se reconstruya con la
 * corrección; si venía de `failed`/`sending` se conserva y se reenvía idéntico.
 */
export async function requeue(
  db: D1Database,
  id: string,
  from: DocumentStatus[] = ["failed", "rejected"],
): Promise<boolean> {
  const placeholders = from.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `UPDATE documents SET status = 'queued', error = NULL,
         xml  = CASE WHEN status = 'rejected' THEN NULL ELSE xml END,
         cufe = CASE WHEN status = 'rejected' THEN NULL ELSE cufe END,
         updated_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .bind(new Date().toISOString(), id, ...from)
    .run();
  return res.meta.changes === 1;
}

/**
 * `sending` que llevan demasiado tiempo sin respuesta (el consumidor murió a
 * mitad de envío, timeout, etc.). El cron los concilia con GetStatus.
 */
export async function listStaleSending(db: D1Database, olderThanIso: string, limit = 20): Promise<DocumentRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM documents WHERE status = 'sending' AND updated_at < ? ORDER BY updated_at LIMIT ?")
    .bind(olderThanIso, limit)
    .all<DocumentRecord>();
  return results ?? [];
}

/** `failed` con intentos disponibles, para el cron de reintentos. */
export async function listRetryable(db: D1Database, maxAttempts: number, limit = 20): Promise<DocumentRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM documents WHERE status = 'failed' AND attempts < ? ORDER BY updated_at LIMIT ?")
    .bind(maxAttempts, limit)
    .all<DocumentRecord>();
  return results ?? [];
}
