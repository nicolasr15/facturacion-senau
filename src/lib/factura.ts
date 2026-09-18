/**
 * Builder de la Factura Electrónica de Venta (tipo 01) — XML UBL 2.1 sin firmar + CUFE.
 *
 * ── Por qué tipo 01 y no el documento equivalente tipo 27 ──────────────────
 * El Artículo 15 de la Resolución DIAN 165 de 2023 incluye explícitamente
 * "la boleta de ingreso a los espectáculos públicos" (tipo 27) entre los
 * documentos equivalentes, y su parágrafo dice textualmente: "Los sujetos que
 * expidan los documentos equivalentes de que trata este artículo, en todos
 * los casos podrán expedir la factura electrónica de venta en las operaciones
 * que se indican para cada uno de los citados documentos." Usar factura
 * electrónica normal es una opción explícita de la norma. Se decidió así
 * porque @dian-kit/core implementa el tipo 01 completo (XML UBL + CUFE),
 * mientras que del tipo 27 solo tiene la constante `DocumentType.BOLETA_ESPECTACULOS`.
 *
 * Esto NO cambia lo demás: PULEP sigue siendo obligatorio para el evento, y
 * la contribución parafiscal del 10% (Ley 1493/2011 art. 7, boletas ≥ 3 UVT)
 * sigue aplicando — son obligaciones independientes del documento de venta.
 *
 * ── Cómo se arma (replica `DianKit.createInvoice()` de @dian-kit/sdk-node) ──
 *   1. Se compone un `DianDocument` (validado con `DianDocumentSchema.parse`).
 *   2. `generateCufe(doc)`                              → CUFE (SHA-384 hex)
 *   3. `generateSoftwareSecurityCode(id, pin, número)`  → código de seguridad
 *   4. `buildInvoiceXml(doc, cufe, securityCode)`        → XML sin firmar
 *   La firma la hace dian.sign() (XAdES-EPES) y el envío dian.sendBillSync().
 *
 * Tipos/firmas transcritos del código fuente (packages/core/src/schemas/common.schema.ts,
 * security/cufe.ts, xml/builder.ts, constants/*.ts). Confirmar con `npm run typecheck`
 * en cuanto `npm install` funcione; los puntos que dependen de criterio contable
 * están marcados "CONTADOR".
 *
 * ── Decisiones que hay que validar con el contador ("CONTADOR") ─────────────
 *   - Comprador persona natural: personType "2", taxLevelCode "R-99-PN"
 *     (No aplica / no responsable), taxScheme { "ZZ", "No aplica" }.
 *   - IVA de las boletas: se emite con tarifa 0% (subtotal de impuesto IVA con
 *     percent 0). Si el contador dice "excluido" en vez de "exento/0%", la forma
 *     de representarlo en UBL puede cambiar.
 *   - Dirección del comprador: senau-tickets no la captura; se usa
 *     config.defaultBuyerAddress (por defecto la del emisor). AddressSchema la
 *     exige (street, ciudad, departamento con códigos DANE).
 *   - Cortesías: una línea con precio 0 no es válida en InvoiceLineSchema
 *     (`price` debe ser > 0) y no es una venta; se EXCLUYEN de la factura. Un
 *     pedido 100% cortesía y sin cargo por servicio no se factura (se rechaza
 *     en validateRequest con "nada que facturar").
 *   - Cargo por servicio (totals.service_fee): es ingreso de Senau, así que va
 *     como una línea más ("Cargo por servicio") para que el total de la factura
 *     cuadre con lo que pagó el comprador.
 */

import {
  DianDocumentSchema,
  DocumentType,
  Environment,
  FiscalResponsibility,
  IdentificationType,
  OperationType,
  PaymentForm,
  PersonType,
  TaxCode,
  buildInvoiceXml,
  generateCufe,
  generateSoftwareSecurityCode,
} from "@dian-kit/core";
import type { DocumentRequest } from "../types";
import type { DianAddress, EmitterConfig } from "./config";

export interface UnsignedDocument {
  /** XML UBL 2.1 sin firmar (la firma la añade dian.ts). */
  xml: string;
  /** Número completo asignado (prefijo + consecutivo). */
  number: string;
  /** CUFE calculado por dian-kit (SHA-384, 96 hex). */
  cufe: string;
  issueDate: string; // YYYY-MM-DD (hora Colombia)
  issueTime: string; // HH:mm:ss-05:00
}

export interface BuildInput {
  request: DocumentRequest;
  number: string;
  config: EmitterConfig;
  /** Fecha/hora de expedición; por defecto ahora. */
  now?: Date;
}

const IVA = { code: TaxCode.IVA, name: "IVA" } as const;
const NO_APLICA = { code: TaxCode.NO_APLICA, name: "No aplica" } as const;

