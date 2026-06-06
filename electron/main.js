const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const path  = require("path");
const fs    = require("fs");
const os    = require("os");
const { spawn, execSync, execFileSync } = require("child_process");
let ffmpegPath = null;
let ffprobePath = null;
try { ffmpegPath = require("ffmpeg-static"); } catch(_) {}
try { ffprobePath = require("ffprobe-static").path; } catch(_) {}

app.name = "ENKRIT";
let win;
let activeWhisperProc = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 780,
    minWidth: 700, minHeight: 480,
    backgroundColor: "#080812",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    title: "ENKRIT",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: false,
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, "..", "src", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.setTitle("ENKRIT");
  win.webContents.on("did-finish-load", () => win.setTitle("ENKRIT"));
  buildMenu();
}

/* ══════════════════════════════════════
   IPC: LOCAL WHISPER SUBTITLE GENERATION
══════════════════════════════════════ */
ipcMain.handle("run-whisper", async (event, videoPath) => {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, "..", "src", "whisper_sub.py");
    const srtPath    = path.join(os.tmpdir(), "enkrit_sub_" + Date.now() + ".srt");

    // Find python3
    let python = "python3";
    try { execSync("python3 --version", { stdio:"ignore" }); }
    catch(_) {
      try { execSync("python --version", { stdio:"ignore" }); python = "python"; }
      catch(_2) { resolve({ error: "Python not found. Install Python 3 from python.org" }); return; }
    }

    if(activeWhisperProc) {
      try { activeWhisperProc.kill(); } catch(_) {}
      activeWhisperProc = null;
    }

    const proc = spawn(python, [scriptPath, videoPath, srtPath]);
    activeWhisperProc = proc;
    let lastMsg = {};

    proc.stdout.on("data", data => {
      const lines = data.toString().trim().split("\n");
      lines.forEach(line => {
        try {
          const msg = JSON.parse(line.trim());
          lastMsg = msg;
          // Forward progress to renderer
          if(win && !win.isDestroyed()) win.webContents.send("whisper-progress", msg);
        } catch(_) {}
      });
    });

    proc.stderr.on("data", data => {
      // stderr from whisper is usually download progress — ignore or forward
      const txt = data.toString();
      if(txt.includes("Downloading") || txt.includes("Loading")) {
        if(win && !win.isDestroyed()) win.webContents.send("whisper-progress", { status:"loading_model" });
      }
    });

    proc.on("close", code => {
      if(activeWhisperProc === proc) activeWhisperProc = null;
      if(code === 0 && lastMsg.status === "done") resolve(lastMsg);
      else resolve(lastMsg.error ? lastMsg : { error: "Transcription failed (code "+code+")" });
    });

    proc.on("error", err => {
      if(activeWhisperProc === proc) activeWhisperProc = null;
      resolve({ error: "Cannot run Python: " + err.message });
    });
  });
});

ipcMain.handle("read-file", async (event, filePath) => {
  try { return fs.readFileSync(filePath, "utf-8"); }
  catch(e) { return null; }
});

ipcMain.handle("prepare-playable", async (event, mediaPath) => {
  if(!mediaPath || !fs.existsSync(mediaPath)) return { error: "File not found" };
  if(!ffmpegPath) return { error: "FFmpeg is not available in this build" };

  const outDir = path.join(os.tmpdir(), "enkrit_playable");
  try { fs.mkdirSync(outDir, { recursive:true }); } catch(_) {}

  const base = path.basename(mediaPath, path.extname(mediaPath))
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 60) || "media";
  const outPath = path.join(outDir, `${base}_${Date.now()}.mp4`);
  const codecs = probeCodecs(mediaPath);
  const canRemux = codecs.video === "h264" && (!codecs.audio || ["aac", "mp3"].includes(codecs.audio));
  const args = canRemux
    ? [
      "-y",
      "-i", mediaPath,
      "-map", "0:v:0?",
      "-map", "0:a:0?",
      "-c", "copy",
      "-movflags", "+faststart",
      outPath,
    ]
    : [
      "-y",
      "-i", mediaPath,
      "-map", "0:v:0?",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "160k",
      "-movflags", "+faststart",
      outPath,
    ];

  const result = await runFfmpeg(args, outPath);
  return result.status === "done"
    ? { ...result, mode:canRemux ? "remux" : "transcode" }
    : result;
});

function probeCodecs(mediaPath) {
  if(!ffprobePath) return {};
  try {
    const raw = execFileSync(ffprobePath, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=nw=1:nk=1",
      mediaPath,
    ], { encoding:"utf8", timeout:10000 }).trim();
    const audio = execFileSync(ffprobePath, [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=nw=1:nk=1",
      mediaPath,
    ], { encoding:"utf8", timeout:10000 }).trim();
    return { video:raw.toLowerCase(), audio:audio.toLowerCase() };
  } catch(_) {
    return {};
  }
}

