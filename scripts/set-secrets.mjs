#!/usr/bin/env node
/**
 * Carga los secrets del Worker en Cloudflare. Ejecuta después de:
 *   node scripts/extract-cert.mjs ruta/al/cert.p12
 *
 *   npm run secrets
 *
 * Reescrito en Node (antes era bash: scripts/set-secrets.sh) porque en Windows,
 * sin Git Bash ni WSL con `bash` en el PATH, `npm run secrets` fallaba con
 * "El sistema no puede ejecutar el programa especificado". Este script no
 * depende de bash ni de ninguna utilidad de shell; corre igual en Windows,
 * macOS y Linux. scripts/set-secrets.sh queda sin uso (se puede borrar).
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    // En Windows, `npx` resuelve a `npx.cmd`, y desde Node 20+ (CVE-2024-27980)
    // spawnear un .cmd/.bat directamente sin `shell: true` falla con "spawn
    // EINVAL". `name` siempre es uno de nuestros nombres de secret fijos (nunca
    // input del usuario en el argv — el valor va por stdin), así que no hay
    // riesgo de inyección al pasar por la shell.
    const child = spawn("npx", ["wrangler", "secret", "put", name], {
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret put ${name} salió con código ${code}`));
    });
    child.stdin.write(value);
    child.stdin.end();
  });
}

/** Pide un valor sin mostrarlo en pantalla (equivalente a `read -s` de bash). */
function promptHidden(query) {
  const stdin = process.stdin;
  process.stdout.write(query);

  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      // Sin terminal interactiva: lee una línea normal, sin ocultar (mejor que colgarse).
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
        case "": // Ctrl-D
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(input);
          break;
        case "": // Ctrl-C
          process.stdout.write("\n");
          process.exit(1);
          break;
        case "": // Backspace
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
  if (existsSync("cert.key.pem") && existsSync("cert.crt.pem")) {
    await putSecret("SIGNING_KEY_PEM", readFileSync("cert.key.pem", "utf8"));
    await putSecret("SIGNING_CERT_PEM", readFileSync("cert.crt.pem", "utf8"));
  } else {
    console.error("No encuentro cert.key.pem / cert.crt.pem en el directorio actual; omito la clave de firma.");
  }

  for (const name of ["DIAN_SOFTWARE_ID", "DIAN_SOFTWARE_PIN", "DIAN_NUMBERING_TECHNICAL_KEY", "INTERNAL_KEY"]) {
    const value = await promptHidden(`${name}: `);
    await putSecret(name, value);
  }

  console.log("Secrets cargados. Recuerda borrar cert.key.pem y cert.crt.pem.");
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
