"use strict";

/* ── STATE ── */
const S = {
  playlist:[], currentIndex:-1, playing:false,
  speed:1, dark:true, controlsTimer:null,
  isDraggingProgress:false, subtitleMode:"off",
  recognition:null, srtCues:[], decoderMode:"hw",
  whisperRunning:false, whisperListenerReady:false,
  filters:{brightness:100,contrast:100,saturation:100,sharpness:0,hue:0,blur:0,grayscale:0},
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
      if(Array.isArray(items)) openAndroidMediaItems(items);
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
      showSubToast(message || "This video could not be played", "error");
      setPlaybackUi(false);
    },
    onDeleteComplete(success, uri){
      handleDeleteComplete(!!success, uri || "");
    },
  };
}
function openNativePicker(){
  if(!isAndroidApp() || !window.AndroidBridge.pickMedia) return false;
  window.AndroidBridge.pickMedia();
  return true;
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
  media.forEach(src=>{
    const item = makeMediaItemFromPath(src.path, src.name, src);
    if(!isDuplicateMedia(item)) S.playlist.push(item);
    addToRecent({ name:item.name, path:item.path, ext:item.ext, size:item.size || 0, kind:item.kind, durationMs:src.durationMs || 0 });
  });
  renderPlaylist();
  renderLibGrid();
  if(wasEmpty||S.currentIndex===-1) loadVideo(Math.max(0, S.playlist.length-media.length));
}
function openAndroidMediaItems(items){
  const media = items.filter(item=>item && item.path);
  if(!media.length) return;
  const wasEmpty = S.playlist.length===0;
  media.forEach(src=>{
    const item = makeMediaItemFromPath(src.path, src.name, src);
    if(!isDuplicateMedia(item)) S.playlist.push(item);
    addToRecent({ name:item.name, path:item.path, ext:item.ext, size:item.size || 0, kind:item.kind, durationMs:src.durationMs || 0 });
  });
  renderPlaylist();
  renderLibGrid();
  if(wasEmpty||S.currentIndex===-1) loadVideo(Math.max(0, S.playlist.length-media.length));
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
});

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
  media.forEach(f=>{
    const item = makeMediaItemFromFile(f);
    if(!isDuplicateMedia(item)) S.playlist.push(item);
  });
  renderPlaylist();
  if(wasEmpty||S.currentIndex===-1) loadVideo(0);
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
  setVideoZoom(1);
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
      window.AndroidBridge.playNativeMedia(item.url, startMs, S.speed, parseInt(volSlider?.value || "100"));
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
  // Show back button
  const backBtn=$("btnBack"); if(backBtn) backBtn.style.display="flex";
  const name=item.name.replace(/\.[^/.]+$/,"");
  $("topbarTitle").textContent=name;
  $("ctrlFilename").textContent=name;
  document.title="ENKRIT — "+name;
  setPlaybackUi(true);
  addToRecent({ name:item.name, path:item.path, ext:item.ext || "", size:item.size || 0, kind:item.kind, durationMs:item.durationMs || 0, playedAt:Date.now() });
  resetHide();
  renderPlaylist(); highlightActive();
  updateMediaModeUI();
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
    try { window.AndroidBridge.nativeSetPlaying(next); } catch(_){}
    setPlaybackUi(next);
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
$("btnBack5").addEventListener("click",()=>seek(-5));
$("btnFwd5").addEventListener("click",()=>seek(5));
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
    while(next === S.currentIndex) next = Math.floor(Math.random() * S.playlist.length);
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
  playNextTrack(false);
}

