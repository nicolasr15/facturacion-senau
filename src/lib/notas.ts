/**
 * Builder de Nota Crédito (tipo 91) y Nota Débito (tipo 92) — UBL 2.1 sin firmar + CUDE.
 *
 * ── Por qué existen ──────────────────────────────────────────────────────
 * Nota crédito: única con uso real en producción, para anular la factura de un
 * pedido (ver senau-tickets `voidOrder` / "Anular pedido" y VoidRequest en
 * types.ts). Nota débito: SIN uso de producción — solo existe para poder
 * generar el set de pruebas de habilitación de la DIAN, que para modalidad
 * "Software propio" exige 60 facturas + 20 notas crédito + 20 notas débito
 * (Presentación de habilitación de la DIAN; ver README).
 *
 * ── Cómo se arma (mismo patrón que factura.ts, replicando lo que hace
 *    DianKit.createCreditNote()/createDebitNote() de @dian-kit/sdk-node) ────
 *   1. Se compone un `DianDocument` con documentType 91/92, operationType
 *      20/30, y los dos campos que no lleva la factura: `billingReference`
 *      (qué documento corrige) y `discrepancyResponse` (por qué).
 *   2. `generateCufe(doc)` — el MISMO export que usa factura.ts: internamente
 *      elige technicalKey (CUFE, documentos 01) o software PIN (CUDE,
 *      documentos 91/92/102) según el documentType — no hace falta una
 *      función aparte para el hash.
 *   3. `generateSoftwareSecurityCode(id, pin, número)` — igual que en factura.ts.
 *   4. `buildCreditNoteXml(doc, cude, securityCode)` / `buildDebitNoteXml(...)`.
 *   La firma y el envío los sigue haciendo dian.ts (mismo SOAP para cualquier
 *   tipo de documento).
 *
 * Nombres/formas transcritos leyendo el código fuente en GitHub
 * (sergioarojasm98/dian-kit, packages/core/src/{constants/document-types.ts,
 * schemas/common.schema.ts, security/cufe.ts, xml/builder.ts} y
 * examples/credit-note.ts) — sin acceso a npm en esta sesión tampoco (mismo
 * problema que cuando se escribió factura.ts). CONFIRMAR con `npm run
 * typecheck` real antes de desplegar, igual que allá.
 *
 * ── Confirmado con el contador ("CONTADOR") ──────────────────────────────
 *   - Numeración de las notas: CONFIRMADO — las notas crédito/débito NO
 *     requieren una resolución de autorización de numeración expedida por la
 *     DIAN; pueden llevar un consecutivo alfanumérico interno propio
 *     administrado directamente por el software de facturación (solo las
 *     facturas de venta y los documentos soporte están sujetos a autorización
 *     de rangos). Como el ejemplo oficial de dian-kit ya reutiliza el mismo
 *     `numbering` de la factura y así se implementó aquí por defecto (ver
 *     config.ts), esto no obliga a cambiar nada — simplemente no hacía falta
 *     el mecanismo DIAN_NOTES_NUMBERING_* para cumplir la norma. Se deja de
 *     todos modos (sin configurar, es un no-op) por si en el futuro se
 *     prefiere un prefijo propio para notas por razones administrativas.
 *   - IVA de las líneas: mismo criterio que factura.ts (boletería EXCLUIDA de
 *     IVA, no exenta al 0% — ver su cabecera para el porqué y cómo se
 *     representa con taxScheme NO_APLICA).
 */

import {
  DianDocumentSchema,
  DocumentType,
  Environment,
  FiscalResponsibility,
  IdentificationType,
  OperationType,
  PersonType,
  TaxCode,
  buildCreditNoteXml,
  buildDebitNoteXml,
  generateCufe,
  generateSoftwareSecurityCode,
} from "@dian-kit/core";
import type { DocumentRequest } from "../types";
import type { EmitterConfig } from "./config";
import { billableLines, dateForDianKit, issueDateTime, party, validateRequest } from "./factura";

export type NoteType = "91" | "92";

export interface BillingReference {
  /** Número completo del documento original (prefijo + consecutivo). */
  id: string;
  /** CUFE del documento original. */
  uuid: string;
  issueDate: Date;
}

export interface DiscrepancyResponse {
  referenceId: string;
  /** "1"-"4" para nota crédito, "1"-"3" para nota débito (ver cabecera). */
  responseCode: string;
  description: string;
}

export interface UnsignedNote {
  xml: string;
  number: string;
  /** CUDE (nombre real: mismo hash SHA-384 que el CUFE, distinto secreto de entrada). */
  cufe: string;
  issueDate: string;
  issueTime: string;
}

