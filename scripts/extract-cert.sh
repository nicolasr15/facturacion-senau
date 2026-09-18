#!/usr/bin/env bash
# Extrae del certificado .p12/.pfx la clave privada (PKCS#8, PEM) y el certificado (PEM)
# para cargarlos como secrets del Worker. Requiere openssl (Git Bash o WSL en Windows).
#
#   bash scripts/extract-cert.sh ruta/al/certificado.p12
#
# Genera cert.key.pem y cert.crt.pem en el directorio actual. NO los subas al repo
# (están en .gitignore). Bórralos cuando hayas cargado los secrets.
set -euo pipefail

P12="${1:?Uso: extract-cert.sh <archivo.p12>}"
read -r -s -p "Contraseña del .p12: " PASS; echo

# Clave privada sin cifrar, en PKCS#8 (formato que acepta crypto.subtle.importKey("pkcs8", …)).
openssl pkcs12 -in "$P12" -nocerts -nodes -passin "pass:$PASS" \
  | openssl pkcs8 -topk8 -nocrypt -out cert.key.pem

# Certificado del firmante (solo el primero; sin la cadena de la CA).
openssl pkcs12 -in "$P12" -clcerts -nokeys -passin "pass:$PASS" \
  | openssl x509 -out cert.crt.pem

echo "Listo: cert.key.pem y cert.crt.pem"
echo "Vigencia del certificado:"
openssl x509 -in cert.crt.pem -noout -dates
