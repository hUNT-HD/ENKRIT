"use strict";

const DEFAULT_SETTINGS = {
  showNomedia: true, showHidden: false, blacklist: [],
  resumePlayback: "ask", rememberBrightness: true, rememberBgPlay: false,
  rememberAspectRatio: true, rememberSpeed: false,
  defaultOrientation: "auto", seekSeconds: 5,
  autoplayNext: true, autoPip: false, gestureControl: true,
  showSubtitles: true, preferredAudioLang: "", preferredSubLang: "",
  showMusic: true, showRecentlyPlayed: true, showFloatingBtn: false,
  folderView: "grid",
};
let AppSettings = (()=>{ try{ return {...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("enkrit_settings")||"{}")}; }catch(_){ return {...DEFAULT_SETTINGS}; } })();
function saveSettings(){ try{ localStorage.setItem("enkrit_settings", JSON.stringify(AppSettings)); }catch(_){} }

/* ── STATE ── */
const S = {
  playlist:[], currentIndex:-1, playing:false,
  speed:1, dark:true, controlsTimer:null,
  isDraggingProgress:false, subtitleMode:"off",
  recognition:null, srtCues:[], decoderMode:"hw",
  whisperRunning:false, whisperListenerReady:false,
  filters:{brightness:100,contrast:100,saturation:100,sharpness:0,hue:0,blur:0,grayscale:0,sepia:0,invert:0,exposure:0,gamma:100},
  ctrlPos:{x:null,y:null}, ctrlDragging:false, ctrlDragOX:0, ctrlDragOY:0,
  nativePlayback:false, nativePosition:0, nativeDuration:0, lastResumeSave:0,
  gesture:null, pinch:null, screenBrightness:100, videoZoom:1, videoPanX:0, videoPanY:0,
  shuffle:false, repeatMode:"off", sleepTimer:null, sleepMinutes:0,
};

/* ── DOM ── */
const $  = id => document.getElementById(id);
const video    = $("videoEl");
const dropZone = $("dropZone");
const vcont    = $("videoContainer");
const controls = $("controls");
const splash   = $("splash");
const app      = $("app");
const sidebar  = $("sidebar");

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|ogv|ts|m2ts|3gp|mts|vob|divx|rmvb|rm|asf)$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|aac|flac|ogg|oga|m4a|opus|wma|aiff|aif|alac)$/i;
const MEDIA_EXT_RE = /\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|ogv|ts|m2ts|3gp|mts|vob|divx|rmvb|rm|asf|mp3|wav|aac|flac|ogg|oga|m4a|opus|wma|aiff|aif|alac)$/i;
const SW_VOLUME_MAX = 500;
function volumeMax(){ return (S.nativePlayback || S.decoderMode === "sw") ? SW_VOLUME_MAX : 100; }

function isVideoExt(name){ return VIDEO_EXT_RE.test(name || ""); }
function isAudioExt(name){ return AUDIO_EXT_RE.test(name || ""); }
function isMediaFile(name, type=""){ return /^video\//.test(type) || /^audio\//.test(type) || MEDIA_EXT_RE.test(name || ""); }
function mediaKind(name, type=""){ return /^audio\//.test(type) || isAudioExt(name) ? "audio" : "video"; }
function getFilePath(file){
  try { return window.electronAPI?.getPathForFile?.(file) || file.path || ""; }
  catch(_) { return file && file.path ? file.path : ""; }
}
function toFileUrl(filePath){
  if(/^(https?|enkrit-media|ph|content|blob|data|file):/i.test(filePath || "")) return filePath; // network/scheme/file URLs pass through
  if(/^(content|blob|https?):/i.test(filePath || "")) return filePath;
  return window.electronAPI?.toFileUrl?.(filePath) || ("file://" + encodeURI(filePath).replace(/#/g, "%23"));
}
function releaseItemUrl(item){
  if(item?.url && item.url.startsWith("blob:")) URL.revokeObjectURL(item.url);
  if(item) item.url = null;
}
function makeMediaItemFromFile(file){
  const path = getFilePath(file);
  return {
    file, path, sourcePath:path, name:file.name, url:null,
    duration:"—", size:file.size || 0, kind:mediaKind(file.name, file.type),
  };
}
function makeMediaItemFromPath(filePath, fileName, fileObj={}){
  const name = fileName || filePath.split(/[\\/]/).pop() || "Media";
  return {
    file:null, path:filePath, sourcePath:filePath, name, url:null,
    duration:fileObj.duration || (fileObj.durationMs ? fmt(fileObj.durationMs/1000) : "—"), size:fileObj.size || 0,
    kind:fileObj.kind || mediaKind(name, fileObj.type || ""),
    ext:fileObj.ext || name.split(".").pop() || "",
  };
}
function isDuplicateMedia(item){
  return S.playlist.some(p => {
    if(item.path && p.path) return p.path === item.path;
    return !item.path && !p.path && p.name === item.name && p.size === item.size;
  });
}

function isAndroidApp(){ return !!window.AndroidBridge; }
function hasNativePlayer(){ return isAndroidApp() && !!window.AndroidBridge.playNativeMedia; }
function setupAndroidBridge(){
  if(!isAndroidApp()) return;

  if(document.body) document.body.classList.add("android-app");

  window.electronAPI = window.electronAPI || {
    getPathForFile: () => "",
    toFileUrl: p => p,
    runWhisper: async () => ({ error:"AI subtitles are not available in the Android build yet" }),
    readFile: async () => null,
    preparePlayable: async () => ({ error:"Codec conversion is not available in the Android build yet" }),
  };

  window.libraryAPI = {
    scanLibrary: async () => {
      try { return JSON.parse(window.AndroidBridge.scanLibrary() || "[]"); }
      catch(e) { console.warn("Android scan failed:", e); return []; }
    },
  };

  window.ENKRITAndroid = {
    onPickedMedia(items){
      if(!Array.isArray(items)) return;
      // BUG-08/09 FIX: always clear safety timers when picker fires (even on cancel/empty)
      if(S._privateAddModeTimer){ clearTimeout(S._privateAddModeTimer); S._privateAddModeTimer = null; }
      if(S._decoyAddModeTimer){ clearTimeout(S._decoyAddModeTimer); S._decoyAddModeTimer = null; }
      // If the user is adding files into the Private folder, route them there
      // instead of playing them.
      if(S.privateAddMode){
        S.privateAddMode = false;
        const objs = privateFileObjsFromItems(items);
        if(objs.length){ addToPrivate(objs); renderPrivateHome(); }
        else showSubToast("No files selected", "info");
        return;
      }
      if(S.decoyAddMode){
        S.decoyAddMode = false;
        const objs = privateFileObjsFromItems(items);
        if(objs.length){ const st=privateStore(); st.decoyItems=(st.decoyItems||[]).concat(objs); savePrivateStore(st); renderDecoyHome(); }
        return;
      }
      openAndroidMediaItems(items);
    },
    onPermissionReady(){
      if(typeof setLibraryTab === "function") setLibraryTab("library");
      if(typeof scanLibrary === "function") scanLibrary();
    },
    onNativeProgress(data){
      updateNativeProgress(data || {});
    },
    onNativeEnded(){
      advanceAfterEnded();
    },
    onNativeStopped(){
      backToLibrary();
    },
    onNativeError(message){
      // Fully unwind native-playback state — leaving S.nativePlayback /
      // body classes stale breaks every subsequent load until app restart.
      try { stopNativePlayback(); } catch(_){}
      // One automatic recovery attempt (e.g. transient seek/decoder glitch)
      // before giving up — prevents "player gayab" on a single hiccup.
      const idx = S.currentIndex, now = Date.now();
      if(idx >= 0 && (!S._lastNativeRetry || now - S._lastNativeRetry > 12000)){
        S._lastNativeRetry = now;
        showSubToast("Recovering playback…");
        setTimeout(()=>{ try { loadVideo(idx); } catch(_){ backToLibrary(); } }, 350);
        return;
      }
      backToLibrary();
      showSubToast(message || "This video could not be played", "error");
    },
    onDeleteComplete(success, uri){
      handleDeleteComplete(!!success, uri || "");
    },
    onBatchDeleteComplete(success, jsonUris){
      try { handleBatchDeleteComplete(!!success, JSON.parse(jsonUris || "[]")); } catch(_){ handleBatchDeleteComplete(false, []); }
    },
    onSubtitleTracks(jsonStr){
      try { renderSubTrackButtons(JSON.parse(jsonStr || "[]"), "native"); } catch(_){}
    },
    onAudioTracks(jsonStr){
      try { showAudioTrackDialog(JSON.parse(jsonStr || "[]"), "native"); } catch(_){}
    },
    onNativeCues(text){
      if(S.subtitleMode !== "track") return;
      const el = $("subtitleDisplay");
      if(el) el.textContent = text || "";
    },
    onTracksChanged(){
      if($("subMenu")?.classList.contains("open") && typeof refreshSubtitleTracks === "function") refreshSubtitleTracks();
    },
    onVideoThumb(idx, base64){
      const img = document.querySelector(`.lib-card[data-idx="${idx}"] .lib-card-thumb-img`);
      if(!img) return;
      img.style.backgroundImage = `url('data:image/jpeg;base64,${base64}')`;
      img.classList.add("has-thumb");
    },
    onSubtitleFileB64(b64){
      if(!b64){ showSubToast("Could not read subtitle file", "error"); return; }
      try {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const text = new TextDecoder("utf-8").decode(bytes);
        S.srtCues = parseSrt(text);
        setSubMode("file");
        showSubToast("SRT loaded ✓");
      } catch(_){ showSubToast("Could not load subtitle", "error"); }
    },
  };
}
function openNativePicker(){
  try { // Bug 18: accessing bridge methods can throw on some WebView versions
    if(!isAndroidApp() || !window.AndroidBridge.pickMedia) return false;
    window.AndroidBridge.pickMedia();
    return true;
  } catch(_) { return false; }
}
async function openDesktopMediaDialog(){
  if(!window.electronAPI?.openMediaDialog) return false;
  const items = await window.electronAPI.openMediaDialog();
  openDesktopMediaItems(items);
  return true;
}
async function openDesktopFolderDialog(){
  if(!window.electronAPI?.openFolderDialog) return false;
  const items = await window.electronAPI.openFolderDialog();
  openDesktopMediaItems(items);
  return true;
}
function openDesktopMediaItems(items){
  const media = Array.isArray(items) ? items.filter(item=>item && item.path) : [];
  if(!media.length) return;
  const wasEmpty = S.playlist.length===0;
  // Audit #5: same first-picked-item logic as openAndroidMediaItems
  let firstIdx = -1;
  media.forEach(src=>{
    const item = makeMediaItemFromPath(src.path, src.name, src);
    if(!isDuplicateMedia(item)){
      if(firstIdx===-1) firstIdx = S.playlist.length;
      S.playlist.push(item);
    } else if(firstIdx===-1){
      const existing = S.playlist.findIndex(p=>p.path && p.path===item.path);
      if(existing!==-1) firstIdx = existing;
    }
    addToRecent({ name:item.name, path:item.path, ext:item.ext, size:item.size || 0, kind:item.kind, durationMs:src.durationMs || 0 });
  });
  renderPlaylist();
  renderLibGrid();
  if(wasEmpty||S.currentIndex===-1) loadVideo(firstIdx===-1 ? Math.max(0, S.playlist.length-1) : firstIdx);
}
function openAndroidMediaItems(items){
  const media = items.filter(item=>item && item.path);
  if(!media.length) return;
  const wasEmpty = S.playlist.length===0;
  // Audit #5: track the index of the first item the user actually picked —
  // newly added OR its existing playlist entry if it was a duplicate.
  let firstIdx = -1;
  media.forEach(src=>{
    const item = makeMediaItemFromPath(src.path, src.name, src);
    if(!isDuplicateMedia(item)){
      if(firstIdx===-1) firstIdx = S.playlist.length;
      S.playlist.push(item);
    } else if(firstIdx===-1){
      const existing = S.playlist.findIndex(p=>p.path && p.path===item.path);
      if(existing!==-1) firstIdx = existing;
    }
    addToRecent({ name:item.name, path:item.path, ext:item.ext, size:item.size || 0, kind:item.kind, durationMs:src.durationMs || 0 });
  });
  renderPlaylist();
  renderLibGrid();
  if(wasEmpty||S.currentIndex===-1) loadVideo(firstIdx===-1 ? Math.max(0, S.playlist.length-1) : firstIdx);
}
setupAndroidBridge();

function resumeStore(){
  try { return JSON.parse(localStorage.getItem("enkrit_resume") || "{}"); }
  catch(_) { return {}; }
}
function resumeKey(item){ return item?.path || item?.sourcePath || item?.name || ""; }
function getResumeMs(item){
  const key = resumeKey(item);
  const entry = key ? resumeStore()[key] : null;
  if(!entry || !entry.position) return 0;
  if(entry.duration && entry.duration - entry.position < 10000) return 0;
  return Math.max(0, entry.position || 0);
}
function chooseStartPosition(item){
  const resumeMs = getResumeMs(item);
  if(resumeMs < 10000) return Promise.resolve(0);
  // Respect resume setting
  const mode = (typeof AppSettings !== "undefined") ? AppSettings.resumePlayback : "ask";
  if(mode === "always") return Promise.resolve(resumeMs);
  if(mode === "never")  return Promise.resolve(0);
  return new Promise(resolve => {
    const existing = document.querySelector(".resume-choice");
    if(existing) existing.remove();
    const box = document.createElement("div");
    box.className = "resume-choice";
    box.innerHTML = `
      <div class="resume-card">
        <div class="resume-title">Continue watching?</div>
        <div class="resume-name">${escHtml(shortN(item.name))}</div>
        <div class="resume-actions">
          <button class="resume-start">Start over</button>
          <button class="resume-continue">Resume ${fmt(resumeMs/1000)}</button>
        </div>
      </div>`;
    const done = (ms) => {
      box.remove();
      resolve(ms);
    };
    box.querySelector(".resume-start").addEventListener("click", () => done(0));
    box.querySelector(".resume-continue").addEventListener("click", () => done(resumeMs));
    document.body.appendChild(box);
  });
}
function saveResumePosition(force=false){
  const item = currentItem();
  if(!item) return;
  const now = Date.now();
  if(!force && now - S.lastResumeSave < 2500) return;
  S.lastResumeSave = now;
  const position = S.nativePlayback ? S.nativePosition : Math.floor((video.currentTime || 0) * 1000);
  const duration = S.nativePlayback ? S.nativeDuration : Math.floor((video.duration || 0) * 1000);
  if(position < 3000) return;
  const store = resumeStore();
  store[resumeKey(item)] = { position, duration, updated:now };
  try { localStorage.setItem("enkrit_resume", JSON.stringify(store)); } catch(_){}
}
function setPlaybackUi(playing){
  S.playing = !!playing;
  $("iconPlay").style.display = playing ? "none" : "block";
  $("iconPause").style.display = playing ? "block" : "none";
}
function stopNativePlayback(){
  if(!S.nativePlayback) return;
  saveResumePosition(true);
  S.nativePlayback = false;
  document.body.classList.remove("native-player");
  document.documentElement.classList.remove("native-player-root");
  try { window.AndroidBridge?.setImmersive?.(false); } catch(_){}
  try { window.AndroidBridge?.stopNativeMedia?.(); } catch(_){}
}

function setVideoZoom(value, announce=false){
  const zoom = Math.max(0.5, Math.min(3, Number(value) || 1));
  S.videoZoom = zoom;
  if(zoom <= 1.01) {
    S.videoPanX = 0;
    S.videoPanY = 0;
  }
  applyVideoTransform();
  document.querySelectorAll(".resize-opt").forEach(btn=>{
    btn.classList.toggle("active", Math.abs(Number(btn.dataset.zoom || 1) - zoom) < 0.02);
  });
  if(announce) showGestureHud("resize", Math.abs(zoom - 1) < 0.02 ? "Fit" : "Zoom", `${Math.round(zoom * 100)}%`, zoom / 3 * 100);
}

function setVideoPan(x, y){
  const bounds = panBounds();
  S.videoPanX = Math.max(-bounds.x, Math.min(bounds.x, x || 0));
  S.videoPanY = Math.max(-bounds.y, Math.min(bounds.y, y || 0));
  applyVideoTransform();
}

function panBounds(){
  const r = vcont.getBoundingClientRect();
  const extraX = Math.max(0, r.width * (S.videoZoom - 1) / 2);
  const extraY = Math.max(0, r.height * (S.videoZoom - 1) / 2);
  return { x:extraX, y:extraY };
}

function applyVideoTransform(){
  const zoom = S.videoZoom || 1;
  if(S.nativePlayback && isAndroidApp()) {
    try {
      if(window.AndroidBridge?.setVideoTransform) window.AndroidBridge.setVideoTransform(Math.round(zoom * 100), Math.round(S.videoPanX || 0), Math.round(S.videoPanY || 0));
      else window.AndroidBridge?.setVideoZoom?.(Math.round(zoom * 100));
    } catch(_){}
  } else if(video) {
    video.style.transform = Math.abs(zoom - 1) > 0.001 ? `translate(${S.videoPanX || 0}px, ${S.videoPanY || 0}px) scale(${zoom})` : "";
    video.style.transformOrigin = "center center";
  }
}

function touchDistance(touches){
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

/* ── WEB AUDIO (SW DECODER) ── */
let audioCtx, gainNode;
let _pendingThumbs = [];  // Bug 1: track pending thumb decode elements
let _loadVideoGen  = 0;   // Bug 11: generation counter for rapid loadVideo calls
function setupAudio(){
  if(audioCtx) return;
  try{
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    audioCtx.createMediaElementSource(video).connect(gainNode);
    gainNode.connect(audioCtx.destination);
    gainNode.gain.value = 1;
  }catch(e){ console.warn("WebAudio:",e); }
}

/* ── SPLASH ── */
window.addEventListener("load",()=>{
  setTimeout(()=>{
    splash.classList.add("done");
    app.style.display="flex";
    app.style.flexDirection="column";
  },2000);
},{once:true}); // Bug 15: once:true prevents duplicate splash triggers

/* ════════════════════════════════
   APP NAME FIX — Electron title
════════════════════════════════ */
document.title = "ENKRIT";

/* ════════════════════════════════
   FILE OPEN / DROP
════════════════════════════════ */
function openFiles(files){
  const media = [...files].filter(f=>isMediaFile(f.name, f.type));
  if(!media.length) return;
  const wasEmpty = S.playlist.length===0;
  const firstIdx = S.playlist.length; // Bug X1: capture insertion point before adding
  media.forEach(f=>{
    const item = makeMediaItemFromFile(f);
    if(!isDuplicateMedia(item)) S.playlist.push(item);
  });
  renderPlaylist();
  if(wasEmpty||S.currentIndex===-1) loadVideo(Math.min(firstIdx, Math.max(0, S.playlist.length-1)));
}

$("btnOpen").addEventListener("click",async()=>{ if(!openNativePicker() && !(await openDesktopMediaDialog())) $("fileInput").click(); });
$("btnOpenMain").addEventListener("click",async()=>{ if(!openNativePicker() && !(await openDesktopMediaDialog())) $("fileInput").click(); });
$("btnAddFolder").addEventListener("click",async()=>{ if(!openNativePicker() && !(await openDesktopFolderDialog())) $("folderInput").click(); });
$("btnOpenFolderMain").addEventListener("click",async()=>{ if(!openNativePicker() && !(await openDesktopFolderDialog())) $("folderInput").click(); });
$("fileInput").addEventListener("change",e=>{ if(e.target.files.length) openFiles(e.target.files); $("fileInput").value=""; });
$("folderInput").addEventListener("change",e=>{ if(e.target.files.length) openFiles(e.target.files); $("folderInput").value=""; });

dropZone.addEventListener("dragover",e=>{ e.preventDefault(); dropZone.classList.add("drag-active"); });
dropZone.addEventListener("dragleave",()=>dropZone.classList.remove("drag-active"));
dropZone.addEventListener("drop",e=>{ e.preventDefault(); dropZone.classList.remove("drag-active"); openFiles(e.dataTransfer.files); });
document.addEventListener("dragover",e=>e.preventDefault());
document.addEventListener("drop",e=>{ e.preventDefault(); if(e.dataTransfer.files.length) openFiles(e.dataTransfer.files); });

/* ════════════════════════════════
   LOAD VIDEO
════════════════════════════════ */
async function loadVideo(idx){
  if(idx<0||idx>=S.playlist.length) return;
  const myGen = ++_loadVideoGen; // Bug 11: stamp this call; stale calls bail out after await
  const previous = currentItem();
  const item=S.playlist[idx];
  if(previous) saveResumePosition(true);
  if(previous && previous!==item) releaseItemUrl(previous);
  S.currentIndex=idx;
  releaseItemUrl(item);
  item.url = item.transcodedPath ? toFileUrl(item.transcodedPath)
    : item.path ? toFileUrl(item.path)
    : URL.createObjectURL(item.file);
  const startMs = await chooseStartPosition(item);
  if(myGen !== _loadVideoGen) return; // Bug 11: a newer loadVideo call superseded this one
  if(!AppSettings.rememberAspectRatio) setVideoZoom(1); // P2: only reset zoom if "remember aspect ratio" is off
  if(!AppSettings.rememberSpeed && S.speed !== 1) setSpeed(1); // P5: reset speed between tracks unless remembered
  if(hasNativePlayer()){
    S.nativePlayback = true;
    S.nativePosition = startMs;
    S.nativeDuration = item.durationMs || 0;
    document.body.classList.add("native-player");
    document.documentElement.classList.add("native-player-root");
    volSlider.max = SW_VOLUME_MAX;
    video.pause();
    video.removeAttribute("src");
    video.load();
    try {
      window.AndroidBridge.playNativeMedia(item.url, startMs, S.speed, video.muted ? 0 : parseInt(volSlider?.value || "100")); // Bug X2: honour mute state
    } catch(e) {
      showSubToast("Native player failed: " + e.message, "error");
    }
  } else {
    S.nativePlayback = false;
    document.body.classList.remove("native-player");
    document.documentElement.classList.remove("native-player-root");
    volSlider.max = S.decoderMode === "sw" ? SW_VOLUME_MAX : 100;
    video.src=item.url;
    video.load();
    if(startMs > 0) video.addEventListener("loadedmetadata", () => { video.currentTime = startMs / 1000; }, {once:true});
    video.play().catch(()=>{});
  }
  dropZone.style.display="none"; vcont.style.display="flex";
  document.body.classList.add("in-player"); // iOS: keeps safe-area bands black behind the player
  $("moreSheet")?.classList.remove("open");
  // Show back button
  const backBtn=$("btnBack"); if(backBtn) backBtn.style.display="flex";
  const name=item.name.replace(/\.[^/.]+$/,"");
  $("topbarTitle").textContent=name;
  $("ctrlFilename").textContent=name;
  const _ptt=$("playerTopTitle"); if(_ptt) _ptt.textContent=$("ctrlFilename").textContent;
  document.title="ENKRIT — "+name;
  setPlaybackUi(true);
  addToRecent({ name:item.name, path:item.path, ext:item.ext || "", size:item.size || 0, kind:item.kind, durationMs:item.durationMs || 0, playedAt:Date.now() });
  resetHide();
  renderPlaylist(); highlightActive();
  updateMediaModeUI();
  _miniDismissed = false;
  if(typeof updateMiniPlayer === "function") updateMiniPlayer();
  if(typeof markNowPlayingCards === "function") markNowPlayingCards();
}

function currentItem(){ return S.playlist[S.currentIndex] || null; }
function currentIsVideo(){
  const item = currentItem();
  return !!item && item.kind !== "audio";
}
function updateMediaModeUI(){
  const inPlayer = vcont.style.display !== "none" && S.currentIndex >= 0;
  const showVideoTools = inPlayer && currentIsVideo();
  const filterBtn = $("btnFilter");
  const resizeWrap = document.querySelector(".resize-wrap");
  const pipBtn = $("btnPip");
  if(filterBtn) filterBtn.style.display = showVideoTools ? "flex" : "none";
  if(resizeWrap) resizeWrap.style.display = showVideoTools ? "flex" : "none";
  if(pipBtn) pipBtn.style.display = showVideoTools ? "flex" : "none";
  if(!showVideoTools) setFilterPanelOpen(false);
  if(!showVideoTools) $("resizePanel")?.classList.remove("open");
  if(!showVideoTools) video.style.filter = "none";
  else applyFilters();
}

/* ════════════════════════════════
   PLAYBACK
════════════════════════════════ */
function togglePlay(){
  if(S.nativePlayback){
    const next = !S.playing;
    if(window.AndroidBridge?.nativeSetPlaying) { // Bug 9: check method exists before calling
      try { window.AndroidBridge.nativeSetPlaying(next); } catch(_){}
      setPlaybackUi(next);
    }
    return;
  }
  if(video.paused) video.play().catch(()=>{}); else video.pause();
}

$("btnPlay").addEventListener("click",()=>{ setupAudio(); togglePlay(); });

video.addEventListener("play",()=>{
  S.playing=true;
  $("iconPlay").style.display="none"; $("iconPause").style.display="block";
  if(audioCtx) audioCtx.resume();
  resetHide();
});
video.addEventListener("pause",()=>{
  S.playing=false;
  $("iconPlay").style.display="block"; $("iconPause").style.display="none";
  showControls();
});
video.addEventListener("ended", advanceAfterEnded);

$("btnPrev").addEventListener("click",()=>{ if(S.currentIndex>0) loadVideo(S.currentIndex-1); else flash("First Video"); });
$("btnNext").addEventListener("click",()=>playNextTrack(true));
$("btnBack5").addEventListener("click",()=>seek(-(AppSettings?.seekSeconds||5)));
$("btnFwd5").addEventListener("click",()=>seek(AppSettings?.seekSeconds||5));
$("btnShuffle")?.addEventListener("click",()=>{
  S.shuffle = !S.shuffle;
  $("btnShuffle").classList.toggle("active", S.shuffle);
  flash(S.shuffle ? "Shuffle On" : "Shuffle Off");
});
$("btnRepeat")?.addEventListener("click",()=>{
  S.repeatMode = S.repeatMode === "off" ? "all" : S.repeatMode === "all" ? "one" : "off";
  updateRepeatUi();
  flash(S.repeatMode === "off" ? "Repeat Off" : S.repeatMode === "all" ? "Repeat All" : "Repeat One");
});
$("btnSleep")?.addEventListener("click", cycleSleepTimer);

function updateRepeatUi(){
  const btn = $("btnRepeat");
  if(!btn) return;
  btn.classList.toggle("active", S.repeatMode !== "off");
  btn.classList.toggle("repeat-single", S.repeatMode === "one");
}
function cycleSleepTimer(){
  const steps = [0, 15, 30, 60];
  const idx = steps.indexOf(S.sleepMinutes);
  S.sleepMinutes = steps[(idx + 1) % steps.length];
  clearTimeout(S.sleepTimer);
  $("btnSleep")?.classList.toggle("active", S.sleepMinutes > 0);
  if(!S.sleepMinutes) {
    flash("Sleep Off");
    return;
  }
  S.sleepTimer = setTimeout(()=>{
    if(S.playing) togglePlay();
    $("btnSleep")?.classList.remove("active");
    S.sleepMinutes = 0;
    showSubToast("Sleep timer stopped playback", "info");
  }, S.sleepMinutes * 60000);
  flash("Sleep " + S.sleepMinutes + "m");
}

function playNextTrack(manual=false){
  if(!S.playlist.length) return;
  if(S.shuffle && S.playlist.length > 1) {
    let next = S.currentIndex;
    let tries = 0;
    while(next === S.currentIndex && tries++ < 20) next = Math.floor(Math.random() * S.playlist.length); // P9: cap iterations to avoid infinite loop
    loadVideo(next);
    return;
  }
  if(S.currentIndex < S.playlist.length - 1) loadVideo(S.currentIndex + 1);
  else if(S.repeatMode === "all") loadVideo(0);
  else if(manual) flash("Last Video");
  else setPlaybackUi(false);
}
function advanceAfterEnded(){
  saveResumePosition(true);
  if(S.repeatMode === "one") {
    // repeat-one always plays again regardless of autoplayNext
    if(S.nativePlayback) {
      S.nativePosition = 0;
      try { window.AndroidBridge.nativeSeekTo(0); window.AndroidBridge.nativeSetPlaying(true); } catch(_){}
      setPlaybackUi(true);
    } else {
      video.currentTime = 0;
      video.play().catch(()=>{});
    }
    return;
  }
  // Autoplay on + a next track → play it; otherwise the video is finished,
  // so return to the library instead of freezing on the last frame.
  const hasNext = S.currentIndex >= 0 && S.currentIndex < S.playlist.length - 1;
  if(AppSettings.autoplayNext && hasNext){ playNextTrack(false); return; }
  backToLibrary();
}

function seek(sec){
  if(S.nativePlayback){
    const maxMs = S.nativeDuration > 0 ? S.nativeDuration : Number.MAX_SAFE_INTEGER; // Bug 8: don't clamp to 0 when duration unknown
    const target = Math.max(0, Math.min(maxMs, S.nativePosition + sec * 1000));
    S.nativePosition = target;
    try { window.AndroidBridge.nativeSeekTo(target); } catch(_){}
    updateNativeProgress({position:S.nativePosition, duration:S.nativeDuration, playing:S.playing});
    flash(sec>0?`+${sec}s`:`${sec}s`);
    return;
  }
  video.currentTime=Math.max(0,Math.min(video.duration||0,video.currentTime+sec));
  flash(sec>0?`+${sec}s`:`${sec}s`);
}
function flash(txt){
  const el=$("seekFeedback");
  el.textContent=txt; el.classList.add("show");
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove("show"),700);
}
function showGestureHud(kind, title, value, pct=0){
  const hud = $("gestureHud");
  if(!hud) return;
  $("gestureTitle").textContent = title || "";
  $("gestureValue").textContent = value || "";
  $("gestureMeter").style.width = Math.max(0, Math.min(100, pct)) + "%";
  $("gestureIcon").textContent = kind === "volume" ? "VOL" : kind === "brightness" ? "SUN" : kind === "lock" ? "LOCK" : "ZOOM";
  hud.className = "gesture-hud show gesture-" + (kind || "info");
  clearTimeout(hud._t);
  hud._t = setTimeout(()=>hud.classList.remove("show"), 650);
}
function showSeekPreview(ms, deltaMs){
  const box = $("seekPreview");
  if(!box) return;
  $("seekPreviewDir").textContent = deltaMs >= 0 ? "+" + fmt(Math.abs(deltaMs)/1000) : "-" + fmt(Math.abs(deltaMs)/1000);
  $("seekPreviewTime").textContent = fmt(ms / 1000);
  box.classList.add("show");
}
function hideSeekPreview(){
  $("seekPreview")?.classList.remove("show");
}
function showTapZone(side){
  const el = side === "left" ? $("tapLeft") : $("tapRight");
  if(!el) return;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(()=>el.classList.remove("show"), 360);
  // Ripple animation
  if(typeof triggerTapZoneRipple === "function") triggerTapZoneRipple(side);
}

/* ════════════════════════════════
   VOLUME + DECODER
════════════════════════════════ */
const volSlider=$("volumeSlider");
const volPct=$("volPct");
volSlider.max = volumeMax();

volSlider.addEventListener("input",applyVolume);

function applyVolume(){
  const val=parseInt(volSlider.value);
  volSlider.max = volumeMax();
  volPct.textContent=val+"%";
  updateVolTrack(val);
  if(S.nativePlayback) {
    try { window.AndroidBridge.nativeSetVolume(val); } catch(_){}
    return; // Bug 17: early return — don't touch HTML video volume on native path
  }
  if(S.decoderMode==="hw"){
    video.volume=Math.min(1,val/100);
    if(gainNode) gainNode.gain.value=1;
  } else {
    // SW Decoder
    if(!audioCtx) setupAudio();
    if(val<=100){ video.volume=val/100; if(gainNode) gainNode.gain.value=1; }
    else{ video.volume=1; if(gainNode) gainNode.gain.value=val/100; }
  }
}

function updateVolTrack(val){
  const pct=(val/(+volSlider.max || SW_VOLUME_MAX)*100).toFixed(1);
  volSlider.style.background=`linear-gradient(90deg, var(--accent) ${pct}%, rgba(255,255,255,0.18) ${pct}%)`;
}
updateVolTrack(100);

// Mute
$("btnMute").addEventListener("click",()=>{
  const muting = !video.muted;
  video.muted = muting;
  if(S.nativePlayback) { // S3: mute must go through native bridge; video.muted has no effect on ExoPlayer
    try { window.AndroidBridge.nativeSetVolume(muting ? 0 : parseInt(volSlider.value || "100")); } catch(_){}
  }
  $("iconVol").style.display=muting?"none":"block";
  $("iconMute").style.display=muting?"block":"none";
});

// Decoder toggle
const decoderBtn=$("decoderBtn");
const decoderPanel=$("decoderPanel");
decoderBtn.addEventListener("click",e=>{ e.stopPropagation(); decoderPanel.classList.toggle("open"); });

$("decoderHW").addEventListener("click",()=>{
  S.decoderMode="hw";
  $("decoderLabel").textContent="HW";
  decoderBtn.classList.remove("sw-active");
  document.querySelectorAll(".dp-opt").forEach(b=>b.classList.remove("active"));
  $("decoderHW").classList.add("active");
  decoderPanel.classList.remove("open");
  // cap volume to 100 in HW mode
  if(parseInt(volSlider.value)>100){ volSlider.value=100; applyVolume(); }
  volSlider.max=100;
});
$("decoderSW").addEventListener("click",()=>{
  S.decoderMode="sw";
  $("decoderLabel").textContent="SW";
  decoderBtn.classList.add("sw-active");
  document.querySelectorAll(".dp-opt").forEach(b=>b.classList.remove("active"));
  $("decoderSW").classList.add("active");
  decoderPanel.classList.remove("open");
  volSlider.max=SW_VOLUME_MAX;
  setupAudio();
});

/* ════════════════════════════════
   SPEED
════════════════════════════════ */
$("btnSpeed").addEventListener("click",e=>{ e.stopPropagation(); $("speedPanel").classList.toggle("open"); setSubMenuOpen(false); decoderPanel.classList.remove("open"); });
$("speedSlider").addEventListener("input",()=>setSpeed(parseFloat($("speedSlider").value)));
function setSpeed(s){
  s=Math.round(s*100)/100; S.speed=s;
  video.playbackRate=s;
  if(S.nativePlayback) {
    try { window.AndroidBridge.nativeSetSpeed(s); } catch(_){}
  }
  $("speedReadout").textContent=s.toFixed(2)+"×";
  $("speedLabel").textContent=(s%1===0?s:s.toFixed(2))+"×";
  $("speedSlider").value=s;
  document.querySelectorAll(".spbtn").forEach(b=>b.classList.toggle("active",parseFloat(b.dataset.s)===s));
  if(AppSettings.rememberSpeed) { // S4: persist speed when setting asks for it
    try { localStorage.setItem("enkrit_speed", String(s)); } catch(_){}
  }
}
document.querySelectorAll(".spbtn").forEach(b=>b.addEventListener("click",()=>setSpeed(parseFloat(b.dataset.s))));

/* ════════════════════════════════
   PROGRESS BAR
════════════════════════════════ */
video.addEventListener("timeupdate",updateProgress);
video.addEventListener("progress",()=>{
  if(!video.buffered.length || !video.duration || !isFinite(video.duration)) return; // Bug 2: guard NaN/0 duration
  $("progressBuf").style.width=(video.buffered.end(video.buffered.length-1)/video.duration*100)+"%";
});
video.addEventListener("loadedmetadata",()=>{
  $("timeDur").textContent=fmt(video.duration);
  const item=S.playlist[S.currentIndex];
  if(item){ item.duration=fmt(video.duration); renderPlaylist(); highlightActive(); }
});
video.addEventListener("error", handlePlaybackError);

async function handlePlaybackError(){
  const item = currentItem();
  if(!item || item.fallbackTried || !item.sourcePath || !window.electronAPI?.preparePlayable) return;
  item.fallbackTried = true;
  showSubToast("Preparing compatible offline copy...", "loading");
  const result = await window.electronAPI.preparePlayable(item.sourcePath);
  if(currentItem() !== item) return;
  if(result?.path){
    releaseItemUrl(item);
    item.transcodedPath = result.path;
    item.url = toFileUrl(result.path);
    video.src = item.url;
    video.load();
    video.play().catch(()=>{});
    showSubToast("Compatible copy ready", "success");
  } else {
    showSubToast(result?.error || "This codec could not be played", "error");
  }
}

function updateProgress(){
  if(S.isDraggingProgress) return;
  const pct=video.duration?video.currentTime/video.duration*100:0;
  $("progressFill").style.width=pct+"%";
  $("progressThumb").style.left=pct+"%";
  $("timeNow").textContent=fmt(video.currentTime);
  saveResumePosition();
  if(S.subtitleMode==="file") updateSrtSub();
}

function updateNativeProgress(data){
  if(!S.nativePlayback) return;
  setPlaybackUi(!!data.playing);
  // While the user is scrubbing, don't let the 500ms native tick yank the thumb/position back.
  if(S.isDraggingProgress) return;
  S.nativePosition = Math.max(0, data.position || 0);
  S.nativeDuration = Math.max(0, data.duration || S.nativeDuration || 0);
  const pct = S.nativeDuration ? S.nativePosition / S.nativeDuration * 100 : 0;
  $("progressFill").style.width = pct + "%";
  $("progressThumb").style.left = pct + "%";
  $("timeNow").textContent = fmt(S.nativePosition / 1000);
  $("timeDur").textContent = fmt(S.nativeDuration / 1000);
  saveResumePosition();
  if(S.subtitleMode === "file" && S.srtCues.length) { // Bug 10: SRT subs on native playback
    const t = S.nativePosition / 1000;
    const c = S.srtCues.find(cu => t >= cu.start && t <= cu.end) || null;
    const sd = $("subtitleDisplay");
    if(sd) { sd.textContent = c ? c.text : ""; sd.className = (c && S.subtitleMode !== "off") ? "subtitle-on" : "subtitle-off"; }
  }
}

const pw=$("progressWrap");
pw.addEventListener("mousedown",e=>{ S.isDraggingProgress=true; doSeek(e); });
pw.addEventListener("touchstart",e=>{ S.isDraggingProgress=true; doSeek(e.touches[0]); },{passive:false});
document.addEventListener("mousemove",e=>{ if(S.isDraggingProgress) doSeek(e); });
document.addEventListener("touchmove",e=>{ if(S.isDraggingProgress) doSeek(e.touches[0]); },{passive:true});
document.addEventListener("mouseup",()=>S.isDraggingProgress=false);
document.addEventListener("touchend",()=>S.isDraggingProgress=false);

function doSeek(e){
  if(e.clientX == null) return; // Bug 5: missing clientX would seek to 0
  const r=pw.getBoundingClientRect();
  if(!r.width) return; // hidden/zero-width bar would make pct NaN
  const x=e.clientX-r.left;
  const pct=Math.max(0,Math.min(1,x/r.width));
  if(S.nativePlayback){
    S.nativePosition = pct * (S.nativeDuration || 0);
    try { window.AndroidBridge.nativeSeekTo(Math.floor(S.nativePosition)); } catch(_){}
    $("progressFill").style.width=(pct*100)+"%";
    $("progressThumb").style.left=(pct*100)+"%";
    $("timeNow").textContent=fmt(S.nativePosition / 1000);
    return;
  }
  video.currentTime=pct*(video.duration||0);
  $("progressFill").style.width=(pct*100)+"%";
  $("progressThumb").style.left=(pct*100)+"%";
  $("timeNow").textContent=fmt(video.currentTime);
}

/* ════════════════════════════════
   FULLSCREEN & PIP
════════════════════════════════ */
$("btnFull").addEventListener("click",toggleFS);
function toggleFS(){
  const pw=$("playerWrap");
  if(!document.fullscreenElement)(pw.requestFullscreen||pw.webkitRequestFullscreen).call(pw);
  else(document.exitFullscreen||document.webkitExitFullscreen).call(document);
}
document.addEventListener("fullscreenchange",()=>{
  const fs=!!document.fullscreenElement;
  $("iconFull").style.display=fs?"none":"block";
  $("iconExit").style.display=fs?"block":"none";
});
$("btnPip").addEventListener("click",async()=>{
  if(!currentIsVideo()) return;
  try{
    if(document.pictureInPictureElement) await document.exitPictureInPicture();
    else if(video.requestPictureInPicture) await video.requestPictureInPicture();
    else if(video.webkitSupportsPresentationMode && video.webkitSupportsPresentationMode("picture-in-picture")) {
      // Safari / iOS WKWebView path
      video.webkitSetPresentationMode(video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
    }
  }
  catch(e){}
});

$("btnResize")?.addEventListener("click", e=>{
  e.stopPropagation();
  setSubMenuOpen(false);
  $("speedPanel")?.classList.remove("open");
  $("orientPanel")?.classList.remove("open");
  $("resizePanel")?.classList.toggle("open");
});
document.querySelectorAll(".resize-opt").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    setVideoZoom(Number(btn.dataset.zoom || 1), true);
    $("resizePanel")?.classList.remove("open");
  });
});

$("btnOrient")?.addEventListener("click", e=>{
  e.stopPropagation();
  $("resizePanel")?.classList.remove("open");
  $("orientPanel")?.classList.toggle("open");
});
document.querySelectorAll(".orient-opt").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    setOrientationMode(btn.dataset.orient || "auto");
    $("orientPanel")?.classList.remove("open");
  });
});
function setOrientationMode(mode){
  document.querySelectorAll(".orient-opt").forEach(btn=>btn.classList.toggle("active", btn.dataset.orient===mode));
  if(isAndroidApp()) {
    try { window.AndroidBridge.setOrientationMode(mode); } catch(_){}
    flash(mode === "landscape" ? "Landscape" : mode === "auto" ? "Auto rotate" : "Portrait");
  }
}
// P1: use saved orientation, fall back to portrait (not "auto") since portrait is the safe default at launch
setOrientationMode(AppSettings.defaultOrientation || "portrait");

