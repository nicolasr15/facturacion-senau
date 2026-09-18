-- Soporte para notas crédito (tipo 91) y nota débito (tipo 92).
--
-- `documents` tenía UNIQUE(order_id) a secas (idempotencia: un solo documento
-- por pedido). Ahora un mismo pedido puede tener una factura (01) Y, si se
-- anula, una nota crédito (91) — así que la idempotencia pasa a ser por
-- (order_id, document_type). SQLite no permite soltar una UNIQUE de columna
-- con ALTER TABLE, así que se recrea la tabla (patrón estándar de SQLite).
--
-- `issued_at`: fecha/hora exacta (ISO, con el -05:00 de Bogotá) con la que se
-- construyó el XML — antes solo vivía dentro del XML firmado. Hace falta como
-- billingReference.issueDate cuando una nota crédito referencia esta factura.
--
-- `ref_document_id/ref_number/ref_cufe/ref_issue_date`: solo se usan en filas
-- de notas (91/92) — es el billingReference (factura que la nota corrige).

CREATE TABLE documents_new (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL,
  document_type    TEXT NOT NULL DEFAULT '01' CHECK (document_type IN ('01','91','92')),
  status           TEXT NOT NULL CHECK (status IN ('queued','sending','accepted','rejected','failed')),
  number           TEXT UNIQUE,
  cufe             TEXT,
  dian_status_code TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  request_json     TEXT NOT NULL,
  xml              TEXT,
  dian_response    TEXT,
  issued_at        TEXT,
  ref_document_id  TEXT,
  ref_number       TEXT,
  ref_cufe         TEXT,
  ref_issue_date   TEXT,
  note_reason_code TEXT,
  note_reason      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(order_id, document_type)
);

INSERT INTO documents_new (id, order_id, document_type, status, number, cufe, dian_status_code, error, attempts, request_json, xml, dian_response, created_at, updated_at)
SELECT id, order_id, '01', status, number, cufe, dian_status_code, error, attempts, request_json, xml, dian_response, created_at, updated_at
FROM documents;

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

CREATE INDEX IF NOT EXISTS idx_documents_status_updated ON documents (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_documents_order ON documents (order_id);