/** Fecha y hora de expedición en el formato que exige la DIAN (hora Colombia). */
export function issueDateTime(now = new Date()): { issueDate: string; issueTime: string } {
  const b = bogotaLocal(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    issueDate: `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())}`,
    issueTime: `${p(b.getUTCHours())}:${p(b.getUTCMinutes())}:${p(b.getUTCSeconds())}-05:00`,
  };
}

/** `now` desplazado de modo que sus getters UTC muestren la hora de Colombia (UTC-5 fijo). */
function bogotaLocal(now: Date): Date {
  return new Date(now.getTime() - 5 * 60 * 60 * 1000);
}

/**
 * dian-kit formatea issueDate/issueTime con getters LOCALES (`getHours()`…) y
 * les pega "-05:00". En Workers el proceso corre en UTC, así que hay que pasarle
 * un Date desplazado para que sus getters locales devuelvan la hora de Bogotá.
 * Se corrige por el offset real del proceso para que también sea correcto si
 * esto corre en Node con TZ=America/Bogota.
 */
export function dateForDianKit(now: Date): Date {
  const processOffsetMin = now.getTimezoneOffset(); // 0 en UTC, 300 en Bogotá
  return new Date(now.getTime() - 5 * 60 * 60 * 1000 + processOffsetMin * 60 * 1000);
}

/** Líneas facturables: entradas no cortesía + cargo por servicio si lo hay. */
export function billableLines(req: DocumentRequest): Array<{ description: string; quantity: number; unit_price: number }> {
  const lines = req.lines
    .filter((l) => !l.courtesy)
    .map((l) => ({
      description: [l.description, l.zone, l.seat].filter(Boolean).join(" · "),
      quantity: l.quantity,
      unit_price: l.unit_price,
    }));
  if (req.totals.service_fee > 0) {
    lines.push({ description: "Cargo por servicio", quantity: 1, unit_price: req.totals.service_fee });
  }
  return lines;
}

/** Validaciones de negocio previas al XML (fallan rápido y con mensaje claro). */
export function validateRequest(req: DocumentRequest): void {
  if (!req.buyer.id_type || !req.buyer.id_number) {
    throw new Error("Falta identificar al comprador (buyer.id_type/id_number) para factura electrónica");
  }
  if (!req.buyer.name?.trim()) throw new Error("Falta buyer.name");
  if (req.lines.length === 0) throw new Error("El documento debe tener al menos una línea");
  for (const l of req.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new Error(`Cantidad inválida en "${l.description}"`);
    if (!Number.isInteger(l.unit_price) || l.unit_price < 0) throw new Error(`Precio inválido en "${l.description}"`);
  }
  const sum = req.lines.reduce((a, l) => a + (l.courtesy ? 0 : l.unit_price * l.quantity), 0);
  if (sum !== req.totals.subtotal) {
    throw new Error(`Subtotal ${req.totals.subtotal} no cuadra con las líneas (${sum})`);
  }
  if (req.totals.subtotal + req.totals.service_fee !== req.totals.total) {
    throw new Error("total debe ser subtotal + service_fee");
  }
  if (req.totals.total <= 0) throw new Error("Nada que facturar: el pedido es 100% cortesía y sin cargo por servicio");
}

function party(opts: {
  name: string;
  idType: string;
  idNumber: string;
  dv?: string;
  personType: "1" | "2";
  taxLevelCode: string;
  taxScheme: { code: string; name: string };
  address: DianAddress;
  email?: string;
  prefix?: string;
}) {
  const identification = { number: opts.idNumber, type: opts.idType, ...(opts.dv ? { dv: opts.dv } : {}) };
  return {
    name: opts.name,
    identification,
    personType: opts.personType,
    fiscalResponsibilities: [opts.taxLevelCode],
    taxInfo: {
      registrationName: opts.name,
      companyId: identification,
      taxLevelCode: opts.taxLevelCode,
      taxScheme: opts.taxScheme,
      address: { ...opts.address, countryCode: "CO", countryName: "Colombia" },
    },
    address: { ...opts.address, countryCode: "CO", countryName: "Colombia" },
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.prefix ? { corporateRegistration: { prefix: opts.prefix } } : {}),
  };
}