/* ════════════════════════════════
   CONTROLS AUTO HIDE
════════════════════════════════ */
const playerWrap=$("playerWrap");

function showControls(){
  controls.classList.remove("hidden");
  $("playerTopBar")?.classList.remove("hidden");
  document.body.classList.remove("player-ui-hidden");
  if(isAndroidApp() && S.currentIndex >= 0) {
    try { window.AndroidBridge.setImmersive(false); } catch(_){}
  }
  playerWrap.style.cursor="default";
}
function hideControls(){
  if($("moreSheet")?.classList.contains("open")) return; // keep UI while More sheet open
  controls.classList.add("hidden");
  $("playerTopBar")?.classList.add("hidden");
  if(S.currentIndex >= 0) document.body.classList.add("player-ui-hidden");
  if(isAndroidApp() && S.currentIndex >= 0 && S.playing) {
    try { window.AndroidBridge.setImmersive(true); } catch(_){}
  }
  playerWrap.style.cursor="none";
}
function resetHide(){
  showControls();
  clearTimeout(S.controlsTimer);
  if(S.playing) S.controlsTimer=setTimeout(()=>hideControls(), isAndroidApp() ? 15000 : 3000);
}

// document-level so controls overlay doesnt block mouse detection
document.addEventListener("mousemove", e=>{
  const pr=playerWrap.getBoundingClientRect();
  if(e.clientX>=pr.left&&e.clientX<=pr.right&&e.clientY>=pr.top&&e.clientY<=pr.bottom){
    resetHide();
  }
});

// pause auto-hide when hovering controls
controls.addEventListener("mouseenter",()=>{ showControls(); clearTimeout(S.controlsTimer); });
controls.addEventListener("mouseleave",()=>{ if(S.playing) S.controlsTimer=setTimeout(()=>hideControls(),2000); });

playerWrap.addEventListener("touchstart",()=>{ resetHide(); },{passive:true});
vcont.addEventListener("click",e=>{
  // On Android the touchend handler already manages tap actions to avoid being
  // blocked by touchmove preventDefault. Only handle mouse clicks here.
  if(isAndroidApp()) return;
  if(e.target===video){ setupAudio(); togglePlay(); }
});

vcont.addEventListener("touchstart", e=>{
  if(!isAndroidApp() || controls.contains(e.target)) return;
  if(S.isLocked) {
    S.isLocked = false;
    document.body.classList.remove("player-locked");
    $("screenLockBtn")?.classList.remove("active");
    showControls();
    showGestureHud("lock", "Unlocked", "Controls ready", 100);
    e.preventDefault();
    return;
  }
  if(e.touches.length === 2) {
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    S.pinch = { dist:touchDistance(e.touches), zoom:S.videoZoom || 1, cx, cy, panX:S.videoPanX || 0, panY:S.videoPanY || 0 };
    S.gesture = null;
    e.preventDefault();
    return;
  }
  if(e.touches.length !== 1) return;
  const t = e.touches[0];
  const now = Date.now();
  if(S.lastTap && now - S.lastTap.t < 280 && Math.abs(t.clientX - S.lastTap.x) < 70 && Math.abs(t.clientY - S.lastTap.y) < 70) {
    const r = vcont.getBoundingClientRect();
    const leftSide = t.clientX < r.left + r.width / 2;
    seek(leftSide ? -(AppSettings?.seekSeconds||5) : (AppSettings?.seekSeconds||5));
    showTapZone(leftSide ? "left" : "right");
    S.lastTap = null;
    e.preventDefault();
    return;
  }
  S.lastTap = { t:now, x:t.clientX, y:t.clientY };
  const currentMs = S.nativePlayback ? S.nativePosition : Math.floor((video.currentTime || 0) * 1000);
  const durationMs = S.nativePlayback ? S.nativeDuration : Math.floor((video.duration || 0) * 1000);
  const r = vcont.getBoundingClientRect();
  S.gesture = {
    x:t.clientX, y:t.clientY,
    mode:null,
    side:t.clientX < r.left + r.width / 2 ? "volume" : "brightness",
    startVol:parseInt(volSlider.value || "100"),
    startBright:S.screenBrightness || 100,
    startMs:currentMs,
    durationMs,
    targetMs:currentMs,
    startPanX:S.videoPanX || 0,
    startPanY:S.videoPanY || 0,
    moved:false,
    // Snapshot controls-hidden state NOW (before playerWrap.touchstart may call showControls).
    // Touchend uses this to decide show vs hide — avoids the race where resetHide() fires
    // between touchstart and touchend, making the controls immediately hide again.
    controlsHidden: controls.classList.contains("hidden") || document.body.classList.contains("player-ui-hidden"),
  };
}, {passive:false});
vcont.addEventListener("touchmove", e=>{
  if(S.isLocked) {
    e.preventDefault();
    return;
  }
  if(S.pinch && e.touches.length === 2) {
    const dist = touchDistance(e.touches);
    if(S.pinch.dist > 0) {
      const next = S.pinch.zoom * (dist / S.pinch.dist);
      setVideoZoom(next);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setVideoPan(S.pinch.panX + (cx - S.pinch.cx), S.pinch.panY + (cy - S.pinch.cy));
      showGestureHud("resize", "Zoom", `${Math.round(S.videoZoom * 100)}%`, S.videoZoom / 3 * 100);
    }
    e.preventDefault();
    return;
  }
  if(!S.gesture || e.touches.length !== 1) return;
  const t = e.touches[0];
  const dx = t.clientX - S.gesture.x;
  const dy = S.gesture.y - t.clientY;
  if(!S.gesture.mode) {
    if(Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
    if(S.videoZoom > 1.01 && Math.abs(dx) > 12 && Math.abs(dy) > 12) S.gesture.mode = "pan";
    else S.gesture.mode = Math.abs(dx) > Math.abs(dy) + 8 ? "seek" : S.gesture.side;
  }
  S.gesture.moved = true;
  e.preventDefault();
  if(S.gesture.mode === "seek"){
    const deltaMs = Math.round(dx * 420);
    const duration = S.gesture.durationMs || 0;
    const target = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, S.gesture.startMs + deltaMs));
    S.gesture.targetMs = target;
    showSeekPreview(target, target - S.gesture.startMs);
  } else if(S.gesture.mode === "pan"){
    setVideoPan(S.gesture.startPanX + dx, S.gesture.startPanY - dy);
    showGestureHud("resize", "Pan", `${Math.round(S.videoZoom * 100)}%`, S.videoZoom / 3 * 100);
  } else if(S.gesture.mode === "volume"){
    const max = volumeMax();
    const next = Math.max(0, Math.min(max, Math.round(S.gesture.startVol + dy / 2.4)));
    volSlider.value = next;
    applyVolume();
    showGestureHud("volume", "Volume", next + "%", next / max * 100);
  } else {
    const next = Math.max(5, Math.min(100, Math.round(S.gesture.startBright + dy / 3.2)));
    S.screenBrightness = next;
    if(isAndroidApp()) {
      try { window.AndroidBridge.setScreenBrightness(next); } catch(_){}
      if(AppSettings.rememberBrightness) { try { localStorage.setItem("enkrit_brightness", next); } catch(_){} } // P3
    } else {
      S.filters.brightness = next;
      applyFilters();
    }
    showGestureHud("brightness", "Brightness", next + "%", next);
  }
}, {passive:false});
vcont.addEventListener("touchend", e=>{
  const wasTap = S.gesture && !S.gesture.moved;
  if(S.gesture?.mode === "seek") {
    const target = Math.floor(S.gesture.targetMs || 0);
    if(S.nativePlayback) {
      S.nativePosition = target;
      try { window.AndroidBridge.nativeSeekTo(target); } catch(_){}
      updateNativeProgress({position:S.nativePosition, duration:S.nativeDuration, playing:S.playing});
    } else {
      video.currentTime = target / 1000;
    }
    hideSeekPreview();
    flash(fmt(target / 1000));
  } else if(wasTap) {
    // touchmove may have called preventDefault, cancelling the click event.
    // Handle the tap action directly here so controls always respond.
    if(S.nativePlayback) {
      if(S.gesture.controlsHidden) showControls();
      else hideControls();
    } else {
      setupAudio(); togglePlay();
    }
  }
  if(e.touches.length < 2) S.pinch = null;
  if(e.touches.length === 0) S.gesture=null;
}, {passive:true});

/* ════════════════════════════════
   DRAGGABLE CONTROLS + LOCK
════════════════════════════════ */
const dragHandle=$("ctrlDragHandle");
S.isLocked = false;

// LOCK BUTTON
$("btnLock").addEventListener("click", e=>{
  e.stopPropagation();
  S.isLocked = !S.isLocked;
  const btn=$("btnLock");
  const handle=$("ctrlDragHandle");
  const hint=$("dragHint");
  const iconU=$("iconUnlocked");
  const iconL=$("iconLocked");
  const dragIcon=$("dragIcon");

  if(S.isLocked){
    // LOCK — snap back to bottom center, fix position
    btn.classList.add("is-locked");
    controls.classList.add("is-locked");
    handle.classList.add("locked");
    hint.textContent="position locked";
    hint.style.color="rgba(255,160,0,0.7)";
    dragIcon.style.opacity="0.3";
    iconU.style.display="none";
    iconL.style.display="block";
    // clear inline position so CSS takes over
    controls.style.left="";
    controls.style.top="";
    controls.style.bottom="";
    controls.style.transform="";
    document.body.classList.add("player-locked");
    $("screenLockBtn")?.classList.add("active");
    showGestureHud("lock", "Locked", "Controls off", 100);
    setTimeout(()=>hideControls(), 100);
  } else {
    // UNLOCK — free to drag
    btn.classList.remove("is-locked");
    controls.classList.remove("is-locked");
    handle.classList.remove("locked");
    hint.textContent="drag to move";
    hint.style.color="";
    dragIcon.style.opacity="";
    iconU.style.display="block";
    iconL.style.display="none";
    document.body.classList.remove("player-locked");
    $("screenLockBtn")?.classList.remove("active");
    showControls();
    showGestureHud("lock", "Unlocked", "Gestures on", 100);
  }
});
$("screenLockBtn")?.addEventListener("click", e=>{
  e.stopPropagation();
  $("btnLock")?.click();
});

dragHandle.addEventListener("mousedown", startDrag);
dragHandle.addEventListener("touchstart", e=>startDrag(e.touches[0]), {passive:false});

function startDrag(e){
  if(S.isLocked) return;           // locked = no drag
  if(e.button!==undefined&&e.button!==0) return;
  if(e.target===$("btnLock")||$("btnLock").contains(e.target)) return;
  S.ctrlDragging=true;
  const rect=controls.getBoundingClientRect();
  S.ctrlDragOX=e.clientX-rect.left;
  S.ctrlDragOY=e.clientY-rect.top;
  controls.style.transition="none";
  controls.style.left=rect.left+"px";
  controls.style.bottom="auto";
  controls.style.top=rect.top+"px";
  controls.style.transform="none";
  e.preventDefault();
}

document.addEventListener("mousemove", doDrag);
document.addEventListener("touchmove", e=>{ if(S.ctrlDragging) doDrag(e.touches[0]); }, {passive:false});

function doDrag(e){
  if(!S.ctrlDragging||S.isLocked) return;
  const pw=$("playerWrap").getBoundingClientRect();
  const cr=controls.getBoundingClientRect();
  let x=e.clientX-pw.left-S.ctrlDragOX;
  let y=e.clientY-pw.top-S.ctrlDragOY;
  x=Math.max(0,Math.min(pw.width-cr.width,x));
  y=Math.max(0,Math.min(pw.height-cr.height,y));
  controls.style.left=x+"px";
  controls.style.top=y+"px";
}

document.addEventListener("mouseup", endDrag);
document.addEventListener("touchend", endDrag);
function endDrag(){ S.ctrlDragging=false; controls.style.transition=""; }

/* ════════════════════════════════
   SIDEBAR
════════════════════════════════ */
function sidebarOpen(){
  sidebar.style.width="280px";
  sidebar.style.borderLeft="1px solid var(--border)";
  playerWrap.style.right="280px";
}
function sidebarClose(){
  sidebar.style.width="0px";
  sidebar.style.borderLeft="none";
  playerWrap.style.right="0";
}
function sidebarToggle(){ sidebar.style.width==="0px" ? sidebarOpen() : sidebarClose(); }

$("btnSidebar").addEventListener("click", sidebarToggle);
$("btnSidebarClose").addEventListener("click", sidebarClose);
$("btnClearPlaylist").addEventListener("click", clearPlaylist);