export interface BuildNoteInput {
  noteType: NoteType;
  /** Misma forma que la factura que se está corrigiendo (comprador, líneas, totales). */
  request: DocumentRequest;
  billingReference: BillingReference;
  discrepancyResponse: DiscrepancyResponse;
  number: string;
  config: EmitterConfig;
  now?: Date;
}

const IVA = { code: TaxCode.IVA, name: "IVA" } as const;
const NO_APLICA = { code: TaxCode.NO_APLICA, name: "No aplica" } as const;

function noteNumbering(noteType: NoteType, config: EmitterConfig) {
  // Si no se configuró una numeración propia para notas, se reutiliza la de la
  // factura (así lo hace el ejemplo oficial de dian-kit) — ver "CONTADOR" arriba.
  return config.notesNumbering ?? config.numbering;
}

/** Compone el DianDocument de la nota (documentType/operationType + billingReference/discrepancyResponse). */
export function toNoteDocument(input: BuildNoteInput) {
  const { request, number, config, noteType } = input;
  const now = input.now ?? new Date();
  const issued = dateForDianKit(now);
  const numbering = noteNumbering(noteType, config);

  const lines = billableLines(request);
  const lineExtensionAmount = lines.reduce((a, l) => a + l.unit_price * l.quantity, 0);
  if (lineExtensionAmount !== request.totals.total) {
    throw new Error(`Las líneas de la nota (${lineExtensionAmount}) no cuadran con el total (${request.totals.total})`);
  }

  const dianLines = lines.map((l, i) => {
    const amount = l.unit_price * l.quantity;
    return {
      id: String(i + 1),
      quantity: l.quantity,
      description: l.description,
      price: l.unit_price,
      lineExtensionAmount: amount,
      // Excluido de IVA, no exento al 0% — mismo criterio que factura.ts.
      taxTotals: [{ taxAmount: 0, subtotals: [{ taxableAmount: amount, taxAmount: 0, percent: 0, taxScheme: NO_APLICA }] }],
    };
  });

  const raw = {
    documentType: noteType === "91" ? DocumentType.NOTA_CREDITO : DocumentType.NOTA_DEBITO,
    operationType: noteType === "91" ? OperationType.NOTA_CREDITO : OperationType.NOTA_DEBITO,
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
      // CONTADOR: mismo criterio que factura.ts (ver su cabecera).
      taxLevelCode: FiscalResponsibility.NO_APLICA,
      taxScheme: IVA,
      address: config.supplier.address,
      email: config.supplier.email,
      prefix: numbering.prefix,
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
    taxTotals: [{ taxAmount: 0, subtotals: [{ taxableAmount: lineExtensionAmount, taxAmount: 0, percent: 0, taxScheme: NO_APLICA }] }],
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
      paymentForm: "1",
      paymentMethod: request.payment_method || config.defaultPaymentMethod,
      paymentId: request.order_id,
    },
    billingReference: {
      id: input.billingReference.id,
      uuid: input.billingReference.uuid,
      issueDate: input.billingReference.issueDate,
    },
    discrepancyResponse: input.discrepancyResponse,
    notes: [
      `Pedido ${request.order_id} · ${request.event.name} · ${request.event.venue} · ${request.event.starts_at}`,
    ],
    software: {
      id: config.software.id,
      pin: config.software.pin,
      providerNit: config.supplier.nit,
      providerName: config.supplier.name,
    },
    numbering: {
      authorizationNumber: numbering.authorizationNumber,
      prefix: numbering.prefix,
      startNumber: numbering.start,
      endNumber: numbering.end,
      startDate: new Date(`${numbering.from}T00:00:00-05:00`),
      endDate: new Date(`${numbering.to}T00:00:00-05:00`),
      // Notas usan CUDE (PIN), no technicalKey — pero el schema igual lo pide
      // como parte de `numbering` (ver examples/credit-note.ts en dian-kit).
      technicalKey: numbering.technicalKey,
    },
  };

  return DianDocumentSchema.parse(raw);
}

export function build(input: BuildNoteInput): UnsignedNote {
  validateRequest(input.request);
  const now = input.now ?? new Date();
  const doc = toNoteDocument({ ...input, now }) as Parameters<typeof generateCufe>[0];
  const cufe = generateCufe(doc); // CUDE para 91/92: mismo export, ver cabecera.
  const securityCode = generateSoftwareSecurityCode(input.config.software.id, input.config.software.pin, input.number);
  const xml = input.noteType === "91" ? buildCreditNoteXml(doc, cufe, securityCode) : buildDebitNoteXml(doc, cufe, securityCode);
  const { issueDate, issueTime } = issueDateTime(now);
  return { xml, number: input.number, cufe, issueDate, issueTime };
}
