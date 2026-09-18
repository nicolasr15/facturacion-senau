#!/usr/bin/env node
/**
 * Extrae del certificado .p12/.pfx la clave privada (PKCS#8, PEM) y el
 * certificado (PEM) para cargarlos como secrets del Worker.
 *
 *   node scripts/extract-cert.mjs ruta/al/certificado.p12
 *   npm run extract-cert -- ruta/al/certificado.p12
 *
 * Genera cert.key.pem y cert.crt.pem en el directorio actual. NO los subas al
 * repo (están en .gitignore). Bórralos cuando hayas cargado los secrets con
 * `npm run secrets`.
 *
 * Reescrito en Node con node-forge (ya es dependencia del proyecto, ver
 * src/lib/cert.ts) en vez de bash+openssl: openssl no viene instalado por
 * defecto en Windows, y el script en bash (scripts/extract-cert.sh, ahora sin
 * uso) tampoco corría ahí sin Git Bash/WSL con `bash` en el PATH.
 */

import { readFileSync, writeFileSync } from "node:fs";
import forge from "node-forge";

/** Misma lógica de entrada oculta que scripts/set-secrets.mjs. */
function promptHidden(query) {
  const stdin = process.stdin;
  process.stdout.write(query);

  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          stdin.removeListener("data", onData);
          resolve(buf.slice(0, nl).replace(/\r$/, ""));
        }
      };
      stdin.on("data", onData);
      return;
    }

    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (char) => {
      switch (char) {
        case "\n":
        case "\r":
        case "":
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(input);
          break;
        case "":
          process.stdout.write("\n");
          process.exit(1);
          break;
        case "":
        case "\b":
          input = input.slice(0, -1);
          break;
        default:
          input += char;
          break;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const p12Path = process.argv[2];
  if (!p12Path) {
    console.error("Uso: node scripts/extract-cert.mjs <archivo.p12>");
    process.exit(1);
  }

  const password = await promptHidden("Contraseña del .p12: ");

  const p12Der = forge.util.createBuffer(readFileSync(p12Path).toString("binary"));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  const shroudedKeyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag =
    shroudedKeyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ??
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  if (!keyBag?.key) throw new Error("No se encontró la clave privada dentro del .p12 (¿contraseña incorrecta?)");

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = certBags[forge.pki.oids.certBag]?.[0];
  if (!certBag?.cert) throw new Error("No se encontró el certificado dentro del .p12");

  // PKCS#8 sin cifrar, mismo formato que generaba `openssl pkcs8 -topk8 -nocrypt`
  // y el que espera crypto.subtle.importKey("pkcs8", …) en src/lib/cert.ts.
  const keyPem = forge.pki.privateKeyInfoToPem(
    forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key)),
  );
  const certPem = forge.pki.certificateToPem(certBag.cert);

  writeFileSync("cert.key.pem", keyPem);
  writeFileSync("cert.crt.pem", certPem);

  console.log("Listo: cert.key.pem y cert.crt.pem");
  console.log("Vigencia del certificado:");
  console.log(`  notBefore: ${certBag.cert.validity.notBefore.toISOString()}`);
  console.log(`  notAfter:  ${certBag.cert.validity.notAfter.toISOString()}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
