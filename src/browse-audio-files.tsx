import { Action, ActionPanel, Clipboard, Icon, List, LocalStorage, Toast, getPreferenceValues, showToast, closeMainWindow, PopToRootType } from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import fs from "fs";
import path from "path";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import {
  runOnDemand,
  ensureAfterEffectsRunning,
  appendLog,
  getLogFilePath,
  nowIso,
  isAfterEffectsRunning,
} from "./bridge-utils";

interface Preferences {
  audioFolder: string;
  aeBinaryPath?: string;
}

interface AudioItem {
  path: string;
  name: string;
  category: string; // derived from subfolder path relative to root
  size: number;
}

const audioExtensions = [
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".aiff",
  ".aif",
  ".caf"
];

export default function Command() {
  const { audioFolder } = getPreferenceValues<Preferences>();
  const [items, setItems] = useState<AudioItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [isLoading, setIsLoading] = useState(true);
  const [favorites, setFavorites] = useState<string[]>([]);
  // Repo/cloud-backed favorites file (visible): audio-files-favorites.json
  function getFavoritesFilePath(): string | null {
    try {
      if (!audioFolder) return null;
      return path.join(audioFolder, "audio-files-favorites.json");
    } catch {}
    return null;
  }
  // Legacy hidden filename support (migration)
  function getLegacyHiddenFavoritesFilePath(): string | null {
    try {
      if (!audioFolder) return null;
      return path.join(audioFolder, ".audio-files-favorites.json");
    } catch {}
    return null;
  }
  // Repo fallback (Git-synced) if writing to audioFolder fails or is blocked
  function getRepoFallbackFavoritesFilePath(): string {
    const home = process.env.HOME || "~";
    return path.join(home, "Documents", "GitHub", "raycast", "resources", "sync", "audio-files-favorites.json");
  }
  function readFavoritesFile(): string[] | null {
    try {
      const fp = getFavoritesFilePath();
      if (fp && fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, "utf8");
        const arr = JSON.parse(content);
        return Array.isArray(arr) ? arr.filter((v: unknown) => typeof v === "string") : null;
      }
      // Fallback to legacy hidden file
      const legacy = getLegacyHiddenFavoritesFilePath();
      if (legacy && fs.existsSync(legacy)) {
        const content = fs.readFileSync(legacy, "utf8");
        const arr = JSON.parse(content);
        return Array.isArray(arr) ? arr.filter((v: unknown) => typeof v === "string") : null;
      }
      // Fallback to repo-synced file if present
      const repoFp = getRepoFallbackFavoritesFilePath();
      if (fs.existsSync(repoFp)) {
        const content = fs.readFileSync(repoFp, "utf8");
        const arr = JSON.parse(content);
        return Array.isArray(arr) ? arr.filter((v: unknown) => typeof v === "string") : null;
      }
    } catch {}
    return null;
  }
  function writeFavoritesFile(list: string[]) {
    try {
      const fp = getFavoritesFilePath();
      if (!fp) return;
      try {
        fs.writeFileSync(fp, JSON.stringify(list, null, 2), "utf8");
      } catch (e) {
        // Primary failed (e.g., permissions). Write to repo fallback instead
        try {
          const repoFp = getRepoFallbackFavoritesFilePath();
          fs.mkdirSync(path.dirname(repoFp), { recursive: true });
          fs.writeFileSync(repoFp, JSON.stringify(list, null, 2), "utf8");
        } catch {}
      }
      // Clean up legacy hidden file if present
      try {
        const legacy = getLegacyHiddenFavoritesFilePath();
        if (legacy && fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });
      } catch {}
    } catch {}
  }
  const [recentlyUsed, setRecentlyUsed] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoplayEnabled, setAutoplayEnabled] = useState(false);
  const [currentlyPlaying, setCurrentlyPlaying] = useState<string | null>(null);
  const playerRef = useRef<any>(null);
  const stopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [shuffleSeed, setShuffleSeed] = useState<number | null>(null);

  useEffect(() => {
    loadFavorites();
    loadRecentlyUsed();
    loadAutoplayPreference();
  }, []);

  useEffect(() => {
    loadItems();
  }, [audioFolder]);

  function recursivelyFindAudio(dir: string, baseDir: string): AudioItem[] {
    const found: AudioItem[] = [];
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          found.push(...recursivelyFindAudio(full, baseDir));
        } else if (stat.isFile()) {
          const ext = path.extname(entry).toLowerCase();
          if (audioExtensions.includes(ext)) {
            const relative = path.relative(baseDir, dir);
            const category = relative === "" ? "Root" : relative;
            found.push({ path: full, name: entry, category, size: stat.size });
          }
        }
      }
    } catch (error) {
      console.error("Error reading directory", dir, error);
    }
    return found;
  }


  // Derive the top-level category name from a relative subfolder path
  function topLevelCategoryName(category: string): string {
    if (!category || category === "Root") return "Root";
    const idx = category.indexOf(path.sep);
    return idx === -1 ? category : category.slice(0, idx);
  }



  async function revealLogInFinder() {
    const logFile = getLogFilePath("audio-files");
    spawn("/usr/bin/open", ["-R", logFile]);
  }

  async function copyLogToClipboard() {
    try {
      const logFile = getLogFilePath("audio-files");
      const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "(no log yet)";
      await Clipboard.copy(content);
      await showToast({ style: Toast.Style.Success, title: "Copied AE Debug Log" });
    } catch (e: any) {
      await showToast({ style: Toast.Style.Failure, title: "Copy Failed", message: e?.message || "Could not copy log" });
    }
  }

  async function clearLogFile() {
    try {
      const logFile = getLogFilePath("audio-files");
      fs.rmSync(logFile, { force: true });
      await showToast({ style: Toast.Style.Success, title: "Cleared AE Debug Log" });
    } catch (e: any) {
      await showToast({ style: Toast.Style.Failure, title: "Clear Failed", message: e?.message || "Could not clear log" });
    }
  }



  // On-demand bridge mode - direct execution in After Effects (no spinner, close window immediately)
  async function sendViaBridge(filePath: string) {
    try {
      const running = await isAfterEffectsRunning();
      if (!running) {
        await showToast({ style: Toast.Style.Failure, title: "Open After Effects first", message: "Open a project with an active comp, then retry." });
        return;
      }

      await closeMainWindow({ popToRootType: PopToRootType.Suspended });

      const result = await runOnDemand({
        action: "import_audio",
        path: filePath,
        requireActiveComp: true
      });

      if (result.ok) {
        appendLog([`On-demand bridge imported audio: ${path.basename(filePath)}`, `elapsedMs: ${result.result?.elapsedMs}`], "audio-files");
        await addToRecentlyUsed(filePath);
      } else {
        appendLog([`On-demand bridge failed: ${path.basename(filePath)}`, `error: ${result.error}`], "audio-files");
      }
    } catch (e: any) {
      appendLog([`sendViaBridge error: ${e?.message || e}`], "audio-files");
      // No toast here since the window may already be closed
    }
  }

  // Bridge installation is now centralized in bridge-control extension

  function escapeForJsDoubleQuotedString(input: string): string {
    return input.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
  }
  function escapeForJsSingleQuotedString(input: string): string {
    return input.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  // Use proper check for whether AE is running
  const isAeProcessRunning = isAfterEffectsRunning;

  async function sendToAfterEffects(filePath: string) {
    try {
      const baseName = path.basename(filePath);
      const toast = await showToast({ style: Toast.Style.Animated, title: "Sending to After Effects…", message: baseName });
      // Write temporary JSX file to avoid heavy quoting
      const pathForExt = escapeForJsSingleQuotedString(filePath);
      const jsx = `function __add(){
        var p='${pathForExt}';
        var prj = app.project; if (!prj) { return; }
        var comp = prj.activeItem; if (!comp || !(comp instanceof CompItem)) { return; }
        function rbEnsureAudioFolder(){
          for (var i=1;i<=prj.items.length;i++){ var it=prj.items[i]; if (it instanceof FolderItem && it.name==='Audio') return it; }
          return prj.items.addFolder('Audio');
        }
        function rbFindFootageByPath(pathStr){
          var fs = new File(pathStr).fsName;
          for (var i=1;i<=prj.items.length;i++){ var it=prj.items[i]; if (it instanceof FootageItem){ try { if (it.file && it.file.fsName===fs) return it; } catch(e){} } }
          return null;
        }
        var footage = rbFindFootageByPath(p);
        if (!footage){ try { var io = new ImportOptions(new File(p)); footage = prj.importFile(io); } catch(e) { footage=null; } }
        if (!footage) { return; }
        try { app.beginUndoGroup('Raycast Add Audio');
          var bin = rbEnsureAudioFolder();
          try { footage.parentFolder = bin; } catch(e){}
          var layer = comp.layers.add(footage); layer.startTime = comp.time;
        } finally { app.endUndoGroup(); }
        try { var home = Folder('~').fsName; var log = new File(home + '/Desktop/raycast-ae-log.txt'); log.open('a'); log.writeln('[JSX OK] ' + p); log.close(); } catch(e) {}
      } __add();`;
      const os = require("os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-audio-"));
      const tmpFile = path.join(tmpDir, "add-audio.jsx");
      fs.writeFileSync(tmpFile, jsx, { encoding: "utf8" });
              appendLog([`Prepared JSX at ${tmpFile}`, `Method=Bridge primary`], "audio-files");

      // New primary: if AE is running, queue via Bridge so we target the existing session
      const running = await isAeProcessRunning();
      if (running) {
        await sendViaBridge(filePath);
        toast.title = "Queued for After Effects";
        toast.message = baseName;
        toast.style = Toast.Style.Success;
        try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch {}
        return;
      }
      // If AE is not running, do not spawn a fresh instance (no active comp). Ask user to open AE.
      await showToast({ style: Toast.Style.Failure, title: "Open After Effects first", message: "Open a project with an active comp, then press ⌘S again." });
      try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch {}
      return;

      function proceedAppleScript() {
        const args = [
        "-e",
        `set jsxAlias to (POSIX file "${tmpFile.replace(/\"/g, '\\"')}") as alias`,
        "-e",
        'tell application id "com.adobe.AfterEffects"',
        "-e",
        "activate",
        "-e",
        "try",
        "-e",
        "DoScriptFile jsxAlias",
        "-e",
        'return "OK"',
        "-e",
        "on error errMsg number errNum",
        "-e",
        'error errMsg & " (" & errNum & ")"',
        "-e",
        "end try",
        "-e",
        "end tell",
        ];
      const ae = spawn("/usr/bin/osascript", args);
      let stderr = "";
      let stdout = "";
      ae.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      ae.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      ae.on("error", async (err: Error) => {
        appendLog([`osascript spawn error: ${err.message}`], "audio-files");
        await showToast({ style: Toast.Style.Failure, title: "AppleScript failed to start", message: err.message });
      });
      // Timeout: if AppleScript hangs (e.g., blocked automation), fallback appropriately
      const timeoutMs = 7000;
      const timeout = setTimeout(async () => {
        try {
          ae.kill("SIGKILL");
        } catch {}
        const isRunning = await isAeProcessRunning();
        appendLog([`AppleScript timed out after ${timeoutMs}ms`, `AE running? ${isRunning}`, `stdout=${stdout.trim()}`, `stderr=${stderr.trim()}`]);
        if (!isRunning) {
          toast.title = "Launching After Effects…";
          toast.message = baseName;
          spawn("/usr/bin/open", ["-b", "com.adobe.AfterEffects", "--args", "-r", tmpFile]).on("error", async (err) => {
            appendLog([`open -b error: ${err.message}`]);
            await showToast({ style: Toast.Style.Failure, title: "Failed to launch After Effects", message: err.message });
          });
          setTimeout(() => {
            try {
              fs.unlinkSync(tmpFile);
              fs.rmdirSync(tmpDir);
            } catch {}
            toast.title = "Attempted via launch";
            toast.message = "If nothing happens, enable Raycast → After Effects in Automation settings.";
            toast.style = Toast.Style.Success;
            appendLog([`Launch fallback issued for ${tmpFile}`]);
          }, 4000);
        } else {
          await showToast({
            style: Toast.Style.Failure,
            title: "After Effects did not accept AppleScript",
            message: "Enable Raycast under Automation for After Effects, then retry.",
          });
          appendLog([`AE rejected AppleScript: stdout=${stdout.trim()} stderr=${stderr.trim()}`]);
          try {
            fs.unlinkSync(tmpFile);
            fs.rmdirSync(tmpDir);
          } catch {}
        }
      }, timeoutMs);
      ae.on("close", async (code: number) => {
        clearTimeout(timeout);
        const ok = stdout.trim().endsWith("OK");
        appendLog([`osascript exit code=${code}`, `stdout=${stdout.trim()}`, `ok=${ok}`]);
        if (code !== 0 || !ok) {
          // Fallback: launch AE and run the JSX on startup
          toast.title = "Launching After Effects…";
          toast.message = baseName;
          spawn("/usr/bin/open", ["-b", "com.adobe.AfterEffects", "--args", "-r", tmpFile]).on("error", async (err) => {
            appendLog([`open -b error: ${err.message}`]);
            await showToast({ style: Toast.Style.Failure, title: "Failed to launch After Effects", message: err.message });
          });
          setTimeout(() => {
            try {
              fs.unlinkSync(tmpFile);
              fs.rmdirSync(tmpDir);
            } catch {}
            toast.title = "Attempted via launch";
            toast.message = "If nothing happens, check Automation permissions for Raycast → After Effects.";
            toast.style = Toast.Style.Success;
            appendLog([`Launch fallback issued for ${tmpFile}`]);
          }, 4000);
        } else {
          toast.title = "Sent to After Effects";
          toast.message = baseName;
          toast.style = Toast.Style.Success;
          appendLog([`AppleScript path succeeded for ${tmpFile}`]);
          try {
            fs.unlinkSync(tmpFile);
            fs.rmdirSync(tmpDir);
          } catch {}
        }
      });
      }
    } catch (e: any) {
      appendLog([`sendToAfterEffects exception: ${e?.message || e}`]);
      await showToast({ style: Toast.Style.Failure, title: "Error", message: e?.message || "Could not send to After Effects" });
    }
  }

  async function sendToAfterEffectsViaRestart(filePath: string) {
    try {
      const baseName = path.basename(filePath);
      const toast = await showToast({ style: Toast.Style.Animated, title: "Restarting After Effects…", message: baseName });
      const pathForExt = escapeForJsSingleQuotedString(filePath);
      const jsx = `function __add(){\n        var p='${pathForExt}';\n        var prj = app.project;\n        if (!prj) { return; }\n        var comp = prj.activeItem;\n        var io = new ImportOptions(File(p));\n        var footage;\n        try { footage = prj.importFile(io); } catch (e) { return; }\n        if (!comp || !(comp instanceof CompItem)) { return; }\n        var layer = comp.layers.add(footage);\n        layer.startTime = comp.time;\n      } __add();`;
      const os = require("os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-audio-"));
      const tmpFile = path.join(tmpDir, "add-audio.jsx");
      fs.writeFileSync(tmpFile, jsx, { encoding: "utf8" });

      appendLog([`Restart path requested with ${tmpFile}`]);
      // Do NOT force-kill AE; instruct user to close if running
      const running = await isAeProcessRunning();
      if (running) {
        await showToast({ style: Toast.Style.Failure, title: "Close After Effects and retry", message: "The restart path runs on launch only." });
        return;
      }

      spawn("/usr/bin/open", ["-b", "com.adobe.AfterEffects", "--args", "-r", tmpFile]).on("error", async (err) => {
        appendLog([`open -b error: ${err.message}`]);
        await showToast({ style: Toast.Style.Failure, title: "Failed to launch After Effects", message: err.message });
      });

      setTimeout(() => {
        try {
          fs.unlinkSync(tmpFile);
          fs.rmdirSync(tmpDir);
        } catch {}
        toast.title = "Attempted via restart";
        toast.message = "If nothing happens, AE may have blocked startup args.";
        toast.style = Toast.Style.Success;
        appendLog([`Restart launch issued for ${tmpFile}`]);
      }, 6000);
    } catch (e: any) {
      appendLog([`sendToAfterEffectsViaRestart exception: ${e?.message || e}`]);
      await showToast({ style: Toast.Style.Failure, title: "Error", message: e?.message || "Could not restart After Effects" });
    }
  }

  async function loadItems() {
    try {
      setIsLoading(true);
      if (!audioFolder || !fs.existsSync(audioFolder)) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Invalid Audio Folder",
          message: "Configure a valid audio folder in preferences",
        });
        setItems([]);
        setCategories([]);
        return;
      }

      const all = recursivelyFindAudio(audioFolder, audioFolder);
      setItems(all);
      const uniqueTop = [...new Set(all.map((i) => topLevelCategoryName(i.category)))].sort();
      const cats = ["All", "Favorites", ...uniqueTop];
      setCategories(cats);

      // Restore last selected category if available and valid
      try {
        const stored = await LocalStorage.getItem("audioFilesSelectedCategory");
        if (typeof stored === "string" && cats.includes(stored)) {
          setSelectedCategory(stored);
        } else {
          setSelectedCategory("All");
        }
      } catch {
        setSelectedCategory("All");
      }

      if (all.length === 0) {
        await showToast({ style: Toast.Style.Failure, title: "No Audio Found", message: "No supported audio files in folder" });
      }
    } catch (error) {
      console.error("Failed to load audio items", error);
      await showToast({ style: Toast.Style.Failure, title: "Error Loading", message: "Could not read audio folder" });
      setItems([]);
      setCategories([]);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadFavorites() {
    try {
      const stored: unknown = await LocalStorage.getItem("favoriteAudioFiles");
      let fromLocal: string[] = [];
      if (typeof stored === "string") {
        try {
          const maybe = JSON.parse(stored);
          if (Array.isArray(maybe)) fromLocal = maybe.filter((v) => typeof v === "string");
        } catch {}
      } else if (Array.isArray(stored)) {
        fromLocal = stored.filter((v) => typeof v === "string");
      }
      const fromFile = readFavoritesFile();
      const chosen = Array.isArray(fromFile) ? fromFile : fromLocal;
      setFavorites(chosen);
      await LocalStorage.setItem("favoriteAudioFiles", JSON.stringify(chosen));
      writeFavoritesFile(chosen);
    } catch (e) {
      console.error("Failed to load favorites", e);
    }
  }

  async function loadRecentlyUsed() {
    try {
      const stored: unknown = await LocalStorage.getItem("recentlyUsedAudioFiles");
      let parsed: string[] = [];
      if (typeof stored === "string") {
        try {
          const maybe = JSON.parse(stored);
          if (Array.isArray(maybe)) parsed = maybe.filter((v) => typeof v === "string");
        } catch {}
      } else if (Array.isArray(stored)) {
        parsed = stored.filter((v) => typeof v === "string");
      }
      setRecentlyUsed(parsed);
    } catch (e) {
      console.error("Failed to load recently used", e);
    }
  }

  async function addToRecentlyUsed(filePath: string) {
    try {
      const next = [filePath, ...recentlyUsed.filter((f) => f !== filePath)].slice(0, 10);
      setRecentlyUsed(next);
      await LocalStorage.setItem("recentlyUsedAudioFiles", JSON.stringify(next));
    } catch (e) {
      console.error("Failed to update recently used", e);
    }
  }

  async function loadAutoplayPreference() {
    try {
      const stored = await LocalStorage.getItem("autoplayEnabled");
      if (typeof stored === "boolean") {
        setAutoplayEnabled(stored);
      }
    } catch (e) {
      console.error("Failed to load autoplay preference", e);
    }
  }

  async function toggleAutoplay() {
    const newValue = !autoplayEnabled;
    setAutoplayEnabled(newValue);
    await LocalStorage.setItem("autoplayEnabled", newValue);
    await showToast({
      style: Toast.Style.Success,
      title: newValue ? "Autoplay Enabled" : "Autoplay Disabled",
      message: newValue ? "Audio will play on selection" : "Use Enter to play audio"
    });
  }

  async function toggleFavorite(filePath: string) {
    const isFav = favorites.includes(filePath);
    const next = isFav ? favorites.filter((f) => f !== filePath) : [...favorites, filePath];
    setFavorites(next);
    await LocalStorage.setItem("favoriteAudioFiles", JSON.stringify(next));
    writeFavoritesFile(next);
    await showToast({
      style: Toast.Style.Success,
      title: isFav ? "Removed from Favorites" : "Added to Favorites",
      message: path.basename(filePath),
    });
  }

  function stopPlayback() {
    // Clear any pending timers
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    
    // Kill the current process immediately
    if (playerRef.current) {
      try {
        playerRef.current.kill("SIGTERM"); // Use SIGTERM for cleaner termination
      } catch {}
      playerRef.current = null;
    }
    
    setCurrentlyPlaying(null);
  }

  async function stopAllAudio() {
    // Kill all afplay processes to ensure no lingering audio
    try {
      const { exec } = require("child_process");
      exec("pkill -9 -f afplay", (error: any) => {
        if (error) {
          console.log("No afplay processes found or already stopped");
        } else {
          console.log("Stopped all afplay processes");
        }
      });
    } catch (e) {
      console.error("Failed to stop all audio", e);
    }
    
    // Also stop current playback
    stopPlayback();
    
    await showToast({
      style: Toast.Style.Success,
      title: "All Audio Stopped",
      message: "Killed all background audio processes"
    });
  }

  function playPreview(filePath: string) {
    // Prefer afplay (built-in). If it fails to spawn, nothing fatal.
    try {
      playerRef.current = spawn("/usr/bin/afplay", [filePath], { stdio: "ignore" });
      playerRef.current.on("exit", () => {
        playerRef.current = null;
        setCurrentlyPlaying(null);
      });
      setCurrentlyPlaying(filePath);
    } catch (e) {
      console.error("Failed to start afplay", e);
    }
  }

  function togglePlayback(filePath: string) {
    if (currentlyPlaying === filePath) {
      // Stop current playback
      stopPlayback();
      setCurrentlyPlaying(null);
    } else {
      // Play this file
      playPreview(filePath);
    }
  }

  function shuffleNow() {
    setShuffleSeed(Math.random());
    // Keep current selection; list order will change deterministically for this seed
  }

  // Deterministic pseudo-random based on item id and seed
  function seededScore(id: string, seed: number): number {
    let h = 2166136261 >>> 0; // FNV-1a base
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const mixed = (h ^ Math.floor(seed * 1e9)) >>> 0;
    // Map to [0,1)
    return (mixed % 1000003) / 1000003;
  }

  // Immediate selection change for autoplay mode, debounced for manual mode
  const handleSelectionChange = useMemo(() => {
    let t: NodeJS.Timeout | null = null;
    return (id: string | null) => {
      if (t) clearTimeout(t);
      
      if (autoplayEnabled) {
        // Immediate response for autoplay mode
        setSelectedId(id);
      } else {
        // Debounced for manual mode to avoid unnecessary processing
        t = setTimeout(() => setSelectedId(id), 120);
      }
    };
  }, [autoplayEnabled]);

  useEffect(() => {
    if (!selectedId) return;
    const item = items.find((i) => i.path === selectedId);
    if (!item) return;
    
    // Only autoplay if autoplay mode is enabled
    if (autoplayEnabled) {
      // Clear any existing timer
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      
      // Stop any currently playing audio first
      if (playerRef.current) {
        try {
          playerRef.current.kill("SIGTERM");
        } catch {}
        playerRef.current = null;
      }
      
      // Clear the currently playing state
      setCurrentlyPlaying(null);
      
      // Small delay to ensure previous audio is fully stopped
      setTimeout(() => {
        // Start new audio
        playPreview(item.path);
        
        // Auto-stop after 8 seconds
        stopTimerRef.current = setTimeout(() => {
          stopPlayback();
        }, 8000);
      }, 100); // 100ms delay to ensure clean transition
    }
    
    return () => {
      // Cleanup function - stop playback when component unmounts or dependencies change
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
    };
  }, [selectedId, autoplayEnabled]);

  // Cleanup on unmount to prevent lingering processes
  useEffect(() => {
    return () => {
      stopPlayback();
      // Also try to kill any remaining afplay processes when component unmounts
      try {
        const { exec } = require("child_process");
        exec("pkill -f afplay", () => {});
      } catch (e) {
        console.error("Failed to cleanup audio processes", e);
      }
    };
  }, []);

  const filtered = useMemo(() => {
    let base = items;
    if (selectedCategory === "Favorites") {
      base = base.filter((i) => favorites.includes(i.path));
    } else if (selectedCategory !== "All") {
      base = base.filter((i) => {
        if (selectedCategory === "Root") return i.category === "Root";
        return topLevelCategoryName(i.category) === selectedCategory;
      });
    }
    if (shuffleSeed !== null) {
      base = base.slice().sort((a, b) => seededScore(a.path, shuffleSeed) - seededScore(b.path, shuffleSeed));
    }
    return base;
  }, [items, favorites, selectedCategory, shuffleSeed]);

  async function sendAllFilteredToAE() {
    if (filtered.length === 0) {
      await showToast({ style: Toast.Style.Failure, title: "No items to import" });
      return;
    }
    try {
      const running = await isAfterEffectsRunning();
      if (!running) {
        await showToast({ style: Toast.Style.Failure, title: "Open After Effects first", message: "Open a project with an active comp, then retry." });
        return;
      }

      await closeMainWindow({ popToRootType: PopToRootType.Suspended });

      let imported = 0;
      for (const it of filtered) {
        try {
          await runOnDemand({
            action: "import_audio",
            path: it.path,
            requireActiveComp: false
          });
          imported++;
        } catch {}
      }

      // Log and update recently used
      appendLog([`Batch import complete: ${imported}/${filtered.length}`], "audio-files");
      for (const it of filtered) {
        await addToRecentlyUsed(it.path);
      }
    } catch (e: any) {
      appendLog([`Batch import error: ${e?.message || e}`], "audio-files");
    }
  }

  if (isLoading) {
    return (
      <List isLoading searchBarPlaceholder="Search audio files...">
        <List.EmptyView title="Loading..." />
      </List>
    );
  }

  if (items.length === 0) {
    return (
      <List searchBarPlaceholder="Search audio files...">
        <List.EmptyView
          title="No Audio Found"
          description="Configure an audio folder in preferences"
          icon={Icon.Folder}
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search audio files..."
      searchBarAccessory={
        <List.Dropdown tooltip="Filter by Category" value={selectedCategory} onChange={(v) => { setSelectedCategory(v); LocalStorage.setItem("audioFilesSelectedCategory", v); }}>
          {categories.map((c) => (
            <List.Dropdown.Item key={c} title={c} value={c} />
          ))}
        </List.Dropdown>
      }
      onSelectionChange={(id) => handleSelectionChange((id as string) || null)}
      actions={
        <ActionPanel>
          <Action
            title={autoplayEnabled ? "Disable Autoplay" : "Enable Autoplay"}
            icon={autoplayEnabled ? Icon.Pause : Icon.Play}
            shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
            onAction={() => toggleAutoplay()}
          />
          <Action
            title={shuffleSeed === null ? "Shuffle List" : "Reshuffle List"}
            icon={Icon.RotateClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={() => shuffleNow()}
          />
          <Action
            title="Import All Filtered to After Effects"
            icon={Icon.Bolt}
            shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
            onAction={() => sendAllFilteredToAE()}
          />
          <Action
            title="Stop All Audio"
            icon={Icon.Stop}
            shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
            onAction={() => stopAllAudio()}
          />
        </ActionPanel>
      }
    >
      <List.Section title={`${selectedCategory} (${filtered.length} files)`} subtitle={autoplayEnabled ? "Autoplay ON - Press ↑/↓ to audition" : "Autoplay OFF - Press Enter to play"}>
        {filtered.map((item) => {
          const fileSizeKB = Math.round(item.size / 1024);
          const title = item.name;
          const subtitle = `${item.category} • ${fileSizeKB} KB${favorites.includes(item.path) ? " ❤️" : ""}`;
          return (
            <List.Item
              key={item.path}
              id={item.path}
              title={title}
              subtitle={subtitle}
              icon={Icon.SpeakerOn}
              actions={
                <ActionPanel>
                  <Action
                    title={currentlyPlaying === item.path ? "Stop Playback" : "Play Audio"}
                    icon={currentlyPlaying === item.path ? Icon.Stop : Icon.Play}
                    onAction={() => togglePlayback(item.path)}
                  />
                  <Action
                    title={shuffleSeed === null ? "Shuffle List" : "Reshuffle List"}
                    icon={Icon.RotateClockwise}
                    shortcut={{ modifiers: ["cmd"], key: "r" }}
                    onAction={() => shuffleNow()}
                  />
                  <Action
                    title={autoplayEnabled ? "Disable Autoplay" : "Enable Autoplay"}
                    icon={autoplayEnabled ? Icon.Pause : Icon.Play}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
                    onAction={() => toggleAutoplay()}
                  />
                  <Action
                    title={favorites.includes(item.path) ? "Remove from Favorites" : "Add to Favorites"}
                    icon={favorites.includes(item.path) ? Icon.HeartDisabled : Icon.Heart}
                    shortcut={{ modifiers: ["cmd"], key: "f" }}
                    onAction={() => toggleFavorite(item.path)}
                  />
                  <Action
                    title="Send to After Effects"
                    icon={Icon.AppWindow}
                    shortcut={{ modifiers: ["cmd"], key: "s" }}
                    onAction={() => sendToAfterEffects(item.path)}
                  />
                  <Action
                    title="Send via AE Restart (Fallback)"
                    icon={Icon.RotateClockwise}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                    onAction={() => sendToAfterEffectsViaRestart(item.path)}
                  />
                  <Action
                    title="Copy AE Debug Log"
                    icon={Icon.Clipboard}
                    shortcut={{ modifiers: ["cmd"], key: "d" }}
                    onAction={() => copyLogToClipboard()}
                  />
                  <Action
                    title="Clear AE Debug Log"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
                    onAction={() => clearLogFile()}
                  />
                  <Action
                    title="Open in Finder"
                    icon={Icon.Finder}
                    onAction={() => {
                      stopPlayback();
                      // reveal in Finder via AppleScript-free approach
                      const script = `osascript -e 'tell application "Finder" to reveal POSIX file "${item.path.replace(/'/g, "'\\''")}"' -e 'tell application "Finder" to activate'`;
                      spawn("/bin/zsh", ["-lc", script], { stdio: "ignore" });
                    }}
                  />

                  <Action
                    title="Import via On-Demand Bridge"
                    icon={Icon.Bolt}
                    shortcut={{ modifiers: ["cmd", "opt"], key: "s" }}
                    onAction={() => sendViaBridge(item.path)}
                  />
                  <Action
                    title="Stop All Audio"
                    icon={Icon.Stop}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                    onAction={() => stopAllAudio()}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}

