import fs from "fs";
import path from "path";

// Bridge utilities for After Effects integration
// Updated to include new on-demand bridge functionality

export interface BridgeTarget {
  base: string;
  versions: string[];
}

export interface BridgeInstallResult {
  success: boolean;
  installCount: number;
  message: string;
}

/**
 * Get the bridge queue directory path
 * @deprecated Use the new on-demand bridge from resources/bridge-utils.ts instead
 */
export function getBridgeQueueDir(): string {
  const home = process.env.HOME || "~";
  return path.join(home, "Library", "Application Support", "raycast-ae-bridge", "queue");
}

/**
 * Get the unified bridge script that handles both audio files and script execution
 */
export function getUnifiedBridgeCode(): string {
  return [
    "// Raycast AE Bridge — Unified bridge for audio import and script execution",
    "function rbEnsureDir(p){var f=new Folder(p);if(!f.exists){f.create();}return f;}",
    "function rbCleanupOldFiles() {",
    "  try {",
    "    var home = Folder('~').fsName;",
    "    var queue = rbEnsureDir(home + '/Library/Application Support/raycast-ae-bridge/queue');",
    "    var files = queue.getFiles('*');",
    "    if (!files || files.length === 0) return;",
    "    var now = new Date().getTime();",
    "    var maxAge = 5 * 60 * 1000; // 5 minutes",
    "    for (var i=0;i<files.length;i++) {",
    "      var f = files[i];",
    "      try {",
    "        var age = now - f.modified.getTime();",
    "        if (age > maxAge) { f.remove(); }",
    "      } catch(e) {}",
    "    }",
    "  } catch(e) {}",
    "}",
    "function rbProcess(){",
    "  try {",
    "    // Check for emergency stop signal",
    "    var home = Folder('~').fsName;",
    "    var queue = rbEnsureDir(home + '/Library/Application Support/raycast-ae-bridge/queue');",
    "    var stopFile = new File(queue + '/STOP_BRIDGE.txt');",
    "    if (stopFile.exists) {",
    "      // Emergency stop is active - don't process anything",
    "      return;",
    "    }",
    "    ",
    "    // Don't process if user is actively working",
    "    if (app.project && app.project.activeItem) {",
    "      var comp = app.project.activeItem;",
    "      if (comp instanceof CompItem && comp.selectedLayers && comp.selectedLayers.length > 0) {",
    "        // User has layers selected, don't interfere",
    "        return;",
    "      }",
    "    }",
    "    ",
    "    var cmdFiles = queue.getFiles('*.cmd');",
    "    var jsxFiles = queue.getFiles('*.jsx');",
    "    var allFiles = [];",
    "    if (cmdFiles) { for (var i=0;i<cmdFiles.length;i++) allFiles.push({file:cmdFiles[i], type:'cmd'}); }",
    "    if (jsxFiles) { for (var i=0;i<jsxFiles.length;i++) allFiles.push({file:jsxFiles[i], type:'jsx'}); }",
    "    if (allFiles.length === 0) return;",
    "    ",
    "    // Only process one file at a time to avoid overwhelming AE",
    "    var item = allFiles[0]; var f = item.file; var fileType = item.type;",
    "    var content=''; var ok=false;",
    "    try {",
    "      if (!(f instanceof File)) return;",
    "      f.open('r');",
    "      content = f.read();",
    "      f.close();",
    "      content = String(content).replace(/\\s+$/, '');",
    "    } catch(e) {",
    "      /* keep file for retry */",
    "      return;",
    "    }",
    "    if (!content) { /* keep file for retry */ return; }",
    "    ",
    "    var prj = app.project;",
    "    if (!prj) { /* keep file for retry */ return; }",
    "    ",
    "    try {",
    "      if (fileType === 'cmd') {",
    "        // Handle audio file import",
    "        app.beginUndoGroup('Raycast Add Audio');",
    "        var io = new ImportOptions(new File(content));",
    "        var footage = prj.importFile(io);",
    "        if (footage){",
    "          // ensure 'Audio' bin",
    "          var bin=null;",
    "          for (var j=1;j<=prj.items.length;j++){",
    "            var it=prj.items[j];",
    "          if (it instanceof FolderItem && it.name==='Audio'){",
    "            bin=it; break;",
    "          }",
    "        }",
    "        if (!bin){ bin = prj.items.addFolder('Audio'); }",
    "        try { footage.parentFolder = bin; } catch(_){ }",
    "        var comp = prj.activeItem;",
    "        if (comp && comp instanceof CompItem) {",
    "          var layer = comp.layers.add(footage);",
    "          layer.startTime = comp.time;",
    "          ok=true;",
    "        }",
    "      }",
    "      app.endUndoGroup();",
    "    } else if (fileType === 'jsx') {",
    "      // Handle script execution",
    "      app.beginUndoGroup('Raycast Script Execution');",
    "      eval(content);",
    "      ok=true;",
    "      app.endUndoGroup();",
    "    }",
    "  } catch(e) {",
    "    ok=false;",
    "    // Log the error silently",
    "  }",
    "  // Log success/failure silently",
    "  // Remove successful files",
    "  if (ok) { try{f.remove();}catch(_){} }",
    "} catch(e) {}",
    "}",
    "// Clean up old files on startup",
    "rbCleanupOldFiles();",
    "// Much less aggressive polling - every 5 seconds instead of 500ms",
    "try { app.scheduleTask('rbProcess()', 5000, true); } catch(e) {}",
  ].join('\n');
}

