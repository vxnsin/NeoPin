import crypto from "node:crypto";
import http from "node:http";
import { config } from "../src/config.js";
import { resetFcm } from "../src/fcm.js";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// A stand-in for Google: the token exchange and messages:send. `sent` collects every message,
// `stop` turns push off again.
export async function startFakeFcm() {
  const sent = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/token") return res.end(JSON.stringify({ access_token: "access", expires_in: 3600 }));
      sent.push(JSON.parse(raw).message);
      res.end(JSON.stringify({ name: "ok" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.fcmServiceAccountJson = JSON.stringify({
    project_id: "neopin-test",
    client_email: "push@neopin-test.iam.gserviceaccount.com",
    private_key: privateKey,
    token_uri: `${base}/token`,
  });
  config.fcmUrl = `${base}/v1/projects/neopin-test/messages:send`;
  config.fcmTokenUrl = `${base}/token`;
  resetFcm();
  return {
    sent,
    async stop() {
      config.fcmServiceAccountJson = null;
      config.fcmUrl = null;
      config.fcmTokenUrl = null;
      resetFcm();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Pushes go out in the background: waits until `count` arrived, or gives up after a second.
export async function sentCount(fake, count) {
  for (let i = 0; i < 50 && fake.sent.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return fake.sent.length;
}