function seek(sec){
  if(S.nativePlayback){
    const target = Math.max(0, Math.min(S.nativeDuration || 0, S.nativePosition + sec * 1000));
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
  video.muted=!video.muted;
  $("iconVol").style.display=video.muted?"none":"block";
  $("iconMute").style.display=video.muted?"block":"none";
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
}
document.querySelectorAll(".spbtn").forEach(b=>b.addEventListener("click",()=>setSpeed(parseFloat(b.dataset.s))));

/* ════════════════════════════════
   PROGRESS BAR
════════════════════════════════ */
video.addEventListener("timeupdate",updateProgress);
video.addEventListener("progress",()=>{
  if(!video.buffered.length) return;
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
  S.nativePosition = Math.max(0, data.position || 0);
  S.nativeDuration = Math.max(0, data.duration || S.nativeDuration || 0);
  setPlaybackUi(!!data.playing);
  const pct = S.nativeDuration ? S.nativePosition / S.nativeDuration * 100 : 0;
  $("progressFill").style.width = pct + "%";
  $("progressThumb").style.left = pct + "%";
  $("timeNow").textContent = fmt(S.nativePosition / 1000);
  $("timeDur").textContent = fmt(S.nativeDuration / 1000);
  saveResumePosition();
}

const pw=$("progressWrap");
pw.addEventListener("mousedown",e=>{ S.isDraggingProgress=true; doSeek(e); });
pw.addEventListener("touchstart",e=>{ S.isDraggingProgress=true; doSeek(e.touches[0]); },{passive:true});
document.addEventListener("mousemove",e=>{ if(S.isDraggingProgress) doSeek(e); });
document.addEventListener("touchmove",e=>{ if(S.isDraggingProgress) doSeek(e.touches[0]); },{passive:true});
document.addEventListener("mouseup",()=>S.isDraggingProgress=false);
document.addEventListener("touchend",()=>S.isDraggingProgress=false);

function doSeek(e){
  const r=pw.getBoundingClientRect();
  const x=(e.clientX??r.left)-r.left;
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
  try{ if(document.pictureInPictureElement) await document.exitPictureInPicture();
       else if(video.requestPictureInPicture) await video.requestPictureInPicture(); }
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
try { localStorage.setItem("enkrit_orientation", "portrait"); } catch(_){}
setOrientationMode("portrait");

/* ════════════════════════════════
   CONTROLS AUTO HIDE
════════════════════════════════ */
const playerWrap=$("playerWrap");

function showControls(){
  controls.classList.remove("hidden");
  document.body.classList.remove("player-ui-hidden");
  if(isAndroidApp() && S.currentIndex >= 0) {
    try { window.AndroidBridge.setImmersive(false); } catch(_){}
  }
  playerWrap.style.cursor="default";
}
function hideControls(){
  controls.classList.add("hidden");
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

playerWrap.addEventListener("touchstart",()=>{ if(!S.nativePlayback) resetHide(); },{passive:true});
vcont.addEventListener("click",e=>{
  if(S.nativePlayback){
    if(controls.classList.contains("hidden") || document.body.classList.contains("player-ui-hidden")) showControls();
    else hideControls();
    return;
  }
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
    seek(leftSide ? -5 : 5);
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
    } else {
      S.filters.brightness = next;
      applyFilters();
    }
    showGestureHud("brightness", "Brightness", next + "%", next);
  }
}, {passive:false});
vcont.addEventListener("touchend", e=>{
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
  if(isAndroidApp()){
    S.isLocked = false;
    $("btnLock")?.classList.remove("is-locked");
    controls.classList.remove("is-locked");
    $("ctrlDragHandle")?.classList.remove("locked");
    document.body.classList.remove("player-locked");
    $("screenLockBtn")?.classList.remove("active");
    $("iconUnlocked").style.display="block";
    $("iconLocked").style.display="none";
    showControls();
    showGestureHud("lock", "Controls", "Unlocked", 100);
    return;
  }
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
dragHandle.addEventListener("touchstart", e=>startDrag(e.touches[0]), {passive:true});

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
  stopNativePlayback();
  S.playlist.forEach(releaseItemUrl);
  S.playlist = [];
  S.currentIndex = -1;
  S.playing = false;
  S.srtCues = [];
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
  const backBtn = $("btnBack");
  if(backBtn) backBtn.style.display = "none";
  $("topbarTitle").textContent = "ENKRIT";
  $("ctrlFilename").textContent = "";
  document.title = "ENKRIT";
  renderPlaylist();
  updateMediaModeUI();
  if(typeof renderLibGrid === "function") renderLibGrid();
}

/* ── BACK TO LIBRARY ── */
const btnBack = $("btnBack");
if(btnBack){
  btnBack.addEventListener("click", backToLibrary);
  btnBack.addEventListener("mouseup", backToLibrary);
}

function backToLibrary(){
  saveResumePosition(true);
  stopNativePlayback();
  S.playing = false; S.currentIndex = -1;
  video.pause(); video.removeAttribute("src"); video.load();
  $("iconPlay").style.display = "block";
  $("iconPause").style.display = "none";
  vcont.style.display = "none";
  dropZone.style.display = "flex";
  controls.classList.remove("hidden");
  document.body.classList.remove("player-ui-hidden");
  if(btnBack) btnBack.style.display = "none";
  $("topbarTitle").textContent = "ENKRIT";
  document.title = "ENKRIT";
  updateMediaModeUI();
  if(typeof renderLibGrid === "function") renderLibGrid();
}

function removeFromPlaylist(i){
  if(S.currentIndex===i) stopNativePlayback();
  releaseItemUrl(S.playlist[i]);
  S.playlist.splice(i,1);
  if(S.currentIndex===i){
    S.currentIndex=-1;
    if(S.playlist.length>0) loadVideo(Math.min(i,S.playlist.length-1));
    else{
      video.pause();
      video.removeAttribute("src");
      video.load();
      vcont.style.display="none";
      dropZone.style.display="flex";
      document.body.classList.remove("player-ui-hidden");
      $("topbarTitle").textContent="ENKRIT";
      $("ctrlFilename").textContent="";
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
  setSubMenuOpen(!$("subMenu").classList.contains("open"));
  $("speedPanel").classList.remove("open");
  decoderPanel.classList.remove("open");
});
$("subOff").addEventListener("click",()=>{ setSubMode("off"); setSubMenuOpen(false); });
$("subAuto").addEventListener("click",()=>{
  setSubMenuOpen(false);
  startLocalWhisper();
});
$("subFile").addEventListener("click",()=>{ $("srtInput").click(); setSubMenuOpen(false); });
$("srtInput").addEventListener("change",e=>{
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=ev=>{ S.srtCues=parseSrt(ev.target.result); setSubMode("file"); showSubToast("SRT loaded ✓"); };
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

function showSubToast(msg, type){
  // Show in subtitle display area temporarily
  const el=$("subtitleDisplay");
  el.textContent=msg;
  el.className="subtitle-on sub-toast"+(type?" sub-toast-"+type:"");
  if(type==="success" || type==="info"){
    setTimeout(()=>{ el.className="subtitle-off"; el.textContent=""; },3000);
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
  kindFilter: "all",
  sortMode: (()=>{ try{ return localStorage.getItem("enkrit_sort") || "recent"; }catch(_){ return "recent"; } })(),
  searchQ: "",
};

// Init library on load
window.addEventListener("load", () => {
  setTimeout(initLibrary, 2200); // after splash
});

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
      const files = await window.libraryAPI.scanLibrary();
      LibState.allFiles = Array.isArray(files) ? files : [];
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

function syncDeletedMediaFromLibrary(){
  if(!LibState.allFiles.length) return;
  const live = new Set();
  LibState.allFiles.forEach(file => {
    if(file?.path) live.add(String(file.path).toLowerCase());
    live.add(mediaListKey(file));
  });
  const existsInLibrary = item => live.has(String(item?.path || "").toLowerCase()) || live.has(mediaListKey(item));
  const beforeRecent = LibState.recentFiles.length;
  LibState.recentFiles = LibState.recentFiles.filter(existsInLibrary);
  if(beforeRecent !== LibState.recentFiles.length) {
    try { localStorage.setItem("enkrit_recent", JSON.stringify(LibState.recentFiles)); } catch(_){}
  }
  const beforePlaylist = S.playlist.length;
  S.playlist = S.playlist.filter(item => {
    if(existsInLibrary(item)) return true;
    releaseItemUrl(item);
    return false;
  });
  if(S.playlist.length !== beforePlaylist) {
    if(S.currentIndex >= S.playlist.length) S.currentIndex = S.playlist.length - 1;
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

function renderLibGrid() {
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

  if(LibState.kindFilter !== "all") {
    files = files.filter(f => (LibState.kindFilter === "audio") === isAudioExt(f.name));
  }

  // Search filter
  if(LibState.searchQ) {
    files = files.filter(f => f.name.toLowerCase().includes(LibState.searchQ));
    // also search in allFiles for recent tab
    if(LibState.activeTab === "recent" && files.length === 0) {
      files = LibState.allFiles.filter(f => f.name.toLowerCase().includes(LibState.searchQ));
    }
  }
  files = sortMediaFiles(files.slice());

  if(files.length === 0) {
    grid.classList.add("is-empty");
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
  grid.style.display = "grid";
  if(empty) empty.style.display = "none";

  grid.innerHTML = files.map((f, i) => {
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
        ${mediaIcon}
        <div class="lib-card-play">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
        </div>
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
        <div class="lib-card-meta">${recentMeta(f, kind)}</div>
      </div>
    </div>
  `}).join("");

  // Click handlers
  grid.querySelectorAll(".lib-card").forEach(card => {
    card.addEventListener("click", () => {
      const idx = parseInt(card.dataset.idx);
      const filePath = card.dataset.path;
      const fileName = card.dataset.name;
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

  // Load video thumbnails async
  if(!isAndroidApp()) {
    files.forEach((f, i) => {
      if(f.path && isVideoExt(f.name)) loadThumb(f.path, i);
    });
  }
}

function openLibraryFile(filePath, fileName, fileObj) {
  if(!filePath) return;
  const item = makeMediaItemFromPath(filePath, fileName, fileObj);
  addToRecent({ name:item.name, path:filePath, ext:fileObj?.ext || item.ext || "", size:fileObj?.size || 0, kind:item.kind, durationMs:fileObj?.durationMs || 0, playedAt:Date.now() });

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
  v.src = toFileUrl(filePath);
  v.muted = true;
  v.preload = "metadata";
  v.currentTime = 5;
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
    v.remove();
  }, {once:true});
  v.addEventListener("error", ()=>v.remove(), {once:true});
  document.body.appendChild(v);
}

function fmtSize(bytes) {
  if(!bytes) return "";
  if(bytes > 1e9) return (bytes/1e9).toFixed(1)+" GB";
  if(bytes > 1e6) return (bytes/1e6).toFixed(0)+" MB";
  return (bytes/1e3).toFixed(0)+" KB";
}

function escAttr(s) { return esc(s).replace(/'/g,"&#39;"); }