/**
 * Discover After Effects installation paths and versions
 */
export function discoverAETargets(): BridgeTarget[] {
  const home = process.env.HOME || "~";
  const candidates = [
    path.join(home, "Library", "Preferences", "Adobe", "After Effects"),
    path.join(home, "Library", "Application Support", "Adobe", "After Effects"),
  ];
  
  const targets: BridgeTarget[] = [];
  
  for (const base of candidates) {
    try { 
      fs.mkdirSync(base, { recursive: true }); 
    } catch {}
    
    let versions: string[] = [];
    try {
      versions = fs
        .readdirSync(base)
        .filter((d) => {
          try { 
            return fs.statSync(path.join(base, d)).isDirectory(); 
          } catch { 
            return false; 
          }
        });
    } catch {}
    
    if (versions.length === 0) {
      // Seed common version folders if none exist
      versions = ["25.0", "24.0", "23.0"];
      for (const v of versions) {
        try { 
          fs.mkdirSync(path.join(base, v), { recursive: true }); 
        } catch {}
      }
    }
    
    targets.push({ base, versions });
  }
  
  return targets;
}

/**
 * Install the unified bridge script to all discovered AE installations
 */
export async function installUnifiedBridge(): Promise<BridgeInstallResult> {
  try {
    const targets = discoverAETargets();
    const bridgeCode = getUnifiedBridgeCode();
    
    let installs = 0;
    for (const target of targets) {
      for (const version of target.versions) {
        const startupDir = path.join(target.base, version, "Scripts", "Startup");
        try {
          fs.mkdirSync(startupDir, { recursive: true });
          const targetPath = path.join(startupDir, "RaycastBridge.jsx");
          fs.writeFileSync(targetPath, bridgeCode, { encoding: "utf8" });
          installs++;
        } catch {}
      }
    }
    
    if (installs === 0) {
      return {
        success: false,
        installCount: 0,
        message: "Could not create any Startup folder"
      };
    }
    
    return {
      success: true,
      installCount: installs,
      message: `Installed Bridge in ${installs} version(s)`
    };
    
  } catch (e: any) {
    return {
      success: false,
      installCount: 0,
      message: e?.message || "Installation failed"
    };
  }
}

/**
 * Queue a command file for the bridge
 */