function renderPlaylist(){
  const pl=$("playlist");
  const empty=$("sbEmpty");
  pl.innerHTML="";
  $("sbCount").textContent=S.playlist.length+" item"+(S.playlist.length!==1?"s":"");
  if(S.playlist.length===0){ pl.appendChild(empty); return; }
  S.playlist.forEach((item,i)=>{
    const mediaIcon = item.kind==="audio"
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v12.5A3.5 3.5 0 1 1 10 12.34V6h10v3H12z"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
    const div=document.createElement("div");
    div.className="playlist-item"+(i===S.currentIndex?" active":"");
    div.innerHTML=`
      <span class="playlist-num">${i+1}</span>
      <div class="playlist-thumb">${mediaIcon}</div>
      <div class="playlist-info">
        <div class="playlist-name" title="${esc(item.name)}">${esc(shortN(item.name))}</div>
        <div class="playlist-duration">${item.duration}</div>
      </div>
      <button class="playlist-del" data-i="${i}" title="Remove">✕</button>`;
    div.addEventListener("click",e=>{ if(!e.target.classList.contains("playlist-del")) loadVideo(i); });
    div.querySelector(".playlist-del").addEventListener("click",e=>{ e.stopPropagation(); removeFromPlaylist(i); });
    pl.appendChild(div);
  });
}

function clearPlaylist(){
  clearTimeout(S.sleepTimer); S.sleepTimer = null; S.sleepMinutes = 0; $("btnSleep")?.classList.remove("active"); // S2
  stopNativePlayback();
  S.playlist.forEach(releaseItemUrl);
  S.playlist = [];
  S.currentIndex = -1;
  S.playing = false;
  S.srtCues = [];
  // Reset lock state
  S.isLocked = false;
  document.body.classList.remove("player-locked");
  $("btnLock")?.classList.remove("is-locked");
  controls.classList.remove("is-locked");
  $("screenLockBtn")?.classList.remove("active");
  $("iconUnlocked") && ($("iconUnlocked").style.display="block");
  $("iconLocked") && ($("iconLocked").style.display="none");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("iconPlay").style.display = "block";
  $("iconPause").style.display = "none";
  $("timeNow").textContent = "0:00";
  $("timeDur").textContent = "0:00";
  $("progressBuf").style.width = "0";
  $("progressFill").style.width = "0";
  $("progressThumb").style.left = "0";
  $("subtitleDisplay").className = "subtitle-off";
  $("subtitleDisplay").textContent = "";
  vcont.style.display = "none";
  dropZone.style.display = "flex";
  controls.classList.remove("hidden");
  document.body.classList.remove("player-ui-hidden");
  document.body.classList.remove("in-player");
  const backBtn = $("btnBack");
  if(backBtn) backBtn.style.display = "none";
  $("topbarTitle").textContent = "ENKRIT";
  $("ctrlFilename").textContent = "";
  const ptt = $("playerTopTitle"); if(ptt) ptt.textContent = "ENKRIT";
  $("playerTopBar")?.classList.add("hidden");
  document.title = "ENKRIT";
  renderPlaylist();
  updateMediaModeUI();
  if(typeof renderLibGrid === "function") renderLibGrid();
  if(typeof updateMiniPlayer === "function") updateMiniPlayer();
}

/* ── BACK TO LIBRARY ── */
const btnBack = $("btnBack");
if(btnBack){
  btnBack.addEventListener("click", backToLibrary);
}

function backToLibrary(){
  saveResumePosition(true);
  clearTimeout(S.sleepTimer); S.sleepTimer = null; S.sleepMinutes = 0; $("btnSleep")?.classList.remove("active"); // S2: cancel sleep timer
  stopNativePlayback();
  S.playing = false; S.currentIndex = -1;
  // Clear lock state
  S.isLocked = false;
  document.body.classList.remove("player-locked");
  $("btnLock")?.classList.remove("is-locked");
  controls.classList.remove("is-locked");
  $("screenLockBtn")?.classList.remove("active");
  $("iconUnlocked") && ($("iconUnlocked").style.display="block");
  $("iconLocked") && ($("iconLocked").style.display="none");
  video.pause(); video.removeAttribute("src"); video.load();
  $("iconPlay").style.display = "block";
  $("iconPause").style.display = "none";
  vcont.style.display = "none";
  dropZone.style.display = "flex";
  controls.classList.remove("hidden");
  document.body.classList.remove("player-ui-hidden");
  document.body.classList.remove("in-player");
  if(btnBack) btnBack.style.display = "none";
  $("topbarTitle").textContent = "ENKRIT";
  document.title = "ENKRIT";
  updateMediaModeUI();
  if(typeof renderLibGrid === "function") renderLibGrid();
  if(typeof updateMiniPlayer === "function") updateMiniPlayer();
  if(typeof markNowPlayingCards === "function") markNowPlayingCards();
}

function removeFromPlaylist(i){
  // Bug 16 + audit #4: clear resume for ANY deleted item (current or not),
  // and do it before stopNativePlayback() re-saves it for the current one.
  const delItem = S.playlist[i];
  if(delItem) {
    try { const rs=resumeStore(); delete rs[resumeKey(delItem)]; localStorage.setItem("enkrit_resume",JSON.stringify(rs)); } catch(_){}
  }
  if(S.currentIndex===i){
    stopNativePlayback();
  }
  releaseItemUrl(S.playlist[i]);
  S.playlist.splice(i,1);
  if(S.currentIndex===i){
    S.currentIndex=-1;
    if(S.playlist.length>0) loadVideo(Math.min(i,S.playlist.length-1));
    else{
      S.playing = false;
      video.pause();
      video.removeAttribute("src");
      video.load();
      $("iconPlay").style.display="block"; $("iconPause").style.display="none";
      vcont.style.display="none";
      dropZone.style.display="flex";
      document.body.classList.remove("player-ui-hidden");
  document.body.classList.remove("in-player");
      $("topbarTitle").textContent="ENKRIT";
      $("ctrlFilename").textContent="";
      const ptt=$("playerTopTitle"); if(ptt) ptt.textContent="ENKRIT";
      $("playerTopBar")?.classList.add("hidden");
      document.title="ENKRIT";
      const backBtn=$("btnBack"); if(backBtn) backBtn.style.display="none";
    }
  } else if(S.currentIndex>i) S.currentIndex--;
  renderPlaylist();
  updateMediaModeUI();
}

function highlightActive(){
  document.querySelectorAll(".playlist-item").forEach((el,i)=>el.classList.toggle("active",i===S.currentIndex));
}

/* ════════════════════════════════
   THEME
════════════════════════════════ */
const THEME_ACCENTS = new Set(["prism","aurora","solar","velvet","nebula","mono"]);
const LEGACY_ACCENTS = {
  blue:"prism",
  mint:"aurora",
  rose:"velvet",
  amber:"solar",
  violet:"nebula",
  cyan:"mono",
};
function normalizeAccent(accent){
  const key = LEGACY_ACCENTS[accent] || accent || "prism";
  return THEME_ACCENTS.has(key) ? key : "prism";
}
function setAccent(accent, persist=true){
  document.body.dataset.accent = normalizeAccent(accent);
  document.querySelectorAll(".theme-choice").forEach(btn=>btn.classList.toggle("active", btn.dataset.accent===document.body.dataset.accent));
  if(persist) try{ localStorage.setItem("enkrit_accent", document.body.dataset.accent); }catch(_){}
}
function setThemeMode(mode, persist=true){
  const dark = mode === "dark";
  document.body.classList.toggle("dark-mode", dark);
  $("themeDark")?.classList.toggle("active", dark);
  $("themeLight")?.classList.toggle("active", !dark);
  if(persist) try{ localStorage.setItem("enkrit_theme", dark ? "dark" : "light"); }catch(_){}
}
function setThemeMenuOpen(open){
  $("themeMenu")?.classList.toggle("open", open);
}
function initTheme(){
  let savedTheme = null;
  let savedAccent = "prism";
  try{
    savedTheme = localStorage.getItem("enkrit_theme");
    savedAccent = localStorage.getItem("enkrit_accent") || "prism";
  }catch(_){}
  setThemeMode(savedTheme ? savedTheme : "dark", false);
  setAccent(savedAccent, false);
}
$("btnTheme").addEventListener("click",e=>{
  e.stopPropagation();
  setThemeMenuOpen(!$("themeMenu").classList.contains("open"));
});
$("themeDark")?.addEventListener("click",()=>setThemeMode("dark"));
$("themeLight")?.addEventListener("click",()=>setThemeMode("light"));
document.querySelectorAll(".theme-choice").forEach(btn=>{
  btn.addEventListener("click",()=>setAccent(btn.dataset.accent || "prism"));
});
window.ENKRITToggleTheme = () => setThemeMode(document.body.classList.contains("dark-mode") ? "light" : "dark");

/* ════════════════════════════════
   SUBTITLES — LOCAL WHISPER
════════════════════════════════ */
$("btnSub").addEventListener("click",e=>{
  e.stopPropagation();
  const opening = !$("subMenu").classList.contains("open");
  setSubMenuOpen(opening);
  if(opening && typeof refreshSubtitleTracks === "function") refreshSubtitleTracks();
  $("speedPanel").classList.remove("open");
  decoderPanel.classList.remove("open");
});
$("subOff").addEventListener("click",()=>{
  try { if(isAndroidApp() && window.AndroidBridge?.setSubtitleTrack) window.AndroidBridge.setSubtitleTrack(-1); } catch(_){}
  try { const tt=video.textTracks||[]; for(let i=0;i<tt.length;i++) tt[i].mode="disabled"; } catch(_){}
  S.subTrackIndex = -1;
  setSubMode("off"); setSubMenuOpen(false);
});
$("subAuto").addEventListener("click",()=>{
  setSubMenuOpen(false);
  startLocalWhisper();
});
$("subFile").addEventListener("click",()=>{
  setSubMenuOpen(false);
  // On Android use the native bridge to read the file directly — avoids the
  // FileReader + content URI permission crash that occurs on some devices.
  if(isAndroidApp() && window.AndroidBridge?.pickSubtitleFile){
    window.AndroidBridge.pickSubtitleFile();
  } else {
    $("srtInput").click();
  }
});
$("srtInput").addEventListener("change",e=>{
  const f=e.target.files?.[0]; if(!f) return;
  const r=new FileReader();
  r.onload=ev=>{ S.srtCues=parseSrt(ev.target.result); setSubMode("file"); showSubToast("SRT loaded ✓"); };
  r.onerror=()=>showSubToast("Could not read file","error");
  r.readAsText(f); $("srtInput").value="";
});

function setSubMenuOpen(open){
  $("subMenu").classList.toggle("open", open);
  document.querySelector(".sub-wrap")?.classList.toggle("expanded", open);
}

function updateSubtitleButtonState(){
  const wrap = document.querySelector(".sub-wrap");
  if(!wrap) return;
  wrap.classList.toggle("has-subs", S.subtitleMode==="file" && S.srtCues.length>0);
  wrap.classList.toggle("ai-running", S.whisperRunning);
  $("subAuto").classList.toggle("busy", S.whisperRunning);
  $("subAuto").classList.toggle("disabled", isAndroidApp());
  $("subAuto").title = isAndroidApp()
    ? "AI subtitles are available on Mac only"
    : S.whisperRunning ? "Generating AI Subtitles" : "Generate AI Subtitles";
}

function setSubMode(mode){
  S.subtitleMode=mode;
  document.querySelectorAll(".sub-opt").forEach(b=>b.classList.remove("active"));
  if(mode==="off"){
    $("subOff").classList.add("active");
    $("subtitleDisplay").className="subtitle-off";
    $("subtitleDisplay").textContent="";
    S.srtCues=[];
  } else if(mode==="auto"||mode==="file"){
    const btn = mode==="auto" ? $("subAuto") : $("subFile");
    if(btn) btn.classList.add("active");
    $("subtitleDisplay").className="subtitle-on";
  } else if(mode==="track"){
    // Embedded subtitle track (native ExoPlayer cues / HTML5 textTracks)
    S.srtCues=[];
    $("subtitleDisplay").className="subtitle-on";
    $("subtitleDisplay").textContent="";
  }
  updateSubtitleButtonState();
}

/* ── LOCAL WHISPER via Electron IPC ── */
async function startLocalWhisper(){
  const item=S.playlist[S.currentIndex];
  if(!item){ showSubToast("No video loaded","error"); return; }
  if(isAndroidApp()){
    showSubToast("AI subtitles are available on Mac only. Use SRT on phone.", "info");
    return;
  }
  if(S.whisperRunning){
    showSubToast("AI subtitles are already generating...", "loading");
    return;
  }

  if(!window.electronAPI || !window.electronAPI.runWhisper){
    showSubToast("Run inside ENKRIT app","error"); return;
  }

  setSubMode("auto");
  S.whisperRunning = true;
  updateSubtitleButtonState();
  showSubToast("⏳ Starting Whisper AI…","loading");

  // Listen for progress events
  if(window.electronAPI.onWhisperProgress && !S.whisperListenerReady){
    S.whisperListenerReady = true;
    window.electronAPI.onWhisperProgress(msg=>{
      if(msg.status==="loading_model") showSubToast("⏳ Loading AI model (first time only)…","loading");
      else if(msg.status==="transcribing") showSubToast("🎙 Generating subtitles…","loading");
      else if(msg.status==="progress"){
        const at = msg.end ? fmt(msg.end) : "";
        const count = msg.count || 0;
        showSubToast(`AI ${count} lines${at ? " • " + at : ""}`, "loading");
      }
      else if(msg.status==="writing_srt") showSubToast("Writing subtitle file...", "loading");
    });
  }

  // Get real file path (Electron gives us access to it)
  const videoPath = item.sourcePath || item.path || getFilePath(item.file);
  if(!videoPath){
    S.whisperRunning = false;
    updateSubtitleButtonState();
    showSubToast("Cannot access file path","error");
    return;
  }

  let result;
  try{
    result = await window.electronAPI.runWhisper(videoPath);
  }catch(e){
    result = { error:e.message || "AI subtitle generation failed" };
  }
  S.whisperRunning = false;
  updateSubtitleButtonState();

  if(result.error){
    showSubToast("✗ "+result.error,"error");
    if(result.error.includes("faster-whisper")||result.error.includes("not installed")){
      setTimeout(()=>showSubToast("Fix: pip3 install faster-whisper","error"),2500);
    }
    setSubMode("off");
    return;
  }

  if(result.status==="done" && result.srt){
    const srtText = await window.electronAPI.readFile(result.srt);
    if(srtText){
      S.srtCues=parseSrt(srtText);
      setSubMode("file");
      showSubToast("✓ "+result.count+" subtitles ready","success");
      return;
    }
  }
  showSubToast("No subtitles were generated", "error");
  setSubMode("off");
}

function showInstallGuide(err){
  const isNotInstalled = err && (err.includes("not installed") || err.includes("No module") || err.includes("not_electron"));
  const msg = isNotInstalled
    ? "Run in Terminal: pip3 install faster-whisper"
    : "Install faster-whisper: pip3 install faster-whisper";
  showSubToast(msg, "error");
}

let _subToastTimer = null;
function showSubToast(msg, type){
  // Show in subtitle display area temporarily
  const el=$("subtitleDisplay");
  el.textContent=msg;
  el.className="subtitle-on sub-toast"+(type?" sub-toast-"+type:"");
  if(_subToastTimer){ clearTimeout(_subToastTimer); _subToastTimer = null; }
  // Every toast auto-dismisses except "loading" (which stays until replaced).
  if(type !== "loading"){
    _subToastTimer = setTimeout(()=>{ el.className="subtitle-off"; el.textContent=""; _subToastTimer = null; }, 3000);
  }
}

function parseSrt(text){
  const cues=[];
  text.trim().replace(/\r\n/g,"\n").split(/\n\n+/).forEach(b=>{
    const lines=b.split("\n"); if(lines.length<3) return;
    const t=lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if(!t) return;
    cues.push({ start:+t[1]*3600+ +t[2]*60+ +t[3]+ +t[4]/1000, end:+t[5]*3600+ +t[6]*60+ +t[7]+ +t[8]/1000, text:lines.slice(2).join(" ").replace(/<[^>]+>/g,"").trim() });
  });
  return cues;
}

function updateSrtSub(){
  const t=video.currentTime;
  const c=S.srtCues.find(c=>t>=c.start&&t<=c.end);
  $("subtitleDisplay").textContent=c?c.text:"";
  if(c && S.subtitleMode!=="off") $("subtitleDisplay").className="subtitle-on";
  else if(!c) $("subtitleDisplay").className="subtitle-off";
}

function stopSpeechRec(){ if(S.recognition){ try{S.recognition.stop();}catch(_){} S.recognition=null; } }

/* ════════════════════════════════
   FILTERS — FULL SYSTEM
════════════════════════════════ */
function setFilterPanelOpen(open){
  const panel = $("filterPanel");
  if(!panel) return;
  panel.style.display = open ? "flex" : "none";
  document.body.classList.toggle("filter-open", !!open);
  if(open) {
    showControls();
    clearTimeout(S.controlsTimer);
  } else {
    resetHide();
  }
}

$("btnFilter").addEventListener("click",e=>{
  e.stopPropagation();
  if(!currentIsVideo()) return;
  setSubMenuOpen(false);
  $("speedPanel").classList.remove("open");
  decoderPanel.classList.remove("open");
  setFilterPanelOpen(true);
});
$("filterClose").addEventListener("click",()=>setFilterPanelOpen(false));
$("filterPanel").addEventListener("click",e=>{ if(e.target===$("filterPanel")) setFilterPanelOpen(false); });

// Default filter state
S.filters = {brightness:100,contrast:100,saturation:100,sharpness:0,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:0,gamma:100};

// All slider definitions: [elementId, stateKey, displayFormatter]
const FILTER_DEFS = [
  ["fBrightness","brightness", v=>v+"%"],
  ["fContrast",  "contrast",   v=>v+"%"],
  ["fSaturation","saturation", v=>v+"%"],
  ["fExposure",  "exposure",   v=>(v>=0?"+":"")+v],
  ["fGamma",     "gamma",      v=>(v/100).toFixed(1)],
  ["fSharpness", "sharpness",  v=>parseFloat(v).toFixed(1)],
  ["fHue",       "hue",        v=>v+"°"],
  ["fBlur",      "blur",       v=>parseFloat(v).toFixed(1)+"px"],
  ["fSepia",     "sepia",      v=>v+"%"],
  ["fGrayscale", "grayscale",  v=>v+"%"],
  ["fInvert",    "invert",     v=>v+"%"],
];

FILTER_DEFS.forEach(([id,key,fmtFn])=>{
  const el=$(id); if(!el) return;
  el.addEventListener("input",()=>{
    S.filters[key]=parseFloat(el.value);
    $(id+"Val").textContent=fmtFn(el.value);
    applyFilters();
  });
});

// HDR and all presets
const PRESETS={
  normal:   {brightness:100,contrast:100,saturation:100,sharpness:0,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:0,gamma:100},
  clean_hd: {brightness:104,contrast:116,saturation:108,sharpness:1.2,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:4,gamma:96},
  ultra_clear:{brightness:106,contrast:128,saturation:116,sharpness:2.2,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:8,gamma:92},
  crisp_4k: {brightness:102,contrast:138,saturation:112,sharpness:2.8,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:6,gamma:94},
  hdr:      {brightness:108,contrast:130,saturation:115,sharpness:1.5,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:15,gamma:90},
  hdr_plus: {brightness:112,contrast:145,saturation:125,sharpness:2,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:20,gamma:85},
  low_light:{brightness:124,contrast:116,saturation:108,sharpness:1.3,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:24,gamma:82},
  vivid:    {brightness:105,contrast:120,saturation:160,sharpness:1.5,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:5,gamma:95},
  sports:   {brightness:108,contrast:126,saturation:132,sharpness:1.8,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:8,gamma:93},
  anime:    {brightness:106,contrast:118,saturation:178,sharpness:1.4,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:6,gamma:96},
  cinematic:{brightness:92,contrast:140,saturation:80,sharpness:2,hue:0,blur:0,sepia:5,grayscale:0,invert:0,exposure:-5,gamma:105},
  dolby:    {brightness:115,contrast:150,saturation:130,sharpness:2.5,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:25,gamma:80},
  amoled:   {brightness:95,contrast:180,saturation:140,sharpness:2,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:0,gamma:88},
  natural:  {brightness:101,contrast:106,saturation:104,sharpness:0.6,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:1,gamma:100},
  soft_clean:{brightness:103,contrast:108,saturation:106,sharpness:0.2,hue:0,blur:0.2,sepia:0,grayscale:0,invert:0,exposure:3,gamma:99},
  cool:     {brightness:100,contrast:110,saturation:110,sharpness:0,hue:200,blur:0,sepia:0,grayscale:0,invert:0,exposure:0,gamma:100},
  warm:     {brightness:105,contrast:108,saturation:118,sharpness:0,hue:15,blur:0,sepia:10,grayscale:0,invert:0,exposure:5,gamma:97},
  grayscale:{brightness:100,contrast:110,saturation:0,sharpness:0.8,hue:0,blur:0,sepia:0,grayscale:100,invert:0,exposure:0,gamma:100},
  black_white:{brightness:106,contrast:185,saturation:0,sharpness:1.8,hue:0,blur:0,sepia:0,grayscale:100,invert:0,exposure:4,gamma:92},
  noir:     {brightness:90,contrast:160,saturation:0,sharpness:2,hue:0,blur:0,sepia:0,grayscale:100,invert:0,exposure:-10,gamma:110},
  vintage:  {brightness:95,contrast:90,saturation:70,sharpness:0,hue:20,blur:0.3,sepia:30,grayscale:0,invert:0,exposure:-5,gamma:105},
  enhance:  {brightness:103,contrast:112,saturation:122,sharpness:1,hue:0,blur:0,sepia:0,grayscale:0,invert:0,exposure:8,gamma:96},
};

function applyPreset(key){
  const p=PRESETS[key]; if(!p) return;
  Object.assign(S.filters,p);
  // Update all sliders and labels
  FILTER_DEFS.forEach(([id,,fmtFn])=>{
    const el=$(id); if(!el) return;
    const stateKey=FILTER_DEFS.find(d=>d[0]===id)[1];
    el.value=p[stateKey];
    $(id+"Val").textContent=fmtFn(p[stateKey]);
  });
  // Update active tab
  document.querySelectorAll(".ptab").forEach(b=>b.classList.toggle("active",b.dataset.preset===key));
  applyFilters();
}

document.querySelectorAll(".ptab").forEach(b=>b.addEventListener("click",()=>applyPreset(b.dataset.preset)));

$("filterReset").addEventListener("click",()=>applyPreset("normal"));

function applyFilters(){
  if(!currentIsVideo()){
    video.style.filter = "none";
    return;
  }
  const f=S.filters;
  // Build CSS filter string
  // Exposure simulated via brightness boost on top
  const exposureMult = 1 + (f.exposure/100);
  const finalBright = (f.brightness/100) * exposureMult * 100;
  // Gamma via SVG filter would need canvas; we approximate with brightness curve
  const gammaAdj = f.gamma !== 100 ? `brightness(${100+(100-f.gamma)*0.3}%)` : "";

  if(S.nativePlayback && isAndroidApp()) {
    try {
      window.AndroidBridge?.setVideoFilter?.(
        Math.round(finalBright),
        Math.round(f.contrast),
        Math.round(f.saturation),
        Math.round(f.grayscale),
        Math.round(f.hue),
        Math.round(f.sepia),
        Math.round(f.invert),
        Math.round((f.blur || 0) * 10)
      );
    } catch(_){}
    video.style.filter = "none";
    return;
  }

  video.style.filter=[
    `brightness(${finalBright.toFixed(1)}%)`,
    `contrast(${f.contrast}%)`,
    `saturate(${f.saturation}%)`,
    f.grayscale>0 ? `grayscale(${f.grayscale}%)` : "",
    `hue-rotate(${f.hue}deg)`,
    f.blur>0 ? `blur(${f.blur}px)` : "",
    f.sepia>0 ? `sepia(${f.sepia}%)` : "",
    f.invert>0 ? `invert(${f.invert}%)` : "",
    gammaAdj,
  ].filter(Boolean).join(" ");
}

/* ════════════════════════════════
   KEYBOARD
════════════════════════════════ */
document.addEventListener("keydown",e=>{
  if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA") return;
  switch(e.code){
    case"Space":      e.preventDefault(); togglePlay(); break;
    case"ArrowLeft":  e.preventDefault(); seek(-5); break;
    case"ArrowRight": e.preventDefault(); seek(5); break;
    case"ArrowUp":    e.preventDefault(); changeVol(10); break;
    case"ArrowDown":  e.preventDefault(); changeVol(-10); break;
    case"KeyF":       toggleFS(); break;
    case"KeyM":       $("btnMute").click(); break;
    case"KeyP":       $("btnPip").click(); break;
    case"BracketLeft":  setSpeed(Math.max(0.1,+(S.speed-0.25).toFixed(2))); break;
    case"BracketRight": setSpeed(Math.min(5,+(S.speed+0.25).toFixed(2))); break;
    case"KeyN":       $("btnNext").click(); break;
    case"KeyB":       $("btnPrev").click(); break;
  }
});
function changeVol(d){ const max=volumeMax(); const v=Math.max(0,Math.min(max,+volSlider.value+d)); volSlider.value=v; applyVolume(); }

/* CLOSE MENUS */
document.addEventListener("click",e=>{
  if(!$("themeWrap").contains(e.target)) setThemeMenuOpen(false);
  if(!$("btnSpeed").contains(e.target)&&!$("speedPanel").contains(e.target)) $("speedPanel").classList.remove("open");
  if(!$("btnSub").contains(e.target)&&!$("subMenu").contains(e.target)) setSubMenuOpen(false);
  if(!$("decoderBtn").contains(e.target)&&!$("decoderPanel").contains(e.target)) $("decoderPanel").classList.remove("open");
  if($("orientPanel") && !$("btnOrient")?.contains(e.target) && !$("orientPanel").contains(e.target)) $("orientPanel").classList.remove("open");
  if($("resizePanel") && !$("btnResize")?.contains(e.target) && !$("resizePanel").contains(e.target)) $("resizePanel").classList.remove("open");
  // filterPanel stays open until X or outside overlay click
});

/* ONLINE/OFFLINE */
window.addEventListener("online",()=>{});
window.addEventListener("offline",()=>{ stopSpeechRec(); });

/* P4: AUTO PIP — enter PiP when app goes to background (desktop only; Android uses native bridge) */
document.addEventListener("visibilitychange", () => {
  if(document.hidden && AppSettings.autoPip && S.playing && currentIsVideo() && !isAndroidApp()) {
    try {
      if(!document.pictureInPictureElement && video.requestPictureInPicture) {
        video.requestPictureInPicture().catch(()=>{});
      }
    } catch(_){}
  }
});

/* ── UTILS ── */
function fmt(sec){ if(!isFinite(sec)) return"0:00"; const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=Math.floor(sec%60); return h>0?`${h}:${pad(m)}:${pad(s)}`:`${m}:${pad(s)}`; }
function pad(n){ return String(n).padStart(2,"0"); }
function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function escHtml(s){ return esc(s); }
function shortN(n){ const s=String(n||"").replace(/\.[^/.]+$/,""); return s.length>38?s.slice(0,35)+"…":s; }



/* INIT */
initTheme();
// Sidebar open by default
sidebarOpen();
renderPlaylist();
updateMediaModeUI();

console.log("ENKRIT ready ✓");

/* ══════════════════════════════════════════
   LIBRARY — AUTO SCAN & DISPLAY
══════════════════════════════════════════ */
const LibState = {
  allFiles: [],
  recentFiles: (()=>{ try{ return dedupeMediaList(JSON.parse(localStorage.getItem("enkrit_recent")||"[]")); }catch(_){ return []; } })(),
  favorites: (()=>{ try{ return new Set(JSON.parse(localStorage.getItem("enkrit_favorites")||"[]")); }catch(_){ return new Set(); } })(),
  activeTab: "library",
  currentFolder: null,
  kindFilter: "all",
  sortMode: (()=>{ try{ return localStorage.getItem("enkrit_sort") || "recent"; }catch(_){ return "recent"; } })(),
  searchQ: "",
};

