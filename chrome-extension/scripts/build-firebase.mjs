import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "vendor"), { recursive: true });
await build({
  entryPoints: [path.join(root, "src/firebase-client.mjs")],
  outfile: path.join(root, "vendor/firebase-client.js"),
  bundle: true, format: "iife", platform: "browser", target: "chrome120",
  minify: true, legalComments: "linked", charset: "utf8", logLevel: "info"
});
const version = JSON.parse(await readFile(path.join(root, "node_modules/firebase/package.json"), "utf8")).version;
const license = await readFile(path.join(root, "licenses/Firebase-APACHE-2.0.txt"), "utf8");
await writeFile(path.join(root, "vendor/NOTICE.txt"), `Firebase JavaScript SDK ${version}\nCopyright Google LLC and contributors.\nhttps://github.com/firebase/firebase-js-sdk\nBundled locally; no remote JavaScript is loaded.\n\n${license}`);
