// The org's sandbox certificate authority. Boxes trust ONLY this CA, so every HTTPS connection an
// agent makes terminates at Karuna's egress proxy, which then opens its own verified connection
// to the real server. That's what lets the proxy see the method + path, hold a request for
// approval, and swap a placeholder for a real API key. The CA key never leaves the data dir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";
import forge from "node-forge";

const { pki, md } = forge;

const serial = () => forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^[89a-f]/, "1");

export class SandboxCA {
  readonly certPem: string;
  private readonly caKey: forge.pki.rsa.PrivateKey;
  private readonly caCert: forge.pki.Certificate;
  /** One key pair for every leaf: signing per host is cheap, generating RSA keys is not. */
  private readonly leafKeys: forge.pki.rsa.KeyPair;
  private readonly leafKeyPem: string;
  private readonly contexts = new Map<string, SecureContext>();

  constructor(dataDir: string) {
    const dir = join(dataDir, "sandbox-ca");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, "ca.key.pem");
    const certPath = join(dir, "ca.cert.pem");
    if (existsSync(keyPath) && existsSync(certPath)) {
      this.caKey = pki.privateKeyFromPem(readFileSync(keyPath, "utf8")) as forge.pki.rsa.PrivateKey;
      this.caCert = pki.certificateFromPem(readFileSync(certPath, "utf8"));
    } else {
      const keys = pki.rsa.generateKeyPair(2048);
      const cert = pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = serial();
      cert.validity.notBefore = new Date(Date.now() - 86_400_000);
      cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 86_400_000);
      const subject = [{ name: "commonName", value: "Karuna Sandbox CA" }, { name: "organizationName", value: "Karuna" }];
      cert.setSubject(subject);
      cert.setIssuer(subject);
      cert.setExtensions([
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
        { name: "subjectKeyIdentifier" },
      ]);
      cert.sign(keys.privateKey, md.sha256.create());
      writeFileSync(keyPath, pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
      writeFileSync(certPath, pki.certificateToPem(cert), { mode: 0o644 });
      this.caKey = keys.privateKey;
      this.caCert = cert;
    }
    this.certPem = pki.certificateToPem(this.caCert);
    this.leafKeys = pki.rsa.generateKeyPair(2048);
    this.leafKeyPem = pki.privateKeyToPem(this.leafKeys.privateKey);
  }

  /** A TLS context presenting a certificate for `host`, signed by the sandbox CA (cached). */
  contextFor(host: string): SecureContext {
    const name = host.toLowerCase();
    const hit = this.contexts.get(name);
    if (hit) return hit;
    const cert = pki.createCertificate();
    cert.publicKey = this.leafKeys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
    cert.setSubject([{ name: "commonName", value: name.slice(0, 64) }]);
    cert.setIssuer(this.caCert.subject.attributes);
    const isIp = /^[\d.]+$/.test(name) || name.includes(":");
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [isIp ? { type: 7, ip: name } : { type: 2, value: name }] },
    ]);
    cert.sign(this.caKey, md.sha256.create());
    const ctx = createSecureContext({ key: this.leafKeyPem, cert: pki.certificateToPem(cert) });
    if (this.contexts.size > 500) this.contexts.clear();
    this.contexts.set(name, ctx);
    return ctx;
  }
}