// Init library on load
window.addEventListener("load", () => {
  setTimeout(initLibrary, 2200); // after splash
},{once:true}); // Bug 15

function setLibraryTab(tabName) {
  LibState.activeTab = tabName;
  document.querySelectorAll(".lib-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  const tools = $("recentTools");
  if(tools) tools.style.display = tabName === "recent" ? "flex" : "none";
}

function initLibrary() {
  setLibraryTab("library");
  LibState.recentFiles = dedupeMediaList(LibState.recentFiles);
  try { localStorage.setItem("enkrit_recent", JSON.stringify(LibState.recentFiles)); } catch(_){}

  // Tab switching
  document.querySelectorAll(".lib-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      LibState.currentFolder = null;
      LibState.kindFilter = "all"; // Bug 12: reset kind filter on tab switch
      document.querySelectorAll(".kind-chip").forEach(c => c.classList.toggle("active", c.dataset.kind === "all"));
      setLibraryTab(tab.dataset.tab);
      renderLibGrid();
    });
  });

  // Search
  const searchEl = $("libSearch");
  if(searchEl) searchEl.addEventListener("input", () => {
    LibState.searchQ = searchEl.value.toLowerCase();
    renderLibGrid();
  });

  // Scan button
  const scanBtn = $("btnScanLib");
  if(scanBtn) scanBtn.addEventListener("click", scanLibrary);
  $("libEmptyAction")?.addEventListener("click", scanLibrary);
  document.querySelectorAll("[data-clear-recent]").forEach(btn => {
    btn.addEventListener("click", () => clearRecent(btn.dataset.clearRecent));
  });
  document.querySelectorAll(".kind-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      LibState.kindFilter = btn.dataset.kind || "all";
      document.querySelectorAll(".kind-chip").forEach(chip => chip.classList.toggle("active", chip === btn));
      renderLibGrid();
    });
  });
  const sortEl = $("libSort");
  if(sortEl) {
    sortEl.value = LibState.sortMode;
    sortEl.addEventListener("change", () => {
      LibState.sortMode = sortEl.value;
      try { localStorage.setItem("enkrit_sort", LibState.sortMode); } catch(_){}
      renderLibGrid();
    });
  }

  if(isAndroidApp() && window.AndroidBridge?.hasMediaPermission && !window.AndroidBridge.hasMediaPermission()) {
    showPermissionEmptyState();
    renderLibGrid();
    return;
  }

  scanLibrary();
}

async function scanLibrary() {
  if(isAndroidApp()) setLibraryTab("library");
  const scanning = $("libScanning");
  const grid = $("libGrid");
  const empty = $("libEmpty");
  if(scanning) scanning.style.display = "flex";
  if(grid) grid.style.display = "none";
  if(empty) empty.style.display = "none";

  try {
    if(isAndroidApp() && window.AndroidBridge?.hasMediaPermission && !window.AndroidBridge.hasMediaPermission()) {
      window.AndroidBridge.requestMediaPermission();
      const status = $("libScanStatus");
      if(status) status.textContent = "Waiting for phone media permission...";
      setTimeout(() => {
        if(window.AndroidBridge?.hasMediaPermission && !window.AndroidBridge.hasMediaPermission()) {
          if(scanning) scanning.style.display = "none";
          showPermissionEmptyState();
        }
      }, 900);
      return;
    }
    if(window.libraryAPI) {
      let files = await window.libraryAPI.scanLibrary();
      files = Array.isArray(files) ? files : [];
      // P6: apply showNomedia / showHidden filters from settings
      if(!AppSettings.showNomedia) {
        files = files.filter(f => !(f.path || "").includes("/.nomedia") && !(f.folder || "").toLowerCase().includes("nomedia"));
      }
      if(!AppSettings.showHidden) {
        files = files.filter(f => !/(^|\/)\./.test(f.path || ""));
      }
      LibState.allFiles = files;
      syncDeletedMediaFromLibrary();
      const status = $("libScanStatus");
      if(status) status.textContent = `Found ${LibState.allFiles.length} media files`;
    }
  } catch(e) {
    console.warn("Library scan failed:", e);
  }

  if(scanning) scanning.style.display = "none";
  renderLibGrid();
}

function showPermissionEmptyState(){
  const grid = $("libGrid");
  const empty = $("libEmpty");
  const title = empty?.querySelector(".lib-empty-title");
  const sub = empty?.querySelector(".lib-empty-sub");
  const action = $("libEmptyAction");
  if(grid) {
    grid.classList.add("is-empty");
    grid.style.display = "none";
  }
  if(empty) empty.style.display = "flex";
  if(title) title.textContent = "Allow media access";
  if(sub) sub.textContent = "ENKRIT needs permission to show videos and audio from your phone.";
  if(action) action.style.display = "inline-flex";
}

// Only MediaStore-backed items (content://media/...) can be proven deleted by a rescan.
// Files added via the system document picker, plain file paths, etc. are never enumerated
// by the scan, so their absence means nothing — leaving them out here avoids wrongly
// dropping picked files (and any MediaStore item past the scan's cap) from the user's lists.
function isScannableMedia(item){
  return String(item?.path || "").toLowerCase().startsWith("content://media/");
}
function syncDeletedMediaFromLibrary(){
  if(!LibState.allFiles.length) return;
  const live = new Set();
  LibState.allFiles.forEach(file => {
    if(file?.path) live.add(String(file.path).toLowerCase());
    live.add(mediaListKey(file));
  });
  const existsInLibrary = item => live.has(String(item?.path || "").toLowerCase()) || live.has(mediaListKey(item));
  const keep = item => !isScannableMedia(item) || existsInLibrary(item);

  // Do NOT filter recentFiles here — the scan has a 500-item cap so any video
  // beyond that would be incorrectly treated as "deleted" and purged from history.
  // Recently played history is only cleared by explicit user action or confirmed deletes.

  const current = currentItem();
  const beforePlaylist = S.playlist.length;
  S.playlist = S.playlist.filter(item => {
    if(keep(item)) return true;
    releaseItemUrl(item);
    return false;
  });
  if(S.playlist.length !== beforePlaylist) {
    // Re-anchor currentIndex to the same item rather than assuming it didn't shift.
    if(current){
      const idx = S.playlist.indexOf(current);
      if(idx === -1){
        S.currentIndex = -1;
        stopNativePlayback();
        backToLibrary();
      } else {
        S.currentIndex = idx;
      }
    } else if(S.currentIndex >= S.playlist.length){
      S.currentIndex = S.playlist.length - 1;
    }
    renderPlaylist();
  }
}

function sortMediaFiles(files){
  const mode = LibState.sortMode || "recent";
  return files.sort((a,b)=>{
    if(mode === "name") return String(a.name || "").localeCompare(String(b.name || ""));
    if(mode === "size") return (b.size || 0) - (a.size || 0);
    if(mode === "long") return (b.durationMs || 0) - (a.durationMs || 0);
    return (b.playedAt || b.mtime || 0) - (a.playedAt || a.mtime || 0);
  });
}
function favoriteKey(fileObj){
  return mediaListKey(fileObj);
}
function isFavorite(fileObj){
  return LibState.favorites.has(favoriteKey(fileObj));
}
function toggleFavorite(fileObj){
  if(!fileObj) return;
  const key = favoriteKey(fileObj);
  if(LibState.favorites.has(key)) {
    LibState.favorites.delete(key);
    showSubToast("Removed from favorites", "info");
  } else {
    LibState.favorites.add(key);
    showSubToast("Added to favorites", "success");
  }
  try { localStorage.setItem("enkrit_favorites", JSON.stringify([...LibState.favorites])); } catch(_){}
  renderLibGrid();
}
function resumeProgressPct(fileObj){
  const entry = resumeStore()[resumeKey(fileObj)] || null;
  if(!entry || !entry.position || !entry.duration) return 0;
  return Math.max(0, Math.min(100, entry.position / entry.duration * 100));
}