/** Compone el DianDocument tal como lo haría DianKit.assembleDocument(). */
export function toDianDocument(input: BuildInput) {
  const { request, number, config } = input;
  const now = input.now ?? new Date();
  const issued = dateForDianKit(now);

  const lines = billableLines(request);
  const lineExtensionAmount = lines.reduce((a, l) => a + l.unit_price * l.quantity, 0);
  if (lineExtensionAmount !== request.totals.total) {
    throw new Error(`Las líneas facturables (${lineExtensionAmount}) no cuadran con el total (${request.totals.total})`);
  }

  const dianLines = lines.map((l, i) => {
    const amount = l.unit_price * l.quantity;
    return {
      id: String(i + 1),
      quantity: l.quantity,
      description: l.description,
      price: l.unit_price,
      lineExtensionAmount: amount,
      // CONTADOR: IVA 0% en cada línea (ver cabecera).
      taxTotals: [{ taxAmount: 0, subtotals: [{ taxableAmount: amount, taxAmount: 0, percent: 0, taxScheme: IVA }] }],
    };
  });

  const raw = {
    documentType: DocumentType.FACTURA_VENTA,
    operationType: config.operationCode || OperationType.ESTANDAR,
    environment: config.environment === "1" ? Environment.PRODUCCION : Environment.HABILITACION,
    id: number,
    issueDate: issued,
    issueTime: issued,
    currency: request.totals.currency,
    supplier: party({
      name: config.supplier.name,
      idType: IdentificationType.NIT,
      idNumber: config.supplier.nit,
      dv: config.supplier.dv,
      personType: PersonType.JURIDICA,
      // CONTADOR: responsabilidad fiscal de Senau SAS según su RUT (hoy: no aplica).
      taxLevelCode: FiscalResponsibility.NO_APLICA,
      taxScheme: IVA,
      address: config.supplier.address,
      email: config.supplier.email,
      prefix: config.numbering.prefix,
    }),
    customer: party({
      name: request.buyer.name.trim(),
      idType: request.buyer.id_type,
      idNumber: request.buyer.id_number.trim(),
      personType: request.buyer.id_type === IdentificationType.NIT ? PersonType.JURIDICA : PersonType.NATURAL,
      taxLevelCode: FiscalResponsibility.NO_APLICA,
      taxScheme: NO_APLICA,
      address: config.defaultBuyerAddress,
      email: request.buyer.email,
    }),
    lines: dianLines,
    taxTotals: [{ taxAmount: 0, subtotals: [{ taxableAmount: lineExtensionAmount, taxAmount: 0, percent: 0, taxScheme: IVA }] }],
    legalMonetaryTotal: {
      lineExtensionAmount,
      taxExclusiveAmount: lineExtensionAmount,
      taxInclusiveAmount: lineExtensionAmount,
      allowanceTotalAmount: 0,
      chargeTotalAmount: 0,
      prepaidAmount: 0,
      payableAmount: lineExtensionAmount,
    },
    paymentMeans: {
      paymentForm: PaymentForm.CONTADO,
      paymentMethod: request.payment_method || config.defaultPaymentMethod,
      paymentId: request.order_id,
    },
    notes: [
      `Pedido ${request.order_id} · ${request.event.name} · ${request.event.venue} · ${request.event.starts_at}` +
        (request.event.pulep_code ? ` · PULEP ${request.event.pulep_code}` : ""),
    ],
    software: {
      id: config.software.id,
      pin: config.software.pin,
      // Software propio: el proveedor es el mismo emisor.
      providerNit: config.supplier.nit,
      providerName: config.supplier.name,
    },
    numbering: {
      authorizationNumber: config.numbering.authorizationNumber,
      prefix: config.numbering.prefix,
      startNumber: config.numbering.start,
      endNumber: config.numbering.end,
      startDate: new Date(`${config.numbering.from}T00:00:00-05:00`),
      endDate: new Date(`${config.numbering.to}T00:00:00-05:00`),
      technicalKey: config.numbering.technicalKey,
    },
  };

  return DianDocumentSchema.parse(raw);
}

export function build(input: BuildInput): UnsignedDocument {
  validateRequest(input.request);
  const now = input.now ?? new Date();
  // `DianDocumentSchema.parse()` valida en runtime la forma completa (y por eso
  // lanza si algo no cuadra), pero su tipo inferido por zod tipa `documentType`
  // como `string` mientras que generateCufe()/buildInvoiceXml() lo exigen como
  // el literal `DocumentTypeValue` de dian-kit (desalineación entre el schema
  // de validación y las firmas de esas funciones, no un error nuestro). Se
  // castea al tipo que esas funciones realmente esperan, sea cual sea su
  // nombre exportado, en vez de adivinarlo.
  const doc = toDianDocument({ ...input, now }) as Parameters<typeof generateCufe>[0];
  const cufe = generateCufe(doc);
  const securityCode = generateSoftwareSecurityCode(input.config.software.id, input.config.software.pin, input.number);
  const xml = buildInvoiceXml(doc, cufe, securityCode);
  const { issueDate, issueTime } = issueDateTime(now);
  return { xml, number: input.number, cufe, issueDate, issueTime };
}
