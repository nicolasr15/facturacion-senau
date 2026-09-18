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

/** Tipo de documento DIAN que maneja este Worker: 01 factura, 91 nota crédito, 92 nota débito. */
export type DianDocumentType = "01" | "91" | "92";

/** Fila de la tabla `documents` en D1. */
export interface DocumentRecord {
  id: string;
  order_id: string;
  document_type: DianDocumentType;
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
  /** Fecha/hora exacta (ISO, hora Bogotá) con la que se construyó el XML. */
  issued_at: string | null;
  /**
   * Solo en notas (91/92): documento original que esta nota corrige
   * (billingReference de la DIAN). `ref_document_id` es la fila de esta misma
   * tabla; number/cufe/issue_date son los que van al XML de la nota.
   */
  ref_document_id: string | null;
  ref_number: string | null;
  ref_cufe: string | null;
  ref_issue_date: string | null;
  note_reason_code: string | null;
  note_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Petición para anular la factura de un pedido: emite una nota crédito (tipo 91)
 * de anulación total, referenciando la factura aceptada de ese pedido. Es el
 * único caso de nota crédito con uso real en producción (ver
 * senau-tickets `voidOrder` / "Anular pedido").
 *
 * Motivos DIAN de nota crédito (discrepancyResponse.responseCode):
 *   "1" devolución parcial · "2" anulación de factura · "3" rebaja/descuento
 *   · "4" ajuste de precio. Por defecto "2": es el único que aplica a anular
 *   un pedido completo.
 */
export interface VoidRequest {
  reason_code?: "1" | "2" | "3" | "4";
  reason?: string;
}

/**
 * Petición "de bajo nivel" para emitir una nota crédito o débito con datos
 * explícitos — pensada para el script de generación del set de pruebas de
 * habilitación DIAN (60 facturas + 20 notas crédito + 20 notas débito), NO
 * para uso en producción (ahí se usa VoidRequest, que deriva todo de la
 * factura real). Motivos de nota débito: "1" intereses · "2" incremento de
 * precio · "3" otros.
 */
export interface RawNoteRequest {
  note_type: "91" | "92";
  request: DocumentRequest;
  billing_reference: { id: string; cufe: string; issue_date: string };
  reason_code: string;
  reason: string;
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
   * Ciudad/departamento por defecto para el comprador cuando senau-tickets no
   * captura los suyos (hoy solo pide cédula, correo y nombre) — son campos
   * con código DANE obligatorio, no admiten texto libre. La calle SÍ es texto
   * libre y va fija en "No informada" (confirmado con el contador; ver
   * config.ts), por eso no hay `DEFAULT_BUYER_STREET`. Opcionales: si faltan
   * se usa la ciudad/departamento del emisor.
   */
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
  /**
   * Numeración propia para notas crédito/débito (opcional). Si no se define
   * DIAN_NOTES_NUMBERING_PREFIX, notas.ts reutiliza la numeración de la
   * factura — ver "CONTADOR" en notas.ts.
   */
  DIAN_NOTES_NUMBERING_PREFIX?: string;
  DIAN_NOTES_NUMBERING_START?: string;
  DIAN_NOTES_NUMBERING_END?: string;
  DIAN_NOTES_NUMBERING_FROM?: string;
  DIAN_NOTES_NUMBERING_TO?: string;
  DIAN_NOTES_NUMBERING_AUTH?: string;
  MAX_ATTEMPTS: string;

  // secrets
  SIGNING_KEY_PEM: string;
  SIGNING_CERT_PEM: string;
  DIAN_SOFTWARE_ID: string;
  DIAN_SOFTWARE_PIN: string;
  DIAN_NUMBERING_TECHNICAL_KEY: string;
  INTERNAL_KEY: string;
}
