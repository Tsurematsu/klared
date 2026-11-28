#!/usr/bin/env bash
set -euo pipefail

REPO="k3stool/klared"
BIN_NAME="klared"
ASSET_NAME="klared-linux-x64"
FORCE="false"
REQUESTED_VERSION="${KLARED_VERSION:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f)
      FORCE="true"
      shift
      ;;
    --version|-v)
      REQUESTED_VERSION="${2:-}"
      shift 2
      ;;
    --dir|-d)
      KLARED_INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --help|-h)
      cat <<EOF
Instalador y actualizador de ${BIN_NAME} (Linux x64)

Uso:
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash -s -- [--force] [--version v1.0.0] [--dir /ruta]

Opciones:
  -f, --force            Reinstala aunque ya tengas la última versión
  -v, --version <tag>    Instala una versión específica (ej. v1.0.0)
  -d, --dir <ruta>       Directorio destino de instalación
EOF
      exit 0
      ;;
    *)
      shift
      ;;
  esac
done

info()  { printf '\033[1;36mℹ\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ "$OS" != "Linux" ]]; then
  fail "Este script es para Linux (detectado: $OS). En Windows usa scripts/install.ps1."
fi
if [[ "$ARCH" != "x86_64" && "$ARCH" != "amd64" ]]; then
  fail "Arquitectura no soportada actualmente: $ARCH (requiere x86_64)."
fi
command -v curl >/dev/null 2>&1 || fail "Se requiere 'curl' instalado en el sistema."

resolve_latest_tag() {
  local api_url="https://api.github.com/repos/${REPO}/releases/latest"
  local tag=""
  if tag="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api_url" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"; then
    if [[ -n "$tag" ]]; then
      printf '%s' "$tag"
      return 0
    fi
  fi

  local final_url
  final_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" 2>/dev/null || true)"
  tag="${final_url##*/}"
  if [[ -n "$tag" && "$tag" != "releases" && "$tag" != "latest" ]]; then
    printf '%s' "$tag"
    return 0
  fi

  return 1
}

if [[ -n "$REQUESTED_VERSION" ]]; then
  TARGET_VERSION="$REQUESTED_VERSION"
  DOWNLOAD_BASE="https://github.com/${REPO}/releases/download/${TARGET_VERSION}"
else
  info "Consultando la última versión de ${BIN_NAME} en GitHub..."
  if TARGET_VERSION="$(resolve_latest_tag)"; then
    DOWNLOAD_BASE="https://github.com/${REPO}/releases/download/${TARGET_VERSION}"
  else
    warn "No se pudo resolver el tag exacto; se descargará desde releases/latest."
    TARGET_VERSION="latest"
    DOWNLOAD_BASE="https://github.com/${REPO}/releases/latest/download"
  fi
fi

EXISTING_BIN="$(command -v "$BIN_NAME" 2>/dev/null || true)"
if [[ -n "${KLARED_INSTALL_DIR:-}" ]]; then
  INSTALL_DIR="$KLARED_INSTALL_DIR"
elif [[ -n "$EXISTING_BIN" ]]; then
  INSTALL_DIR="$(dirname "$EXISTING_BIN")"
elif [[ -w "/usr/local/bin" ]]; then
  INSTALL_DIR="/usr/local/bin"
elif [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

TARGET_BIN="${INSTALL_DIR}/${BIN_NAME}"
STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/${BIN_NAME}"
VERSION_FILE="${STATE_DIR}/version"
INSTALLED_VERSION=""
if [[ -f "$VERSION_FILE" ]]; then
  INSTALLED_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE" || true)"
fi

if [[ "$FORCE" != "true" && -x "$TARGET_BIN" && "$TARGET_VERSION" != "latest" && "$INSTALLED_VERSION" == "$TARGET_VERSION" ]]; then
  ok "${BIN_NAME} ya está instalado y actualizado en la última versión (${TARGET_VERSION}) en ${TARGET_BIN}"
  info "Usa --force si deseas reinstalarlo de todos modos."
  exit 0
fi

if [[ -x "$TARGET_BIN" ]]; then
  info "Actualizando ${BIN_NAME} (${INSTALLED_VERSION:-versión previa} -> ${TARGET_VERSION}) en ${TARGET_BIN}..."
else
  info "Instalando ${BIN_NAME} (${TARGET_VERSION}) en ${TARGET_BIN}..."
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BIN_URL="${DOWNLOAD_BASE}/${ASSET_NAME}"
SUMS_URL="${DOWNLOAD_BASE}/SHA256SUMS.txt"

info "Descargando ${ASSET_NAME}..."
curl -fL --progress-bar --retry 3 -o "${TMP_DIR}/${ASSET_NAME}" "$BIN_URL" \
  || fail "No se pudo descargar ${BIN_URL}"

if curl -fsSL --retry 2 -o "${TMP_DIR}/SHA256SUMS.txt" "$SUMS_URL" 2>/dev/null; then
  EXPECTED_SHA="$(awk -v f="$ASSET_NAME" '$2 == f || $2 == "*"f { print $1; exit }' "${TMP_DIR}/SHA256SUMS.txt")"
  if [[ -n "$EXPECTED_SHA" ]] && command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA="$(sha256sum "${TMP_DIR}/${ASSET_NAME}" | awk '{ print $1 }')"
    if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
      fail "Fallo de verificación SHA-256 (esperado: ${EXPECTED_SHA}, obtenido: ${ACTUAL_SHA})."
    fi
    ok "Integridad SHA-256 verificada correctamente."
  fi
else
  warn "No se encontró SHA256SUMS.txt en el release; omitiendo verificación de hash."
fi

chmod +x "${TMP_DIR}/${ASSET_NAME}"

mkdir -p "$INSTALL_DIR" 2>/dev/null || true
if [[ -w "$INSTALL_DIR" ]]; then
  mv -f "${TMP_DIR}/${ASSET_NAME}" "$TARGET_BIN"
elif command -v sudo >/dev/null 2>&1; then
  info "Se requieren permisos de administrador para escribir en ${INSTALL_DIR}..."
  sudo mkdir -p "$INSTALL_DIR"
  sudo mv -f "${TMP_DIR}/${ASSET_NAME}" "$TARGET_BIN"
  sudo chmod 0755 "$TARGET_BIN"
else
  fail "Sin permisos de escritura en ${INSTALL_DIR}. Define KLARED_INSTALL_DIR=\$HOME/.local/bin y reintenta."
fi

mkdir -p "$STATE_DIR"
if [[ "$TARGET_VERSION" != "latest" ]]; then
  printf '%s\n' "$TARGET_VERSION" > "$VERSION_FILE"
fi

ok "${BIN_NAME} ${TARGET_VERSION} instalado correctamente en ${TARGET_BIN}"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    warn "${INSTALL_DIR} no está en tu PATH actual."
    printf '   Agrega esta línea a ~/.bashrc o ~/.zshrc:\n'
    printf '   export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

if ! command -v kubectl >/dev/null 2>&1; then
  warn "No se detectó 'kubectl' en el PATH. Recuerda instalarlo y configurar tu kubeconfig antes de usar ${BIN_NAME}."
fi

info "Ejecuta '${BIN_NAME}' para abrir la TUI (o '${BIN_NAME} --check' para validar conexión)."
info "Para actualizar en el futuro, vuelve a ejecutar este mismo comando."
