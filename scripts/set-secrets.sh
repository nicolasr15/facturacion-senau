#!/usr/bin/env bash
# Carga los secrets del Worker en Cloudflare. Ejecuta después de scripts/extract-cert.sh.
#   npm run secrets
set -euo pipefail

if [[ -f cert.key.pem && -f cert.crt.pem ]]; then
  npx wrangler secret put SIGNING_KEY_PEM  < cert.key.pem
  npx wrangler secret put SIGNING_CERT_PEM < cert.crt.pem
else
  echo "No encuentro cert.key.pem / cert.crt.pem en el directorio actual; omito la clave de firma." >&2
fi

for name in DIAN_SOFTWARE_ID DIAN_SOFTWARE_PIN DIAN_NUMBERING_TECHNICAL_KEY INTERNAL_KEY; do
  read -r -s -p "$name: " value; echo
  printf '%s' "$value" | npx wrangler secret put "$name"
done

echo "Secrets cargados. Recuerda borrar cert.key.pem y cert.crt.pem."
