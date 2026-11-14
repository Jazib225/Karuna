// Images the runner builds on demand. Kept as text here so `karuna run` needs nothing but Docker.

/** Relay for a Gatekeeper on another machine: plain proxy port in, one TLS tunnel per connection
 *  out, naming its run in the handshake (ALPN). Trusts only the org's sandbox CA. Optionally also
 *  forwards the desktop viewer port to the box. */
export const REMOTE_RELAY_TAG = "karuna-relay:1";
export const REMOTE_RELAY_DOCKERFILE = `FROM node:24-alpine
COPY relay.mjs /relay.mjs
USER node
CMD ["node", "/relay.mjs"]`;
export const REMOTE_RELAY_JS = `import net from "node:net";
import tls from "node:tls";
const { GK_HOST, GK_PORT, SESSION, CA_B64, VIEW_TARGET } = process.env;
const ca = Buffer.from(CA_B64, "base64").toString();
const isIp = /^[\\d.]+$/.test(GK_HOST) || GK_HOST.includes(":");
const pipe = (a, b) => {
  const kill = () => { a.destroy(); b.destroy(); };
  a.on("error", kill); b.on("error", kill); a.on("close", kill); b.on("close", kill);
  a.pipe(b); b.pipe(a);
};
net.createServer((c) => {
  c.pause();
  const t = tls.connect({ host: GK_HOST, port: Number(GK_PORT), ca, servername: isIp ? undefined : GK_HOST, ALPNProtocols: ["karuna-tunnel/" + SESSION] });
  t.on("secureConnect", () => { c.resume(); pipe(c, t); });
  t.on("error", () => c.destroy());
}).listen(3128);
if (VIEW_TARGET) {
  const [h, p] = VIEW_TARGET.split(":");
  net.createServer((c) => pipe(c, net.connect(Number(p), h))).listen(6080);
}`;

/** Desktop box for computer-use agents: virtual screen, window manager, Chromium wired to the
 *  egress proxy and trusting only the org CA, xdotool/ImageMagick for clicks and screenshots, and a
 *  noVNC viewer (port 6080) that only the relay can reach. Node 24 + Python 3 for the agent. */
export const DESKTOP_BASE_TAG = "karuna-desktop-base:2";
export const DESKTOP_BASE_DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      xvfb x11vnc novnc websockify fluxbox xdotool imagemagick chromium libnss3-tools \\
      fonts-dejavu-core python3 python3-pip python3-venv procps ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
COPY karuna-desktop /usr/local/bin/karuna-desktop
COPY karuna-browser /usr/local/bin/karuna-browser
RUN chmod 755 /usr/local/bin/karuna-desktop /usr/local/bin/karuna-browser && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html
ENV DISPLAY=:99 PIP_BREAK_SYSTEM_PACKAGES=1
ENTRYPOINT ["/usr/local/bin/karuna-desktop"]`;
export const DESKTOP_ENTRY = `#!/bin/sh
# Start the virtual desktop, then the agent. Everything writable lives in /tmp (tmpfs).
set -e
export DISPLAY=:99 HOME=\${HOME:-/tmp}
mkdir -p /tmp/.X11-unix "$HOME/.pki/nssdb"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.3; done
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -localhost -nopw -forever -shared -quiet -rfbport 5900 >/tmp/vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
# Chromium reads its own trust store (NSS): trust the org's sandbox CA there, and nothing else is needed.
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password >/dev/null 2>&1 || true
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n karuna -i /etc/karuna/ca.pem
exec "$@"`;
export const DESKTOP_BROWSER = `#!/bin/sh
# Chromium inside a Karuna box: every request goes through the egress proxy.
# Background services (update, sync, safe-browsing pings) are off: only what the agent asks for leaves.
exec chromium --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \\
  --disable-background-networking --disable-component-update --disable-sync --disable-default-apps \\
  --no-pings --disable-domain-reliability --disable-client-side-phishing-detection --metrics-recording-only \\
  --disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication \\
  --user-data-dir=/tmp/chromium --proxy-server="$HTTPS_PROXY" --proxy-bypass-list="<-loopback>" "$@"`;