function runFfmpeg(args, outPath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = "";

    proc.stderr.on("data", data => {
      stderr = (stderr + data.toString()).slice(-5000);
    });

    proc.on("close", code => {
      if(code === 0 && fs.existsSync(outPath)) resolve({ status:"done", path:outPath });
      else resolve({ error: "Playback conversion failed", detail:stderr });
    });

    proc.on("error", err => resolve({ error: "Cannot run FFmpeg: " + err.message }));
  });
}

/* ══════════════════════════════════════
   MENU
══════════════════════════════════════ */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ label: "ENKRIT", submenu: [
      { role:"about" }, { type:"separator" },
      { role:"hide" }, { role:"hideOthers" }, { role:"unhide" },
      { type:"separator" }, { role:"quit" },
    ]}] : []),
    { label:"File", submenu:[
      { label:"Open Media…",   accelerator:"CmdOrCtrl+O",       click:()=>win.webContents.executeJavaScript('document.getElementById("fileInput").click()') },
      { label:"Open Folder…",  accelerator:"CmdOrCtrl+Shift+O", click:()=>win.webContents.executeJavaScript('document.getElementById("folderInput").click()') },
      { type:"separator" },
      isMac ? { role:"close" } : { role:"quit" },
    ]},
    { label:"Playback", submenu:[
      { label:"Play / Pause",      accelerator:"Space",            click:()=>win.webContents.executeJavaScript('document.getElementById("btnPlay").click()') },
      { label:"Back 5 seconds",    accelerator:"Left",             click:()=>win.webContents.executeJavaScript('document.getElementById("btnBack5").click()') },
      { label:"Forward 5 secs",    accelerator:"Right",            click:()=>win.webContents.executeJavaScript('document.getElementById("btnFwd5").click()') },
      { label:"Previous Video",    accelerator:"CmdOrCtrl+Left",   click:()=>win.webContents.executeJavaScript('document.getElementById("btnPrev").click()') },
      { label:"Next Video",        accelerator:"CmdOrCtrl+Right",  click:()=>win.webContents.executeJavaScript('document.getElementById("btnNext").click()') },
      { type:"separator" },
      { label:"Toggle Fullscreen", accelerator:isMac?"Ctrl+Cmd+F":"F11", click:()=>win.webContents.executeJavaScript('document.getElementById("btnFull").click()') },
      { label:"Picture in Picture",click:()=>win.webContents.executeJavaScript('document.getElementById("btnPip").click()') },
    ]},
    { label:"View", submenu:[
      { label:"Toggle Dark/Light", accelerator:"CmdOrCtrl+D",       click:()=>win.webContents.executeJavaScript('window.ENKRITToggleTheme && window.ENKRITToggleTheme()') },
      { label:"Video Filters",     accelerator:"CmdOrCtrl+Shift+F", click:()=>win.webContents.executeJavaScript('document.getElementById("btnFilter").click()') },
      { label:"Toggle Playlist",   accelerator:"CmdOrCtrl+L",       click:()=>win.webContents.executeJavaScript('document.getElementById("btnSidebar").click()') },
      { type:"separator" },
      { role:"reload" }, { role:"toggleDevTools" },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if(BrowserWindow.getAllWindows().length===0) createWindow(); });
});
app.on("before-quit", () => {
  if(activeWhisperProc) {
    try { activeWhisperProc.kill(); } catch(_) {}
    activeWhisperProc = null;
  }
});
app.on("window-all-closed", () => { if(process.platform !== "darwin") app.quit(); });

/* ══════════════════════════════════
   IPC: SCAN FOLDERS FOR MEDIA FILES
══════════════════════════════════ */
const MEDIA_EXTS = new Set([
  ".mp4",".mkv",".avi",".mov",".webm",".flv",".wmv",".m4v",".ogv",".ts",".m2ts",".3gp",".mts",".vob",".divx",".rmvb",".rm",".asf",
  ".mp3",".wav",".aac",".flac",".ogg",".oga",".m4a",".opus",".wma",".aiff",".aif",".alac",
]);
const SKIP_SCAN_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache", ".next", "Library", "Applications", "System"]);

function scanDir(dir, depth=0) {
  const files = [];
  if(depth > 4) return files;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes:true });
    for(const e of entries) {
      if(e.name.startsWith('.')) continue;
      if(SKIP_SCAN_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if(e.isDirectory() && depth < 4) {
        files.push(...scanDir(full, depth+1));
      } else if(e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if(MEDIA_EXTS.has(ext)) {
          try {
            const stat = fs.statSync(full);
            files.push({ name:e.name, path:full, size:stat.size, ext:ext.slice(1), mtime:stat.mtimeMs });
          } catch(_) {}
        }
      }
    }
  } catch(_) {}
  return files;
}

ipcMain.handle("scan-library", async () => {
  const home = os.homedir();
  const dirs = [
    path.join(home, "Movies"),
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Music"),
  ].filter(d => { try { return fs.statSync(d).isDirectory(); } catch(_){ return false; } });

  const all = [];
  for(const d of dirs) all.push(...scanDir(d));

  // Sort by most recent
  all.sort((a,b) => b.mtime - a.mtime);
  return all.slice(0, 500); // keep the UI fast while still surfacing a real library
});
