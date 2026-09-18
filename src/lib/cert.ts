/**
 * Carga del certificado de firma desde secrets.
 *
 * Decisión de arquitectura: el .p12 NO se parsea en el Worker. Se extrae una vez
 * (scripts/extract-cert.mjs) a PEM y se guarda como secrets. Aquí se arma el
 * objeto `CertificateData` que espera `signXml()` / `sendBill()` de
 * @dian-kit/core, replicando exactamente lo que hace su `loadP12()`
 * (packages/core/src/security/certificate.ts) pero partiendo de PEM:
 *
 *   privateKeyPem        → tal cual del secret (PKCS#8; dian-kit acepta PKCS#1 o #8)
 *   certificatePem       → tal cual del secret
 *   certificateDerBase64 → base64 del DER del certificado
 *   certDigestBase64     → SHA-256 del DER, en base64 (va en <ds:DigestValue> de XAdES)
 *   issuerName           → atributos del emisor "shortName=value", en orden inverso, unidos por ", "
 *   serialNumber         → cert.serialNumber de node-forge (hex)
 *   subjectName          → solo el CN del sujeto
 *   notBefore / notAfter → vigencia
 *
 * node-forge (JS puro, ya es dependencia de dian-kit) se importa de forma
 * perezosa para que test/run.ts pueda ejercitar el resto sin tenerlo instalado.
 */

import type { CertificateData } from "@dian-kit/core";

function normalizePem(pem: string): string {
  // Los secrets suelen pegarse en una sola línea con "\n" literales.
  return pem.replace(/\\n/g, "\n").trim();
}

export function pemToDer(pem: string, label: string): Uint8Array {
  const match = normalizePem(pem).match(
    new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`),
  );
  if (!match || !match[1]) throw new Error(`PEM inválido: no se encontró bloque ${label}`);
  const b64 = match[1].replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toBase64(new Uint8Array(digest));
}

export async function loadCertificateData(keyPem: string, certPem: string): Promise<CertificateData> {
  // Antes de tener el certificado real (npm run extract-cert + npm run secrets), estos
  // secrets no existen y llegan `undefined`: sin esta guarda, normalizePem() revienta con
  // "Cannot read properties of undefined (reading 'replace')", que no dice nada útil en la
  // columna `error` de `documents`.
  if (!keyPem) throw new Error("Falta el secret SIGNING_KEY_PEM (carga el certificado con npm run secrets)");
  if (!certPem) throw new Error("Falta el secret SIGNING_CERT_PEM (carga el certificado con npm run secrets)");

  const privateKeyPem = normalizePem(keyPem);
  const certificatePem = normalizePem(certPem);
  if (!privateKeyPem.includes("PRIVATE KEY-----")) throw new Error("SIGNING_KEY_PEM no parece una clave PEM");

  const der = pemToDer(certificatePem, "CERTIFICATE");
  const certificateDerBase64 = toBase64(der);
  const certDigestBase64 = await sha256Base64(der);

  const forge = (await import("node-forge")).default;
  const cert = forge.pki.certificateFromPem(certificatePem);
  const issuerName = cert.issuer.attributes
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${a.value}`)
    .reverse()
    .join(", ");
  const subjectName = cert.subject.getField("CN")?.value ?? "";

  return {
    privateKeyPem,
    certificatePem,
    certificateDerBase64,
    certDigestBase64,
    issuerName,
    serialNumber: cert.serialNumber,
    subjectName,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
  };
}

/** Lanza si el certificado está vencido o aún no es válido (mensaje claro en `failed`). */
export function assertValidNow(cert: CertificateData, now = new Date()): void {
  if (now < cert.notBefore) throw new Error(`Certificado aún no válido (desde ${cert.notBefore.toISOString()})`);
  if (now > cert.notAfter) throw new Error(`Certificado vencido (${cert.notAfter.toISOString()}); renovar y recargar secrets`);
}
