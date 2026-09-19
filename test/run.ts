/**
 * Pruebas end-to-end sin red (Node 22+). `npm test`.
 *
 *  - factura.ts: validaciones, líneas facturables, fechas en hora Colombia.
 *  - cert.ts: parseo PEM y digest; loadCertificateData completo solo si
 *    node-forge está instalado (npm install) — si no, se marca como omitida.
 *  - store.ts: sobre node:sqlite emulando D1 (test/d1.ts): idempotencia por
 *    order_id, numeración atómica y agotada, compuerta de envío, reintentos,
 *    conciliación de `sending` viejos.
 *  - factura.build() completo y dian.ts requieren @dian-kit/core instalado:
 *    se prueban con `npm run dev` contra DIAN_ENV=2 (ver README, Fase 2).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  billableLines,
  dateForDianKit,
  issueDateTime,
  validateRequest,
} from "../src/lib/factura";
import { loadCertificateData, pemToDer, sha256Base64 } from "../src/lib/cert";
import * as store from "../src/lib/store";
import type { DocumentRequest } from "../src/types";
import { createTestDb } from "./d1";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
let skipped = 0;
class Skip extends Error {}

const baseRequest = (): DocumentRequest => ({
  order_id: "O-TEST-1",
  paid_at: "2026-10-03T21:14:05Z",
  buyer: { name: "Ana Pérez", email: "ana@example.com", id_type: "13", id_number: "1037672499" },
  event: {
    id: "EV-1",
    name: "Senau en vivo",
    venue: "Teatro X, Medellín",
    starts_at: "2026-11-15T20:00:00-05:00",
    pulep_code: "PULEP-TEST",
  },
  lines: [{ description: "Entrada General", quantity: 2, unit_price: 60000 }],
  totals: { subtotal: 120000, service_fee: 8000, total: 128000, currency: "COP" },
});

// ── factura.ts ──────────────────────────────────────────────────────────────

test("validateRequest acepta un pedido consistente", () => {
  validateRequest(baseRequest());
});

test("validateRequest exige identificar al comprador (factura electrónica, no consumidor final)", () => {
  const r = baseRequest();
  r.buyer.id_number = "";
  assert.throws(() => validateRequest(r), /identificar al comprador/i);
});

test("validateRequest detecta subtotal que no cuadra", () => {
  const r = baseRequest();
  r.totals.subtotal = 100;
  assert.throws(() => validateRequest(r), /no cuadra/);
});

test("validateRequest: cortesía no suma al subtotal", () => {
  const r = baseRequest();
  r.lines.push({ description: "Cortesía", quantity: 1, unit_price: 60000, courtesy: true });
  validateRequest(r);
});

test("validateRequest rechaza pedidos 100% cortesía sin cargo por servicio", () => {
  const r = baseRequest();
  r.lines = [{ description: "Cortesía", quantity: 1, unit_price: 60000, courtesy: true }];
  r.totals = { subtotal: 0, service_fee: 0, total: 0, currency: "COP" };
  assert.throws(() => validateRequest(r), /nada que facturar/i);
});

test("billableLines excluye cortesías y añade el cargo por servicio como línea", () => {
  const r = baseRequest();
  r.lines.push({ description: "Cortesía", quantity: 1, unit_price: 60000, courtesy: true });
  r.lines.push({ description: "VIP", quantity: 1, unit_price: 90000, zone: "Platea", seat: "A12" });
  r.totals = { subtotal: 210000, service_fee: 8000, total: 218000, currency: "COP" };
  validateRequest(r);
  const lines = billableLines(r);
  assert.deepEqual(
    lines.map((l) => [l.description, l.quantity, l.unit_price]),
    [
      ["Entrada General", 2, 60000],
      ["VIP · Platea · A12", 1, 90000],
      ["Cargo por servicio", 1, 8000],
    ],
  );
  assert.equal(lines.reduce((a, l) => a + l.quantity * l.unit_price, 0), r.totals.total);
});

test("issueDateTime usa hora Colombia (UTC-5) y formato DIAN", () => {
  const { issueDate, issueTime } = issueDateTime(new Date("2026-10-04T02:30:15Z"));
  assert.equal(issueDate, "2026-10-03");
  assert.equal(issueTime, "21:30:15-05:00");
});

test("dateForDianKit: los getters locales del Date devuelven la hora de Bogotá", () => {
  // dian-kit formatea con getHours()/getDate() del proceso y pega "-05:00".
  const now = new Date("2026-10-04T02:30:15Z"); // 21:30:15 del 3 de octubre en Bogotá
  const d = dateForDianKit(now);
  assert.equal(d.getHours(), 21);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getDate(), 3);
  assert.equal(d.getMonth() + 1, 10);
});

// ── cert.ts ─────────────────────────────────────────────────────────────────

/** Certificado autofirmado de prueba con openssl (si está disponible). */
function makeTestCert(): { keyPem: string; certPem: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "senau-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
        "-subj", "/C=CO/O=SENAU SAS/OU=Pruebas/CN=SENAU SAS TEST",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      keyPem: readFileSync(join(dir, "key.pem"), "utf8"),
      certPem: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("pemToDer parsea PEM real y PEM en una línea con \\n literales", () => {
  const der = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]);
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString("base64")}\n-----END CERTIFICATE-----`;
  assert.deepEqual(pemToDer(pem, "CERTIFICATE"), der);
  assert.deepEqual(pemToDer(pem.replace(/\n/g, "\\n"), "CERTIFICATE"), der);
  assert.throws(() => pemToDer(pem, "PRIVATE KEY"), /no se encontró bloque/);
});

test("sha256Base64 coincide con node:crypto", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = new TextEncoder().encode("senau");
  assert.equal(await sha256Base64(bytes), createHash("sha256").update(bytes).digest("base64"));
});

test("loadCertificateData arma CertificateData como loadP12 de dian-kit (requiere node-forge)", async () => {
  const pems = makeTestCert();
  if (!pems) throw new Skip("openssl no disponible");
  let data;
  try {
    data = await loadCertificateData(pems.keyPem, pems.certPem);
  } catch (e) {
    if (/Cannot find (module|package) 'node-forge'/.test(String(e))) throw new Skip("node-forge no instalado (npm install)");
    throw e;
  }
  assert.ok(data.privateKeyPem.includes("PRIVATE KEY-----"));
  assert.equal(data.certificateDerBase64, Buffer.from(pemToDer(pems.certPem, "CERTIFICATE")).toString("base64"));
  assert.equal(data.subjectName, "SENAU SAS TEST");
  assert.equal(data.issuerName, "CN=SENAU SAS TEST, OU=Pruebas, O=SENAU SAS, C=CO");
  assert.ok(data.serialNumber.length > 0);
  assert.ok(data.notAfter > data.notBefore);
});

// ── store.ts (D1 emulado) ───────────────────────────────────────────────────

test("createQueued es idempotente por order_id", async () => {
  const db = createTestDb();
  const a = await store.createQueued(db, baseRequest());
  const b = await store.createQueued(db, baseRequest());
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.record.id, b.record.id);
  assert.equal(a.record.status, "queued");
});

test("nextNumber es consecutivo y falla al agotar el rango", async () => {
  const db = createTestDb();
  assert.equal(await store.nextNumber(db, "SETP", 990000001, 990000002), "SETP990000001");
  assert.equal(await store.nextNumber(db, "SETP", 990000001, 990000002), "SETP990000002");
  await assert.rejects(() => store.nextNumber(db, "SETP", 990000001, 990000002), /agotado/);
});

test("claimForSending solo reclama una vez y finish/requeue mueven el estado", async () => {
  const db = createTestDb();
  const { record } = await store.createQueued(db, baseRequest());
  assert.equal(await store.claimForSending(db, record.id), true);
  assert.equal(await store.claimForSending(db, record.id), false); // ya está en sending
  await store.setNumberAndXml(db, record.id, "SETP990000001", "<xml/>", "abc", new Date().toISOString());
  await store.finish(db, record.id, "failed", { error: "timeout" });
  const failed = await store.findById(db, record.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.cufe, "abc");
  // Desde failed se reencola conservando XML/CUFE (reenvío idéntico).
  assert.equal(await store.requeue(db, record.id), true);
  const queued = await store.findById(db, record.id);
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.xml, "<xml/>");
  // Desde rejected se descarta el XML para reconstruir con la corrección.
  await store.claimForSending(db, record.id);
  await store.finish(db, record.id, "rejected", { error: "regla X" });
  assert.equal(await store.requeue(db, record.id), true);
  const rebuilt = await store.findById(db, record.id);
  assert.equal(rebuilt?.xml, null);
  assert.equal(rebuilt?.cufe, null);
  assert.equal(rebuilt?.number, "SETP990000001"); // el consecutivo se conserva
  // accepted no se reencola.
  await store.claimForSending(db, record.id);
  await store.finish(db, record.id, "accepted", { cufe: "abc" });
  assert.equal(await store.requeue(db, record.id), false);
});

test("listRetryable y listStaleSending filtran como espera el cron", async () => {
  const db = createTestDb();
  const r1 = (await store.createQueued(db, { ...baseRequest(), order_id: "O-1" })).record;
  const r2 = (await store.createQueued(db, { ...baseRequest(), order_id: "O-2" })).record;
  await store.claimForSending(db, r1.id);
  await store.finish(db, r1.id, "failed", { error: "x" });
  await store.claimForSending(db, r2.id); // se queda en sending
  assert.deepEqual((await store.listRetryable(db, 5)).map((r) => r.id), [r1.id]);
  assert.deepEqual((await store.listRetryable(db, 1)).map((r) => r.id), []); // attempts=1 no < 1
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual((await store.listStaleSending(db, future)).map((r) => r.id), [r2.id]);
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.deepEqual(await store.listStaleSending(db, past), []);
  // El cron reencola un sending viejo con requeue(..., ["sending"]).
  assert.equal(await store.requeue(db, r2.id, ["sending"]), true);
  assert.equal((await store.findById(db, r2.id))?.status, "queued");
});

// ── runner ──────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    if (e instanceof Skip) {
      skipped++;
      console.log(`skip ${name} (${e.message})`);
      continue;
    }
    failed++;
    console.error(`FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`);
  }
}
console.log(`\n${tests.length - failed - skipped}/${tests.length} pruebas en verde${skipped ? `, ${skipped} omitida(s)` : ""}`);
if (failed) process.exit(1);
