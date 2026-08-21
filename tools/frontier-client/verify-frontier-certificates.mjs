#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const forge = require("node-forge");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    ca: path.join(REPO_ROOT, "server", "certs", "xmpp-ca-cert.pem"),
    xmppLeaf: path.join(REPO_ROOT, "server", "certs", "xmpp-dev-cert.pem"),
    gatewayLeaf: path.join(
      REPO_ROOT,
      "server",
      "src",
      "_secondary",
      "express",
      "certs",
      "gateway-dev-cert.pem",
    ),
    bundles: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ca") {
      options.ca = path.resolve(argv[++index] || "");
    } else if (argument === "--xmpp-leaf") {
      options.xmppLeaf = path.resolve(argv[++index] || "");
    } else if (argument === "--gateway-leaf") {
      options.gatewayLeaf = path.resolve(argv[++index] || "");
    } else if (argument === "--bundle") {
      options.bundles.push(path.resolve(argv[++index] || ""));
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/frontier-client/verify-frontier-certificates.mjs [options]",
    "",
    "Options:",
    "  --ca <path>            EveJS public CA certificate",
    "  --xmpp-leaf <path>     XMPP leaf certificate",
    "  --gateway-leaf <path>  secure public-gateway leaf certificate",
    "  --bundle <path>        staged PEM bundle; may be repeated",
  ].join("\n");
}

function readCertificate(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Certificate is missing: ${filePath}`);
  }
  try {
    return forge.pki.certificateFromPem(fs.readFileSync(filePath, "ascii"));
  } catch (error) {
    throw new Error(`Could not parse certificate ${filePath}: ${error.message}`);
  }
}

function certificateDer(certificate) {
  return Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
    "binary",
  );
}

function fingerprint(certificate) {
  return crypto.createHash("sha256").update(certificateDer(certificate)).digest("hex");
}

function subjectKey(certificate) {
  return certificate.subject.attributes
    .map((attribute) => `${attribute.type}=${attribute.value}`)
    .join(",");
}

function issuerKey(certificate) {
  return certificate.issuer.attributes
    .map((attribute) => `${attribute.type}=${attribute.value}`)
    .join(",");
}

function extension(certificate, name) {
  return certificate.extensions.find((entry) => entry.name === name);
}

function verifyExtensionPolicy(ca, leaf, label) {
  const caConstraints = extension(ca, "basicConstraints");
  const caUsage = extension(ca, "keyUsage");
  if (!caConstraints?.cA || !caUsage?.keyCertSign) {
    throw new Error("The EveJS CA lacks CA basic constraints or keyCertSign usage.");
  }
  const leafConstraints = extension(leaf, "basicConstraints");
  const leafUsage = extension(leaf, "keyUsage");
  const leafExtendedUsage = extension(leaf, "extKeyUsage");
  if (
    leafConstraints?.cA !== false ||
    !leafUsage?.digitalSignature ||
    !leafExtendedUsage?.serverAuth
  ) {
    throw new Error(`${label} leaf lacks the required TLS server extensions.`);
  }
}

function verifyLeaf(ca, leaf, label) {
  const now = new Date();
  if (now < leaf.validity.notBefore || now > leaf.validity.notAfter) {
    throw new Error(`${label} leaf is outside its validity period.`);
  }
  if (issuerKey(leaf) !== subjectKey(ca)) {
    throw new Error(`${label} leaf issuer does not match the EveJS CA subject.`);
  }
  if (!ca.verify(leaf)) {
    throw new Error(`${label} leaf signature does not verify against the EveJS CA.`);
  }
  verifyExtensionPolicy(ca, leaf, label);
  const store = forge.pki.createCaStore([ca]);
  forge.pki.verifyCertificateChain(store, [leaf], {
    validityCheckDate: now,
    verify(verified, depth, certificates) {
      // node-forge labels critical extKeyUsage as unsupported even though it
      // parses it. Accept only that specific diagnostic after independently
      // validating every critical extension above; preserve all other chain
      // failures.
      if (verified === forge.pki.certificateError.unsupported_certificate) {
        const knownCritical = new Set([
          "basicConstraints",
          "keyUsage",
          "extKeyUsage",
        ]);
        const certificate = certificates[depth];
        if (
          certificate &&
          certificate.extensions
            .filter((entry) => entry.critical)
            .every((entry) => knownCritical.has(entry.name))
        ) {
          return true;
        }
      }
      return verified;
    },
  });
}

function pemCertificateDers(text, filePath) {
  const blocks = text.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  ) || [];
  return blocks.map((block, index) => {
    try {
      // Retail bundles contain RSA and EC certificates. node-forge cannot
      // construct every modern non-RSA public key, while Node's native X.509
      // parser handles the platform bundle and exposes the exact DER bytes we
      // need for an identity count.
      return new crypto.X509Certificate(block).raw;
    } catch (error) {
      throw new Error(
        `Invalid PEM certificate ${index + 1} in ${filePath}: ${error.message}`,
      );
    }
  });
}

function countCaInBundle(bundlePath, caFingerprint) {
  if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isFile()) {
    throw new Error(`Staged CA bundle is missing: ${bundlePath}`);
  }
  const certificateDers = pemCertificateDers(
    fs.readFileSync(bundlePath, "ascii"),
    bundlePath,
  );
  const count = certificateDers.filter((der) =>
    crypto.createHash("sha256").update(der).digest("hex") === caFingerprint
  ).length;
  if (count !== 1) {
    throw new Error(
      `Expected the EveJS CA exactly once in ${bundlePath}; found ${count}.`,
    );
  }
  return { certificates: certificateDers.length, evejsCaCount: count };
}

function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  const ca = readCertificate(options.ca);
  const xmppLeaf = readCertificate(options.xmppLeaf);
  const gatewayLeaf = readCertificate(options.gatewayLeaf);
  if (!ca.isIssuer(ca) || !ca.verify(ca)) {
    throw new Error("The EveJS CA is not a valid self-issued certificate.");
  }
  verifyLeaf(ca, xmppLeaf, "XMPP");
  verifyLeaf(ca, gatewayLeaf, "Public gateway");
  const caFingerprint = fingerprint(ca);
  const bundles = Object.fromEntries(
    options.bundles.map((bundlePath) => [
      bundlePath,
      countCaInBundle(bundlePath, caFingerprint),
    ]),
  );
  console.log(JSON.stringify({
    caFingerprintSha256: caFingerprint,
    gatewayLeafFingerprintSha256: fingerprint(gatewayLeaf),
    valid: true,
    xmppLeafFingerprintSha256: fingerprint(xmppLeaf),
    bundles,
  }));
}

try {
  main();
} catch (error) {
  console.error(`[evejs-frontier] ${error.message}`);
  process.exitCode = 1;
}

export { countCaInBundle, fingerprint, parseArgs, verifyLeaf };