export async function queueCommand(
  content: string, 
  fileExtension: 'cmd' | 'jsx', 
  description: string
): Promise<boolean> {
  try {
    const queue = getBridgeQueueDir();
    fs.mkdirSync(queue, { recursive: true });
    
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${fileExtension}`;
    const cmdFile = path.join(queue, fileName);
    
    fs.writeFileSync(cmdFile, content + "\n", { encoding: "utf8" });
    
    return true;
  } catch (e: any) {
    console.error(`Failed to queue ${fileExtension} command:`, e);
    return false;
  }
}

/**
 * Queue an audio file path for import
 */
export async function queueAudioImport(filePath: string): Promise<boolean> {
  return queueCommand(filePath, 'cmd', `audio import: ${path.basename(filePath)}`);
}

/**
 * Queue a script for execution
 */
export async function queueScriptExecution(scriptContent: string, scriptName: string): Promise<boolean> {
  return queueCommand(scriptContent, 'jsx', `script execution: ${scriptName}`);
}

/**
 * Check if After Effects is running
 */
export async function isAERunning(): Promise<boolean> {
  try {
    const { spawn } = require('child_process');
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn("/usr/bin/osascript", [
        "-e", 'tell application "System Events" to return (exists process "After Effects")'
      ]);
      let stdout = "";
      
      proc.stdout?.on("data", (data: Buffer) => stdout += data.toString());
      proc.on("close", (code: number) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`AppleScript failed`));
      });
      proc.on("error", reject);
    });
    
    return result.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Log utility functions
 */
export function nowIso(): string {
  return new Date().toISOString();
}

export function appendLog(lines: string[], extensionName: string): string | null {
  try {
    const home = process.env.HOME || "~";
    const userLogDir = path.join(home, "Library", "Logs", `raycast-${extensionName}`);
    fs.mkdirSync(userLogDir, { recursive: true });
    const userLogFile = path.join(userLogDir, "ae-integration.log");
    const desktopLogFile = path.join(home, "Desktop", "raycast-ae-log.txt");
    
    const content = lines.map((l) => `[${nowIso()}] ${l}`).join("\n") + "\n";
    fs.appendFileSync(userLogFile, content, { encoding: "utf8" });
    
    try {
      fs.appendFileSync(desktopLogFile, content, { encoding: "utf8" });
    } catch {}
    
    return userLogFile;
  } catch {
    return null;
  }
}

export function getLogFilePath(extensionName: string): string {
  const home = process.env.HOME || "~";
  return path.join(home, "Library", "Logs", `raycast-${extensionName}`, "ae-integration.log");
}

// === NEW ON-DEMAND BRIDGE FUNCTIONS ===

export type OnDemandCommand =
  | { action: "import_audio"; path: string; requireActiveComp?: boolean }
  | { action: "run_jsx_text"; code: string }
  | { action: "run_jsx_file"; path: string };

export interface OnDemandResult {
  ok: boolean;
  result?: {
    requestId: string;
    operation: string;
    elapsedMs: number;
  };
  error?: string;
  stack?: string;
}

/**
 * Execute a command in After Effects using the on-demand bridge
 * Updated to match the b-roll approach using aelistener.jsx
 */
export async function runOnDemand(cmd: OnDemandCommand): Promise<OnDemandResult> {
  const isRunning = await isAERunning();
  if (!isRunning) {
    throw new Error("After Effects is not running. Please open After Effects first.");
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const os = require("os");
  const homeDir = process.env.HOME || os.homedir();
  const bridgeDir = path.join(homeDir, "Library", "Application Support", "raycast-ae-bridge");
  const jobsDir = path.join(bridgeDir, "jobs");
  
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  
  const cmdPath = path.join(jobsDir, `rb_${requestId}.json`);
  const artifactPath = path.join(jobsDir, `rb_${requestId}.done.json`);

  const payload = {
    ...cmd,
    requestId,
    artifactPath,
  };

  try {
    const { spawn } = require('child_process');
    
    // Fast path: for direct JSX execution or import_audio converted to JSX
    if (cmd.action === "run_jsx_text" || cmd.action === "run_jsx_file" || cmd.action === "import_audio") {
      let jsxPath = "";
      
      if (cmd.action === "run_jsx_text") {
        jsxPath = path.join(jobsDir, `rb_${requestId}_direct.jsx`);
        fs.writeFileSync(jsxPath, cmd.code, { encoding: "utf8" });
      } else if (cmd.action === "run_jsx_file") {
        jsxPath = cmd.path;
      } else if (cmd.action === "import_audio") {
        // Convert import_audio to JSX code (same as b-roll approach)
        const escapedPath = cmd.path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const jsxCode = `
(function() {
  try {
    var prj = app.project;
    if (!prj) throw new Error("No project open");
    
    var io = new ImportOptions(new File('${escapedPath}'));
    var footage = prj.importFile(io);
    if (!footage) throw new Error("Failed to import file");
    
    // Create or find Audio bin
    var bin = null;
    for (var i = 1; i <= prj.items.length; i++) {
      var it = prj.items[i];
      if (it instanceof FolderItem && it.name === 'Audio') {
        bin = it;
        break;
      }
    }
    if (!bin) {
      bin = prj.items.addFolder('Audio');
    }
    try { footage.parentFolder = bin; } catch(_) {}
    
    // Add to active comp if one is open
    var comp = prj.activeItem;
    if (comp && comp instanceof CompItem) {
      app.beginUndoGroup('Add Audio');
      var layer = comp.layers.add(footage);
      try {
        layer.startTime = comp.time;
      } catch(_) {}
      app.endUndoGroup();
    }
  } catch(e) {
    // Silent fail - logged elsewhere
  }
})();
`;
        jsxPath = path.join(jobsDir, `rb_${requestId}_direct.jsx`);
        fs.writeFileSync(jsxPath, jsxCode, { encoding: "utf8" });
      }

      // Try multiple AE versions
      const appleScript = `
        tell application "After Effects"
          activate
          DoScriptFile POSIX file "${jsxPath.replace(/"/g, '\\"')}"
        end tell
      `;
      
      await new Promise<void>((resolve, reject) => {
        const p = spawn("/usr/bin/osascript", ["-e", appleScript]);
        p.on("close", (code: number) => (code === 0 ? resolve() : reject(new Error(`AppleScript failed: ${code}`))));
        p.on("error", reject);
      });
      
      // Cleanup JSX file
      if (cmd.action !== "run_jsx_file") {
        try { fs.unlinkSync(jsxPath); } catch { /* ignore */ }
      }
      
      return { ok: true, result: { requestId, operation: "direct", elapsedMs: 0 } };
    }

    // Fallback: use the inbox approach with aelistener.jsx
    const inboxDir = path.join(homeDir, "Library", "Application Support", "raycast-ae-bridge", "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    
    const inboxCmdPath = path.join(inboxDir, "cmd.json");
    const inboxCmdTmp = inboxCmdPath + ".tmp";
    fs.writeFileSync(inboxCmdTmp, JSON.stringify(payload));
    fs.renameSync(inboxCmdTmp, inboxCmdPath);
    fs.writeFileSync(cmdPath, JSON.stringify(payload));

    // Execute via AppleScript - trigger aelistener.jsx (try multiple versions)
    const appleScript = `
      tell application "After Effects"
        activate
        set ran to false
        if ran is false then
          try
            DoScriptFile POSIX file "/Applications/Adobe After Effects 2025/Scripts/Startup/aelistener.jsx"
            set ran to true
          end try
        end if
        if ran is false then
          try
            DoScriptFile POSIX file "/Applications/Adobe After Effects 2024/Scripts/Startup/aelistener.jsx"
            set ran to true
          end try
        end if
        if ran is false then error "AE Listener script not found"
      end tell
    `;

    await new Promise<string>((resolve, reject) => {
      const proc = spawn("/usr/bin/osascript", ["-e", appleScript]);
      let stdout = "";
      let stderr = "";
      
      proc.stdout?.on("data", (data: Buffer) => stdout += data.toString());
      proc.stderr?.on("data", (data: Buffer) => stderr += data.toString());
      
      proc.on("close", (code: number) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`AppleScript failed: ${stderr}`));
      });
      
      proc.on("error", reject);
    });

    // Wait for artifact with timeout
    const start = Date.now();
    const deadlineMs = 5000;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    while (Date.now() - start < deadlineMs) {
      try {
        let txt: string;
        try {
          txt = fs.readFileSync(artifactPath, "utf8");
        } catch {
          const tmpPath = artifactPath + ".tmp";
          try {
            txt = fs.readFileSync(tmpPath, "utf8");
          } catch {
            throw new Error("Artifact not found");
          }
        }
        
        const result = JSON.parse(txt);
        
        // Clean up
        try {
          fs.unlinkSync(cmdPath);
          fs.unlinkSync(artifactPath);
          try { fs.unlinkSync(artifactPath + ".tmp"); } catch { /* ignore */ }
        } catch { /* ignore */ }
        
        return result;
      } catch {
        await sleep(150);
      }
    }

    try { fs.unlinkSync(cmdPath); } catch { /* ignore */ }
    throw new Error("Timed out waiting for After Effects");
    
  } catch (error) {
    try { fs.unlinkSync(cmdPath); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Check if After Effects is running (alias for isAERunning)
 */
export async function isAfterEffectsRunning(): Promise<boolean> {
  return isAERunning();
}

/**
 * Launch After Effects if not running
 */
export async function ensureAfterEffectsRunning(): Promise<void> {
  const isRunning = await isAfterEffectsRunning();
  if (!isRunning) {
    const { spawn } = require('child_process');
    // Use generic "After Effects" which will launch whatever version is installed
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("/usr/bin/osascript", [
        "-e", 'tell application "After Effects" to activate'
      ]);
      
      proc.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`Failed to launch AE: code ${code}`));
      });
      proc.on("error", reject);
    });
    
    // Give AE time to fully launch
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
