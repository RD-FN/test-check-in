/* เว็บเช็คชื่อ คลาส Claude AI : ทำงานกับ Supabase (ฐานข้อมูล ล็อกอิน และอัปเดตแบบเรียลไทม์) */
(function(){
  "use strict";

  const CFG = Object.assign({
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    ADMIN_EMAIL_HINT: "",
    TIMEZONE: "Asia/Bangkok"
  }, window.ATTENDANCE_CONFIG || {});
  const TZ = CFG.TIMEZONE;

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  const S = {
    students:new Map(),          // id -> student
    checkins:new Map(),          // student_id -> checkin
    sigs:new Map(),              // checkin_id -> signature (ผู้สอนเท่านั้น)
    settings:{class_name:"Claude AI", start_time:"09:00", grace_minutes:15},
    date:todayStr(), filter:"all", q:"",
    admin:false, email:"", uid:null,
    loaded:false, current:null, flash:new Set()
  };

  /* ---------- เวลา (เวลาประเทศไทยเสมอ ไม่ขึ้นกับนาฬิกาเครื่อง) ---------- */
  function todayStr(){
    return new Intl.DateTimeFormat("en-CA", {timeZone:TZ, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
  }
  function fmtTime(iso){ return new Date(iso).toLocaleTimeString("th-TH", {hour:"2-digit", minute:"2-digit", hour12:false, timeZone:TZ}); }
  function fmtDate(str){
    const [y,m,d] = str.split("-").map(Number);
    return new Date(Date.UTC(y, m-1, d, 12)).toLocaleDateString("th-TH", {weekday:"long", day:"numeric", month:"long", year:"numeric", timeZone:TZ});
  }
  const hhmm = t => String(t || "").slice(0, 5);
  function clockParts(){
    const p = {};
    new Intl.DateTimeFormat("en-GB", {timeZone:TZ, hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false})
      .formatToParts(new Date()).forEach(x => p[x.type] = x.value);
    return p;
  }
  function tick(){
    const p = clockParts();
    $("clock").innerHTML = p.hour + ":" + p.minute + '<span class="sec">' + p.second + "</span>";
    const mt = document.querySelector("#mClock"); if(mt) mt.textContent = p.hour + ":" + p.minute + ":" + p.second;
  }
  tick(); setInterval(tick, 1000);

  function setSync(t, err){ const el = $("sync"); el.textContent = t; el.classList.toggle("err", !!err); }
  function listMsg(h, p){ $("list").innerHTML = '<div class="empty"><h3>' + esc(h) + '</h3><p>' + esc(p) + '</p></div>'; }
  const errText = e => (e && (e.message || e.error_description || e.msg)) || "เกิดข้อผิดพลาด";

  if(!window.supabase || !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY){
    setSync("ยังไม่ได้ตั้งค่า Supabase ใน config.js", true);
    listMsg("ยังเชื่อมต่อฐานข้อมูลไม่ได้", "ตรวจค่า SUPABASE_URL และ SUPABASE_ANON_KEY ใน config.js หรือการเชื่อมต่ออินเทอร์เน็ต");
    return;
  }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, flowType:"pkce"}
  });

  /* ---------- โหลดข้อมูล ---------- */
  let loading = null, again = false;
  async function load(){
    if(loading){ again = true; return loading; }
    loading = (async () => {
      do {
        again = false;
        const date = S.date;
        const [st, se, ci] = await Promise.all([
          sb.from("students").select("id,code,name,sort_order").order("sort_order").order("name").limit(5000),
          sb.from("settings").select("class_name,start_time,grace_minutes").eq("id", 1).maybeSingle(),
          sb.from("checkins").select("id,student_id,student_name,student_code,class_date,checked_at,status,late_minutes").eq("class_date", date).limit(5000)
        ]);
        for(const r of [st, se, ci]) if(r.error) throw r.error;
        if(date !== S.date){ again = true; continue; }
        S.students = new Map(st.data.map(s => [s.id, s]));
        if(se.data) S.settings = se.data;
        const m = new Map();
        ci.data.forEach(c => { if(c.student_id) m.set(c.student_id, c); });
        S.checkins = m;
        if(S.admin) await loadSigs(); else S.sigs = new Map();
        S.loaded = true;
        applySettingsInputs();
        render();
      } while(again);
    })();
    try{ await loading; setSync("เชื่อมต่อฐานข้อมูลแล้ว อัปเดตอัตโนมัติ"); }
    catch(e){
      setSync("โหลดข้อมูลไม่ได้: " + errText(e), true);
      if(!S.loaded) listMsg("โหลดรายชื่อไม่ได้", errText(e));
    }
    finally{ loading = null; }
  }
  async function loadSigs(){
    const ids = [...S.checkins.values()].map(c => c.id).filter(id => !S.sigs.has(id));
    for(let i = 0; i < ids.length; i += 100){
      const {data, error} = await sb.from("checkin_signatures").select("checkin_id,signature").in("checkin_id", ids.slice(i, i+100));
      if(error) throw error;
      data.forEach(r => S.sigs.set(r.checkin_id, r.signature));
    }
  }
  let reloadT = null;
  function scheduleLoad(){ clearTimeout(reloadT); reloadT = setTimeout(load, 200); }

  function subscribe(){
    sb.channel("attendance")
      .on("postgres_changes", {event:"*", schema:"public", table:"checkins"}, p => {
        if(p.eventType === "INSERT" && p.new && p.new.class_date === S.date && p.new.student_id) S.flash.add(p.new.student_id);
        scheduleLoad();
      })
      .on("postgres_changes", {event:"*", schema:"public", table:"students"}, scheduleLoad)
      .on("postgres_changes", {event:"*", schema:"public", table:"settings"}, scheduleLoad)
      .subscribe(status => {
        if(status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSync("การอัปเดตอัตโนมัติขัดข้อง กำลังลองใหม่", true);
        if(status === "SUBSCRIBED" && S.loaded) setSync("เชื่อมต่อฐานข้อมูลแล้ว อัปเดตอัตโนมัติ");
      });
    // สำรองไว้ เผื่อการเชื่อมต่อแบบเรียลไทม์หลุด
    setInterval(() => { if(!document.hidden) load(); }, 60000);
    document.addEventListener("visibilitychange", () => { if(!document.hidden) load(); });
  }

  /* ---------- แสดงผล ---------- */
  function sortedStudents(){ return [...S.students.values()]; }
  function applySettingsInputs(){
    const cn = S.settings.class_name || "Claude AI";
    $("className").textContent = cn;
    document.title = "เช็คชื่อ คลาส " + cn;
    const busy = [$("startTime"), $("grace"), $("classNameInput")].includes(document.activeElement);
    if(!busy){
      $("startTime").value = hhmm(S.settings.start_time);
      $("grace").value = S.settings.grace_minutes;
      $("classNameInput").value = cn;
    }
  }
  function render(){
    const isToday = S.date === todayStr();
    $("dateText").textContent = fmtDate(S.date) + (isToday ? "" : " (ย้อนหลัง)");
    $("startNote").textContent = S.settings.start_time ? "เริ่มคลาส " + hhmm(S.settings.start_time) + " น." : "";

    const all = sortedStudents();
    const present = all.filter(s => S.checkins.has(s.id));
    const late = present.filter(s => S.checkins.get(s.id).status === "late");
    $("tallyText").innerHTML =
      '<span><b>' + present.length + '</b>มาแล้ว จาก ' + all.length + ' คน</span>' +
      (late.length ? '<span><b>' + late.length + '</b>มาสาย</span>' : '') +
      '<span><b>' + (all.length - present.length) + '</b>ยังไม่มา</span>';
    $("seeds").innerHTML = all.map(s => {
      const c = S.checkins.get(s.id);
      return '<span class="seed' + (c ? (c.status === "late" ? " on late" : " on") : "") + '"></span>';
    }).join("");

    if(!S.loaded) return;
    if(all.length === 0){
      if(S.admin){ listMsg("ยังไม่มีรายชื่อผู้เรียน", "นำเข้าไฟล์ CSV หรือ Excel ใน “เครื่องมือผู้สอน” ด้านล่าง"); $("tools").open = true; }
      else listMsg("ยังไม่มีรายชื่อผู้เรียน", "ผู้สอนจะเพิ่มรายชื่อก่อนเริ่มคลาส");
      return;
    }
    const q = S.q.trim().toLowerCase();
    const idx = new Map(all.map((s,i) => [s.id, i+1]));
    const rows = all.filter(s => {
      const c = S.checkins.has(s.id);
      if(S.filter === "in" && !c) return false;
      if(S.filter === "out" && c) return false;
      if(q && !(String(s.name).toLowerCase().includes(q) || String(s.code || "").toLowerCase().includes(q))) return false;
      return true;
    });
    if(rows.length === 0){ listMsg("ไม่พบรายชื่อ", "ลองพิมพ์ชื่อสั้นลง หรือเปลี่ยนตัวกรอง"); return; }
    $("list").innerHTML = rows.map(s => {
      const c = S.checkins.get(s.id);
      let sub = s.code ? '<span>' + esc(s.code) + '</span>' : '';
      let action, sig = '<span class="sig-empty"></span>';
      if(c){
        sub += c.status === "late"
          ? '<span class="chip late">มา ' + fmtTime(c.checked_at) + ' น. สาย ' + c.late_minutes + ' นาที</span>'
          : '<span class="chip ok">มา ' + fmtTime(c.checked_at) + ' น.</span>';
        const img = S.admin && S.sigs.get(c.id);
        sig = img
          ? '<img class="sig-thumb" alt="ลายเซ็นของ ' + esc(s.name) + '" src="' + esc(img) + '" data-view="' + esc(s.id) + '">'
          : '<span class="chip signed">✍ เซ็นแล้ว</span>';
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

  /* ---------- หน้าต่าง (modal) ---------- */
  function openModal(html, key){
    S.current = key;
    $("modal").innerHTML = html;
    $("scrim").classList.add("open");
  }
  function closeModal(){ $("scrim").classList.remove("open"); $("modal").innerHTML = ""; S.current = null; }
  $("scrim").addEventListener("click", e => { if(S.current && e.target === $("scrim")) closeModal(); });
  document.addEventListener("keydown", e => { if(e.key === "Escape" && S.current) closeModal(); });

  function openSign(id){
    const s = S.students.get(id); if(!s) return;
    openModal(
      '<div class="m-head"><div><p class="sub" style="margin:0">ยืนยันการเข้าเรียน</p><h2 class="m-name" id="mName">' + esc(s.name) + '</h2></div>' +
      '<div class="m-time"><b id="mClock"></b><span>เวลาที่จะบันทึก</span></div></div>' +
      '<div class="padwrap"><canvas id="pad" aria-label="ช่องเซ็นชื่อ"></canvas><div class="padline"></div><div class="padhint" id="padHint">เซ็นชื่อด้วยนิ้วหรือเมาส์</div></div>' +
      '<div class="status err" id="mErr"></div>' +
      '<div class="m-actions"><button class="btn btn-ghost" id="clearPad">ล้างลายเซ็น</button>' +
      '<div class="right"><button class="btn btn-ghost" id="mCancel">ยกเลิก</button><button class="btn btn-go" id="mOk">ยืนยันเข้าเรียน</button></div></div>', id);
    tick(); setupPad();
    $("mCancel").onclick = closeModal;
    $("mOk").onclick = () => confirmSign(id);
  }
  function openView(id){
    const s = S.students.get(id), c = S.checkins.get(id); if(!s || !c) return;
    const img = S.admin && S.sigs.get(c.id);
    openModal(
      '<div class="m-head"><div><p class="sub" style="margin:0">เช็คชื่อแล้ว</p><h2 class="m-name" id="mName">' + esc(s.name) + '</h2></div>' +
      '<div class="m-time"><b>' + fmtTime(c.checked_at) + '</b><span>' + (c.status === "late" ? "สาย " + c.late_minutes + " นาที" : "ตรงเวลา") + '</span></div></div>' +
      (img ? '<img class="bigsig" alt="ลายเซ็น" src="' + esc(img) + '">' : '<p class="note">' + (S.admin ? "ไม่มีลายเซ็นในระบบ" : "ลายเซ็นดูได้เฉพาะผู้สอน") + '</p>') +
      '<div class="status err" id="mErr"></div>' +
      '<div class="m-actions">' + (S.admin ? '<button class="btn btn-danger" id="mUndo">ยกเลิกการเช็คชื่อ</button>' : '<span></span>') +
      '<div class="right"><button class="btn btn-go" id="mCancel">ปิด</button></div></div>', id);
    $("mCancel").onclick = closeModal;
    if($("mUndo")) $("mUndo").onclick = async () => {
      if(!confirm("ยกเลิกการเช็คชื่อของ " + s.name + "?")) return;
      $("mUndo").disabled = true;
      const {error} = await sb.from("checkins").delete().eq("id", c.id);
      if(error){ $("mUndo").disabled = false; $("mErr").textContent = errText(error); return; }
      S.checkins.delete(id); closeModal(); render(); load();
    };
  }

  /* ---------- ช่องเซ็นชื่อ ---------- */
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
    const w = 420, h = Math.round(w * pad.cv.height / pad.cv.width);
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    out.getContext("2d").drawImage(pad.cv, 0, 0, w, h);
    return out.toDataURL("image/png");
  }
  async function confirmSign(id){
    if(!pad || !pad.ink){ $("mErr").textContent = "กรุณาเซ็นชื่อก่อนกดยืนยัน"; return; }
    const btn = $("mOk"); btn.disabled = true; btn.textContent = "กำลังบันทึก";
    const sig = exportSig();
    const {data, error} = await sb.rpc("check_in", {p_student_id:id, p_signature:sig});
    if(error){
      btn.disabled = false; btn.textContent = "ยืนยันเข้าเรียน";
      $("mErr").textContent = "บันทึกไม่สำเร็จ: " + errText(error);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if(row && row.student_id){
      S.checkins.set(row.student_id, row);
      if(S.admin) S.sigs.set(row.id, sig);
      S.flash.add(row.student_id);
    }
    closeModal(); render(); load();
  }

  /* ---------- รายชื่อ ค้นหา ตัวกรอง ---------- */
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
  function setDate(d){ S.date = d; S.checkins = new Map(); render(); load(); }
  $("dateInput").addEventListener("change", e => { if(e.target.value) setDate(e.target.value); });
  setInterval(() => { if(!S.admin && S.date !== todayStr()) setDate(todayStr()); }, 60000);

  /* ---------- ล็อกอินผู้สอน (Google หรือ ลิงก์ทางอีเมล) ---------- */
  const redirectTo = location.origin + location.pathname;
  function openLogin(msg, isErr){
    openModal(
      '<div class="login">' +
      '<div class="login-mark" aria-hidden="true">🌿</div>' +
      '<h2 class="m-name" id="mName">เข้าสู่ระบบผู้สอน</h2>' +
      '<p class="login-sub">สำหรับผู้สอนที่ได้รับสิทธิ์เท่านั้น ผู้เรียนเช็คชื่อได้โดยไม่ต้องเข้าสู่ระบบ</p>' +
      '<button class="btn gbtn" id="gLogin" type="button">' +
        '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z"/></svg>' +
        '<span>เข้าสู่ระบบด้วย Google</span></button>' +
      '<div class="divider"><span>หรือรับลิงก์ทางอีเมล</span></div>' +
      '<div class="inline"><input type="email" id="loginEmail" autocomplete="email" placeholder="อีเมลผู้สอน" value="' + esc(CFG.ADMIN_EMAIL_HINT) + '">' +
      '<button class="btn btn-ghost" id="mailLogin" type="button">ส่งลิงก์</button></div>' +
      '<div class="status' + (isErr ? " err" : "") + '" id="loginStatus">' + esc(msg || "") + '</div>' +
      '<div class="m-actions"><span></span><div class="right"><button class="btn btn-ghost" id="mCancel">ปิด</button></div></div>' +
      '</div>', "__login");
    $("mCancel").onclick = closeModal;
    $("gLogin").onclick = async () => {
      $("gLogin").disabled = true;
      const {error} = await sb.auth.signInWithOAuth({
        provider:"google",
        options:{redirectTo, queryParams:{prompt:"select_account", login_hint:CFG.ADMIN_EMAIL_HINT || undefined}}
      });
      if(error){ $("gLogin").disabled = false; loginStatus(errText(error), true); }
    };
    $("mailLogin").onclick = async () => {
      const email = $("loginEmail").value.trim();
      if(!/^\S+@\S+\.\S+$/.test(email)){ loginStatus("กรอกอีเมลให้ถูกต้อง", true); return; }
      $("mailLogin").disabled = true;
      const {error} = await sb.auth.signInWithOtp({email, options:{emailRedirectTo:redirectTo}});
      $("mailLogin").disabled = false;
      if(error) loginStatus(errText(error), true);
      else loginStatus("ส่งลิงก์ไปที่ " + email + " แล้ว เปิดอีเมลแล้วกดลิงก์เพื่อเข้าสู่ระบบ", false);
    };
  }
  function loginStatus(t, err){ const el = $("loginStatus"); if(!el) return; el.textContent = t; el.classList.toggle("err", !!err); }

  async function applySession(session){
    const uid = session && session.user ? session.user.id : null;
    if(uid === S.uid) return;
    S.uid = uid;
    if(!session){
      S.admin = false; S.email = ""; S.sigs = new Map();
      applyAdmin(); return;
    }
    const email = session.user.email || "";
    const {data, error} = await sb.rpc("is_admin");
    if(error || data !== true){
      await sb.auth.signOut();
      S.uid = null; S.admin = false; S.email = "";
      applyAdmin();
      openLogin(error ? "ตรวจสิทธิ์ไม่สำเร็จ: " + errText(error) : "บัญชี " + email + " ไม่มีสิทธิ์ผู้สอน ลองเข้าด้วยบัญชีผู้สอน", true);
      return;
    }
    S.admin = true; S.email = email;
    if(S.current === "__login") closeModal();
    applyAdmin();
    load();
  }
  function applyAdmin(){
    $("tools").hidden = !S.admin;
    $("dateWrap").hidden = !S.admin;
    $("who").hidden = !S.admin;
    $("who").textContent = S.admin ? "ผู้สอน: " + S.email : "";
    $("adminBtn").textContent = S.admin ? "ออกจากระบบ" : "เข้าสู่ระบบผู้สอน";
    $("dateInput").value = S.date;
    if(!S.admin && S.date !== todayStr()) setDate(todayStr()); else render();
  }
  $("adminBtn").addEventListener("click", async () => {
    if(S.admin){ await sb.auth.signOut(); return; }
    openLogin("");
  });
  sb.auth.onAuthStateChange((event, session) => { setTimeout(() => applySession(session), 0); });

  // แสดงข้อผิดพลาดที่ส่งกลับมาจากหน้าล็อกอิน (เช่น ยังไม่ได้เปิด Google ใน Supabase)
  (function(){
    const qs = new URLSearchParams(location.search + "&" + location.hash.replace(/^#/, ""));
    const msg = qs.get("error_description");
    if(msg){
      history.replaceState(null, "", location.pathname);
      openLogin("เข้าสู่ระบบไม่สำเร็จ: " + msg.replace(/\+/g, " "), true);
    }
  })();

  /* ---------- เครื่องมือผู้สอน ---------- */
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
    st.classList.remove("err");
    const names = new Set([...S.students.values()].map(s => s.name.trim()));
    let order = [...S.students.values()].reduce((m, s) => Math.max(m, s.sort_order || 0), 0);
    const rows = []; let skipped = 0;
    people.forEach(p => {
      if(names.has(p.name)){ skipped++; return; }
      names.add(p.name);
      rows.push({name:p.name, code:p.code || "", sort_order:++order});
    });
    if(!rows.length){ st.textContent = "ไม่มีชื่อใหม่ (ซ้ำกับที่มีอยู่ " + skipped + " คน)"; return; }
    st.textContent = "กำลังเพิ่ม " + rows.length + " คน";
    for(let i = 0; i < rows.length; i += 500){
      const {error} = await sb.from("students").upsert(rows.slice(i, i+500), {onConflict:"name", ignoreDuplicates:true});
      if(error){ st.classList.add("err"); st.textContent = "เพิ่มไม่สำเร็จ: " + errText(error); return; }
    }
    st.textContent = "เพิ่มแล้ว " + rows.length + " คน" + (skipped ? " (ข้ามชื่อซ้ำ " + skipped + " คน)" : "");
    load();
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
    const data = {
      class_name: $("classNameInput").value.trim() || "Claude AI",
      start_time: $("startTime").value || "09:00",
      grace_minutes: Math.min(240, Math.max(0, Number($("grace").value) || 0)),
      updated_at: new Date().toISOString()
    };
    const {error} = await sb.from("settings").update(data).eq("id", 1);
    if(error){ st.classList.add("err"); st.textContent = "บันทึกไม่สำเร็จ: " + errText(error); return; }
    S.settings = Object.assign({}, S.settings, data);
    st.classList.remove("err"); st.textContent = "บันทึกการตั้งค่าแล้ว";
    $("startTime").blur(); applySettingsInputs(); render();
  });

  function downloadCsv(name, lines){
    const csv = "\uFEFF" + lines.map(r => r.map(v => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const statusTh = c => c ? (c.status === "late" ? "สาย" : "มาเรียน") : "ขาด";
  $("exportBtn").addEventListener("click", () => {
    const lines = [["ลำดับ","รหัส","ชื่อ","วันที่","สถานะ","เวลามา","สายกี่นาที"]];
    sortedStudents().forEach((s, i) => {
      const c = S.checkins.get(s.id);
      lines.push([i+1, s.code || "", s.name, S.date, statusTh(c), c ? fmtTime(c.checked_at) : "", c && c.status === "late" ? c.late_minutes : ""]);
    });
    downloadCsv("attendance-" + S.date + ".csv", lines);
    $("exportStatus").classList.remove("err"); $("exportStatus").textContent = "ดาวน์โหลดแล้ว";
  });
  $("exportAllBtn").addEventListener("click", async () => {
    const st = $("exportStatus"); st.classList.remove("err"); st.textContent = "กำลังรวบรวมประวัติ";
    const all = [];
    for(let from = 0; ; from += 1000){
      const {data, error} = await sb.from("checkins")
        .select("class_date,checked_at,student_code,student_name,status,late_minutes")
        .order("class_date").order("checked_at").range(from, from + 999);
      if(error){ st.classList.add("err"); st.textContent = "ดาวน์โหลดไม่สำเร็จ: " + errText(error); return; }
      all.push(...data);
      if(data.length < 1000) break;
    }
    const lines = [["วันที่","เวลามา","รหัส","ชื่อ","สถานะ","สายกี่นาที"]];
    all.forEach(c => lines.push([c.class_date, fmtTime(c.checked_at), c.student_code, c.student_name, statusTh(c), c.status === "late" ? c.late_minutes : ""]));
    downloadCsv("attendance-history.csv", lines);
    st.textContent = "ดาวน์โหลดประวัติ " + all.length + " รายการแล้ว";
  });
  $("clearBtn").addEventListener("click", async () => {
    const st = $("exportStatus");
    if(!S.students.size) return;
    if(!confirm("ลบรายชื่อผู้เรียนทั้งหมด " + S.students.size + " คน? ประวัติการเช็คชื่อยังเก็บไว้")) return;
    const {error} = await sb.from("students").delete().not("id", "is", null);
    if(error){ st.classList.add("err"); st.textContent = "ลบไม่สำเร็จ: " + errText(error); return; }
    st.classList.remove("err"); st.textContent = "ลบรายชื่อแล้ว"; load();
  });

  /* ---------- เริ่มทำงาน ---------- */
  render();
  load();
  subscribe();
})();
