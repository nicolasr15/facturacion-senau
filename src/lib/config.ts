import type { DianDocumentType, Env } from "../types";

/** Dirección en el formato que espera AddressSchema de @dian-kit/core. */
export interface DianAddress {
  street: string;
  cityCode: string; // DANE, 5 dígitos (05001 = Medellín)
  cityName: string;
  departmentCode: string; // DANE, 2 dígitos (05 = Antioquia)
  departmentName: string;
}

/** Configuración tipada del emisor, derivada de vars y secrets de Wrangler. */
export interface EmitterConfig {
  environment: "1" | "2";
  supplier: {
    name: string;
    nit: string;
    dv: string;
    email: string;
    address: DianAddress;
  };
  software: { id: string; pin: string };
  numbering: {
    prefix: string;
    start: number;
    end: number;
    from: string; // YYYY-MM-DD
    to: string; // YYYY-MM-DD
    authorizationNumber: string;
    technicalKey: string;
  };
  /**
   * Numeración propia para notas crédito/débito, SOLO si se configura
   * (DIAN_NOTES_NUMBERING_*). Si no, notas.ts reutiliza `numbering`.
   * CONFIRMADO con el contador: la DIAN no exige numeración autorizada aparte
   * para notas crédito/débito (pueden llevar consecutivo interno propio), así
   * que reutilizar `numbering` cumple la norma sin más — este override queda
   * disponible solo por si se prefiere un prefijo propio por otras razones.
   */
  notesNumbering?: EmitterConfig["numbering"];
  operationCode: string;
  /**
   * Dirección por defecto del comprador (ver TODO en src/lib/factura.ts):
   * senau-tickets no captura ciudad/dirección del comprador hoy, solo cédula,
   * correo y nombre. Mientras eso no cambie (o se confirme con un contador
   * que no hace falta), se usa esta dirección — normalmente la del venue —
   * para todos los compradores.
   */
  defaultBuyerAddress: DianAddress;
  /** Método de pago DIAN por defecto (48 tarjeta crédito, 49 débito, ZZZ otro). */
  defaultPaymentMethod: string;
  maxAttempts: number;
  /** Minutos tras los cuales un `sending` sin respuesta se concilia con GetStatus. */
  staleSendingMinutes: number;
}

function required(env: Env, key: keyof Env): string {
  const v = env[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Falta la variable o secret ${String(key)}`);
  }
  return v;
}

export function loadConfig(env: Env): EmitterConfig {
  const environment = required(env, "DIAN_ENV");
  if (environment !== "1" && environment !== "2") {
    throw new Error(`DIAN_ENV debe ser "1" (producción) o "2" (pruebas), no "${environment}"`);
  }
  const supplierAddress: DianAddress = {
    street: required(env, "SUPPLIER_ADDRESS"),
    cityCode: required(env, "SUPPLIER_CITY_CODE"),
    cityName: required(env, "SUPPLIER_CITY_NAME"),
    departmentCode: required(env, "SUPPLIER_DEPT_CODE"),
    departmentName: required(env, "SUPPLIER_DEPT_NAME"),
  };
  return {
    environment,
    supplier: {
      name: required(env, "SUPPLIER_NAME"),
      nit: required(env, "SUPPLIER_NIT"),
      dv: required(env, "SUPPLIER_DV"),
      email: required(env, "SUPPLIER_EMAIL"),
      address: supplierAddress,
    },
    software: {
      id: required(env, "DIAN_SOFTWARE_ID"),
      pin: required(env, "DIAN_SOFTWARE_PIN"),
    },
    numbering: {
      prefix: required(env, "DIAN_NUMBERING_PREFIX"),
      start: Number(required(env, "DIAN_NUMBERING_START")),
      end: Number(required(env, "DIAN_NUMBERING_END")),
      from: required(env, "DIAN_NUMBERING_FROM"),
      to: required(env, "DIAN_NUMBERING_TO"),
      authorizationNumber: required(env, "DIAN_NUMBERING_AUTH"),
      technicalKey: required(env, "DIAN_NUMBERING_TECHNICAL_KEY"),
    },
    notesNumbering: env.DIAN_NOTES_NUMBERING_PREFIX
      ? {
          prefix: required(env, "DIAN_NOTES_NUMBERING_PREFIX"),
          start: Number(required(env, "DIAN_NOTES_NUMBERING_START")),
          end: Number(required(env, "DIAN_NOTES_NUMBERING_END")),
          from: required(env, "DIAN_NOTES_NUMBERING_FROM"),
          to: required(env, "DIAN_NOTES_NUMBERING_TO"),
          // authorizationNumber propio si se define; si no, se reutiliza el de
          // la factura — confirmado que no hace falta una resolución aparte
          // para notas (ver notas.ts). technicalKey no se usa en el hash de
          // las notas (usan CUDE/PIN) pero el schema lo pide igual como parte
          // de `numbering`, así que se reutiliza el de la factura — no hace
          // falta un secret aparte.
          authorizationNumber: env.DIAN_NOTES_NUMBERING_AUTH || required(env, "DIAN_NUMBERING_AUTH"),
          technicalKey: required(env, "DIAN_NUMBERING_TECHNICAL_KEY"),
        }
      : undefined,
    operationCode: env.OPERATION_CODE || "10",
    defaultBuyerAddress: {
      // CONFIRMADO con el contador: senau-tickets no captura dirección del
      // comprador (solo cédula, correo y nombre) y la norma no obliga a
      // recolectarla en compras de taquilla digital — "No informada" es el
      // procedimiento formal correcto para el campo de dirección cuando el
      // dato no se tiene, así que se usa siempre (ya no es configurable por
      // env var ni cae a la dirección del emisor como atajo). La ciudad y el
      // departamento sí son campos con código DANE obligatorio por schema
      // (no admiten texto libre como "No informada"), así que ahí se sigue
      // usando la del emisor por defecto (configurable con DEFAULT_BUYER_*).
      street: "No informada",
      cityCode: env.DEFAULT_BUYER_CITY_CODE || supplierAddress.cityCode,
      cityName: env.DEFAULT_BUYER_CITY_NAME || supplierAddress.cityName,
      departmentCode: env.DEFAULT_BUYER_DEPT_CODE || supplierAddress.departmentCode,
      departmentName: env.DEFAULT_BUYER_DEPT_NAME || supplierAddress.departmentName,
    },
    defaultPaymentMethod: env.DEFAULT_PAYMENT_METHOD || "ZZZ",
    maxAttempts: Number(env.MAX_ATTEMPTS ?? "5"),
    staleSendingMinutes: Number(env.STALE_SENDING_MINUTES ?? "30"),
  };
}

/** Numeración a usar según el tipo de documento (facturas vs. notas — ver notesNumbering arriba). */
export function numberingFor(documentType: DianDocumentType, config: EmitterConfig): EmitterConfig["numbering"] {
  return documentType === "01" ? config.numbering : config.notesNumbering ?? config.numbering;
}
