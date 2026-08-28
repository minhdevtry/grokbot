import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import {
  archivedDmg,
  cachedDmg,
  cachedRuntimeApp,
  dmgSha256,
  dmgUrl,
  repoRoot
} from "./lib/config.mjs";
import { run } from "./lib/process.mjs";
import { cacheRuntimeFromApp, hydrateSourcePayloadFromRuntime, validateRuntimeApp } from "./lib/runtime.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

const cachedExe = path.join(repoRoot, ".cache/downloads/Grok_Bot_0.18.0_Setup.exe");
const archivedExe = path.join(repoRoot, "research-archives/original/0.18.0/windows-x64/Grok_Bot_0.18.0_Setup.exe");
const exeSha256 = "464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function fetchFromGitLfs(oid, size) {
  const res = await fetch("https://github.com/b-nnett/grok-bot-0.18-reconstructed.git/info/lfs/objects/batch", {
    method: "POST",
    headers: {
      "Accept": "application/vnd.git-lfs+json",
      "Content-Type": "application/vnd.git-lfs+json"
    },
    body: JSON.stringify({
      operation: "download",
      transfers: ["basic"],
      objects: [{ oid, size }]
    })
  });
  if (!res.ok) throw new Error(`LFS batch request failed: HTTP ${res.status}`);
  const data = await res.json();
  const action = data.objects?.[0]?.actions?.download;
  if (!action?.href) throw new Error("No download action found in LFS response");
  return action.href;
}

async function downloadDmg() {
  await mkdir(path.dirname(cachedDmg), { recursive: true });
  if (await exists(cachedDmg)) {
    const digest = await sha256(cachedDmg);
    if (digest === dmgSha256) return;
    await rm(cachedDmg, { force: true });
  }

  if (await exists(archivedDmg)) {
    const archivedDigest = await sha256(archivedDmg);
    if (archivedDigest !== dmgSha256) {
      throw new Error(`Archived DMG checksum mismatch: expected ${dmgSha256}, got ${archivedDigest}. Run git lfs pull before bootstrapping.`);
    }
    console.log(`Using archived release ${archivedDmg}`);
    await copyFile(archivedDmg, cachedDmg);
    return;
  }

  console.log(`Downloading ${dmgUrl}`);
  let response = await fetch(dmgUrl, { redirect: "follow" }).catch(() => null);
  if (!response || !response.ok || response.body == null) {
    const lfsUrl = await fetchFromGitLfs(dmgSha256, 155793020);
    response = await fetch(lfsUrl);
  }
  if (!response.ok || response.body == null) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const partial = `${cachedDmg}.partial`;
  await rm(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
  const digest = await sha256(partial);
  if (digest !== dmgSha256) {
    await rm(partial, { force: true });
    throw new Error(`DMG checksum mismatch: expected ${dmgSha256}, got ${digest}`);
  }
  await rename(partial, cachedDmg);
}

async function downloadExe() {
  await mkdir(path.dirname(cachedExe), { recursive: true });
  if (await exists(cachedExe)) {
    const digest = await sha256(cachedExe);
    if (digest === exeSha256) return;
    await rm(cachedExe, { force: true });
  }

  if (await exists(archivedExe)) {
    const archivedDigest = await sha256(archivedExe);
    if (archivedDigest === exeSha256) {
      console.log(`Using archived release ${archivedExe}`);
      await copyFile(archivedExe, cachedExe);
      return;
    }
  }

  console.log("Downloading Windows Setup.exe...");
  let response = await fetch("https://downloads.cursor.com/grokbot/stable/win32-x64/0.18.0/Grok_Bot_0.18.0_Setup.exe", { redirect: "follow" }).catch(() => null);
  if (!response || !response.ok || response.body == null) {
    const lfsUrl = await fetchFromGitLfs(exeSha256, 125825552);
    response = await fetch(lfsUrl);
  }
  if (!response.ok || response.body == null) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const partial = `${cachedExe}.partial`;
  await rm(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
  const digest = await sha256(partial);
  if (digest !== exeSha256) {
    await rm(partial, { force: true });
    throw new Error(`Checksum mismatch: expected ${exeSha256}, got ${digest}`);
  }
  await rename(partial, cachedExe);
}

async function extractRuntime() {
  if (process.platform === "darwin") {
    const mountRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-018-mount-"));
    let attached = false;
    try {
      await run(SYSTEM_TOOLS.hdiutil, ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, cachedDmg]);
      attached = true;
      await cacheRuntimeFromApp(path.join(mountRoot, "Grok Bot.app"));
    } finally {
      if (attached) await run(SYSTEM_TOOLS.hdiutil, ["detach", mountRoot]);
      await rm(mountRoot, { recursive: true, force: true });
    }
  } else {
    // Linux / Windows: extract using 7za
    console.log("Extracting runtime using 7za for Linux...");
    const { path7za } = await import("7zip-bin");
    const extractedDir = path.join(repoRoot, ".cache/extracted");
    await rm(extractedDir, { recursive: true, force: true });
    await mkdir(extractedDir, { recursive: true });

    await new Promise((resolve, reject) => {
      const child = spawn(path7za, ["x", "-y", cachedExe, `-o${extractedDir}`, "resources/*"], { stdio: "inherit" });
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`7za exited with code ${code}`)));
      child.on("error", reject);
    });

    const resourcesDir = path.join(cachedRuntimeApp, "Contents", "Resources");
    await mkdir(resourcesDir, { recursive: true });
    await copyFile(path.join(extractedDir, "resources", "app.asar"), path.join(resourcesDir, "app.asar"));
    
    const unpackedDest = path.join(resourcesDir, "app.asar.unpacked");
    await rm(unpackedDest, { recursive: true, force: true });
    const { cp } = await import("node:fs/promises");
    await cp(path.join(extractedDir, "resources", "app.asar.unpacked"), unpackedDest, { recursive: true });
  }
}

const configuredApp = process.env.GROK_BOT_018_APP?.trim();
let runtimeApp;
if (configuredApp) {
  runtimeApp = await cacheRuntimeFromApp(configuredApp);
} else if (await exists(cachedRuntimeApp)) {
  runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
} else {
  if (process.platform === "darwin") {
    await downloadDmg();
  } else {
    await downloadExe();
  }
  await extractRuntime();
  runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
}

const hydrated = await hydrateSourcePayloadFromRuntime(runtimeApp);

console.log(`Runtime ready: ${cachedRuntimeApp}`);
console.log(`Checksum-pinned source payload ready: ${hydrated.destination} (${hydrated.sha256})`);
console.log("The checksum-pinned app supplies only the Electron shell, ABI-matched native dependencies, and explicitly documented build fallbacks.");
