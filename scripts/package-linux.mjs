import { cp, mkdir, rm, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { outputDir, repoRoot } from "./lib/config.mjs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const electronDistDir = path.join(repoRoot, "node_modules", "electron", "dist");
const linuxAppDir = path.join(outputDir, "grok-bot-linux-x64");

console.log("Building reconstructed ASAR for Linux...");
const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar();

console.log("Staging Linux Electron package...");
await mkdir(outputDir, { recursive: true });
await rm(linuxAppDir, { recursive: true, force: true });
await cp(electronDistDir, linuxAppDir, { recursive: true, dereference: true });

const targetExecutable = path.join(linuxAppDir, "grok-bot");
await rm(targetExecutable, { force: true });
await cp(path.join(linuxAppDir, "electron"), targetExecutable);
await chmod(targetExecutable, 0o755);

const resources = path.join(linuxAppDir, "resources");
const packagedAsar = path.join(resources, "app.asar");
const packagedUnpacked = path.join(resources, "app.asar.unpacked");

await rm(packagedAsar, { force: true });
await rm(path.join(resources, "default_app.asar"), { force: true });
await rm(packagedUnpacked, { recursive: true, force: true });

await cp(builtAsar, packagedAsar);
await cp(builtAsarUnpacked, packagedUnpacked, {
  recursive: true,
  dereference: false,
  preserveTimestamps: true,
});

// Stage Linux native bindings into unpacked deps
const treeSitterNode = path.join(repoRoot, "node_modules/tree-sitter/build/Release/tree_sitter_runtime_binding.node");
const treeSitterBashNode = path.join(repoRoot, "node_modules/tree-sitter-bash/build/Release/tree_sitter_bash_binding.node");

const targetTreeSitterDir = path.join(packagedUnpacked, "dist/deps/tree-sitter/build/Release");
const targetTreeSitterBashDir = path.join(packagedUnpacked, "dist/deps/tree-sitter-bash/build/Release");

await mkdir(targetTreeSitterDir, { recursive: true });
await mkdir(targetTreeSitterBashDir, { recursive: true });

try {
  await cp(treeSitterNode, path.join(targetTreeSitterDir, "tree_sitter_runtime_binding.node"));
  await cp(treeSitterBashNode, path.join(targetTreeSitterBashDir, "tree_sitter_bash_binding.node"));
} catch (err) {
  console.warn("Could not copy prebuilt native addons, falling back to node-deps:", err.message);
}

// Create a launcher script
const launcherScript = `#!/usr/bin/env bash
DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
exec "$DIR/grok-bot" --no-sandbox "$@"
`;
const launcherPath = path.join(linuxAppDir, "start.sh");
await writeFile(launcherPath, launcherScript, { mode: 0o755 });

console.log("\n==================================================");
console.log("  Grok Bot 0.18 Reconstructed packaged for Linux!");
console.log(`  Location: ${linuxAppDir}`);
console.log(`  Executable: ${targetExecutable}`);
console.log(`  To launch: ${targetExecutable} or ${launcherPath}`);
console.log("==================================================\n");
