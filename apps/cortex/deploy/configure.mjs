// Run on the target host. No credential values are printed or passed as arguments.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const stateDir = NodePath.resolve(process.argv[2] ?? "/var/lib/lbgos-learn/userdata");
const envDir = NodePath.resolve(process.argv[3] ?? "/etc/cortex");
const configPath = NodePath.join(stateDir, "cortex-mcp.json");
const envPath = NodePath.join(envDir, "cortex.env");
if (NodeFS.existsSync(configPath) || NodeFS.existsSync(envPath))
  throw new Error("Back up existing Cortex config files before configuring new scoped tokens");
for (const directory of [stateDir, envDir])
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
const readToken = NodeCrypto.randomBytes(32).toString("hex");
const writeToken = NodeCrypto.randomBytes(32).toString("hex");
for (const [file, body] of [
  [
    configPath,
    JSON.stringify(
      { url: "http://127.0.0.1:3981/mcp", bearerToken: readToken, writeBearerToken: writeToken },
      null,
      2,
    ) + "\n",
  ],
  [
    envPath,
    `CORTEX_READ_TOKEN=${readToken}\nCORTEX_WRITE_TOKEN=${writeToken}\nCORTEX_VAULT=/var/lib/cortex\nCORTEX_MODEL_CACHE=/var/cache/cortex/models\nCORTEX_HOST=127.0.0.1\nCORTEX_PORT=3981\n`,
  ],
]) {
  const fd = NodeFS.openSync(file, "wx", 0o600);
  try {
    NodeFS.writeFileSync(fd, body);
  } finally {
    NodeFS.closeSync(fd);
  }
}
console.log("Created scoped Cortex service credentials and the app's read-only MCP connection.");
