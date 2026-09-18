-- Documentos equivalentes electrónicos emitidos (uno por pedido pagado).
CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL UNIQUE,          -- idempotencia: un documento por pedido
  status           TEXT NOT NULL CHECK (status IN ('queued','sending','accepted','rejected','failed')),
  number           TEXT UNIQUE,                   -- prefijo + consecutivo asignado
  cufe             TEXT,
  dian_status_code TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  request_json     TEXT NOT NULL,                 -- DocumentRequest tal como llegó
  xml              TEXT,                          -- XML firmado enviado (auditoría)
  dian_response    TEXT,                          -- respuesta cruda de la DIAN (auditoría)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_status_updated ON documents (status, updated_at);

-- Consecutivo por prefijo de numeración (reserva atómica en store.nextNumber).
CREATE TABLE IF NOT EXISTS numbering (
  prefix TEXT PRIMARY KEY,
  next   INTEGER NOT NULL
);
