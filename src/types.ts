/**
 * Contratos del Worker. Si cambias algo aquí, actualiza el README (sección
 * "Contrato de la API interna"): es lo que consume senau-tickets.
 */

/** Petición que envía senau-tickets cuando un pedido queda pagado. */
export interface DocumentRequest {
  order_id: string;
  /** ISO 8601 */
  paid_at: string;
  buyer: {
    name: string;
    email: string;
    /**
     * Tipo de documento DIAN (13 = cédula, 31 = NIT…) y número. senau-tickets
     * siempre los captura en el checkout, así que aquí son obligatorios: con
     * factura electrónica tipo 01 no usamos el placeholder "consumidor final"
     * cuando sí conocemos al comprador (ver src/lib/factura.ts).
     */
    id_type: string;
    id_number: string;
  };
  event: {
    id: string;
    name: string;
    venue: string;
    /** ISO 8601 con zona horaria */
    starts_at: string;
    /**
     * Código PULEP del evento (Ministerio de Cultura). Ya NO es parte del XML
     * de la factura electrónica tipo 01 (solo aplicaba al documento
     * equivalente tipo 27) — se deja opcional aquí únicamente para
     * trazabilidad interna (auditoría: qué pedido corresponde a qué evento).
     */
    pulep_code?: string;
  };
  lines: Array<{
    description: string;
    quantity: number;
    /** COP, sin decimales */
    unit_price: number;
    zone?: string;
    seat?: string;
    /** Entrada de cortesía (valor 0, marcada como tal en el documento) */
    courtesy?: boolean;
  }>;
  totals: {
    subtotal: number;
    /** Cargo por servicio cobrado por Senau. Si es > 0 va como una línea más de la factura. */
    service_fee: number;
    total: number;
    currency: "COP";
  };
  /**
   * Método de pago en códigos DIAN (48 tarjeta crédito, 49 débito, 47 PSE/transferencia,
   * ZZZ otro). Opcional: si no viene se usa DEFAULT_PAYMENT_METHOD.
   */
  payment_method?: string;
}

export type DocumentStatus = "queued" | "sending" | "accepted" | "rejected" | "failed";

/** Fila de la tabla `documents` en D1. */
export interface DocumentRecord {
  id: string;
  order_id: string;
  status: DocumentStatus;
  /** Número asignado (prefijo + consecutivo), null hasta que se construye. */
  number: string | null;
  cufe: string | null;
  dian_status_code: string | null;
  error: string | null;
  attempts: number;
  /** JSON de DocumentRequest tal como llegó (auditoría / reintentos). */
  request_json: string;
  /** XML firmado enviado a la DIAN (auditoría). */
  xml: string | null;
  /** Respuesta cruda de la DIAN (auditoría). */
  dian_response: string | null;
  created_at: string;
  updated_at: string;
}

/** Lo que devuelve GET /documents/:id (y POST /documents al crear). */
export interface DocumentView {
  document_id: string;
  order_id: string;
  status: DocumentStatus;
  number: string | null;
  cufe: string | null;
  dian_status_code: string | null;
  error: string | null;
  attempts: number;
  updated_at: string;
}

/** Mensaje que viaja por la cola. */
export interface EmisionMessage {
  document_id: string;
}

/** Resultado de un envío o consulta a la DIAN. */
export interface DianSendResult {
  isValid: boolean;
  statusCode: string;
  statusDescription: string;
  /** Errores de validación de reglas que devolvió la DIAN (vacío si no hubo). */
  errors: Array<{ code: string; description: string }>;
  cufe: string | null;
  /** Respuesta cruda (para auditoría) */
  raw: string;
  /** true si la DIAN rechazó el documento (no reintentar sin corregir). */
  rejected: boolean;
}

export interface Env {
  DB: D1Database;
  EMISION: Queue<EmisionMessage>;

  DIAN_ENV: "1" | "2";
  SUPPLIER_NAME: string;
  SUPPLIER_NIT: string;
  SUPPLIER_DV: string;
  SUPPLIER_EMAIL: string;
  SUPPLIER_ADDRESS: string;
  SUPPLIER_CITY_CODE: string;
  SUPPLIER_CITY_NAME: string;
  SUPPLIER_DEPT_CODE: string;
  SUPPLIER_DEPT_NAME: string;
  /**
   * Dirección por defecto para el comprador cuando senau-tickets no captura
   * la suya (hoy solo pide cédula, correo y nombre). Ver TODO en
   * src/lib/factura.ts. Opcionales: si faltan se usa la dirección del emisor.
   */
  DEFAULT_BUYER_STREET?: string;
  DEFAULT_BUYER_CITY_CODE?: string;
  DEFAULT_BUYER_CITY_NAME?: string;
  DEFAULT_BUYER_DEPT_CODE?: string;
  DEFAULT_BUYER_DEPT_NAME?: string;
  /** Código DIAN de método de pago por defecto (ZZZ si no se configura). */
  DEFAULT_PAYMENT_METHOD?: string;
  OPERATION_CODE?: string;
  STALE_SENDING_MINUTES?: string;
  DIAN_NUMBERING_PREFIX: string;
  DIAN_NUMBERING_START: string;
  DIAN_NUMBERING_END: string;
  DIAN_NUMBERING_FROM: string;
  DIAN_NUMBERING_TO: string;
  DIAN_NUMBERING_AUTH: string;
  MAX_ATTEMPTS: string;

  // secrets
  SIGNING_KEY_PEM: string;
  SIGNING_CERT_PEM: string;
  DIAN_SOFTWARE_ID: string;
  DIAN_SOFTWARE_PIN: string;
  DIAN_NUMBERING_TECHNICAL_KEY: string;
  INTERNAL_KEY: string;
}