function isCallRecording(file) {
  const folder = (file.folder || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return folder.includes("call record") || folder.includes("call_record") ||
         folder.includes("phonerecord") || folder.includes("phone record") ||
         folder.includes("sound_recorder") || folder.includes("voicerecorder") ||
         folder.includes("voice record") || folder.includes("voicemail") ||
         type === "audio/amr" || type === "audio/3gpp2";
}

function renderLibGrid() {
  // Bug 1: cancel any pending thumbnail decode video elements from previous render
  _pendingThumbs.forEach(v => { try { v.src = ""; v.remove(); } catch(_){} });
  _pendingThumbs = [];
  const grid = $("libGrid");
  const empty = $("libEmpty");
  if(!grid) return;

  if(isAndroidApp() && window.AndroidBridge?.hasMediaPermission && !window.AndroidBridge.hasMediaPermission()) {
    showPermissionEmptyState();
    return;
  }

  let files = LibState.activeTab === "recent"
    ? LibState.recentFiles
    : LibState.activeTab === "favorites"
    ? LibState.allFiles.filter(isFavorite)
    : LibState.allFiles;

  // S6: filter based on showRecentlyPlayed / showMusic settings
  if(LibState.activeTab === "recent" && !AppSettings.showRecentlyPlayed) {
    files = []; // "Recently Played" tab hidden by setting
  }
  if(!AppSettings.showMusic) {
    files = files.filter(f => !isAudioExt(f.name));
  }

  // Remove call recordings from All/Video views (they clutter the library)
  if(LibState.activeTab !== "recent") {
    files = files.filter(f => !isCallRecording(f));
  }

  if(LibState.kindFilter !== "all") {
    files = files.filter(f => (LibState.kindFilter === "audio") === isAudioExt(f.name));
  }

  // Search filter — multi-word, relevance-ranked, searches names AND folders
  if(LibState.searchQ) {
    let results = searchMediaFiles(files, LibState.searchQ);
    // widen to the whole library if the current tab has no hits
    if(results.length === 0 && LibState.activeTab !== "library") {
      results = searchMediaFiles(LibState.allFiles, LibState.searchQ);
    }
    files = results; // already relevance-sorted
  } else {
    files = sortMediaFiles(files.slice());
  }

  if(files.length === 0) {
    grid.classList.add("is-empty");
    grid.classList.remove("recent-carousel", "folder-carousel", "folder-list");
    grid.style.display = "none";
    if(empty) {
      empty.style.display = "flex";
      const title = empty.querySelector(".lib-empty-title");
      const sub = empty.querySelector(".lib-empty-sub");
      const action = $("libEmptyAction");
      if(title) title.textContent = "No media yet";
      if(action) action.style.display = "none";
      if(sub) {
        const kindLabel = LibState.kindFilter === "audio" ? "audio" : LibState.kindFilter === "video" ? "video" : "media";
        if(LibState.activeTab === "recent") {
          sub.textContent = `No recently played ${kindLabel} - open a file to start`;
        } else if(isAndroidApp()) {
          sub.textContent = `No phone ${kindLabel} found. Tap refresh or open files.`;
        } else {
          sub.textContent = `Click Scan Library to find ${kindLabel} on this computer`;
        }
      }
    }
    return;
  }

  grid.classList.remove("is-empty");
  if(empty) empty.style.display = "none";

  // On Android library tab, group files by folder
  const useFolderGroups = isAndroidApp() && LibState.activeTab === "library" && !LibState.searchQ;

  // Hide sort pills on Android — sort is handled per-folder via the back-bar dropdown
  if(isAndroidApp()) {
    const sortPills = $("libSortPills");
    if(sortPills) sortPills.style.display = "none";
  }
  if(useFolderGroups) {
    // Folder contents view (after tapping a tile) — vertical card list
    if(LibState.currentFolder !== null) {
      grid.classList.remove("folder-carousel", "recent-carousel");
      grid.style.cssText = ""; // clear inline styles, let CSS handle
      const folderFiles = files.filter(f => {
        const label = (f.folder && f.folder.trim()) ? f.folder : "Other";
        return label === LibState.currentFolder;
      });
      renderLibGridFolderContents(grid, folderFiles, LibState.currentFolder);
    } else {
      // Top-level folder tiles — horizontal carousel
      renderLibGridGrouped(grid, files); // adds folder-carousel class internally
    }
    return;
  }

  // Remove folder-carousel if navigated away
  grid.classList.remove("folder-carousel");

  // Always vertical grid on Android for all tabs
  grid.classList.remove("recent-carousel");
  grid.style.display = "grid";

  // Update file count chip in search placeholder
  if(isAndroidApp()) {
    const searchInput = $("libSearch");
    if(searchInput && !LibState.searchQ) {
      const total = files.length;
      const label = LibState.kindFilter === "audio" ? "audio" : LibState.kindFilter === "video" ? "videos" : "files";
      searchInput.placeholder = total > 0 ? `Search ${total} ${label}...` : "Search files...";
    }
  }

  grid.innerHTML = files.map((f, i) => makeCardHtml(f, i)).join("");
  wireGridCards(grid, files);
  if(typeof markNowPlayingCards === "function") markNowPlayingCards();
  if(typeof updateMiniPlayer === "function") updateMiniPlayer();
  if(typeof maybeShowOnboarding === "function") maybeShowOnboarding();

  // Load video thumbnails async (desktop only)
  if(!isAndroidApp()) {
    files.forEach((f, i) => {
      if(f.path && isVideoExt(f.name)) loadThumb(f.path, i);
    });
  }
}

function makeCardHtml(f, i) {
  const kind = isAudioExt(f.name) ? "audio" : "video";
  const ext = f.ext || (f.name.match(/\.([^.]+)$/)?.[1] || (kind==="audio" ? "aud" : "vid"));
  const progress = resumeProgressPct(f);
  const fav = isFavorite(f);
  const mediaIcon = kind==="audio"
    ? `<svg class="thumb-icon" width="34" height="34" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v12.5A3.5 3.5 0 1 1 10 12.34V6h10v3H12z"/></svg>`
    : `<svg class="thumb-icon" width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
  return `
  <div class="lib-card ${kind==="audio" ? "lib-card-audio" : ""}" data-idx="${i}" data-path="${escAttr(f.path || '')}" data-name="${escAttr(f.name)}">
    <div class="lib-card-thumb">
      <div class="lib-card-thumb-img"></div>
      ${mediaIcon}
      <div class="lib-card-play"><svg width="40" height="40" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
      <div class="lib-card-progress"><span style="width:${progress}%"></span></div>
      <div class="lib-card-dur" id="dur-${i}">--:--</div>
    </div>
    <div class="lib-card-ext">${escHtml(ext)}</div>
    <button class="lib-card-fav ${fav ? "active" : ""}" data-fav-idx="${i}" title="Favorite">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="${fav ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.1"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1z"/></svg>
    </button>
    <button class="lib-card-delete" data-delete-idx="${i}" title="Delete from device">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>
    </button>
    <div class="lib-card-info">
      <div class="lib-card-name" title="${escAttr(f.name)}">${escHtml(shortN(f.name))}</div>
      <div class="lib-card-meta">${recentMeta(f, kind)}${LibState.searchQ && f.folder ? ` · <span class="lib-card-folder">${escHtml(f.folder)}</span>` : ""}</div>
    </div>
  </div>`;
}

function wireGridCards(grid, files) {
  grid.querySelectorAll(".lib-card").forEach(card => {
    card.addEventListener("click", () => {
      const idx = parseInt(card.dataset.idx);
      const filePath = card.dataset.path;
      const fileName = card.dataset.name;
      if(LibState.selectMode){ toggleCardSelection(card, files[idx]); return; }
      if(filePath) openLibraryFile(filePath, fileName, files[idx]);
    });
  });
  grid.querySelectorAll(".lib-card-delete").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.deleteIdx);
      requestDeleteFile(files[idx]);
    });
  });
  grid.querySelectorAll(".lib-card-fav").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.favIdx);
      toggleFavorite(files[idx]);
    });
  });
  // Long-press context menu on Android
  if(typeof addLongPressToCards === "function") addLongPressToCards(grid, files);
  // Request video thumbnails from native layer, staggered to avoid spawning too many threads
  if(isAndroidApp() && window.AndroidBridge?.requestVideoThumb) {
    files.forEach((f, i) => {
      if(f.kind !== "audio" && f.path) {
        setTimeout(() => {
          if(window.AndroidBridge?.requestVideoThumb) window.AndroidBridge.requestVideoThumb(f.path, i);
        }, i * 40);
      }
    });
  }
}

const FOLDER_ICONS = {
  "download":  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  "whatsapp":  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  "dcim":      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  "telegram":  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  "default":   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
};
function folderIcon(name) {
  const lc = name.toLowerCase();
  if(lc.includes("download")) return FOLDER_ICONS.download;
  if(lc.includes("whatsapp")) return FOLDER_ICONS.whatsapp;
  if(lc.includes("dcim") || lc.includes("camera")) return FOLDER_ICONS.dcim;
  if(lc.includes("telegram")) return FOLDER_ICONS.telegram;
  return FOLDER_ICONS.default;
}

function renderLibGridGrouped(grid, files) {
  // Group by folder label — show folder TILES only (Arc Player style)
  const groups = new Map();
  files.forEach(f => {
    const label = (f.folder && f.folder.trim()) ? f.folder : "Other";
    if(!groups.has(label)) groups.set(label, []);
    groups.get(label).push(f);
  });

  // Sort: Downloads first, then alphabetical
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const al = a.toLowerCase(), bl = b.toLowerCase();
    if(al.includes("download") && !bl.includes("download")) return -1;
    if(!al.includes("download") && bl.includes("download")) return 1;
    return al.localeCompare(bl);
  });

  const chevronSvg = `<svg class="lib-folder-tile-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`;
  const html = sortedKeys.map(label => {
    const count = groups.get(label).length;
    return `<div class="lib-folder-tile" data-folder="${escAttr(label)}">
      <div class="lib-folder-tile-icon">${folderIcon(label)}</div>
      <div class="lib-folder-tile-info">
        <span class="lib-folder-tile-name">${escHtml(label)}</span>
        <span class="lib-folder-tile-sub">${count} ${count === 1 ? 'file' : 'files'}</span>
      </div>
      ${chevronSvg}
    </div>`;
  }).join("");

  // Apply view mode from settings
  grid.style.cssText = "";
  const viewMode = AppSettings?.folderView || "grid";
  grid.classList.remove("folder-carousel", "folder-list");
  grid.classList.add(viewMode === "list" ? "folder-list" : "folder-carousel");

  // Storage summary card (tap → full storage breakdown + tools)
  const st = computeStorageStats(files);
  const statsCard = `<div class="lib-storage-card" id="libStorageCard">
    <div class="lsc-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg></div>
    <div class="lsc-info">
      <div class="lsc-title">${st.count} files · ${fmtSize(st.total) || "0 KB"}</div>
      <div class="lsc-sub">${st.videos} video · ${st.audios} audio · tap for breakdown & tools</div>
    </div>
    <svg class="lsc-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
  </div>`;
  grid.innerHTML = statsCard + html;
  grid.querySelector("#libStorageCard")?.addEventListener("click", () => openStoragePanel());

  grid.querySelectorAll(".lib-folder-tile").forEach(tile => {
    tile.addEventListener("click", () => {
      LibState.currentFolder = tile.dataset.folder;
      renderLibGrid();
    });
  });
  if(typeof markNowPlayingCards === "function") markNowPlayingCards();
  if(typeof updateMiniPlayer === "function") updateMiniPlayer();
}

function renderLibGridFolderContents(grid, files, folderName) {
  const sortLabels = {recent:"Newest", name:"Name", size:"Size", long:"Duration"};
  const currentSortLabel = sortLabels[LibState.sortMode || "recent"] || "Newest";

  const backRow = `<div class="lib-folder-back" id="libFolderBack">
    <button class="lib-folder-back-btn" id="libFolderBackBtn">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
    </button>
    <span class="lib-folder-back-name">${escHtml(folderName)}</span>
    <span class="lib-folder-back-count">${files.length}</span>
    <button class="lib-folder-sort-btn" id="libFolderSortBtn">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="9" y2="18"/></svg>
      <span id="libFolderSortLabel">${currentSortLabel}</span>
    </button>
    <button class="lib-folder-sort-btn lib-folder-select-btn" id="libFolderSelectBtn">${LibState.selectMode ? "Cancel" : "Select"}</button>
  </div>`;

  const cardsHtml = files.map((f, i) => makeCardHtml(f, i)).join("");

  grid.style.display = "flex";
  grid.style.flexDirection = "column";
  grid.style.gap = "0";
  grid.innerHTML = backRow + `<div class="lib-folder-contents">${cardsHtml}</div>`;

  grid.querySelector("#libFolderBackBtn").addEventListener("click", () => {
    exitSelectMode(false);
    LibState.currentFolder = null;
    renderLibGrid();
  });

  grid.querySelector("#libFolderSelectBtn")?.addEventListener("click", () => {
    if(LibState.selectMode) exitSelectMode(true);
    else enterSelectMode();
  });

  grid.querySelector("#libFolderSortBtn").addEventListener("click", () => {
    openSettingsDialog(
      "Sort files by",
      [
        {value:"recent", label:"Newest first"},
        {value:"name",   label:"Name (A–Z)"},
        {value:"size",   label:"Largest first"},
        {value:"long",   label:"Longest first"},
      ],
      LibState.sortMode || "recent",
      v => {
        LibState.sortMode = v;
        try { localStorage.setItem("enkrit_sort", v); } catch(_) {}
        renderLibGrid();
      }
    );
  });

  wireGridCards(grid.querySelector(".lib-folder-contents"), files);
  if(typeof markNowPlayingCards === "function") markNowPlayingCards();
  if(typeof updateMiniPlayer === "function") updateMiniPlayer();
}

function openLibraryFile(filePath, fileName, fileObj) {
  if(!filePath) return;
  const item = makeMediaItemFromPath(filePath, fileName, fileObj);
  // BUG-03 FIX: never write private file paths into Recently Played
  if(!isPrivatePath(filePath)){
    addToRecent({ name:item.name, path:filePath, ext:fileObj?.ext || item.ext || "", size:fileObj?.size || 0, kind:item.kind, durationMs:fileObj?.durationMs || 0, playedAt:Date.now() });
  }

  let idx = S.playlist.findIndex(p => p.path === filePath);
  if(idx === -1) {
    S.playlist.push(item);
    idx = S.playlist.length - 1;
  }
  renderPlaylist();
  loadVideo(idx);
}

function requestDeleteFile(fileObj){
  if(!fileObj?.path) return;
  const ok = confirm(`Delete "${fileObj.name || "this file"}" from this device?`);
  if(!ok) return;
  S.pendingDeleteTarget = fileObj;
  if(isAndroidApp() && window.AndroidBridge?.deleteMedia) {
    try {
      window.AndroidBridge.deleteMedia(fileObj.path);
      return;
    } catch(e) {
      console.warn("Android delete failed:", e);
    }
  }
  removeMediaEverywhere(fileObj);
  showSubToast("Removed from ENKRIT. Device delete is Android-only here.", "info");
}

function handleDeleteComplete(success, uri){
  const target = S.pendingDeleteTarget || { path:uri };
  S.pendingDeleteTarget = null;
  if(!success) {
    showSubToast("Delete cancelled", "info");
    return;
  }
  removeMediaEverywhere(target);
  showSubToast("Deleted", "success");
  if(typeof scanLibrary === "function") scanLibrary();
}

function removeMediaEverywhere(target){
  const targetPath = typeof target === "string" ? target : target?.path;
  const targetKey = typeof target === "string" ? String(target).toLowerCase() : mediaListKey(target);
  const matches = item => {
    if(!item) return false;
    if(targetPath && item.path === targetPath) return true;
    return mediaListKey(item) === targetKey;
  };
  const wasCurrent = matches(currentItem());
  LibState.allFiles = LibState.allFiles.filter(item => !matches(item));
  LibState.recentFiles = LibState.recentFiles.filter(item => !matches(item));
  LibState.favorites.delete(targetKey);
  try { localStorage.setItem("enkrit_recent", JSON.stringify(LibState.recentFiles)); } catch(_){}
  try { localStorage.setItem("enkrit_favorites", JSON.stringify([...LibState.favorites])); } catch(_){}

  for(let i=S.playlist.length-1; i>=0; i--){
    if(matches(S.playlist[i])) {
      releaseItemUrl(S.playlist[i]);
      S.playlist.splice(i, 1);
      if(S.currentIndex > i) S.currentIndex--;
    }
  }
  if(wasCurrent) {
    S.currentIndex = -1; // Bug 4: zero out index before stopNativePlayback so currentItem() returns null, not a wrong item
    stopNativePlayback();
    backToLibrary();
  }
  renderPlaylist();
  renderLibGrid();
}

function addToRecent(fileObj) {
  fileObj.playedAt = fileObj.playedAt || Date.now();
  const key = mediaListKey(fileObj);
  LibState.recentFiles = LibState.recentFiles.filter(f => mediaListKey(f) !== key);
  LibState.recentFiles.unshift(fileObj);
  LibState.recentFiles = dedupeMediaList(LibState.recentFiles).slice(0, 50);
  try { localStorage.setItem("enkrit_recent", JSON.stringify(LibState.recentFiles)); } catch(_){}
}

function mediaListKey(fileObj){
  const name = String(fileObj?.name || "").replace(/\s+/g, " ").trim().toLowerCase();
  const size = Number(fileObj?.size || 0);
  if(name && size) return `${name}|${size}`;
  return String(fileObj?.path || name).toLowerCase();
}
function dedupeMediaList(list){
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter(item => {
    const key = mediaListKey(item);
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function recentMeta(fileObj, kind){
  const base = `${kind==="audio" ? "Audio" : "Video"}${fileObj.size ? " - " + fmtSize(fileObj.size) : ""}`;
  if(LibState.activeTab !== "recent" || !fileObj.playedAt) return base;
  return `${base} - ${formatRecentDate(fileObj.playedAt)}`;
}
function formatRecentDate(ts){
  const d = new Date(ts);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yStart = start - 86400000;
  if(ts >= start) return "Today";
  if(ts >= yStart) return "Yesterday";
  return d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
}
function clearRecent(mode){
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const week = today - 7 * 86400000;
  if(mode === "all") LibState.recentFiles = [];
  else if(mode === "today") LibState.recentFiles = LibState.recentFiles.filter(f => (f.playedAt || 0) < today);
  else if(mode === "yesterday") LibState.recentFiles = LibState.recentFiles.filter(f => (f.playedAt || 0) < yesterday || (f.playedAt || 0) >= today);
  else if(mode === "older") LibState.recentFiles = LibState.recentFiles.filter(f => (f.playedAt || 0) >= week);
  try { localStorage.setItem("enkrit_recent", JSON.stringify(LibState.recentFiles)); } catch(_){}
  renderLibGrid();
}

function loadThumb(filePath, idx) {
  // Create hidden video element to grab thumbnail
  const v = document.createElement("video");
  _pendingThumbs.push(v); // Bug 1: track so renderLibGrid can cancel stale decodes
  v.src = toFileUrl(filePath);
  v.muted = true;
  v.preload = "metadata";
  v.currentTime = 5;
  const cleanup = () => {
    const pos = _pendingThumbs.indexOf(v);
    if(pos !== -1) _pendingThumbs.splice(pos, 1);
    v.remove();
  };
  v.addEventListener("loadeddata", () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 180;
      canvas.getContext("2d").drawImage(v, 0, 0, 320, 180);
      const thumb = canvas.toDataURL("image/jpeg", 0.7);
      const card = document.querySelector(`.lib-card[data-idx="${idx}"] .lib-card-thumb`);
      if(card) {
        const img = document.createElement("img");
        img.src = thumb;
        img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
        card.appendChild(img);
      }
      // Duration
      const dur = $("dur-"+idx);
      if(dur && v.duration) dur.textContent = fmt(v.duration);
    } catch(_) {}
    cleanup();
  }, {once:true});
  v.addEventListener("error", cleanup, {once:true});
  document.body.appendChild(v);
}

function fmtSize(bytes) {
  if(!bytes) return "";
  if(bytes > 1e9) return (bytes/1e9).toFixed(1)+" GB";
  if(bytes > 1e6) return (bytes/1e6).toFixed(0)+" MB";
  return (bytes/1e3).toFixed(0)+" KB";
}

function escAttr(s) { return esc(s).replace(/'/g,"&#39;"); }

/* ══════════════════════════════════════════
   SETTINGS
══════════════════════════════════════════ */
function openSettings() {
  const panel = $("settingsPanel");
  if(!panel) return;
  const toggleMap = {
    sShowNomedia:"showNomedia", sShowHidden:"showHidden",
    sRememberBrightness:"rememberBrightness", sRememberBgPlay:"rememberBgPlay",
    sRememberAspect:"rememberAspectRatio", sRememberSpeed:"rememberSpeed",
    sAutoplayNext:"autoplayNext", sAutoPip:"autoPip",
    sGestureControl:"gestureControl", sShowSubtitles:"showSubtitles",
    sShowMusic:"showMusic", sShowRecentlyPlayed:"showRecentlyPlayed",
    sShowFloatingBtn:"showFloatingBtn",
  };
  Object.entries(toggleMap).forEach(([elId, key]) => {
    const el = $(elId);
    if(!el) return;
    el.checked = !!AppSettings[key];
    el.onchange = () => { AppSettings[key] = el.checked; saveSettings(); applySettings(); };
  });
  updateSettingsSubtext();
  panel.style.display = "flex";
}

function updateSettingsSubtext() {
  const resumeMap = {ask:"Ask every time", always:"Always resume", never:"Never resume"};
  const orientMap = {auto:"Auto rotate (Sensor)", portrait:"Portrait", landscape:"Landscape"};
  const rs = $("sResumeSub"); if(rs) rs.textContent = resumeMap[AppSettings.resumePlayback]||"Ask every time";
  const os = $("sOrientSub"); if(os) os.textContent = orientMap[AppSettings.defaultOrientation]||"Auto rotate (Sensor)";
  const ss = $("sSeekSub"); if(ss) ss.textContent = (AppSettings.seekSeconds||5)+"s";
  const fvMap = { grid:"Grid (2 columns)", list:"List view" };
  const fvs = $("sFolderViewSub"); if(fvs) fvs.textContent = fvMap[AppSettings.folderView||"grid"]||"Grid (2 columns)";
}

function openSettingsDialog(title, options, currentVal, onSelect) {
  const dlg = $("settingsDialog");
  if(!dlg) return;
  $("settingsDialogTitle").textContent = title;
  $("settingsDialogOpts").innerHTML = options.map(o =>
    `<div class="sdlg-opt ${String(o.value)===String(currentVal)?"active":""}" data-value="${o.value}">
      <div class="sdlg-radio"></div><span>${o.label}</span>
    </div>`
  ).join("");
  dlg.querySelectorAll(".sdlg-opt").forEach(opt => {
    opt.addEventListener("click", () => {
      const v = opt.dataset.value;
      // P7: isNaN("") is false, which would coerce empty string to 0; check explicitly
      onSelect((v !== "" && !isNaN(v)) ? Number(v) : v);
      dlg.style.display = "none";
      updateSettingsSubtext();
    });
  });
  dlg.style.display = "flex";
}

function applySettings() {
  // Seek button labels
  const sec = AppSettings.seekSeconds || 5;
  document.querySelectorAll(".seek-label").forEach(el => el.textContent = sec);
  // Gesture control
  if(vcont) vcont.classList.toggle("no-gesture", !AppSettings.gestureControl);
  // S5: show/hide subtitle button based on setting
  const subWrap = document.querySelector(".sub-wrap");
  if(subWrap) subWrap.style.display = AppSettings.showSubtitles ? "" : "none";
  // S4: restore remembered speed
  if(AppSettings.rememberSpeed) {
    try {
      const saved = parseFloat(localStorage.getItem("enkrit_speed") || "1");
      if(saved && isFinite(saved) && saved !== S.speed) setSpeed(saved);
    } catch(_){}
  }
  // S5: apply default orientation on startup
  if(isAndroidApp() && AppSettings.defaultOrientation) {
    setOrientationMode(AppSettings.defaultOrientation);
  }
  // S6: show/hide "Recent" tab based on setting
  const recentTab = document.querySelector('.lib-tab[data-tab="recent"]');
  if(recentTab) recentTab.style.display = AppSettings.showRecentlyPlayed ? "" : "none";
  // P3: restore saved brightness
  if(isAndroidApp() && AppSettings.rememberBrightness) {
    try {
      const b = parseInt(localStorage.getItem("enkrit_brightness") || "");
      if(b && b >= 5 && b <= 100) {
        S.screenBrightness = b;
        window.AndroidBridge?.setScreenBrightness?.(b);
      }
    } catch(_){}
  }
  // P3: apply background play setting
  if(isAndroidApp()) {
    try { window.AndroidBridge?.setBackgroundPlay?.(!!AppSettings.rememberBgPlay); } catch(_){}
  }
}

/* ─────────────────────────────────────────
   NOW-PLAYING CARD HIGHLIGHT
───────────────────────────────────────── */
function markNowPlayingCards() {
  // Remove previous marks
  document.querySelectorAll(".lib-card.is-playing, .lib-folder-tile.is-playing").forEach(el => el.classList.remove("is-playing"));
  const item = currentItem();
  if(!item || !item.path) return;
  // Mark matching card by path
  document.querySelectorAll(".lib-card").forEach(card => {
    if(card.dataset.path === item.path) card.classList.add("is-playing");
  });
  // Mark folder tile if we're in grouped view
  document.querySelectorAll(".lib-folder-tile").forEach(tile => {
    const folder = tile.dataset.folder;
    if(folder && item.path && item.path.includes(folder)) tile.classList.add("is-playing");
  });
}

/* ─────────────────────────────────────────
   MINI PLAYER
───────────────────────────────────────── */
let _miniDismissed = false;

function updateMiniPlayer() {
  const mp = $("miniPlayer");
  if(!mp) return;
  // Only show in library view, not in player
  const inLibrary = !!(dropZone && dropZone.style.display !== "none");
  const item = LibState.recentFiles?.[0];
  if(!inLibrary || !item || !item.path || _miniDismissed) {
    mp.style.display = "none";
    return;
  }
  mp.style.display = "flex";
  const nameEl = $("miniName");
  const statusEl = $("miniStatus");
  const shortName = (item.name || "").replace(/\.[^/.]+$/, "");
  if(nameEl) nameEl.textContent = shortName.length > 40 ? shortName.slice(0,38)+"…" : shortName;
  // Show thumbnail if available
  const thumb = $("miniThumb");
  if(thumb && item._thumbDataUrl) {
    thumb.innerHTML = `<img src="${item._thumbDataUrl}" alt="">`;
  }
  if(statusEl) statusEl.textContent = "Tap to resume";
  // Always show play icon (we're in library, not playing)
  const pip = $("miniIconPlay"), pau = $("miniIconPause");
  if(pip) pip.style.display = "block";
  if(pau) pau.style.display = "none";
}

function initMiniPlayer() {
  const mp = $("miniPlayer");
  if(!mp) return;
  // Tapping anywhere on bar (except buttons) opens the file
  mp.addEventListener("click", e => {
    if(e.target.closest(".mini-player-close") || e.target.closest(".mini-player-playbtn")) return;
    const item = LibState.recentFiles?.[0];
    if(item?.path) { _miniDismissed = false; openLibraryFile(item.path, item.name, item); }
  });
  $("miniPlayBtn")?.addEventListener("click", e => {
    e.stopPropagation();
    const item = LibState.recentFiles?.[0];
    if(item?.path) { _miniDismissed = false; openLibraryFile(item.path, item.name, item); }
  });
  $("miniClose")?.addEventListener("click", e => {
    e.stopPropagation();
    _miniDismissed = true;
    if(mp) mp.style.display = "none";
  });
}

/* ─────────────────────────────────────────
   ANDROID SORT PILLS
───────────────────────────────────────── */
function initSortPills() {
  if(!isAndroidApp()) return;
  const pills = document.querySelectorAll("#libSortPills .sort-pill");
  const sel = $("libSort");
  pills.forEach(pill => {
    pill.addEventListener("click", () => {
      pills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      if(sel) {
        sel.value = pill.dataset.sort;
        sel.dispatchEvent(new Event("change"));
      }
    });
  });
  // Keep pills in sync with select when select changes externally
  if(sel) {
    sel.addEventListener("change", () => {
      pills.forEach(p => p.classList.toggle("active", p.dataset.sort === sel.value));
    });
  }
}

/* ─────────────────────────────────────────
   TAP ZONE RIPPLE
───────────────────────────────────────── */
function triggerTapZoneRipple(side) {
  const el = side === "left" ? $("tapLeft") : $("tapRight");
  if(!el) return;
  el.classList.remove("tapping");
  void el.offsetWidth; // force reflow
  el.classList.add("tapping");
  el.addEventListener("animationend", () => el.classList.remove("tapping"), {once:true});
}

window.addEventListener("load", () => {
  $("btnSettings")?.addEventListener("click", openSettings);
  $("btnSettingsBack")?.addEventListener("click", () => { $("settingsPanel").style.display = "none"; });
  $("settingsDialogCancel")?.addEventListener("click", () => { $("settingsDialog").style.display = "none"; });

  $("sResumeItem")?.addEventListener("click", () => openSettingsDialog(
    "Resume Playback",
    [{value:"ask",label:"Ask every time"},{value:"always",label:"Always resume"},{value:"never",label:"Never resume"}],
    AppSettings.resumePlayback,
    v => { AppSettings.resumePlayback = v; saveSettings(); }
  ));
  $("sOrientItem")?.addEventListener("click", () => openSettingsDialog(
    "Default Screen Orientation",
    [{value:"auto",label:"Auto rotate (Sensor)"},{value:"portrait",label:"Portrait"},{value:"landscape",label:"Landscape"}],
    AppSettings.defaultOrientation,
    v => { AppSettings.defaultOrientation = v; saveSettings(); }
  ));
  $("sSeekItem")?.addEventListener("click", () => openSettingsDialog(
    "Fast Forward / Rewind Time",
    [{value:5,label:"5 seconds"},{value:10,label:"10 seconds"},{value:15,label:"15 seconds"},{value:30,label:"30 seconds"}],
    AppSettings.seekSeconds,
    v => { AppSettings.seekSeconds = v; saveSettings(); applySettings(); }
  ));
  $("sFolderViewItem")?.addEventListener("click", () => openSettingsDialog(
    "Folder View",
    [{value:"grid",label:"Grid (2 columns)"},{value:"list",label:"List view"}],
    AppSettings.folderView || "grid",
    v => { AppSettings.folderView = v; saveSettings(); updateSettingsSubtext(); renderLibGrid(); }
  ));
  $("btnBackToLib")?.addEventListener("click", () => {
    const backBtn = $("btnBack");
    if(backBtn && backBtn.style.display !== "none") backBtn.click();
  });
  $("btnTopSettings")?.addEventListener("click", () => {
    openSettings();
  });

  applySettings();
  initMiniPlayer();
  initSortPills();
  initSwipeDownToDismiss();
  initPullToRefresh();
  initSpeedLongPress();

  // ── Android hardware back button ──
  document.addEventListener("backbutton", function(e) {
    e.preventDefault();
    if(!window.ENKRITHandleBack()){
      try { if(window.AndroidBridge?.exitApp) window.AndroidBridge.exitApp(); } catch(_){}
    }
  }, false);
}, {once:true});

/* ═══════════════════════════════════════════════════
   SWIPE-DOWN TO DISMISS PLAYER
═══════════════════════════════════════════════════ */
function initSwipeDownToDismiss() {
  if(!isAndroidApp()) return;
  let _sdStart = null;
  const vc = $("videoContainer");
  if(!vc) return;

  vc.addEventListener("touchstart", e => {
    // Detect swipe-down from top 160px — works with notch + status bar areas
    const t = e.touches[0];
    if(t.clientY > 160) return;
    _sdStart = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, {passive: true});

  vc.addEventListener("touchmove", e => {
    if(!_sdStart) return;
    const t = e.touches[0];
    const dy = t.clientY - _sdStart.y;
    const dx = Math.abs(t.clientX - _sdStart.x);
    // Must be mostly vertical, downward
    if(dy > 40 && dx < 60) {
      const ind = $("swipeDownIndicator");
      if(ind) ind.style.display = "flex";
    } else {
      const ind = $("swipeDownIndicator");
      if(ind) ind.style.display = "none";
    }
  }, {passive: true});

  vc.addEventListener("touchend", e => {
    const ind = $("swipeDownIndicator");
    if(ind) ind.style.display = "none";
    if(!_sdStart) return;
    const t = e.changedTouches[0];
    const dy = t.clientY - _sdStart.y;
    const dx = Math.abs(t.clientX - _sdStart.x);
    const dt = Date.now() - _sdStart.time;
    _sdStart = null;
    // Swipe down > 80px, mostly vertical, within 600ms
    if(dy > 80 && dx < 80 && dt < 600) {
      const backBtn = $("btnBack");
      if(backBtn && backBtn.style.display !== "none") backBtn.click();
    }
  }, {passive: true});
}

/* ═══════════════════════════════════════════════════
   FILE INFO SHEET
═══════════════════════════════════════════════════ */
function showFileInfo(fileObj) {
  if(!fileObj) return;
  const sheet = $("fileInfoSheet");
  if(!sheet) return;

  const fmtSize = bytes => {
    if(!bytes || bytes <= 0) return "Unknown";
    if(bytes > 1073741824) return (bytes/1073741824).toFixed(2) + " GB";
    if(bytes > 1048576) return (bytes/1048576).toFixed(1) + " MB";
    return Math.round(bytes/1024) + " KB";
  };
  const fmtDur = ms => {
    if(!ms || ms <= 0) return "Unknown";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
  };

  const name = fileObj.name || "—";
  const ext  = (name.match(/\.([^.]+)$/) || [])[1]?.toUpperCase() || "—";
  const rows = [
    { label:"File Name", value: name },
    { label:"Format",    value: ext },
    { label:"Duration",  value: fmtDur(fileObj.durationMs) },
    { label:"File Size", value: fmtSize(fileObj.size) },
    { label:"Type",      value: fileObj.kind === "audio" ? "Audio" : "Video" },
    { label:"Path",      value: fileObj.path || "—" },
  ];

  const rowsEl = $("infoRows");
  if(rowsEl) rowsEl.innerHTML = rows.map(r => `
    <div class="info-row">
      <div class="info-row-body">
        <div class="info-row-label">${r.label}</div>
        <div class="info-row-value">${esc(String(r.value))}</div>
      </div>
    </div>`).join("");

  sheet.style.display = "block";
  // Use onclick — always replaces previous handler, no stale refs
  const close = () => {
    $("fileInfoSheet").style.display = "none";
    const bd = $("infoBackdrop");
    if(bd) bd.style.display = "none";
    const ic = $("infoClose");
    if(ic) ic.onclick = null;
    const bd2 = $("infoBackdrop");
    if(bd2) bd2.onclick = null;
  };
  const bd = $("infoBackdrop");
  if(bd) { bd.style.display = "block"; bd.onclick = close; }
  const ic = $("infoClose");
  if(ic) ic.onclick = close;
}

/* ═══════════════════════════════════════════════════
   CARD CONTEXT MENU
═══════════════════════════════════════════════════ */
let _ctxFile = null;

function showContextMenu(fileObj) {
  _ctxFile = fileObj;
  const menu = $("cardContextMenu");
  if(!menu) return;

  // Populate header
  const title = $("ctxTitle");
  if(title) title.textContent = (fileObj.name || "").replace(/\.[^/.]+$/, "") || "—";

  const thumb = $("ctxThumb");
  if(thumb) thumb.innerHTML = fileObj._thumbDataUrl
    ? `<img src="${fileObj._thumbDataUrl}" alt="">`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" opacity="0.6"><polygon points="5,3 19,12 5,21"/></svg>`;

  const isFav = typeof isFavorite === "function" ? isFavorite(fileObj) : false;
  const favLabel = $("ctxFavLabel");
  if(favLabel) favLabel.textContent = isFav ? "Remove from Favorites" : "Add to Favorites";

  menu.style.display = "block";
  const bd = $("ctxBackdrop");
  if(bd) bd.style.display = "block";

  // Use onclick — one handler at a time, no stale references
  const dismiss = () => {
    $("cardContextMenu").style.display = "none";
    const b = $("ctxBackdrop"); if(b) b.style.display = "none";
    _ctxFile = null;
  };

  const p = $("ctxPlay");    if(p) p.onclick = () => { dismiss(); openLibraryFile(fileObj.path, fileObj.name, fileObj); };
  const f = $("ctxFav");     if(f) f.onclick = () => { dismiss(); toggleFavorite(fileObj); }; // Bug 13: toggleFavorite already calls showSubToast internally
  const i = $("ctxInfo");    if(i) i.onclick = () => { dismiss(); showFileInfo(fileObj); };
  const d = $("ctxDelete");  if(d) d.onclick = () => { dismiss(); requestDeleteFile(fileObj); };
  const c = $("ctxCancel");  if(c) c.onclick = dismiss;
  if(bd) bd.onclick = dismiss;
}

/* ═══════════════════════════════════════════════════
   LONG-PRESS WIRING (called from wireGridCards)
═══════════════════════════════════════════════════ */
function addLongPressToCards(grid, files) {
  if(!isAndroidApp()) return;
  grid.querySelectorAll(".lib-card").forEach(card => {
    let _lpt = null;
    let _suppressClick = false;

    card.addEventListener("touchstart", e => {
      _suppressClick = false;
      const idx = parseInt(card.dataset.idx);
      const f = files[idx];
      if(!f) return;
      _lpt = setTimeout(() => {
        _lpt = null;
        _suppressClick = true; // prevent the click that fires after touchend
        try { if(navigator.vibrate) navigator.vibrate(40); } catch(_) {}
        showContextMenu(f);
      }, 480);
    }, {passive: true});

    card.addEventListener("touchend", () => { clearTimeout(_lpt); _lpt = null; }, {passive: true});
    card.addEventListener("touchmove", () => { clearTimeout(_lpt); _lpt = null; }, {passive: true});

    // Intercept click — skip if long-press already consumed this touch
    card.addEventListener("click", e => {
      if(_suppressClick) { _suppressClick = false; e.stopImmediatePropagation(); }
    }, true); // capture phase so it runs before the existing click listener
  });
}

/* ═══════════════════════════════════════════════════
   PULL TO REFRESH
═══════════════════════════════════════════════════ */
function initPullToRefresh() {
  if(!isAndroidApp()) return;
  // #libGrid is the actual scrolling container; .library-wrap is overflow:hidden
  const libScroll = $("libGrid");
  if(!libScroll) return;
  const ind = $("ptrIndicator");
  let _ptrStart = null, _ptrActive = false;

  libScroll.addEventListener("touchstart", e => {
    if(libScroll.scrollTop > 0) return;
    const t = e.touches[0];
    _ptrStart = { y: t.clientY, time: Date.now() };
    _ptrActive = false;
  }, {passive: true});

  libScroll.addEventListener("touchmove", e => {
    if(!_ptrStart) return;
    const t = e.touches[0];
    const dy = t.clientY - _ptrStart.y;
    if(dy > 20 && libScroll.scrollTop <= 0) {
      if(ind) {
        ind.classList.add(dy > 60 ? "ptr-releasing" : "ptr-pulling");
        ind.classList.remove(dy > 60 ? "ptr-pulling" : "ptr-releasing");
        const label = ind.querySelector(".ptr-label");
        if(label) label.textContent = dy > 60 ? "Release to refresh" : "Pull to refresh";
      }
      _ptrActive = dy > 60;
    }
  }, {passive: true});

  libScroll.addEventListener("touchend", () => {
    if(ind) { ind.classList.remove("ptr-pulling", "ptr-releasing"); }
    if(_ptrActive) {
      _ptrActive = false;
      _ptrStart = null;
      showSubToast("Refreshing library…", "info");
      if(typeof scanLibrary === "function") scanLibrary();
      return;
    }
    _ptrStart = null;
  }, {passive: true});
}

/* ═══════════════════════════════════════════════════
   SMOOTH LIBRARY ↔ PLAYER TRANSITIONS
═══════════════════════════════════════════════════ */
function transitionToPlayer(cb) {
  if(!isAndroidApp()) { cb?.(); return; }
  document.body.classList.add("transitioning-to-player");
  setTimeout(() => {
    document.body.classList.remove("transitioning-to-player");
    cb?.();
  }, 180);
}

function transitionToLibrary(cb) {
  if(!isAndroidApp()) { cb?.(); return; }
  document.body.classList.add("transitioning-to-library");
  setTimeout(() => {
    document.body.classList.remove("transitioning-to-library");
    cb?.();
  }, 180);
}

/* ═══════════════════════════════════════════════════
   ONBOARDING HINT
═══════════════════════════════════════════════════ */
function maybeShowOnboarding() {
  if(!isAndroidApp()) return;
  const seen = localStorage.getItem("enkrit_onboarded");
  if(seen) return;
  // Only show if library is empty
  setTimeout(() => {
    const files = LibState.allFiles || [];
    if(files.length > 0) { localStorage.setItem("enkrit_onboarded","1"); return; }
    let hint = $("onboardHint");
    if(!hint) {
      hint = document.createElement("div");
      hint.id = "onboardHint";
      hint.className = "onboard-hint";
      hint.innerHTML = `<div class="onboard-hint-text">Tap here to scan media</div><div class="onboard-hint-arrow">↑</div>`;
      const libTools = document.querySelector(".lib-tools");
      if(libTools) libTools.style.position = "relative";
      document.querySelector(".lib-tools")?.appendChild(hint);
    }
    hint.classList.add("show");
    // Hide on any scan action
    const hide = () => { hint.classList.remove("show"); localStorage.setItem("enkrit_onboarded","1"); };
    $("btnScanLib")?.addEventListener("click", hide, {once:true});
    $("btnPickFile")?.addEventListener("click", hide, {once:true});
  }, 800);
}

/* ═══════════════════════════════════════════════════
   SPEED LONG-PRESS → QUICK SPEED PICKER
═══════════════════════════════════════════════════ */
function initSpeedLongPress() {
  const btn = $("btnSpeed");
  if(!btn) return;
  let _slt = null;

  btn.addEventListener("touchstart", e => {
    btn.classList.add("long-pressing");
    _slt = setTimeout(() => {
      _slt = null;
      try { if(navigator.vibrate) navigator.vibrate(30); } catch(_) {}
      // Show a quick speed picker inline
      showQuickSpeedPicker();
    }, 600);
  }, {passive: true});

  btn.addEventListener("touchend", () => {
    btn.classList.remove("long-pressing");
    clearTimeout(_slt); _slt = null;
  }, {passive: true});
  btn.addEventListener("touchmove", () => {
    btn.classList.remove("long-pressing");
    clearTimeout(_slt); _slt = null;
  }, {passive: true});
}

function showQuickSpeedPicker() {
  // Remove existing if any
  let existing = $("quickSpeedPicker");
  if(existing) { existing.remove(); return; }

  const speeds = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
  const videoEl = $("videoEl");
  const current = (videoEl && videoEl.playbackRate) ? videoEl.playbackRate : (S.speed || 1.0);

  const picker = document.createElement("div");
  picker.id = "quickSpeedPicker";
  picker.style.cssText = `
    position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
    z-index:180; background:var(--bg2); border:1px solid var(--border2);
    border-radius:16px; padding:8px; display:flex; gap:6px; flex-wrap:wrap;
    justify-content:center; max-width:320px; box-shadow:0 8px 32px rgba(0,0,0,0.5);
    animation:sheetUp 0.2s cubic-bezier(0.34,1.56,0.64,1);
  `;

  speeds.forEach(sp => {
    const btn = document.createElement("button");
    btn.style.cssText = `
      padding:8px 12px; border-radius:10px; border:1px solid var(--border2);
      background:${Math.abs(sp - current) < 0.01 ? "var(--accent)" : "var(--bg3)"};
      color:${Math.abs(sp - current) < 0.01 ? "#fff" : "var(--text1)"};
      font-size:13px; font-weight:600; cursor:pointer; min-width:52px;
    `;
    btn.textContent = sp === 1.0 ? "1×" : sp + "×";
    btn.addEventListener("click", () => {
      S.speed = sp;
      video.playbackRate = sp;
      if(isAndroidApp() && window.AndroidBridge?.setSpeed) window.AndroidBridge.setSpeed(sp);
      // Update speed panel active item
      document.querySelectorAll(".speed-item").forEach(el => el.classList.toggle("active", parseFloat(el.dataset.speed) === sp));
      const speedLabel = $("btnSpeed")?.querySelector(".speed-label") || $("btnSpeed");
      if(speedLabel && speedLabel.textContent !== undefined) speedLabel.textContent = sp === 1.0 ? "1×" : sp + "×";
      picker.remove();
      showSubToast(`Speed: ${sp}×`, "info");
    });
    picker.appendChild(btn);
  });

  // Close label
  const closeBtn = document.createElement("div");
  closeBtn.style.cssText = "width:100%;text-align:center;padding:6px 0 2px;font-size:12px;color:var(--text3);cursor:pointer;";
  closeBtn.textContent = "tap outside to close";
  picker.appendChild(closeBtn);

  document.body.appendChild(picker);

  // Click outside to close
  setTimeout(() => {
    document.addEventListener("click", function close(e) {
      if(!picker.contains(e.target)) { picker.remove(); document.removeEventListener("click", close); }
    });
  }, 100);
}

/* ════════════════════════════════
   MX MORE SHEET + LOCK ROW BUTTON
════════════════════════════════ */
(function(){
  const sheet=$("moreSheet");
  if(!sheet) return;
  $("btnMore")?.addEventListener("click",e=>{
    e.stopPropagation();
    sheet.classList.toggle("open");
    $("speedPanel")?.classList.remove("open");
    try{ setSubMenuOpen(false); }catch(_){}
    $("decoderPanel")?.classList.remove("open");
    if(sheet.classList.contains("open")){ showControls(); clearTimeout(S.controlsTimer); }
    else resetHide();
  });
  $("moreClose")?.addEventListener("click",e=>{
    e.stopPropagation();
    sheet.classList.remove("open");
    resetHide();
  });
  sheet.addEventListener("click",e=>{
    e.stopPropagation();
    const item=e.target.closest(".more-item");
    if(!item) return;
    if(e.target.closest(".resize-panel,.orient-panel")) return; // option taps handled by their own listeners
    const btn=item.querySelector(".ctrl-btn");
    if(btn && e.target!==btn && !btn.contains(e.target)) btn.click();
  });
  sheet.addEventListener("touchstart",e=>{ e.stopPropagation(); },{passive:true});
  $("btnLockRow")?.addEventListener("click",e=>{
    e.stopPropagation();
    sheet.classList.remove("open");
    $("btnLock")?.click();
  });
})();

/* ════════════════════════════════════════════════════════
   LIBRARY TOOLS — search ranking, storage stats, duplicate
   finder, batch delete, embedded subtitle tracks
════════════════════════════════════════════════════════ */

/* ── Better search ── */
function searchMediaFiles(list, query){
  const tokens = String(query||"").toLowerCase().split(/\s+/).filter(Boolean);
  if(!tokens.length) return list.slice();
  const scored = [];
  for(const f of list){
    const name = (f.name||"").toLowerCase();
    const folder = (f.folder||"").toLowerCase();
    let total = 0, ok = true;
    for(const t of tokens){
      let s = 0;
      if(name.startsWith(t)) s = 100;
      else if(new RegExp("(^|[\\s._\\-\\[\\(])" + t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).test(name)) s = 60;
      else if(name.includes(t)) s = 30;
      else if(folder.includes(t)) s = 10;
      if(!s){ ok = false; break; }
      total += s;
    }
    if(ok) scored.push([total, f]);
  }
  scored.sort((a,b)=>b[0]-a[0]);
  return scored.map(x=>x[1]);
}

/* ── Storage stats ── */
function computeStorageStats(files){
  let total=0, videos=0, audios=0;
  for(const f of files){
    total += f.size||0;
    if(isAudioExt(f.name)) audios++; else videos++;
  }
  return { count:files.length, total, videos, audios };
}

function ensureToolsPanel(){
  let p = $("toolsPanel");
  if(p) return p;
  p = document.createElement("div");
  p.id = "toolsPanel";
  p.className = "tools-panel";
  document.body.appendChild(p);
  return p;
}
function closeToolsPanel(){
  $("toolsPanel")?.classList.remove("open");
  // BUG-02 FIX: if vault is open, delegate full cleanup to lockVault() instead of
  // silently clearing state — previously ANY panel close (URL dialog, storage panel)
  // would wipe S.vaultOpen without a proper lock. lockVault() will call closeToolsPanel
  // again but the panel is already closed so it's a harmless no-op.
  if(typeof lockVault === "function" && typeof S !== "undefined" && S.vaultOpen){
    lockVault();
  } else {
    if(typeof _vaultIdleTimer !== "undefined" && _vaultIdleTimer){ clearTimeout(_vaultIdleTimer); _vaultIdleTimer = null; }
    if(typeof setSecureScreen === "function") setSecureScreen(false);
  }
}

function openStoragePanel(){
  const files = LibState.allFiles || [];
  const st = computeStorageStats(files);
  // per-folder sizes
  const map = new Map();
  for(const f of files){
    const label = (f.folder && f.folder.trim()) ? f.folder : "Other";
    const e = map.get(label) || { size:0, count:0 };
    e.size += f.size||0; e.count++;
    map.set(label, e);
  }
  const rows = [...map.entries()].sort((a,b)=>b[1].size-a[1].size);
  const max = rows.length ? rows[0][1].size : 1;
  const dupCount = findDuplicateGroups(files).length;

  const p = ensureToolsPanel();
  p.innerHTML = `
    <div class="tools-head">
      <button class="tools-back" id="toolsBack"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></button>
      <span class="tools-title">Storage</span>
    </div>
    <div class="tools-body">
      <div class="tools-total">
        <div class="tt-size">${fmtSize(st.total) || "0 KB"}</div>
        <div class="tt-sub">${st.count} files · ${st.videos} video · ${st.audios} audio</div>
      </div>
      <button class="tools-action" id="toolsDupBtn">
        <span>Find duplicates</span>
        <span class="ta-badge">${dupCount ? dupCount + " group" + (dupCount>1?"s":"") : "scan"}</span>
      </button>
      <div class="tools-sec-label">Folders</div>
      ${rows.map(([label,e])=>`
        <div class="tools-folder-row">
          <div class="tfr-top"><span class="tfr-name">${escHtml(label)}</span><span class="tfr-size">${fmtSize(e.size) || "0 KB"}</span></div>
          <div class="tfr-bar"><span style="width:${Math.max(2, Math.round(e.size/max*100))}%"></span></div>
          <div class="tfr-sub">${e.count} ${e.count===1?"file":"files"}</div>
        </div>`).join("")}
    </div>`;
  p.classList.add("open");
  p.querySelector("#toolsBack").addEventListener("click", closeToolsPanel);
  p.querySelector("#toolsDupBtn").addEventListener("click", openDuplicatesPanel);
}

/* ── Duplicate finder ── */
function findDuplicateGroups(files){
  const map = new Map();
  for(const f of files){
    if(!f.size) continue;
    const key = f.size + "|" + (f.ext || "").toLowerCase();
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return [...map.values()].filter(g => g.length > 1);
}

function openDuplicatesPanel(){
  const groups = findDuplicateGroups(LibState.allFiles || []);
  const p = ensureToolsPanel();
  const wasted = groups.reduce((s,g)=>s+(g[0].size||0)*(g.length-1),0);
  p.innerHTML = `
    <div class="tools-head">
      <button class="tools-back" id="toolsBack2"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></button>
      <span class="tools-title">Duplicates</span>
    </div>
    <div class="tools-body">
      ${groups.length === 0 ? `<div class="tools-empty">No duplicate files found 🎉</div>` : `
      <div class="tt-sub" style="margin-bottom:10px">${groups.length} group${groups.length>1?"s":""} · ~${fmtSize(wasted)} reclaimable. First copy in each group stays unchecked.</div>
      ${groups.map((g,gi)=>`
        <div class="dup-group">
          <div class="dup-group-head">${fmtSize(g[0].size)} · ${g.length} copies</div>
          ${g.map((f,fi)=>`
            <label class="dup-row">
              <input type="checkbox" data-dup="${gi}:${fi}" ${fi>0?"checked":""}>
              <span class="dup-name">${escHtml(f.name)}</span>
              <span class="dup-folder">${escHtml(f.folder||"")}</span>
            </label>`).join("")}
        </div>`).join("")}
      <button class="tools-action tools-danger" id="dupDeleteBtn">Delete selected</button>`}
    </div>`;
  p.classList.add("open");
  p.querySelector("#toolsBack2").addEventListener("click", openStoragePanel);
  p.querySelector("#dupDeleteBtn")?.addEventListener("click", () => {
    const sel = [];
    p.querySelectorAll("input[data-dup]:checked").forEach(cb => {
      const [gi,fi] = cb.dataset.dup.split(":").map(Number);
      const f = groups[gi]?.[fi];
      if(f) sel.push(f);
    });
    if(!sel.length){ showSubToast("Nothing selected","info"); return; }
    if(!confirm(`Delete ${sel.length} file${sel.length>1?"s":""} from this device?`)) return;
    batchDeleteFiles(sel, () => openDuplicatesPanel());
  });
}

/* ── Batch delete / multi-select ── */
LibState.selectMode = false;
LibState.selected = new Map(); // path -> fileObj

function enterSelectMode(){
  LibState.selectMode = true;
  LibState.selected = new Map();
  document.body.classList.add("lib-select-mode");
  renderLibGrid();
  updateBatchBar();
}
function exitSelectMode(rerender){
  LibState.selectMode = false;
  LibState.selected = new Map();
  document.body.classList.remove("lib-select-mode");
  $("batchBar")?.remove();
  if(rerender) renderLibGrid();
}
function toggleCardSelection(card, fileObj){
  if(!fileObj?.path) return;
  if(LibState.selected.has(fileObj.path)){ LibState.selected.delete(fileObj.path); card.classList.remove("selected"); }
  else { LibState.selected.set(fileObj.path, fileObj); card.classList.add("selected"); }
  updateBatchBar();
}
function updateBatchBar(){
  let bar = $("batchBar");
  if(!LibState.selectMode){ bar?.remove(); return; }
  if(!bar){
    bar = document.createElement("div");
    bar.id = "batchBar";
    bar.className = "batch-bar";
    document.body.appendChild(bar);
  }
  const n = LibState.selected.size;
  bar.innerHTML = `
    <span class="bb-count">${n} selected</span>
    <button class="bb-btn" id="bbCancel">Cancel</button>
    <button class="bb-btn bb-danger" id="bbDelete" ${n?"":"disabled"}>Delete${n?` (${n})`:""}</button>`;
  bar.querySelector("#bbCancel").addEventListener("click", () => exitSelectMode(true));
  bar.querySelector("#bbDelete").addEventListener("click", () => {
    const sel = [...LibState.selected.values()];
    if(!sel.length) return;
    if(!confirm(`Delete ${sel.length} file${sel.length>1?"s":""} from this device?`)) return;
    batchDeleteFiles(sel, () => exitSelectMode(true));
  });
}

let _batchTargets = null, _batchDone = null;
function batchDeleteFiles(fileObjs, done){
  const targets = (fileObjs||[]).filter(f=>f && f.path);
  if(!targets.length) return;
  if(isAndroidApp() && window.AndroidBridge?.deleteMediaBatch){
    _batchTargets = targets;
    _batchDone = done || null;
    try {
      window.AndroidBridge.deleteMediaBatch(JSON.stringify(targets.map(f=>f.path)));
      return;
    } catch(e){ _batchTargets = null; _batchDone = null; }
  }
  // Desktop / fallback: remove from ENKRIT only
  targets.forEach(f => removeMediaEverywhere(f));
  showSubToast(`Removed ${targets.length} item${targets.length>1?"s":""} from ENKRIT`, "info");
  renderLibGrid();
  if(done) done();
}
function handleBatchDeleteComplete(success, deletedUris){
  const targets = _batchTargets || [];
  const done = _batchDone;
  _batchTargets = null; _batchDone = null;
  if(!success){ showSubToast("Delete cancelled","info"); if(done) done(); return; }
  const set = new Set(deletedUris && deletedUris.length ? deletedUris : targets.map(f=>f.path));
  let n = 0;
  targets.forEach(f => { if(set.has(f.path)){ removeMediaEverywhere(f); n++; } });
  showSubToast(`Deleted ${n} file${n!==1?"s":""} ✓`);
  renderLibGrid();
  if(done) done();
}

/* ── Embedded subtitle tracks (language selection) ── */
const LANG_NAMES = {en:"English",hi:"Hindi",ta:"Tamil",te:"Telugu",ml:"Malayalam",kn:"Kannada",bn:"Bengali",mr:"Marathi",pa:"Punjabi",gu:"Gujarati",ur:"Urdu",ja:"Japanese",ko:"Korean",zh:"Chinese",fr:"French",de:"German",es:"Spanish",pt:"Portuguese",ru:"Russian",ar:"Arabic",it:"Italian",tr:"Turkish",th:"Thai",vi:"Vietnamese",id:"Indonesian",fa:"Persian",nl:"Dutch",pl:"Polish",sv:"Swedish",uk:"Ukrainian"};
function langDisplay(t){
  const code = (t.lang||"").split(/[-_]/)[0].toLowerCase();
  return t.label || LANG_NAMES[code] || (t.lang ? t.lang.toUpperCase() : "Track " + (t.index+1));
}

function refreshSubtitleTracks(){
  const wrap = $("subTracks");
  if(!wrap) return;
  if(isAndroidApp() && S.nativePlayback && window.AndroidBridge?.requestSubtitleTracks){
    try { window.AndroidBridge.requestSubtitleTracks(); } catch(_){ wrap.innerHTML=""; }
    return;
  }
  // HTML5 text tracks (desktop / iOS)
  const tt = video.textTracks || [];
  const tracks = [];
  for(let i=0;i<tt.length;i++){
    const t = tt[i];
    if(t.kind === "subtitles" || t.kind === "captions"){
      tracks.push({ index:i, lang:t.language||"", label:t.label||"", selected:t.mode!=="disabled" });
    }
  }
  renderSubTrackButtons(tracks, "html");
}

function renderSubTrackButtons(tracks, source){
  const wrap = $("subTracks");
  if(!wrap) return;
  if(!tracks || !tracks.length){ wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<div class="sub-tracks-label">Language</div>` + tracks.map(t =>
    `<button class="sub-opt sub-track-opt ${S.subtitleMode==="track" && S.subTrackIndex===t.index ? "active":""}" data-track="${t.index}">
      <span class="sub-opt-icon">CC</span><span>${escHtml(langDisplay(t))}</span>
    </button>`).join("");
  wrap.querySelectorAll(".sub-track-opt").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.track);
      selectSubtitleTrack(idx, source);
      setSubMenuOpen(false);
    });
  });
}

function selectSubtitleTrack(index, source){
  S.subTrackIndex = index;
  if(source === "native"){
    try { window.AndroidBridge?.setSubtitleTrack?.(index); } catch(_){}
  } else {
    const tt = video.textTracks || [];
    for(let i=0;i<tt.length;i++){
      const t = tt[i];
      if(i === index){
        t.mode = "hidden";
        t.oncuechange = () => {
          if(S.subtitleMode !== "track") return;
          const txt = [...(t.activeCues||[])].map(c=>c.text).join("\n");
          const el = $("subtitleDisplay");
          if(el) el.textContent = txt;
        };
      } else {
        t.mode = "disabled"; t.oncuechange = null;
      }
    }
  }
  setSubMode("track");
  showSubToast("Subtitles: " + langDisplay({index, lang:"", label:""}), "info");
}

/* ════════════════════════════════════════════════════════
   POWER FEATURES — A-B repeat, audio boost, audio tracks,
   private folder (PIN), open network URL
════════════════════════════════════════════════════════ */

/* ── helpers ── */
function curPlaybackSec(){
  return S.nativePlayback ? (S.nativePosition||0)/1000 : (video.currentTime||0);
}
function seekAbsSec(sec){
  if(S.nativePlayback && window.AndroidBridge?.nativeSeekTo){
    const ms = Math.max(0, Math.round(sec*1000));
    S.nativePosition = ms;
    try { window.AndroidBridge.nativeSeekTo(ms); } catch(_){}
  } else {
    try { video.currentTime = Math.max(0, sec); } catch(_){}
  }
}

/* ── A-B Repeat ── */
S.abA = null; S.abB = null;
function updateABLabel(){
  const el = $("abLabel");
  const btn = $("btnABRepeat");
  if(!el) return;
  if(S.abA == null){ el.textContent = "A-B"; btn?.classList.remove("active"); }
  else if(S.abB == null){ el.textContent = "A ✓"; btn?.classList.add("active"); }
  else { el.textContent = "A-B ON"; btn?.classList.add("active"); }
}
$("btnABRepeat")?.addEventListener("click", e => {
  e.stopPropagation();
  if(S.currentIndex < 0){ showSubToast("Play a video first","info"); return; }
  if(S.abA == null){
    S.abA = curPlaybackSec();
    showSubToast("A set at " + fmt(S.abA) + " — tap again to set B");
  } else if(S.abB == null){
    const t = curPlaybackSec();
    if(t <= S.abA + 0.5){ showSubToast("B must be after A","error"); return; }
    S.abB = t;
    showSubToast("A-B loop ON: " + fmt(S.abA) + " → " + fmt(S.abB));
  } else {
    S.abA = S.abB = null;
    showSubToast("A-B loop off","info");
  }
  updateABLabel();
});
setInterval(() => {
  if(S.abB == null || S.abA == null || S.currentIndex < 0) return;
  if(curPlaybackSec() >= S.abB) seekAbsSec(S.abA);
}, 250);
// clear loop on track change
(function(){
  const _origLoad = loadVideo;
  loadVideo = async function(idx){ S.abA = S.abB = null; updateABLabel(); return _origLoad(idx); };
})();

/* ── Audio boost (LoudnessEnhancer on Android, SW gain on desktop) ── */
S.audioBoost = 100;
$("btnBoost")?.addEventListener("click", e => {
  e.stopPropagation();
  openSettingsDialog("Volume boost",
    [ {value:"100", label:"Normal (100%)"},
      {value:"150", label:"150%"},
      {value:"200", label:"200%"},
      {value:"300", label:"300%"},
      {value:"500", label:"500% (max)"} ],
    String(S.audioBoost || 100),
    v => {
      const pct = parseInt(v) || 100;
      S.audioBoost = pct;
      const bl = $("boostLabel");
      if(bl) bl.textContent = pct > 100 ? pct + "%" : "Boost";
      $("btnBoost")?.classList.toggle("active", pct > 100);
      if(isAndroidApp() && S.nativePlayback && window.AndroidBridge?.setAudioBoost){
        try { window.AndroidBridge.setAudioBoost(pct); } catch(_){}
        showSubToast("Audio boost: " + pct + "%");
      } else if(!isAndroidApp()){
        // Desktop: drive the existing volume pipeline (SW decoder supports up to 500%)
        const slider = $("volumeSlider");
        if(slider){ slider.value = pct; slider.dispatchEvent(new Event("input")); }
        showSubToast("Volume: " + pct + "%" + (pct > 100 ? " (switch to SW decoder if it caps)" : ""));
      } else {
        showSubToast(pct > 100 ? "Boost beyond 100% not supported on iOS" : "Volume normal", "info");
      }
    });
});

/* ── Audio track switching (dual audio) ── */
$("btnAudioTrack")?.addEventListener("click", e => {
  e.stopPropagation();
  if(S.currentIndex < 0){ showSubToast("Play a video first","info"); return; }
  if(isAndroidApp() && S.nativePlayback && window.AndroidBridge?.requestAudioTracks){
    try { window.AndroidBridge.requestAudioTracks(); } catch(_){}
    return;
  }
  // HTML5 audioTracks (Safari/iOS; limited elsewhere)
  const at = video.audioTracks;
  if(at && at.length > 1){
    const tracks = [];
    for(let i=0;i<at.length;i++) tracks.push({index:i, lang:at[i].language||"", label:at[i].label||"", selected:at[i].enabled});
    showAudioTrackDialog(tracks, "html");
  } else {
    showSubToast("Only one audio track in this video","info");
  }
});
function showAudioTrackDialog(tracks, source){
  if(!tracks || tracks.length === 0){ showSubToast("No switchable audio tracks","info"); return; }
  if(tracks.length === 1){ showSubToast("Only one audio track in this video","info"); return; }
  const current = tracks.find(t=>t.selected);
  openSettingsDialog("Audio track",
    tracks.map(t => ({ value:String(t.index), label:langDisplay(t) })),
    current ? String(current.index) : String(tracks[0].index),
    v => {
      const idx = parseInt(v);
      if(source === "native"){
        try { window.AndroidBridge?.setAudioTrack?.(idx); } catch(_){}
      } else {
        const at = video.audioTracks;
        for(let i=0;i<at.length;i++) at[i].enabled = (i === idx);
      }
      const chosen = tracks.find(t=>t.index===idx);
      showSubToast("Audio: " + (chosen ? langDisplay(chosen) : "switched"));
    });
}

/* ════════════════════════════════════════════════════════
   PRIVATE FOLDER — PIN/Password + optional biometric, with
   its own home screen, Add-files, and Settings page.
   Store: { method:"pin"|"pass", pin, pass, bio:bool, items:[] }
════════════════════════════════════════════════════════ */
const PRIVATE_SCHEMA = 2;
/* One-time cleanup: wipe any pre-v2 (leftover/test) private state so the user
   always gets a proper first-time "Create PIN" setup. */
(function(){
  try {
    const raw = localStorage.getItem("enkrit_private");
    if(raw){ const o = JSON.parse(raw); if(o.v !== PRIVATE_SCHEMA) localStorage.removeItem("enkrit_private"); }
  } catch(_){ try { localStorage.removeItem("enkrit_private"); } catch(__){} }
})();
function privateStore(){
  try { return JSON.parse(localStorage.getItem("enkrit_private") || "{}"); } catch(_){ return {}; }
}
function savePrivateStore(st){
  try { st.v = PRIVATE_SCHEMA; localStorage.setItem("enkrit_private", JSON.stringify(st)); } catch(_){}
}
function pinHash(pin){
  let h = 5381; const s = "enkrit:" + pin;
  for(let i=0;i<s.length;i++) h = ((h<<5)+h+s.charCodeAt(i))|0;
  return String(h);
}
// BUG-12 FIX: Stronger hash — salted + 2000 rounds (legacy pinHash was unsalted 1-round djb2)
function pinHashV2(pin, salt){
  let h = 5381;
  const s = "enkrit:v2:" + (salt||"") + ":" + pin;
  for(let r = 0; r < 2000; r++){
    let rh = 5381; const rs = String(h) + s + String(r);
    for(let i = 0; i < rs.length; i++) rh = ((rh<<5)+rh+rs.charCodeAt(i))|0;
    h = rh;
  }
  return "v2:" + (h>>>0).toString(36);
}
function generateSalt(){
  try { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, b=>b.toString(36)).join(""); }
  catch(_){ return Date.now().toString(36) + Math.random().toString(36).slice(2); }
}
// Use V2 when store has a salt, fall back to legacy V1 for existing stores
function computeHash(val, st){ return (st && st.salt) ? pinHashV2(val, st.salt) : pinHash(val); }
function privatePaths(){
  return new Set((privateStore().items||[]).map(f=>f.path));
}
function isPrivatePath(p){ return privatePaths().has(p); }
function isPrivateSetup(){ const st = privateStore(); return !!(st.pin || st.pass); }
function biometricAvailable(){
  return (isAndroidApp() && !!window.AndroidBridge?.requestBiometric) || !!window.electronAPI?.requestBiometric;
}
function triggerBiometric(reason, cb){
  // Desktop (Electron): promise-based TouchID (Windows returns false → PIN fallback)
  if(window.electronAPI?.requestBiometric){
    window.electronAPI.requestBiometric(reason).then(ok => cb(!!ok)).catch(() => cb(false));
    return;
  }
  // Android / iOS: bridge + onBiometric callback
  if(window.AndroidBridge?.requestBiometric){
    // BUG-06 FIX: cancel any previous pending request before registering new one
    const prevCb = window.__privateAuthCb;
    if(prevCb){ window.__privateAuthCb = null; try { prevCb(false); } catch(_){} }
    window.__privateAuthCb = cb;
    try { window.AndroidBridge.requestBiometric(reason); } catch(_){ window.__privateAuthCb = null; cb(false); }
    return;
  }
  cb(false);
}

function addToPrivate(fileObjs){
  const objs = (Array.isArray(fileObjs) ? fileObjs : []).filter(f => f && f.path);
  if(!objs.length) return 0;
  // Android: physically MOVE the files into app-private storage so they vanish
  // from the Gallery and from ENKRIT's own scan (true private, not just hidden).
  if(isAndroidApp() && window.AndroidBridge?.moveToPrivate){
    showSubToast("Moving to Private…", "loading");
    try { window.AndroidBridge.moveToPrivate(JSON.stringify(objs.map(f => ({path:f.path, name:f.name, kind:f.kind})))); }
    catch(_){ showSubToast("Could not move files", "error"); }
    return objs.length;   // committed asynchronously in onMovedToPrivate
  }
  // Desktop/iOS fallback: hide from ENKRIT's list only.
  const st = privateStore();
  st.items = st.items || [];
  const have = new Set(st.items.map(f=>f.path));
  let n = 0;
  for(const f of objs){
    if(!have.has(f.path)){
      st.items.push({name:f.name, path:f.path, size:f.size||0, folder:f.folder||"", ext:f.ext||"", kind:f.kind||""});
      have.add(f.path); n++;
    }
  }
  savePrivateStore(st);
  // BUG-04 FIX: renderLibGrid wrapper now handles filtering without mutating allFiles
  showSubToast(n + " file" + (n!==1?"s":"") + " moved to Private");
  renderLibGrid();
  return n;
}

function privateFileObjsFromItems(items){
  return (Array.isArray(items) ? items : [])
    .filter(x=>x && x.path)
    .map(x=>({name:x.name, path:x.path, size:x.size||0, folder:x.folder||"", ext:x.ext||"", kind:x.kind||""}));
}

/* ── Entry point (called by the secret long-press) ── */
function unlockPrivate(){
  setSecureScreen(true);   // protect even the authentication screen
  if(!isPrivateSetup()){ runPrivateSetup(); return; }
  authPrivate(renderPrivateHome);
}

/* ── First-time setup: ONE simple screen — just create a PIN.
   Password & fingerprint are optional, set later in Private Settings. ── */
function runPrivateSetup(onDone){
  promptSecret("Create a 4-digit PIN for Private", "pin", val => {
    const st = privateStore();
    if(!st.salt) st.salt = generateSalt(); // BUG-12 FIX: salt for stronger hash
    st.method = "pin";
    st.pin = pinHashV2(val, st.salt);      // BUG-12 FIX: use V2 hash
    delete st.pass;
    st.items = st.items || [];
    savePrivateStore(st);
    showSubToast("Private folder created");
    if(typeof onDone === "function") onDone(); else renderPrivateHome();
  });
}

/* ── Auth before opening ── */
function authPrivate(onOk){
  const st = privateStore();
  if(st.bio && biometricAvailable()){
    triggerBiometric("Unlock Private folder", ok => { if(ok) onOk(); else promptSecretUnlock(onOk); });
  } else {
    promptSecretUnlock(onOk);
  }
}
function promptSecretUnlock(onOk){
  const initSt = privateStore();
  const mode = initSt.method || (initSt.pass ? "pass" : "pin");
  promptSecret(mode === "pass" ? "Enter Password" : "Enter PIN", mode, (val, fail) => {
    const st = privateStore(); // BUG-05 FIX: fresh read on every attempt (not stale closure)
    const h = computeHash(val, st); // BUG-12 FIX: use stronger hash with salt
    if(h === st.pin || h === st.pass){ onOk(); return; }
    // Decoy: a different "fake" PIN opens a harmless dummy vault.
    if(st.decoyPin && h === st.decoyPin){ renderDecoyHome(); return; }
    // Wrong PIN → silently capture an intruder selfie + timestamp, show inline.
    captureIntruder();
    if(fail) fail("Incorrect — try again"); else showSubToast("Incorrect — try again", "error");
  });
  // "Forgot?" escape so the user is never permanently locked out.
  const body = document.querySelector("#toolsPanel .tools-body");
  if(body && !body.querySelector("#secForgot")){
    const link = document.createElement("a");
    link.id = "secForgot";
    link.className = "prv-act";
    link.style.cssText = "display:block;margin-top:22px;text-align:center;font-size:12px";
    link.textContent = "Forgot? Reset Private folder";
    link.addEventListener("click", () => {
      if(!confirm("Reset the Private folder? All locked files return to your library and the PIN/Password is removed.")) return;
      const s2 = privateStore();
      if(Array.isArray(LibState.allFiles)) (s2.items||[]).forEach(f => { if(!LibState.allFiles.some(x=>x.path===f.path)) LibState.allFiles.push(f); });
      localStorage.removeItem("enkrit_private");
      showSubToast("Private folder reset — long-press again to set it up fresh");
      closeToolsPanel();
      renderLibGrid();
    });
    body.appendChild(link);
  }
}

/* PIN = numeric (min 4); Password = any (min 4) */
function promptSecret(title, mode, cb){
  const p = ensureToolsPanel();
  // For PIN use a text field with CSS masking + autocomplete off, so the OS
  // never autofills a strong password (which fails the numeric check).
  const inputHtml = mode === "pin"
    ? `<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" id="secInput" class="pin-input pin-masked" placeholder="••••">`
    : `<input type="password" maxlength="32" autocomplete="new-password" id="secInput" class="pin-input" placeholder="Password" style="letter-spacing:2px;font-size:16px;width:240px">`;
  p.innerHTML = `
    <div class="tools-head">
      <button class="tools-back" id="secBack"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></button>
      <span class="tools-title">${escHtml(title)}</span>
    </div>
    <div class="tools-body" style="display:flex;flex-direction:column;align-items:center;padding-top:40px">
      ${inputHtml}
      <div id="secError" style="min-height:18px;margin:8px 0 2px;color:#ff8a8a;font-size:12px;font-weight:600"></div>
      <button class="tools-action" style="max-width:240px;justify-content:center" id="secGo">Continue</button>
    </div>`;
  p.classList.add("open");
  const input = p.querySelector("#secInput");
  const errEl = p.querySelector("#secError");
  setTimeout(() => input?.focus(), 150);
  // keep PIN strictly numeric as the user types
  if(mode === "pin") input.addEventListener("input", () => {
    const cleaned = input.value.replace(/[^0-9]/g, "").slice(0, 8);
    if(cleaned !== input.value) input.value = cleaned;
    if(errEl) errEl.textContent = "";
  });
  p.querySelector("#secBack").addEventListener("click", closeToolsPanel);
  // Pass a fail() so callers can show errors (e.g. "Incorrect PIN") INLINE,
  // not via the hidden subtitle toast.
  const fail = msg => { if(errEl) errEl.textContent = msg; };
  const go = () => {
    const v = (input.value || "").trim();
    if(mode === "pin" && !/^[0-9]+$/.test(v)){ fail("PIN must be numbers only"); return; }
    if(v.length < 4){ fail(mode === "pin" ? "Enter at least 4 digits" : "Password too short (min 4)"); return; }
    cb(v, fail);
  };
  p.querySelector("#secGo").addEventListener("click", go);
  input.addEventListener("keydown", e => { if(e.key === "Enter") go(); });
}

/* ── Private home (after unlock) ── */
function renderPrivateHome(){
  vaultOpened();   // mark vault open → secure screen + auto-lock timer
  // If a Lock action was queued during first-time setup, apply it now.
  if(S._pendingPrivateLock && S._pendingPrivateLock.length){
    addToPrivate(S._pendingPrivateLock);
    S._pendingPrivateLock = null;
  }
  const st = privateStore();
  const items = st.items || [];
  const p = ensureToolsPanel();
  p.innerHTML = `
    <div class="tools-head">
      <button class="tools-back" id="prvBack"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></button>
      <span class="tools-title">Private</span>
      <button class="tools-back" id="prvSettings" style="margin-left:auto"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    </div>
    <div class="tools-body">
      <button class="tools-action" id="prvAdd"><span>＋ Add files to Private</span></button>
      ${items.length === 0 ? `<div class="tools-empty">No private files yet.<br><br>Tap “Add files” above, or use Select → 🔒 Lock in any folder.</div>` :
        items.map((f,i)=>`
        <div class="tools-folder-row prv-row">
          <div class="tfr-top"><span class="tfr-name">${escHtml(f.name)}</span><span class="tfr-size">${fmtSize(f.size)||""}</span></div>
          <div class="tfr-sub" style="display:flex;gap:16px;margin-top:6px">
            <a class="prv-act" data-play="${i}">▶ Play</a>
            <a class="prv-act" data-unlock="${i}">Remove</a>
          </div>
        </div>`).join("")}
    </div>`;
  p.classList.add("open");
  p.querySelector("#prvBack").addEventListener("click", closeToolsPanel);
  p.querySelector("#prvSettings").addEventListener("click", renderPrivateSettings);
  p.querySelector("#prvAdd").addEventListener("click", addFilesToPrivate);
  p.querySelectorAll("[data-play]").forEach(a => a.addEventListener("click", () => {
    const f = items[parseInt(a.dataset.play)];
    if(f){ closeToolsPanel(); openLibraryFile(f.path, f.name, f); }
  }));
  p.querySelectorAll("[data-unlock]").forEach(a => a.addEventListener("click", () => {
    const i = parseInt(a.dataset.unlock);
    const st2 = privateStore();
    const f = st2.items[i];
    if(!f) return;
    // Android: physically MOVE the file back out to the public library.
    if(isAndroidApp() && window.AndroidBridge?.restoreFromPrivate){
      showSubToast("Restoring…", "loading");
      try { window.AndroidBridge.restoreFromPrivate(f.path, f.name); }   // store updated in onRestoredFromPrivate
      catch(_){ showSubToast("Could not restore", "error"); }
      return;
    }
    // Desktop/iOS fallback: just un-hide.
    st2.items.splice(i,1);
    savePrivateStore(st2);
    if(Array.isArray(LibState.allFiles) && !LibState.allFiles.some(x=>x.path===f.path)) LibState.allFiles.push(f);
    showSubToast("Removed from Private");
    renderPrivateHome();
    renderLibGrid();
  }));
}

/* ── Add files into Private via the system picker ── */
async function addFilesToPrivate(){
  if(isAndroidApp() && window.AndroidBridge?.pickMedia){
    S.privateAddMode = true;
    // BUG-08 FIX: reset flag after 30s if picker is dismissed without firing onPickedMedia
    if(S._privateAddModeTimer) clearTimeout(S._privateAddModeTimer);
    S._privateAddModeTimer = setTimeout(() => { S.privateAddMode = false; S._privateAddModeTimer = null; }, 30000);
    try { window.AndroidBridge.pickMedia(); }
    catch(_){ S.privateAddMode = false; clearTimeout(S._privateAddModeTimer); S._privateAddModeTimer = null; showSubToast("Could not open picker", "error"); }
  } else if(window.electronAPI?.openMediaDialog) {
    try {
      const objs = privateFileObjsFromItems(await window.electronAPI.openMediaDialog());
      if(objs.length){ addToPrivate(objs); renderPrivateHome(); }
      else showSubToast("No files selected", "info");
    } catch(_) {
      showSubToast("Could not open picker", "error");
    }
  } else {
    showSubToast("Use Select → 🔒 Lock in a folder to add files", "info");
  }
}

/* ── Private settings page ── */
function renderPrivateSettings(){
  const st = privateStore();
  const p = ensureToolsPanel();
  const bioRow = biometricAvailable() ? `
      <button class="tools-action" id="prvBio">
        <span>Biometric unlock (fingerprint / face)</span>
        <span class="ta-badge">${st.bio ? "ON" : "OFF"}</span>
      </button>` : "";
  p.innerHTML = `
    <div class="tools-head">
      <button class="tools-back" id="psBack"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></button>
      <span class="tools-title">Private Settings</span>
    </div>
    <div class="tools-body">
      <div class="tools-sec-label">Unlock method</div>
      <button class="tools-action" id="prvChangePin"><span>${st.pin ? "Change PIN" : "Set a PIN"}</span><span class="ta-badge">${st.method==="pin"?"ACTIVE":"PIN"}</span></button>
      <button class="tools-action" id="prvChangePass"><span>${st.pass ? "Change Password" : "Set a Password"}</span><span class="ta-badge">${st.method==="pass"?"ACTIVE":"PASS"}</span></button>
      ${bioRow}
      <div class="tools-sec-label" style="margin-top:16px">Security</div>
      <button class="tools-action" id="prvDecoy"><span>Decoy (fake) PIN</span><span class="ta-badge">${st.decoyPin ? "SET" : "OFF"}</span></button>
      <button class="tools-action" id="prvIntruderToggle"><span>Intruder selfie on wrong PIN</span><span class="ta-badge">${st.intruderOff ? "OFF" : "ON"}</span></button>
      <button class="tools-action" id="prvIntruderLog"><span>Intruder log</span><span class="ta-badge">${(st.intruderLog||[]).length}</span></button>
      <div class="tools-sec-label" style="margin-top:16px">Danger zone</div>
      <button class="tools-action tools-danger" id="prvEmpty">Remove all & reset Private folder</button>
    </div>`;
  p.classList.add("open");
  p.querySelector("#psBack").addEventListener("click", renderPrivateHome);
  p.querySelector("#prvChangePin").addEventListener("click", () => {
    promptSecret("Set a PIN", "pin", v1 => promptSecret("Confirm PIN", "pin", (v2, fail) => {
      if(v1!==v2){ if(fail) fail("PINs did not match"); return; }
      const s2 = privateStore();
      if(!s2.salt) s2.salt = generateSalt(); // BUG-12 FIX
      s2.pin = pinHashV2(v1, s2.salt); s2.method = "pin"; savePrivateStore(s2);
      showSubToast("PIN updated — now the active method"); renderPrivateSettings();
    }));
  });
  p.querySelector("#prvChangePass").addEventListener("click", () => {
    promptSecret("Set a Password", "pass", v1 => promptSecret("Confirm Password", "pass", (v2, fail) => {
      if(v1!==v2){ if(fail) fail("Passwords did not match"); return; }
      const s2 = privateStore();
      if(!s2.salt) s2.salt = generateSalt(); // BUG-12 FIX
      s2.pass = pinHashV2(v1, s2.salt); s2.method = "pass"; savePrivateStore(s2);
      showSubToast("Password updated — now the active method"); renderPrivateSettings();
    }));
  });
  const bioBtn = p.querySelector("#prvBio");
  if(bioBtn) bioBtn.addEventListener("click", () => {
    const s2 = privateStore(); s2.bio = !s2.bio; savePrivateStore(s2);
    showSubToast("Biometric unlock " + (s2.bio ? "enabled" : "disabled")); renderPrivateSettings();
  });
  p.querySelector("#prvDecoy").addEventListener("click", () => {
    promptSecret("Set a Decoy PIN (different from real)", "pin", (v, fail) => {
      const s2 = privateStore();
      if(!s2.salt) s2.salt = generateSalt(); // BUG-12 FIX
      if(computeHash(v, s2) === s2.pin){ if(fail) fail("Decoy PIN must differ from your real PIN"); return; }
      s2.decoyPin = pinHashV2(v, s2.salt); s2.decoyItems = s2.decoyItems || []; savePrivateStore(s2);
      showSubToast("Decoy PIN set — entering it opens a fake vault"); renderPrivateSettings();
    });
  });
  p.querySelector("#prvIntruderToggle").addEventListener("click", () => {
    const s2 = privateStore(); s2.intruderOff = !s2.intruderOff; savePrivateStore(s2);
    showSubToast("Intruder selfie " + (s2.intruderOff ? "disabled" : "enabled")); renderPrivateSettings();
  });
  p.querySelector("#prvIntruderLog").addEventListener("click", renderIntruderLog);
  p.querySelector("#prvEmpty").addEventListener("click", () => {
    if(!confirm("Reset Private folder? Files return to the library and your PIN/Password is removed.")) return;
    const s2 = privateStore();
    if(Array.isArray(LibState.allFiles)) (s2.items||[]).forEach(f => { if(!LibState.allFiles.some(x=>x.path===f.path)) LibState.allFiles.push(f); });
    localStorage.removeItem("enkrit_private");
    showSubToast("Private folder reset");
    closeToolsPanel();
    renderLibGrid();
  });
}

/* ── Open network URL (HTTP/HTTPS streaming) ── */
function openUrlDialog(){
  const p = ensureToolsPanel();
  p.innerHTML = `
    <div class="tools-head">
      <button class="tools-back" id="urlBack"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></button>
      <span class="tools-title">Network stream</span>
    </div>
    <div class="tools-body">
      <div class="tt-sub" style="margin-bottom:10px">Paste a video URL — direct file, YouTube, Instagram, Vimeo</div>
      <input type="url" id="urlInput" class="pin-input" style="width:100%;text-align:left;font-size:13px;letter-spacing:0" placeholder="https://example.com/video.mp4">
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="tools-action" style="justify-content:center;flex:0 0 110px;margin:0" id="urlPaste">📋 Paste</button>
        <button class="tools-action" style="justify-content:center;flex:1;margin:0" id="urlGo">Play stream</button>
      </div>
    </div>`;
  p.classList.add("open");
  p.querySelector("#urlBack").addEventListener("click", closeToolsPanel);
  const go = () => {
    const url = p.querySelector("#urlInput").value.trim();
    if(!/^https?:\/\/.+/i.test(url)){ showSubToast("Enter a valid http/https URL","error"); return; }
    // Direct media file (.mp4/.mkv/.m3u8/…) → play in ENKRIT's own player.
    if(isDirectMediaUrl(url)){
      closeToolsPanel();
      showSubToast("Connecting to stream…","loading");
      const name = decodeURIComponent(url.split("/").pop().split("?")[0]) || "Network stream";
      const item = makeMediaItemFromPath(url, name, {kind: mediaKind(name, "")});
      let idx = S.playlist.findIndex(x => x.path === url);
      if(idx === -1){ S.playlist.push(item); idx = S.playlist.length - 1; }
      renderPlaylist();
      loadVideo(idx);
      return;
    }
    // Any web page (YouTube / Instagram / Facebook / etc.) → open it in-app so
    // the site's own player plays it.
    closeToolsPanel();
    if(isAndroidApp() && window.AndroidBridge?.openInAppBrowser){
      try { window.AndroidBridge.openInAppBrowser(url); } catch(_){ showSubToast("Could not open link","error"); }
    } else {
      const embed = parseEmbedUrl(url);
      openWebEmbed(embed || { src: url, label: "Web" });
    }
  };
  p.querySelector("#urlGo").addEventListener("click", go);
  p.querySelector("#urlPaste").addEventListener("click", async () => {
    const input = p.querySelector("#urlInput");
    if(isAndroidApp() && window.AndroidBridge?.requestClipboardText){
      try { window.AndroidBridge.requestClipboardText(); } catch(_){}
      return; // filled via onClipboardText callback
    }
    try {
      const t = await navigator.clipboard.readText();
      if(t){ input.value = t.trim(); input.focus(); }
      else showSubToast("Clipboard empty","info");
    } catch(_){ showSubToast("Clipboard not accessible — type the URL manually","info"); }
  });
  p.querySelector("#urlInput").addEventListener("keydown", e => { if(e.key === "Enter") go(); });
}

/* Hook ONLY the network-URL entry into the Storage hub.
   The Private folder is intentionally NOT listed anywhere visible — it is
   opened by a hidden gesture: long-press the ENKRIT logo in the library header. */
(function(){
  const _origStorage = openStoragePanel;
  openStoragePanel = function(){
    _origStorage();
    const p = $("toolsPanel");
    const dupBtn = p?.querySelector("#toolsDupBtn");
    if(!dupBtn || p.querySelector("#toolsUrlBtn")) return;
    const url = document.createElement("button");
    url.className = "tools-action"; url.id = "toolsUrlBtn";
    url.innerHTML = `<span>Open network stream</span><span class="ta-badge">URL</span>`;
    url.addEventListener("click", openUrlDialog);
    dupBtn.after(url);
  };
})();

/* Secret access: long-press (1.2s) the palette/theme button (Android) or the
   ENKRIT logo (desktop) → unlock Private folder. A normal tap still works. */
(function(){
  const targets = [document.querySelector(".lib-logo"), document.getElementById("btnTheme")].filter(Boolean);
  if(!targets.length) return;
  targets.forEach(el => {
    let timer = null, fired = false;
    const start = () => { fired = false; timer = setTimeout(() => { timer = null; fired = true; try { if(navigator.vibrate) navigator.vibrate(40); } catch(_){} unlockPrivate(); }, 2000); };
    const cancel = () => { if(timer){ clearTimeout(timer); timer = null; } };
    // swallow the click that follows a successful long-press (don't open theme menu)
    el.addEventListener("click", e => { if(fired){ e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
    el.addEventListener("touchstart", start, {passive:true});
    el.addEventListener("touchend", cancel);
    el.addEventListener("touchmove", cancel, {passive:true});
    el.addEventListener("mousedown", start);
    el.addEventListener("mouseup", cancel);
    el.addEventListener("mouseleave", cancel);
  });
})();

/* Biometric result from native */
window.ENKRITAndroid && (window.ENKRITAndroid.onBiometric = function(ok){
  const cb = window.__privateAuthCb; window.__privateAuthCb = null;
  if(cb) cb(!!ok);
});

/* Hide private files from all library views */
(function(){
  const _origRender = renderLibGrid;
  renderLibGrid = function(){
    const prv = privatePaths();
    if(prv.size && Array.isArray(LibState.allFiles)){
      // BUG-04 FIX: shadow allFiles during render then restore — never permanently mutate
      const orig = LibState.allFiles;
      LibState.allFiles = orig.filter(f => !prv.has(f.path));
      const result = _origRender();
      LibState.allFiles = orig;
      return result;
    }
    return _origRender();
  };
})();

/* Lock button in batch bar */
(function(){
  const _origBar = updateBatchBar;
  updateBatchBar = function(){
    _origBar();
    const bar = $("batchBar");
    if(!bar || bar.querySelector("#bbLock")) return;
    const del = bar.querySelector("#bbDelete");
    if(!del) return;
    const lock = document.createElement("button");
    lock.className = "bb-btn"; lock.id = "bbLock";
    lock.textContent = "🔒 Lock";
    if(LibState.selected.size === 0) lock.disabled = true;
    lock.addEventListener("click", () => {
      const sel = [...LibState.selected.values()];
      if(!sel.length) return;
      if(!isPrivateSetup()){
        // First time: one quick PIN screen, then lock the selection.
        const toLock = sel.slice();
        exitSelectMode(true);
        runPrivateSetup(() => { addToPrivate(toLock); renderPrivateHome(); });
        return;
      }
      // BUG-01 FIX: require authentication before adding files to an existing vault
      const toLock = sel.slice();
      exitSelectMode(true);
      authPrivate(() => { addToPrivate(toLock); renderPrivateHome(); });
    });
    del.before(lock);
  };
})();

/* ════════════════════════════════════════════════════════
   WAVE 3 — dialogue enhance, bookmarks, eco mode,
   screenshot, audio extract, seek preview thumbnails
════════════════════════════════════════════════════════ */

/* ── Dialogue enhance (smart compressor) ── */
S.dialogueOn = false;
let _desktopComp = null;
$("btnDialogue")?.addEventListener("click", e => {
  e.stopPropagation();
  S.dialogueOn = !S.dialogueOn;
  $("btnDialogue")?.classList.toggle("active", S.dialogueOn);
  if(isAndroidApp() && window.AndroidBridge?.setDialogueEnhance){
    try { window.AndroidBridge.setDialogueEnhance(S.dialogueOn); } catch(_){}
    showSubToast(S.dialogueOn ? "Dialogue enhance ON — louder, clearer speech" : "Dialogue enhance off", "info");
    return;
  }
  // Desktop: WebAudio compressor in the SW chain
  try {
    if(typeof audioCtx !== "undefined" && audioCtx && typeof gainNode !== "undefined" && gainNode){
      if(S.dialogueOn){
        if(!_desktopComp){
          _desktopComp = audioCtx.createDynamicsCompressor();
          _desktopComp.threshold.value = -38; _desktopComp.knee.value = 12;
          _desktopComp.ratio.value = 5; _desktopComp.attack.value = 0.008; _desktopComp.release.value = 0.16;
        }
        gainNode.disconnect(); gainNode.connect(_desktopComp); _desktopComp.connect(audioCtx.destination);
      } else if(_desktopComp){
        gainNode.disconnect(); _desktopComp.disconnect(); gainNode.connect(audioCtx.destination);
      }
      showSubToast(S.dialogueOn ? "Dialogue enhance ON (SW decoder)" : "Dialogue enhance off", "info");
    } else {
      showSubToast("Turn on SW decoder mode first (volume cluster)", "info");
      S.dialogueOn = false; $("btnDialogue")?.classList.remove("active");
    }
  } catch(_){ showSubToast("Dialogue enhance unavailable", "error"); }
});

/* ── Bookmarks (per file) ── */
function bookmarkStore(){
  try { return JSON.parse(localStorage.getItem("enkrit_bookmarks") || "{}"); } catch(_){ return {}; }
}
function saveBookmarkStore(st){ try { localStorage.setItem("enkrit_bookmarks", JSON.stringify(st)); } catch(_){} }
$("btnBookmark")?.addEventListener("click", e => {
  e.stopPropagation();
  const item = S.playlist[S.currentIndex];
  if(!item?.path){ showSubToast("Play a video first","info"); return; }
  const st = bookmarkStore();
  const list = st[item.path] || [];
  const t = curPlaybackSec();
  const opts = [
    {value:"__add", label:"➕ Add bookmark at " + fmt(t)},
    ...list.map((b,i)=>({value:String(i), label:"🔖 " + fmt(b) + "  — jump"})),
    ...(list.length ? [{value:"__clear", label:"🗑 Clear all bookmarks"}] : [])
  ];
  openSettingsDialog("Bookmarks — " + (item.name||"").slice(0,28), opts, "__add", v => {
    if(v === "__add"){
      list.push(Math.round(t*10)/10);
      list.sort((a,b)=>a-b);
      st[item.path] = list.slice(0,50);
      saveBookmarkStore(st);
      showSubToast("Bookmark added at " + fmt(t) + " 🔖");
    } else if(v === "__clear"){
      delete st[item.path];
      saveBookmarkStore(st);
      showSubToast("Bookmarks cleared","info");
    } else {
      const b = list[parseInt(v)];
      if(b != null){ seekAbsSec(b); showSubToast("Jumped to " + fmt(b)); }
    }
  });
});

/* ── Eco / battery saver mode ── */
S.ecoMode = false;
$("btnEco")?.addEventListener("click", e => {
  e.stopPropagation();
  S.ecoMode = !S.ecoMode;
  document.body.classList.toggle("eco-mode", S.ecoMode);
  $("btnEco")?.classList.toggle("active", S.ecoMode);
  const el = $("ecoLabel"); if(el) el.textContent = S.ecoMode ? "Eco ON" : "Eco";
  if(S.ecoMode){
    try { applyPreset("normal"); } catch(_){}  // drop all video filters (GPU work)
    showSubToast("Eco mode ON — effects off to save battery");
  } else {
    showSubToast("Eco mode off","info");
  }
});

/* ── Clean screenshot ── */
$("btnShot")?.addEventListener("click", e => {
  e.stopPropagation();
  if(S.currentIndex < 0){ showSubToast("Play a video first","info"); return; }
  if(isAndroidApp() && S.nativePlayback && window.AndroidBridge?.captureFrame){
    try { window.AndroidBridge.captureFrame(); } catch(_){}
    return;
  }
  // Desktop / HTML5: draw current frame to canvas
  try {
    const c = document.createElement("canvas");
    c.width = video.videoWidth || 1280; c.height = video.videoHeight || 720;
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    c.toBlob(async blob => {
      if(!blob){ showSubToast("Screenshot failed","error"); return; }
      try {
        await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);
        showSubToast("Screenshot copied to clipboard 📋");
      } catch(_){
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "ENKRIT_" + Date.now() + ".png";
        a.click();
        showSubToast("Screenshot downloaded 📷");
      }
    }, "image/png");
  } catch(_){ showSubToast("Screenshot failed (DRM/CORS)","error"); }
});

/* ── Audio extract (video → M4A) ── */
$("btnExtractAudio")?.addEventListener("click", e => {
  e.stopPropagation();
  const item = S.playlist[S.currentIndex];
  if(!item?.path){ showSubToast("Play a video first","info"); return; }
  if(isAndroidApp() && window.AndroidBridge?.extractAudio){
    showSubToast("Extracting audio… ⏳","loading");
    try { window.AndroidBridge.extractAudio(item.path); } catch(_){}
  } else {
    showSubToast("Audio extract is available on Android only","info");
  }
});

/* ── Seek preview thumbnails while scrubbing ── */
let _spToken = 0, _spLast = 0, _spShownToken = -1;
let _spDesktopVid = null;
function showSeekBubbleAt(pct, sec){
  const bubble = $("seekBubble");
  if(!bubble) return;
  bubble.style.left = (pct*100) + "%";
  $("seekBubbleTime").textContent = fmt(sec);
  bubble.classList.add("visible");
}
function hideSeekBubble(){ $("seekBubble")?.classList.remove("visible"); }

(function(){
  const _origSeek = doSeek;
  doSeek = function(e){
    _origSeek(e);
    if(!S.isDraggingProgress) return;
    try {
      const r = pw.getBoundingClientRect();
      if(!r.width || e.clientX == null) return;
      const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const durSec = S.nativePlayback ? (S.nativeDuration||0)/1000 : (video.duration||0);
      if(!durSec) return;
      const sec = pct * durSec;
      showSeekBubbleAt(pct, sec);
      const now = Date.now();
      if(now - _spLast < 200) return;       // throttle
      _spLast = now;
      const item = S.playlist[S.currentIndex];
      if(isAndroidApp() && S.nativePlayback && window.AndroidBridge?.requestSeekPreview && item?.path){
        _spToken++;
        window.AndroidBridge.requestSeekPreview(item.path, Math.round(sec*1000), _spToken);
      } else if(!isAndroidApp() && item){
        // Desktop: offscreen <video> seeks + draws the frame
        if(!_spDesktopVid){ _spDesktopVid = document.createElement("video"); _spDesktopVid.muted = true; _spDesktopVid.preload = "auto"; }
        if(_spDesktopVid.src !== (item.url || "")) _spDesktopVid.src = item.url || "";
        _spDesktopVid.currentTime = sec;
        _spDesktopVid.onseeked = () => {
          try {
            const c = document.createElement("canvas");
            c.width = 200; c.height = Math.round(200 * (_spDesktopVid.videoHeight||9) / (_spDesktopVid.videoWidth||16));
            c.getContext("2d").drawImage(_spDesktopVid, 0, 0, c.width, c.height);
            $("seekBubbleImg").src = c.toDataURL("image/jpeg", 0.6);
          } catch(_){}
        };
      }
    } catch(_){}
  };
  document.addEventListener("mouseup", hideSeekBubble);
  document.addEventListener("touchend", hideSeekBubble);
})();

/* native preview frames arrive here */
window.ENKRITAndroid && (window.ENKRITAndroid.onSeekPreview = function(token, b64){
  if(token < _spShownToken) return;
  _spShownToken = token;
  const img = $("seekBubbleImg");
  if(img && b64) img.src = "data:image/jpeg;base64," + b64;
});
window.ENKRITAndroid && (window.ENKRITAndroid.onShotSaved = function(ok, name){
  showSubToast(ok ? "Screenshot saved (Pictures/ENKRIT) + clipboard 📋" : "Screenshot failed", ok ? "info" : "error");
});
window.ENKRITAndroid && (window.ENKRITAndroid.onAudioExtracted = function(ok, name){
  showSubToast(ok ? "Audio saved: Music/ENKRIT/" + name + " 🎵" : "Audio extract failed (codec not MP4-compatible)", ok ? "info" : "error");
});

/* clipboard text from native (fills the network-stream URL input) */
window.ENKRITAndroid && (window.ENKRITAndroid.onClipboardText = function(text){
  const input = document.getElementById("urlInput");
  if(!input){ return; }
  if(text && text.trim()){ input.value = text.trim(); }
  else showSubToast("Clipboard empty — copy a URL first","info");
});

/* ════════════════════════════════════════════════════════
   WEB EMBED PLAYER — YouTube / Instagram / Vimeo links
   (official embed players, in-app overlay)
════════════════════════════════════════════════════════ */
function isDirectMediaUrl(url){
  return /\.(mp4|m4v|mkv|webm|mov|avi|flv|wmv|3gp|ts|m3u8|mpd|mp3|m4a|aac|wav|flac|ogg|opus)(\?|#|$)/i.test(url || "");
}
function parseEmbedUrl(url){
  let m = url.match(/(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if(m) return { src:"https://www.youtube-nocookie.com/embed/" + m[1] + "?autoplay=1&playsinline=1&rel=0", label:"YouTube" };
  m = url.match(/instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if(m) return { src:"https://www.instagram.com/" + (m[1]==="reels"?"reel":m[1]) + "/" + m[2] + "/embed/", label:"Instagram" };
  m = url.match(/vimeo\.com\/(\d+)/);
  if(m) return { src:"https://player.vimeo.com/video/" + m[1] + "?autoplay=1", label:"Vimeo" };
  m = url.match(/dailymotion\.com\/video\/([A-Za-z0-9]+)/);
  if(m) return { src:"https://www.dailymotion.com/embed/video/" + m[1] + "?autoplay=1", label:"Dailymotion" };
  return null;
}

function openWebEmbed(embed){
  closeToolsPanel();
  let ov = $("embedOverlay");
  if(!ov){
    ov = document.createElement("div");
    ov.id = "embedOverlay";
    ov.className = "embed-overlay";
    document.body.appendChild(ov);
  }
  ov.innerHTML = `
    <div class="embed-head">
      <span class="embed-title">${escHtml(embed.label)} player</span>
      <button class="embed-close" id="embedClose">✕</button>
    </div>
    <iframe class="embed-frame" src="${escAttr(embed.src)}"
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  ov.classList.add("open");
  ov.querySelector("#embedClose").addEventListener("click", () => {
    ov.classList.remove("open");
    ov.innerHTML = ""; // kill iframe → stops playback
  });
}

/* ════════════════════════════════════════════════════════
   GIF MAKER — pick duration, drag a range, save to gallery
════════════════════════════════════════════════════════ */
S.gifBusy = false;
S.gifResumePos = 0;       // where the user was watching before opening GIF
S.gifMaxDur = 5;          // chosen max span (seconds)
S.gifA = 0;               // selection start (seconds)
S.gifB = 5;               // selection end (seconds)

$("btnGif")?.addEventListener("click", e => {
  e.stopPropagation();
  const item = S.playlist[S.currentIndex];
  if(!item?.path && !item?.url){ showSubToast("Play a video first", "info"); return; }
  if(S.gifBusy){ showSubToast("A GIF is already being created", "info"); return; }
  openSettingsDialog("GIF length",
    [ {value:"5",  label:"Up to 5 seconds"},
      {value:"8",  label:"Up to 8 seconds"},
      {value:"10", label:"Up to 10 seconds"} ],
    "5",
    v => openGifRange(parseInt(v) || 5));
});

function gifTotalDur(){
  return S.nativePlayback ? (S.nativeDuration || 0) / 1000 : (video.duration || 0);
}

function openGifRange(maxDur){
  const total = gifTotalDur();
  if(!total || total < 1){ showSubToast("Video not ready yet", "info"); return; }
  $("moreSheet")?.classList.remove("open");
  S.gifResumePos = curPlaybackSec();      // resume here when everything is done
  if(S.playing) try { togglePlay(); } catch(_){}

  S.gifMaxDur = Math.min(maxDur, total);
  S.gifA = Math.max(0, Math.min(curPlaybackSec(), total - S.gifMaxDur));
  S.gifB = Math.min(total, S.gifA + S.gifMaxDur);

  let ov = $("gifRange");
  if(!ov){
    ov = document.createElement("div");
    ov.id = "gifRange";
    ov.className = "gif-range";
    $("videoContainer")?.appendChild(ov);
  }
  ov.innerHTML = `
    <div class="gif-range-head">
      <span class="gif-range-title">Drag the handles to choose your clip</span>
      <span class="gif-range-time" id="gifRangeTime"></span>
    </div>
    <div class="gif-range-track" id="gifTrack">
      <div class="gif-range-sel" id="gifSel"></div>
      <div class="gif-range-handle gif-handle-a" id="gifHandleA"></div>
      <div class="gif-range-handle gif-handle-b" id="gifHandleB"></div>
    </div>
    <div class="gif-range-actions">
      <button class="gif-range-btn" id="gifRangeCancel">Cancel</button>
      <button class="gif-range-btn gif-range-make" id="gifRangeMake">Create GIF</button>
    </div>`;
  ov.classList.add("open");
  showControls(); clearTimeout(S.controlsTimer);

  const track = ov.querySelector("#gifTrack");
  const updateUI = () => {
    const a = S.gifA / total, b = S.gifB / total;
    ov.querySelector("#gifSel").style.left = (a*100) + "%";
    ov.querySelector("#gifSel").style.width = ((b-a)*100) + "%";
    ov.querySelector("#gifHandleA").style.left = (a*100) + "%";
    ov.querySelector("#gifHandleB").style.left = (b*100) + "%";
    ov.querySelector("#gifRangeTime").textContent =
      fmt(S.gifA) + " – " + fmt(S.gifB) + "  (" + (S.gifB - S.gifA).toFixed(1) + "s)";
  };
  updateUI();

  let drag = null; // "a" | "b"
  const posToSec = clientX => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total;
  };
  const onMove = clientX => {
    if(clientX == null) return;
    let sec = posToSec(clientX);
    if(drag === "a"){
      sec = Math.min(sec, S.gifB - 0.3);
      if(S.gifB - sec > S.gifMaxDur) sec = S.gifB - S.gifMaxDur;  // cap span
      S.gifA = Math.max(0, sec);
      // live-preview the start frame
      seekAbsSec(S.gifA);
    } else if(drag === "b"){
      sec = Math.max(sec, S.gifA + 0.3);
      if(sec - S.gifA > S.gifMaxDur) sec = S.gifA + S.gifMaxDur;
      S.gifB = Math.min(total, sec);
      seekAbsSec(S.gifB);
    }
    updateUI();
  };
  ov.querySelector("#gifHandleA").addEventListener("mousedown", e => { drag="a"; e.preventDefault(); });
  ov.querySelector("#gifHandleB").addEventListener("mousedown", e => { drag="b"; e.preventDefault(); });
  ov.querySelector("#gifHandleA").addEventListener("touchstart", e => { drag="a"; }, {passive:true});
  ov.querySelector("#gifHandleB").addEventListener("touchstart", e => { drag="b"; }, {passive:true});
  const mm = e => { if(drag) onMove(e.clientX); };
  const tm = e => { if(drag) onMove(e.touches[0]?.clientX); };
  const up = () => { drag = null; };
  document.addEventListener("mousemove", mm);
  document.addEventListener("touchmove", tm, {passive:true});
  document.addEventListener("mouseup", up);
  document.addEventListener("touchend", up);
  ov._cleanup = () => {
    document.removeEventListener("mousemove", mm);
    document.removeEventListener("touchmove", tm);
    document.removeEventListener("mouseup", up);
    document.removeEventListener("touchend", up);
  };

  ov.querySelector("#gifRangeCancel").addEventListener("click", () => closeGifRange(true));
  ov.querySelector("#gifRangeMake").addEventListener("click", () => {
    const item = S.playlist[S.currentIndex];
    if(!item){ closeGifRange(true); return; }
    const startS = S.gifA, durS = Math.max(0.3, S.gifB - S.gifA);
    closeGifRange(false);     // hide range UI, keep video paused
    showGifLoading();
    if(isAndroidApp() && S.nativePlayback && window.AndroidBridge?.createGif){
      S.gifBusy = true;
      try { window.AndroidBridge.createGif(item.path, Math.round(startS*1000), Math.round(durS*1000)); }
      catch(_){ gifFinished(false); }
    } else if(!isAndroidApp()){
      makeGifDesktop(item, startS, durS);
    } else {
      hideGifLoading();
      showSubToast("GIF maker is not available on iOS yet", "info");
      resumeAfterGif();
    }
  });
}

function closeGifRange(resume){
  const ov = $("gifRange");
  if(ov){ ov._cleanup && ov._cleanup(); ov.classList.remove("open"); ov.innerHTML = ""; }
  if(resume) resumeAfterGif();
}

let _gifWatchdog = null;
function armGifWatchdog(){
  clearGifWatchdog();
  _gifWatchdog = setTimeout(() => {
    if(S.gifBusy){ gifFinished(false); showSubToast("GIF timed out — try a shorter clip", "error"); }
  }, 60000);
}
function clearGifWatchdog(){ if(_gifWatchdog){ clearTimeout(_gifWatchdog); _gifWatchdog = null; } }
function bumpGifWatchdog(){ if(_gifWatchdog) armGifWatchdog(); }   // reset on each progress tick

function showGifLoading(){
  armGifWatchdog();
  let ld = $("gifLoading");
  if(!ld){
    ld = document.createElement("div");
    ld.id = "gifLoading";
    ld.className = "gif-loading";
    $("videoContainer")?.appendChild(ld);
  }
  ld.innerHTML = `
    <div class="gif-loading-card">
      <div class="gif-spinner"></div>
      <div class="gif-loading-text">Creating GIF…</div>
      <div class="gif-loading-pct" id="gifPct">0%</div>
    </div>`;
  ld.classList.add("open");
}
function setGifProgress(pct){
  bumpGifWatchdog();
  const el = $("gifPct");
  if(el) el.textContent = pct + "%";
  setGifLabel(pct + "%");
}
function hideGifLoading(){
  const ld = $("gifLoading");
  if(ld){ ld.classList.remove("open"); ld.innerHTML = ""; }
}

function resumeAfterGif(){
  const pos = S.gifResumePos || 0;
  try { seekAbsSec(pos); } catch(_){}
  // Give the native seek a moment, then explicitly resume playback.
  setTimeout(() => {
    try {
      if(S.nativePlayback){
        S.nativePosition = pos * 1000;
        if(window.AndroidBridge?.nativeSetPlaying) window.AndroidBridge.nativeSetPlaying(true);
        setPlaybackUi(true);
      } else {
        video.currentTime = pos;
        video.play().catch(()=>{});
      }
    } catch(_){}
    resetHide();
  }, 150);
}

function gifFinished(ok){
  clearGifWatchdog();
  S.gifBusy = false;
  setGifLabel("GIF");
  hideGifLoading();
  resumeAfterGif();
  if(ok) showSubToast("Saved to Gallery (Pictures/ENKRIT)");
  else showSubToast("Could not create GIF", "error");
}

function setGifLabel(t){ const el = $("gifLabel"); if(el) el.textContent = t; }

window.ENKRITAndroid && (window.ENKRITAndroid.onGifState = function(state, pct, uri){
  if(state === "progress"){ setGifProgress(pct); return; }
  if(state === "busy"){ showSubToast("A GIF is already being created", "info"); return; }
  gifFinished(state === "done");
});

/* ── Desktop GIF: offscreen video + canvas frames + JS GIF89a encoder ── */
async function makeGifDesktop(item, startS, durS){
  S.gifBusy = true;
  setGifProgress(0);
  try {
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto";
    v.src = item.url || toFileUrl(item.path);
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; setTimeout(rej, 8000); });
    const fps = 10, frameCount = Math.min(100, Math.max(10, Math.round(durS * fps)));
    const w = 480, h = Math.max(2, Math.round((v.videoHeight / v.videoWidth) * 480 / 2) * 2);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d", {willReadFrequently:true});
    const frames = [];
    for(let i = 0; i < frameCount; i++){
      v.currentTime = startS + (i * durS / frameCount);
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 1200); });
      ctx.drawImage(v, 0, 0, w, h);
      frames.push(ctx.getImageData(0, 0, w, h).data);
      if(i % 3 === 0) setGifProgress(Math.round(i * 85 / frameCount));
    }
    setGifProgress(92);
    const bytes = encodeGif89a(frames, w, h, Math.round(100 / fps));
    const blob = new Blob([bytes], {type:"image/gif"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ENKRIT_" + Date.now() + ".gif";
    a.click();
    setGifProgress(100);
    S.gifBusy = false;
    hideGifLoading();
    resumeAfterGif();
    showSubToast("GIF saved to Downloads (" + fmtSize(blob.size) + ")");
    return;
  } catch(err){
    gifFinished(false);
  }
}

/* GIF89a encoder — fixed 6x7x6 palette + GIF-LZW (mirror of the Java encoder) */
function encodeGif89a(rgbaFrames, w, h, delayCs){
  const out = [];
  const push = b => out.push(b & 0xFF);
  const pushShort = v => { push(v); push(v >> 8); };
  "GIF89a".split("").forEach(ch => push(ch.charCodeAt(0)));
  pushShort(w); pushShort(h); push(0xF7); push(0); push(0);
  for(let r = 0; r < 6; r++) for(let g = 0; g < 7; g++) for(let b = 0; b < 6; b++){
    push(Math.round(r*255/5)); push(Math.round(g*255/6)); push(Math.round(b*255/5));
  }
  for(let i = 0; i < 4*3; i++) push(0); // pad palette to 256
  [0x21,0xFF,0x0B].forEach(push);
  "NETSCAPE2.0".split("").forEach(ch => push(ch.charCodeAt(0)));
  [0x03,0x01,0x00,0x00,0x00].forEach(push);

  for(const data of rgbaFrames){
    [0x21,0xF9,0x04,0x00].forEach(push);
    pushShort(delayCs); push(0); push(0);
    push(0x2C); pushShort(0); pushShort(0); pushShort(w); pushShort(h); push(0);
    // map to palette indices
    const n = w * h, idx = new Uint8Array(n);
    const BAYER = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
    for(let i = 0; i < n; i++){
      const d = (BAYER[((i/w)|0)%4*4 + (i%w)%4] / 16 - 0.5);
      const r = Math.min(255, Math.max(0, data[i*4]   + d*51));
      const g = Math.min(255, Math.max(0, data[i*4+1] + d*42));
      const b = Math.min(255, Math.max(0, data[i*4+2] + d*51));
      idx[i] = Math.round(r*5/255)*42 + Math.round(g*6/255)*6 + Math.round(b*5/255);
    }
    lzwGif(idx, out);
  }
  push(0x3B);
  return new Uint8Array(out);
}
function lzwGif(indices, out){
  const MIN = 8, CLEAR = 256, EOI = 257;
  out.push(MIN);
  let block = [], cur = 0, nbits = 0;
  const flushBlock = () => { if(block.length){ out.push(block.length); for(const b of block) out.push(b); block = []; } };
  const emit = b => { block.push(b & 0xFF); if(block.length === 255) flushBlock(); };
  const writeCode = (code, size) => {
    cur |= code << nbits; nbits += size;
    while(nbits >= 8){ emit(cur & 0xFF); cur >>= 8; nbits -= 8; }
  };
  let table = new Map(), codeSize = MIN + 1, nextCode = EOI + 1;
  writeCode(CLEAR, codeSize);
  let prefix = indices[0];
  for(let i = 1; i < indices.length; i++){
    const k = indices[i], key = (prefix << 8) | k;
    const code = table.get(key);
    if(code !== undefined){ prefix = code; continue; }
    writeCode(prefix, codeSize);
    if(nextCode < 4096){
      table.set(key, nextCode);
      if(nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
      nextCode++;
    } else {
      writeCode(CLEAR, codeSize);
      table = new Map(); codeSize = MIN + 1; nextCode = EOI + 1;
    }
    prefix = k;
  }
  writeCode(prefix, codeSize);
  writeCode(EOI, codeSize);
  if(nbits > 0) emit(cur & 0xFF);
  flushBlock();
  out.push(0);
}

/* ════════════════════════════════════════════════════════
   UNIFIED BACK NAVIGATION — returns true if back was consumed.
   Android onBackPressed delegates here; only exits when false.
════════════════════════════════════════════════════════ */
window.ENKRITHandleBack = function(){
  const vis = id => { const el = $(id); return el && el.style.display !== "none" && getComputedStyle(el).display !== "none"; };

  // 0. transient dialogs / sheets
  const resumeChoice = document.querySelector(".resume-choice");
  if(resumeChoice){ const b = resumeChoice.querySelector(".resume-start"); if(b) b.click(); else resumeChoice.remove(); return true; }
  const infoSheet = $("fileInfoSheet");
  if(infoSheet && infoSheet.style.display !== "none"){ const ic=$("infoClose"); if(ic&&ic.onclick) ic.onclick(); else infoSheet.style.display="none"; return true; }
  const ctxMenu = $("cardContextMenu");
  if(ctxMenu && ctxMenu.style.display !== "none"){ const cc=$("ctxCancel"); if(cc&&cc.onclick) cc.onclick(); else ctxMenu.style.display="none"; return true; }
  const qspd = $("quickSpeedPicker");
  if(qspd){ qspd.remove(); return true; }
  const dlg = $("settingsDialog");
  if(dlg && dlg.style.display !== "none"){ dlg.style.display = "none"; return true; }

  // 1. GIF flow
  const gifLoading = $("gifLoading");
  if(gifLoading && gifLoading.classList.contains("open")) return true;   // busy — block exit, don't cancel
  const gifRange = $("gifRange");
  if(gifRange && gifRange.classList.contains("open")){ closeGifRange(true); return true; }

  // 2. In-app browser / web embed
  const embed = $("embedOverlay");
  if(embed && embed.classList.contains("open")){ const c=embed.querySelector("#embedClose"); if(c) c.click(); else { embed.classList.remove("open"); embed.innerHTML=""; } return true; }
  if(window.AndroidBridge?.closeInAppBrowser && window.__enkritBrowserOpen){ try { window.AndroidBridge.closeInAppBrowser(); } catch(_){} window.__enkritBrowserOpen=false; return true; }

  // 3. tools panel (storage / private / duplicates / network url)
  const tools = $("toolsPanel");
  if(tools && tools.classList.contains("open")){ closeToolsPanel(); return true; }

  // 4. open dropdowns / menus
  const openMenus = ["speedPanel","subMenu","resizePanel","orientPanel","themeMenu","decoderPanel","moreSheet"];
  let closedMenu = false;
  openMenus.forEach(id => { const el = $(id); if(el && el.classList.contains("open")){ el.classList.remove("open"); closedMenu = true; } });
  if(closedMenu) return true;

  // 5. batch select mode
  if(typeof LibState !== "undefined" && LibState.selectMode){ exitSelectMode(true); return true; }

  // 6. settings panel
  const sp = $("settingsPanel");
  if(sp && sp.style.display !== "none"){ sp.style.display = "none"; return true; }

  // 7. filter panel
  const fp = $("filterPanel");
  if(fp && fp.style.display !== "none"){ fp.style.display = "none"; return true; }

  // 8. player open → back to library
  if(vcont && vcont.style.display !== "none"){ backToLibrary(); return true; }

  // 9. inside a library folder → up to folder list
  if(typeof LibState !== "undefined" && LibState.currentFolder !== null){
    LibState.currentFolder = null;
    if(typeof renderLibGrid === "function") renderLibGrid();
    return true;
  }

  // 10. library root → let the app exit
  return false;
};

/* ════════════════════════════════════════════════════════
   VAULT SECURITY — secure-screen mode, auto-lock, panic
════════════════════════════════════════════════════════ */
S.vaultOpen = false;
let _vaultIdleTimer = null;

function setSecureScreen(on){
  // Android: FLAG_SECURE (blocks screenshots/recording + hides recents thumb).
  try { if(isAndroidApp() && window.AndroidBridge?.setSecureMode) window.AndroidBridge.setSecureMode(!!on); } catch(_){}
  // Desktop (Electron): content protection.
  try { if(window.electronAPI?.setContentProtection) window.electronAPI.setContentProtection(!!on); } catch(_){}
}

function vaultOpened(){
  S.vaultOpen = true;
  setSecureScreen(true);
  armVaultIdle();
}
function armVaultIdle(){
  if(_vaultIdleTimer) clearTimeout(_vaultIdleTimer);
  if(!S.vaultOpen) return;
  _vaultIdleTimer = setTimeout(() => { if(S.vaultOpen) lockVault("Auto-locked (inactivity)"); }, 30000);
}
function lockVault(msg){
  if(!S.vaultOpen) return;
  S.vaultOpen = false;
  if(_vaultIdleTimer){ clearTimeout(_vaultIdleTimer); _vaultIdleTimer = null; }
  setSecureScreen(false);
  try { closeToolsPanel(); } catch(_){}
  if(msg) showSubToast(msg, "info");
}

/* reset idle timer on any interaction while the vault is open */
["touchstart","mousedown","keydown"].forEach(ev =>
  document.addEventListener(ev, () => { if(S.vaultOpen) armVaultIdle(); }, {passive:true, capture:true}));

/* auto-lock when app is backgrounded / screen locked */
document.addEventListener("visibilitychange", () => { if(document.hidden && S.vaultOpen) lockVault(); });
window.addEventListener("blur", () => { if(S.vaultOpen) lockVault(); });
window.ENKRITAndroid && (window.ENKRITAndroid.onAppPaused = function(){ if(S.vaultOpen) lockVault(); });

/* ── Panic switch ── */
// Desktop: double-tap Esc or Space → instant lock
let _panicKeyT = 0;
document.addEventListener("keydown", e => {
  if(!S.vaultOpen) return;
  if(e.key === "Escape" || e.key === " " || e.code === "Space"){
    const now = Date.now();
    if(now - _panicKeyT < 500){ lockVault("Locked"); _panicKeyT = 0; }
    else _panicKeyT = now;
  }
});
// Mobile: violent shake → lock
(function(){
  let lastX=0,lastY=0,lastZ=0,lastT=0;
  window.addEventListener("devicemotion", e => {
    if(!S.vaultOpen) return;
    const a = e.accelerationIncludingGravity; if(!a) return;
    const now = Date.now(); if(now - lastT < 100) return; lastT = now;
    const delta = Math.abs(a.x-lastX) + Math.abs(a.y-lastY) + Math.abs(a.z-lastZ);
    lastX=a.x||0; lastY=a.y||0; lastZ=a.z||0;
    if(delta > 45) lockVault("Locked (shake)");
  });
  // Mobile: phone turned face-down → lock
  window.addEventListener("deviceorientation", e => {
    if(!S.vaultOpen) return;
    // beta ~180 or gamma near +/-180 → screen facing down
    if(typeof e.beta === "number" && Math.abs(e.beta) > 150) lockVault("Locked (face-down)");
  });
})();

/* ════════════════════════════════════════════════════════
   DECOY VAULT + INTRUDER LOG
════════════════════════════════════════════════════════ */
function renderDecoyHome(){
  vaultOpened();
  const st = privateStore();
  const items = st.decoyItems || [];
  const p = ensureToolsPanel();
  p.innerHTML = `
    <div class="tools-head">
      <button class="tools-back" id="dcyBack"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></button>
      <span class="tools-title">Private</span>
    </div>
    <div class="tools-body">
      <button class="tools-action" id="dcyAdd"><span>＋ Add files to Private</span></button>
      ${items.length === 0 ? `<div class="tools-empty">No private files yet.</div>` :
        items.map((f,i)=>`
        <div class="tools-folder-row prv-row">
          <div class="tfr-top"><span class="tfr-name">${escHtml(f.name)}</span><span class="tfr-size">${fmtSize(f.size)||""}</span></div>
          <div class="tfr-sub" style="display:flex;gap:16px;margin-top:6px">
            <a class="prv-act" data-play="${i}">▶ Play</a>
          </div>
        </div>`).join("")}
    </div>`;
  p.classList.add("open");
  p.querySelector("#dcyBack").addEventListener("click", () => lockVault());
  p.querySelector("#dcyAdd").addEventListener("click", () => {
    // adding to the decoy vault uses the same picker, flagged as decoy
    S.decoyAddMode = true;
    // BUG-09 FIX: reset flag if picker is dismissed without firing onPickedMedia
    if(S._decoyAddModeTimer) clearTimeout(S._decoyAddModeTimer);
    S._decoyAddModeTimer = setTimeout(() => { S.decoyAddMode = false; S._decoyAddModeTimer = null; }, 30000);
    if(isAndroidApp() && window.AndroidBridge?.pickMedia){ try{ window.AndroidBridge.pickMedia(); }catch(_){ S.decoyAddMode=false; clearTimeout(S._decoyAddModeTimer); S._decoyAddModeTimer=null; } }
    else showSubToast("Use Select → Lock to add", "info");
  });
  p.querySelectorAll("[data-play]").forEach(a => a.addEventListener("click", () => {
    const f = items[parseInt(a.dataset.play)];
    if(f){ lockVault(); openLibraryFile(f.path, f.name, f); }
  }));
}

/* Intruder selfie: silently grab one front-camera frame + timestamp. */
function captureIntruder(){
  const st = privateStore();
  if(st.intruderOff) return;            // user can disable in settings
  try {
    if(!navigator.mediaDevices?.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then(stream => {
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.srcObject = stream;
        v.play().then(() => setTimeout(() => {
          try {
            const c = document.createElement("canvas");
            c.width = 320; c.height = Math.round(320 * (v.videoHeight||240) / (v.videoWidth||320));
            c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
            const img = c.toDataURL("image/jpeg", 0.6);
            const s2 = privateStore();
            s2.intruderLog = s2.intruderLog || [];
            s2.intruderLog.unshift({ t: Date.now(), img });
            s2.intruderLog = s2.intruderLog.slice(0, 20);   // keep last 20
            savePrivateStore(s2);
          } catch(_){}
          stream.getTracks().forEach(t => t.stop());
        }, 400));
      }).catch(()=>{});
  } catch(_){}
}

function renderIntruderLog(){
  const st = privateStore();
  const log = st.intruderLog || [];
  const p = ensureToolsPanel();
  p.innerHTML = `
    <div class="tools-head">
      <button class="tools-back" id="ilBack"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 5l-7 7 7 7"/></svg></button>
      <span class="tools-title">Intruder log</span>
    </div>
    <div class="tools-body">
      ${log.length === 0 ? `<div class="tools-empty">No failed unlock attempts recorded.</div>` :
        `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">` + log.map(e=>`
          <div class="tools-folder-row" style="padding:0;overflow:hidden">
            <img src="${e.img}" style="width:100%;display:block">
            <div class="tfr-sub" style="padding:6px 8px">${new Date(e.t).toLocaleString()}</div>
          </div>`).join("") + `</div>
        <button class="tools-action tools-danger" id="ilClear" style="margin-top:14px">Clear log</button>`}
    </div>`;
  p.classList.add("open");
  p.querySelector("#ilBack").addEventListener("click", renderPrivateSettings);
  p.querySelector("#ilClear")?.addEventListener("click", () => {
    const s2 = privateStore(); s2.intruderLog = []; savePrivateStore(s2);
    showSubToast("Log cleared"); renderIntruderLog();
  });
}

/* ════════════════════════════════════════════════════════
   TRUE PRIVATE — native move/restore callbacks
════════════════════════════════════════════════════════ */
window.ENKRITAndroid && (window.ENKRITAndroid.onMovedToPrivate = function(jsonItems){
  let moved = [];
  try { moved = JSON.parse(jsonItems || "[]"); } catch(_){}
  const st = privateStore();
  st.items = st.items || [];
  const have = new Set(st.items.map(f=>f.path));
  let n = 0;
  for(const f of moved){ if(f && f.path && !have.has(f.path)){ st.items.push(f); have.add(f.path); n++; } }
  savePrivateStore(st);
  showSubToast(n ? (n + " file" + (n!==1?"s":"") + " moved to Private ✓") : "Nothing moved", n ? "info" : "info");
  // originals were deleted from the device → refresh the library
  if(typeof scanLibrary === "function") scanLibrary();
  if(S.vaultOpen) renderPrivateHome();
});

window.ENKRITAndroid && (window.ENKRITAndroid.onRestoredFromPrivate = function(ok, path){
  if(ok){
    const st = privateStore();
    st.items = (st.items || []).filter(f => f.path !== path);
    savePrivateStore(st);
    showSubToast("File restored to your library");
    if(typeof scanLibrary === "function") scanLibrary();
    if(S.vaultOpen) renderPrivateHome();
  } else {
    showSubToast("Could not restore file", "error");
  }
});
