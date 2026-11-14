(function(){
  "use strict";

  /* ค่าตั้งต้น ปรับได้ในไฟล์ config.js */
  const CONFIG = Object.assign({
    SHEETS_URL: "",
    LOCAL_PIN: "1234",
    POLL_SECONDS: 8,
    CLASS_NAME: "Claude AI"
  }, window.ATTENDANCE_CONFIG || {});

  // ชื่อคลาสบนหน้าเว็บ
  document.getElementById("title").innerHTML = '<small>ใบเช็คชื่อผู้เข้าเรียน</small>' +
    String(CONFIG.CLASS_NAME).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  document.title = "เช็คชื่อ คลาส " + CONFIG.CLASS_NAME;

  const S = {
    students:new Map(), checkins:new Map(),
    settings:{start:"09:00", grace:15},
    date:todayStr(), lastDate:null, filter:"all", q:"",
    admin:false, pin:"", loaded:false, busy:false, current:null, flash:new Set()
  };
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  function todayStr(){ return new Date().toLocaleDateString("en-CA"); }
  function fmtTime(d){ return d.toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit",hour12:false}); }
  function fmtDate(str){
    const [y,m,d] = str.split("-").map(Number);
    return new Date(y,m-1,d).toLocaleDateString("th-TH",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  }
  function isLate(iso){
    if(!S.settings.start) return false;
    const t = new Date(iso); const [h,m] = S.settings.start.split(":").map(Number);
    const limit = new Date(t); limit.setHours(h, m + Number(S.settings.grace||0), 0, 0);
    return t > limit;
  }
  function minsLate(iso){
    if(!S.settings.start) return 0;
    const t = new Date(iso); const [h,m] = S.settings.start.split(":").map(Number);
    const st = new Date(t); st.setHours(h,m,0,0);
    return Math.max(0, Math.round((t-st)/60000));
  }
  function cleanId(s){ return String(s || "").trim().replace(/[^A-Za-z0-9_\-.~:@+]/g, "").slice(0, 60); }
  function newId(){ return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- ที่เก็บข้อมูลในเครื่อง (เมื่อไม่ได้ตั้ง SHEETS_URL) ---------- */
  const LKEY = "claude-ai-attendance-v1";
  const blank = () => ({students:[], checkins:{}, settings:{start:"09:00", grace:15}});
  function lload(){ try{ return JSON.parse(localStorage.getItem(LKEY)) || blank(); }catch(e){ return blank(); } }
  function lsave(st){ try{ localStorage.setItem(LKEY, JSON.stringify(st)); }catch(e){ throw new Error("พื้นที่เก็บข้อมูลในเบราว์เซอร์เต็ม"); } }
  function needPin(d){ if(String(d.pin) !== String(CONFIG.LOCAL_PIN)) throw new Error("PIN ไม่ถูกต้อง"); }
  function mergeStudents(list, people){
    const names = new Set(list.map(s => s.name.trim())), ids = new Set(list.map(s => s.id));
    let order = list.reduce((m,s) => Math.max(m, s.order||0), 0) + 1, added = 0, skipped = 0;
    for(const p of people){
      if(names.has(p.name)){ skipped++; continue; }
      let id = cleanId(p.code) || newId(); if(ids.has(id)) id = newId();
      list.push({id, code:p.code||"", name:p.name, order:order++});
      names.add(p.name); ids.add(id); added++;
    }
    return {added, skipped};
  }
  function local(action, d){
    const st = lload();
    switch(action){
      case "load": return {students:st.students, checkins:Object.values(st.checkins[d.date]||{}), settings:st.settings};
      case "auth": needPin(d); return {};
      case "checkin": {
        const day = st.checkins[d.date] = st.checkins[d.date] || {};
        if(day[d.record.studentId]) return {existed:true};
        day[d.record.studentId] = d.record; lsave(st); return {};
      }
      case "undo": needPin(d); if(st.checkins[d.date]) delete st.checkins[d.date][d.studentId]; lsave(st); return {};
      case "addStudents": { needPin(d); const r = mergeStudents(st.students, d.people); lsave(st); return r; }
      case "clearStudents": needPin(d); st.students = []; lsave(st); return {};
      case "saveSettings": needPin(d); st.settings = {start:d.start, grace:d.grace}; lsave(st); return {};
    }
    throw new Error("ไม่รู้จักคำสั่ง " + action);
  }

  /* ---------- เรียกข้อมูล: Google Sheets หรือในเครื่อง ---------- */
  async function api(action, d){
    const body = Object.assign({action, pin:S.pin}, d || {});
    if(!CONFIG.SHEETS_URL) return Object.assign({ok:true}, local(action, body));
    let res;
    try{
      res = await fetch(CONFIG.SHEETS_URL, {method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body:JSON.stringify(body)});
    }catch(e){ throw new Error("เชื่อมต่อ Google Sheets ไม่ได้ ตรวจอินเทอร์เน็ตและ SHEETS_URL"); }
    if(!res.ok) throw new Error("Google Sheets ตอบกลับผิดพลาด (" + res.status + ")");
    const j = await res.json();
    if(!j.ok) throw new Error(j.error || "เกิดข้อผิดพลาด");
    return j;
  }

  /* ---------- นาฬิกา ---------- */
  function tick(){
    const n = new Date();
    const hh = String(n.getHours()).padStart(2,"0"), mm = String(n.getMinutes()).padStart(2,"0"), ss = String(n.getSeconds()).padStart(2,"0");
    $("clock").innerHTML = hh + ":" + mm + '<span class="sec">' + ss + "</span>";
    const mt = document.querySelector("#mClock"); if(mt) mt.textContent = hh + ":" + mm + ":" + ss;
  }
  tick(); setInterval(tick, 1000);

  /* ---------- โหลดและอัปเดตข้อมูล ---------- */
  async function refresh(){
    if(S.busy) return; S.busy = true;
    const date = S.date;
    try{
      const have = [...S.checkins.entries()].filter(([, c]) => c.sig).map(([id]) => id);
      const r = await api("load", {date, have});
      if(date !== S.date) return;
      S.students = new Map((r.students||[]).map(s => [String(s.id), Object.assign({}, s, {id:String(s.id)})]));
      const same = S.loaded && S.lastDate === date;
      const m = new Map();
      (r.checkins||[]).forEach(c => {
        const id = String(c.studentId), old = S.checkins.get(id);
        if(!c.sig && old && old.sig) c = Object.assign({}, c, {sig:old.sig});
        m.set(id, c);
        if(same && !old) S.flash.add(id);
      });
      S.checkins = m;
      if(r.settings){
        S.settings = {start:String(r.settings.start||""), grace:Number(r.settings.grace)||0};
        if(document.activeElement !== $("startTime") && document.activeElement !== $("grace")){
          $("startTime").value = S.settings.start; $("grace").value = S.settings.grace;
        }
      }
      S.loaded = true; S.lastDate = date;
      setSync((CONFIG.SHEETS_URL ? "เชื่อมต่อ Google Sheets แล้ว" : "เก็บข้อมูลในเครื่องนี้") + " อัปเดตเมื่อ " + new Date().toLocaleTimeString("th-TH",{hour12:false}));
      render();
    }catch(e){
      setSync("โหลดข้อมูลไม่ได้: " + e.message, true);
      if(!S.loaded) $("list").innerHTML = '<div class="empty"><h3>โหลดรายชื่อไม่ได้</h3><p>' + esc(e.message) + '</p></div>';
    }finally{ S.busy = false; }
  }
  function setSync(t, err){ const el = $("sync"); el.textContent = t; el.classList.toggle("err", !!err); }

  /* ---------- แสดงผล ---------- */
  function sortedStudents(){
    return [...S.students.values()].sort((a,b) => (Number(a.order)||0) - (Number(b.order)||0) || String(a.name).localeCompare(String(b.name),"th"));
  }
  function render(){
    const isToday = S.date === todayStr();
    $("dateText").textContent = fmtDate(S.date) + (isToday ? "" : " (ย้อนหลัง)");
    $("startNote").textContent = S.settings.start ? "เริ่มคลาส " + S.settings.start + " น." : "";

    const all = sortedStudents().filter(s => s.name);
    const present = all.filter(s => S.checkins.has(s.id));
    const late = present.filter(s => isLate(S.checkins.get(s.id).time));
    $("tallyText").innerHTML =
      '<span><b>' + present.length + '</b>มาแล้ว จาก ' + all.length + ' คน</span>' +
      (late.length ? '<span><b>' + late.length + '</b>มาสาย</span>' : '') +
      '<span><b>' + (all.length - present.length) + '</b>ยังไม่มา</span>';
    $("seeds").innerHTML = all.map(s => {
      const c = S.checkins.get(s.id);
      return '<span class="seed' + (c ? (isLate(c.time) ? " on late" : " on") : "") + '"></span>';
    }).join("");

    if(!S.loaded) return;
    if(all.length === 0){
      $("list").innerHTML = S.admin
        ? '<div class="empty"><h3>ยังไม่มีรายชื่อผู้เรียน</h3><p>นำเข้าไฟล์ CSV หรือ Excel ใน “เครื่องมือผู้สอน” ด้านล่าง</p></div>'
        : '<div class="empty"><h3>ยังไม่มีรายชื่อผู้เรียน</h3><p>ผู้สอนกด “โหมดผู้สอน” ท้ายหน้าเพื่อนำเข้ารายชื่อ</p></div>';
      if(S.admin) $("tools").open = true;
      return;
    }
    const q = S.q.trim().toLowerCase();
    const idx = new Map(all.map((s,i) => [s.id, i+1]));
    const rows = all.filter(s => {
      const c = S.checkins.has(s.id);
      if(S.filter === "in" && !c) return false;
      if(S.filter === "out" && c) return false;
      if(q && !(String(s.name).toLowerCase().includes(q) || String(s.code||"").toLowerCase().includes(q))) return false;
      return true;
    });
    if(rows.length === 0){
      $("list").innerHTML = '<div class="empty"><h3>ไม่พบรายชื่อ</h3><p>ลองพิมพ์ชื่อสั้นลง หรือเปลี่ยนตัวกรอง</p></div>';
      return;
    }
    $("list").innerHTML = rows.map(s => {
      const c = S.checkins.get(s.id);
      let sub = s.code ? '<span>' + esc(s.code) + '</span>' : '';
      let action, sig = '<span class="sig-empty"></span>';
      if(c){
        const t = new Date(c.time), lt = isLate(c.time);
        sub += lt
          ? '<span class="chip late">มา ' + fmtTime(t) + ' น. สาย ' + minsLate(c.time) + ' นาที</span>'
          : '<span class="chip ok">มา ' + fmtTime(t) + ' น.</span>';
        if(c.sig) sig = '<img class="sig-thumb" alt="ลายเซ็นของ ' + esc(s.name) + '" src="' + esc(c.sig) + '" data-view="' + esc(s.id) + '">';
        action = '<button class="btn btn-done" data-view="' + esc(s.id) + '">เช็คแล้ว ✓</button>';
      } else {
        action = '<button class="btn btn-go" data-sign="' + esc(s.id) + '"' + (isToday ? "" : " disabled") + '>เช็คชื่อ</button>';
      }
      return '<div class="row' + (c ? " present" : "") + (S.flash.has(s.id) ? " flash" : "") + '">' +
        '<div class="no">' + idx.get(s.id) + '</div>' +
        '<div class="who"><div class="name">' + esc(s.name) + '</div><div class="sub">' + sub + '</div></div>' +
        '<div class="sig-cell">' + sig + '</div><div>' + action + '</div></div>';
    }).join("");
    S.flash.clear();
    $("note").textContent = isToday ? "" : "กำลังดูข้อมูลย้อนหลัง เช็คชื่อได้เฉพาะวันนี้";
  }

  /* ---------- หน้าต่างเซ็นชื่อ ---------- */
  function openSign(id){
    const s = S.students.get(id); if(!s) return;
    S.current = id;
    $("modal").innerHTML =
      '<div class="m-head"><div><p class="sub" style="margin:0">ยืนยันการเข้าเรียน</p><h2 class="m-name" id="mName">' + esc(s.name) + '</h2></div>' +
      '<div class="m-time"><b id="mClock"></b><span>เวลาที่จะบันทึก</span></div></div>' +
      '<div class="padwrap"><canvas id="pad" aria-label="ช่องเซ็นชื่อ"></canvas><div class="padline"></div><div class="padhint" id="padHint">เซ็นชื่อด้วยนิ้วหรือเมาส์</div></div>' +
      '<div class="status err" id="mErr"></div>' +
      '<div class="m-actions"><button class="btn btn-ghost" id="clearPad">ล้างลายเซ็น</button>' +
      '<div class="right"><button class="btn btn-ghost" id="mCancel">ยกเลิก</button><button class="btn btn-go" id="mOk">ยืนยันเข้าเรียน</button></div></div>';
    $("scrim").classList.add("open");
    tick(); setupPad();
    $("mCancel").onclick = closeModal;
    $("mOk").onclick = confirmSign;
  }
  function openView(id){
    const s = S.students.get(id), c = S.checkins.get(id); if(!s || !c) return;
    S.current = id;
    const t = new Date(c.time);
    $("modal").innerHTML =
      '<div class="m-head"><div><p class="sub" style="margin:0">เช็คชื่อแล้ว</p><h2 class="m-name" id="mName">' + esc(s.name) + '</h2></div>' +
      '<div class="m-time"><b>' + fmtTime(t) + '</b><span>' + (isLate(c.time) ? "สาย " + minsLate(c.time) + " นาที" : "ตรงเวลา") + '</span></div></div>' +
      (c.sig ? '<img class="bigsig" alt="ลายเซ็น" src="' + esc(c.sig) + '">' : '') +
      '<div class="status err" id="mErr"></div>' +
      '<div class="m-actions">' + (S.admin ? '<button class="btn btn-danger" id="mUndo">ยกเลิกการเช็คชื่อ</button>' : '<span></span>') +
      '<div class="right"><button class="btn btn-go" id="mCancel">ปิด</button></div></div>';
    $("scrim").classList.add("open");
    $("mCancel").onclick = closeModal;
    if($("mUndo")) $("mUndo").onclick = async () => {
      $("mUndo").disabled = true;
      try{ await api("undo", {date:S.date, studentId:id}); S.checkins.delete(id); closeModal(); render(); refresh(); }
      catch(e){ $("mUndo").disabled = false; $("mErr").textContent = e.message; }
    };
  }
  function closeModal(){ $("scrim").classList.remove("open"); $("modal").innerHTML = ""; S.current = null; }
  $("scrim").addEventListener("click", e => { if(e.target === $("scrim")) closeModal(); });
  document.addEventListener("keydown", e => { if(e.key === "Escape" && S.current) closeModal(); });

  let pad = null;
  function setupPad(){
    const cv = $("pad"), ctx = cv.getContext("2d");
    pad = {cv, ctx, ink:false, drawing:false, last:null};
    sizePad();
    const pos = e => { const b = cv.getBoundingClientRect(); return {x:e.clientX-b.left, y:e.clientY-b.top}; };
    cv.onpointerdown = e => {
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      pad.drawing = true; pad.last = pos(e);
      ctx.beginPath(); ctx.arc(pad.last.x, pad.last.y, 1.2, 0, Math.PI*2); ctx.fillStyle = "#0F3B27"; ctx.fill();
      if(!pad.ink){ pad.ink = true; $("padHint").style.display = "none"; $("mErr").textContent = ""; }
    };
    cv.onpointermove = e => {
      if(!pad.drawing) return;
      const p = pos(e), l = pad.last, mid = {x:(l.x+p.x)/2, y:(l.y+p.y)/2};
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.quadraticCurveTo(l.x, l.y, mid.x, mid.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      pad.last = p;
    };
    cv.onpointerup = cv.onpointercancel = () => { pad.drawing = false; };
    $("clearPad").onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); pad.ink = false; $("padHint").style.display = ""; };
  }
  function sizePad(){
    if(!pad) return;
    const cv = pad.cv, ctx = pad.ctx;
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if(!w || !h || (w === cv.width && h === cv.height)) return;
    let copy = null;
    if(pad.ink && cv.width){ copy = document.createElement("canvas"); copy.width = cv.width; copy.height = cv.height; copy.getContext("2d").drawImage(cv, 0, 0); }
    cv.width = w; cv.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if(copy) ctx.drawImage(copy, 0, 0, w, h);
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0F3B27"; ctx.lineWidth = 2.6;
  }
  let resizeT = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if(pad && $("pad") === pad.cv) sizePad(); }, 120);
  });
  function exportSig(){
    // ขนาดเล็กพอจะเก็บในเซลล์ Google Sheets ได้ (จำกัด 50,000 ตัวอักษร)
    const w = 360, h = Math.round(w * pad.cv.height / pad.cv.width);
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    out.getContext("2d").drawImage(pad.cv, 0, 0, w, h);
    return out.toDataURL("image/png");
  }
  async function confirmSign(){
    if(!pad || !pad.ink){ $("mErr").textContent = "กรุณาเซ็นชื่อก่อนกดยืนยัน"; return; }
    const id = S.current, s = S.students.get(id);
    const btn = $("mOk"); btn.disabled = true; btn.textContent = "กำลังบันทึก";
    const now = new Date(), iso = now.toISOString(), lt = isLate(iso);
    const record = {
      studentId:id, name:s.name, code:s.code || "", time:iso, timeText:fmtTime(now),
      status: lt ? "สาย" : "มาเรียน", lateMinutes: lt ? minsLate(iso) : 0, sig: exportSig()
    };
    try{
      await api("checkin", {date:S.date, record});
      S.checkins.set(id, record); S.flash.add(id);
      closeModal(); render(); refresh();
    }catch(e){
      btn.disabled = false; btn.textContent = "ยืนยันเข้าเรียน";
      $("mErr").textContent = "บันทึกไม่สำเร็จ: " + e.message;
    }
  }

  /* ---------- การใช้งานรายชื่อ ---------- */
  $("list").addEventListener("click", e => {
    const sign = e.target.closest("[data-sign]"); if(sign && !sign.disabled) return openSign(sign.dataset.sign);
    const view = e.target.closest("[data-view]"); if(view) return openView(view.dataset.view);
  });
  $("q").addEventListener("input", e => { S.q = e.target.value; render(); });
  document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
    S.filter = b.dataset.f;
    document.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }));
  function setDate(d){ S.date = d; S.checkins = new Map(); render(); refresh(); }
  $("dateInput").addEventListener("change", e => { if(e.target.value) setDate(e.target.value); });

  /* ---------- โหมดผู้สอน ---------- */
  function applyAdmin(){
    $("tools").hidden = !S.admin; $("dateWrap").hidden = !S.admin;
    $("adminBtn").textContent = S.admin ? "ออกจากโหมดผู้สอน" : "โหมดผู้สอน";
    $("dateInput").value = S.date;
    if(!S.admin && S.date !== todayStr()) setDate(todayStr()); else render();
  }
  $("adminBtn").addEventListener("click", async () => {
    if(S.admin){
      S.admin = false; S.pin = "";
      try{ sessionStorage.removeItem("att-pin"); }catch(e){}
      applyAdmin(); return;
    }
    const pin = prompt("ใส่ PIN ผู้สอน");
    if(pin === null) return;
    S.pin = pin;
    try{
      await api("auth");
      S.admin = true;
      try{ sessionStorage.setItem("att-pin", pin); }catch(e){}
      applyAdmin();
    }catch(e){ S.pin = ""; alert(e.message); }
  });

  function parseRows(rows){
    rows = rows.filter(r => r && r.some(c => String(c ?? "").trim() !== ""));
    if(!rows.length) return [];
    const head = rows[0].map(c => String(c ?? "").trim().toLowerCase());
    const find = re => head.findIndex(h => re.test(h));
    let iLast = find(/นามสกุล|surname|last ?name/);
    let iFirst = head.findIndex((h, i) => i !== iLast && /ชื่อ|name|first/.test(h));
    let iCode = find(/รหัส|^id$|code|student ?id|เลขประจำตัว/);
    let body = rows;
    if(iFirst >= 0 || iCode >= 0){ body = rows.slice(1); }
    else {
      const r0 = rows[0];
      if(r0.length >= 2 && /^\d+$/.test(String(r0[0]).trim())){ iCode = 0; iFirst = 1; } else iFirst = 0;
      iLast = -1;
    }
    if(iFirst < 0) iFirst = iCode === 0 ? 1 : 0;
    return body.map(r => {
      const name = [r[iFirst], iLast >= 0 ? r[iLast] : ""].map(x => String(x ?? "").trim()).filter(Boolean).join(" ");
      const code = iCode >= 0 ? String(r[iCode] ?? "").trim() : "";
      return {name, code};
    }).filter(p => p.name && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(p.name) && p.name.length <= 120);
  }
  async function importPeople(people, st){
    st.classList.remove("err"); st.textContent = "กำลังเพิ่ม " + people.length + " คน";
    try{
      const r = await api("addStudents", {people});
      st.textContent = "เพิ่มแล้ว " + r.added + " คน" + (r.skipped ? " (ข้ามชื่อซ้ำ " + r.skipped + " คน)" : "");
      refresh();
    }catch(e){ st.classList.add("err"); st.textContent = "เพิ่มไม่สำเร็จ: " + e.message; }
  }
  async function handleFile(file){
    const st = $("importStatus"); st.classList.remove("err");
    if(!file) return;
    if(typeof XLSX === "undefined"){ st.classList.add("err"); st.textContent = "โหลดตัวอ่านไฟล์ไม่สำเร็จ ลองรีเฟรชหน้า"; return; }
    st.textContent = "กำลังอ่าน " + file.name;
    try{
      const buf = await file.arrayBuffer();
      const b = new Uint8Array(buf.slice(0, 4));
      const isExcel = (b[0] === 0x50 && b[1] === 0x4B) || (b[0] === 0xD0 && b[1] === 0xCF);
      const wb = isExcel ? XLSX.read(buf, {type:"array"}) : XLSX.read(new TextDecoder("utf-8").decode(buf), {type:"string", raw:true});
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, defval:"", raw:false});
      const people = parseRows(rows);
      if(!people.length){ st.classList.add("err"); st.textContent = "ไม่พบรายชื่อในไฟล์ ตรวจว่ามีคอลัมน์ชื่ออยู่ในชีตแรก"; }
      else await importPeople(people, st);
    }catch(e){ st.classList.add("err"); st.textContent = "อ่านไฟล์ไม่ได้ ตรวจว่าเป็น CSV หรือ Excel"; }
    $("file").value = "";
  }
  $("file").addEventListener("change", e => handleFile(e.target.files[0]));
  const drop = $("drop");
  ["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => handleFile(e.dataTransfer.files[0]));

  $("addBtn").addEventListener("click", async () => {
    const v = $("addName").value.trim(), st = $("addStatus");
    if(!v){ st.classList.add("err"); st.textContent = "พิมพ์ชื่อก่อนกดเพิ่ม"; return; }
    await importPeople([{name:v, code:""}], st);
    $("addName").value = "";
  });
  $("addName").addEventListener("keydown", e => { if(e.key === "Enter") $("addBtn").click(); });

  $("saveSettings").addEventListener("click", async () => {
    const st = $("setStatus");
    const data = {start:$("startTime").value || "", grace:Math.max(0, Number($("grace").value) || 0)};
    try{ await api("saveSettings", data); S.settings = data; st.classList.remove("err"); st.textContent = "บันทึกเวลาเริ่มคลาสแล้ว"; render(); }
    catch(e){ st.classList.add("err"); st.textContent = "บันทึกไม่สำเร็จ: " + e.message; }
  });

  $("exportBtn").addEventListener("click", () => {
    const lines = [["ลำดับ","รหัส","ชื่อ","วันที่","สถานะ","เวลามา","สายกี่นาที","เซ็นชื่อแล้ว"]];
    sortedStudents().forEach((s, i) => {
      const c = S.checkins.get(s.id);
      lines.push([i+1, s.code || "", s.name, S.date,
        c ? (isLate(c.time) ? "สาย" : "มาเรียน") : "ขาด",
        c ? fmtTime(new Date(c.time)) : "",
        c && isLate(c.time) ? minsLate(c.time) : "",
        c && c.sig ? "ใช่" : ""]);
    });
    const csv = "\uFEFF" + lines.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
    a.download = "attendance-claude-ai-" + S.date + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    $("exportStatus").textContent = "ดาวน์โหลดแล้ว";
  });

  $("clearBtn").addEventListener("click", async () => {
    const st = $("exportStatus");
    if(!S.students.size) return;
    if(!confirm("ลบรายชื่อผู้เรียนทั้งหมด " + S.students.size + " คน? ประวัติการเช็คชื่อยังเก็บไว้")) return;
    try{ await api("clearStudents"); st.classList.remove("err"); st.textContent = "ลบรายชื่อแล้ว"; refresh(); }
    catch(e){ st.classList.add("err"); st.textContent = "ลบไม่สำเร็จ: " + e.message; }
  });

  /* ---------- เริ่มทำงาน ---------- */
  async function start(){
    render();
    await refresh();
    try{
      const saved = sessionStorage.getItem("att-pin");
      if(saved){ S.pin = saved; await api("auth"); S.admin = true; applyAdmin(); }
    }catch(e){ S.pin = ""; }
    if(CONFIG.SHEETS_URL){
      setInterval(() => { if(!document.hidden) refresh(); }, Math.max(3, CONFIG.POLL_SECONDS) * 1000);
      document.addEventListener("visibilitychange", () => { if(!document.hidden) refresh(); });
    } else {
      window.addEventListener("storage", e => { if(e.key === LKEY) refresh(); });
    }
    setInterval(() => { if(!S.admin && S.date !== todayStr()) setDate(todayStr()); }, 60000);
  }
  start();
})();
