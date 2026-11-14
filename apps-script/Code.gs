/**
 * ระบบเช็คชื่อ คลาส Claude AI : ตัวเชื่อมกับ Google Sheets
 *
 * ผูกกับ Google Sheet "รายชื่อ" ของคลาสแล้วผ่าน SPREADSHEET_ID ด้านล่าง
 * ทุกการเช็คชื่อจะเพิ่มแถวในชีตแรก (timestamp, name, note) และเก็บรายละเอียดในชีต Checkins
 *
 * วิธีติดตั้ง
 * 1. เปิด Google Sheet "รายชื่อ" แล้วไปที่ ส่วนขยาย > Apps Script
 * 2. ลบโค้ดเดิมทั้งหมด วางโค้ดไฟล์นี้แทน
 * 2.1 ตั้ง PIN ผู้สอน: ไอคอนเฟือง (การตั้งค่าโปรเจ็กต์) > พร็อพเพอร์ตี้ของสคริปต์
 *     > เพิ่ม ชื่อ ADMIN_PIN ค่า = PIN ของคุณ
 *     (เก็บ PIN ไว้ที่นี่ ไม่ต้องเขียนในโค้ด จึงอัปโหลดโค้ดขึ้น GitHub ได้อย่างปลอดภัย)
 * 3. กด ทำให้ใช้งานได้ (Deploy) > การทำให้ใช้งานได้รายการใหม่ > เลือกประเภท "เว็บแอป"
 *    - เรียกใช้ในฐานะ: ฉัน (Me)
 *    - ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน (Anyone)
 * 4. อนุญาตสิทธิ์ แล้วคัดลอก URL ที่ลงท้ายด้วย /exec
 * 5. นำ URL ไปใส่ใน SHEETS_URL ในไฟล์ config.js
 *
 * ชีต Students, Checkins และ Settings จะถูกสร้างให้อัตโนมัติเมื่อมีการใช้งานครั้งแรก
 * ถ้าแก้โค้ดนี้ภายหลัง ต้อง Deploy > จัดการการทำให้ใช้งานได้ > แก้ไข > เวอร์ชันใหม่ ทุกครั้ง
 */

const MAX_SIG = 49000;      // เซลล์ Google Sheets เก็บได้ไม่เกิน 50,000 ตัวอักษร

// Google Sheet ที่ใช้เก็บข้อมูล (รหัสจากลิงก์ docs.google.com/spreadsheets/d/<รหัส>/edit)
// เว้นว่างไว้ ถ้าจะใช้ชีตที่เปิด Apps Script ขึ้นมา
const SPREADSHEET_ID = "13u-gWPZjH2hOnps6gyh7jvYI_vLSr-FqjlK31TPHYow";
const LOG_SHEET_GID = 0;    // ชีตแรก (gid=0) ที่บันทึก timestamp, name, note
const LOG_HEADERS = ["timestamp", "name", "note"];
const TZ = "Asia/Bangkok";

const SHEETS = {
  Students: ["id", "code", "name", "order"],
  Checkins: ["date", "studentId", "code", "name", "time", "timeText", "status", "lateMinutes", "signature"],
  Settings: ["key", "value"]
};

function doGet() {
  return json({ ok: true, message: "Attendance API is running" });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const out = route(req) || {};
    out.ok = true;
    return json(out);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route(req) {
  switch (req.action) {
    case "load":          return load(req);
    case "auth":          requirePin(req); return {};
    case "checkin":       return withLock(function () { return checkin(req); });
    case "undo":          requirePin(req); return withLock(function () { return undo(req); });
    case "addStudents":   requirePin(req); return withLock(function () { return addStudents(req); });
    case "clearStudents": requirePin(req); return withLock(clearStudents);
    case "saveSettings":  requirePin(req); return withLock(function () { return saveSettings(req); });
  }
  throw new Error("ไม่รู้จักคำสั่ง " + req.action);
}

function requirePin(req) {
  const pin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!pin) throw new Error("ยังไม่ได้ตั้ง ADMIN_PIN ใน พร็อพเพอร์ตี้ของสคริปต์");
  if (String(req.pin || "") !== String(pin)) throw new Error("PIN ไม่ถูกต้อง");
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- ชีต ---------- */
function book() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

// ชีตแรกของไฟล์ ใช้บันทึกการเช็คชื่อแบบอ่านง่าย: timestamp, name, note
function logSheet() {
  const sh = book().getSheets().filter(function (x) { return x.getSheetId() === LOG_SHEET_GID; })[0];
  if (!sh) return null;
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight("bold");
  return sh;
}

function logStamp(iso) {
  return Utilities.formatDate(new Date(iso), TZ, "dd/MM/yyyy HH:mm");
}

function sheet(name) {
  const ss = book();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    // เก็บทุกช่องเป็นข้อความ กันวันที่ เวลา และรหัสที่มีเลข 0 นำหน้าถูกแปลง
    sh.getRange("A:Z").setNumberFormat("@");
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function data(name) {
  const sh = sheet(name);
  const last = sh.getLastRow();
  const vals = last > 1 ? sh.getRange(2, 1, last - 1, SHEETS[name].length).getValues() : [];
  return { sh: sh, vals: vals };
}

function asDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(v == null ? "" : v);
}

function asTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "HH:mm");
  return String(v == null ? "" : v);
}

/* ---------- คำสั่ง ---------- */
function load(req) {
  const students = data("Students").vals
    .filter(function (r) { return r[0] !== "" && r[2] !== ""; })
    .map(function (r) { return { id: String(r[0]), code: String(r[1]), name: String(r[2]), order: Number(r[3]) || 0 }; });

  const date = String(req.date || "");
  const have = {};
  (req.have || []).forEach(function (id) { have[String(id)] = true; });

  const checkins = data("Checkins").vals
    .filter(function (r) { return r[1] !== "" && asDate(r[0]) === date; })
    .map(function (r) {
      const id = String(r[1]);
      return {
        studentId: id, code: String(r[2]), name: String(r[3]), time: String(r[4]),
        timeText: String(r[5]), status: String(r[6]), lateMinutes: Number(r[7]) || 0,
        sig: have[id] ? "" : String(r[8] || "")   // ไม่ส่งลายเซ็นซ้ำถ้าหน้าเว็บมีอยู่แล้ว
      };
    });

  return { students: students, checkins: checkins, settings: getSettings() };
}

function checkin(req) {
  const r = req.record || {};
  const date = String(req.date || "");
  if (!date || !r.studentId) throw new Error("ข้อมูลไม่ครบ");
  if (String(r.sig || "").length > MAX_SIG) throw new Error("ลายเซ็นใหญ่เกินไป ลองเซ็นใหม่อีกครั้ง");

  const d = data("Checkins");
  const exists = d.vals.some(function (v) { return asDate(v[0]) === date && String(v[1]) === String(r.studentId); });
  if (exists) return { existed: true };

  d.sh.appendRow([date, String(r.studentId), String(r.code || ""), String(r.name || ""), String(r.time || ""),
    String(r.timeText || ""), String(r.status || ""), String(r.lateMinutes || 0), String(r.sig || "")]);

  const ls = logSheet();
  if (ls) {
    const row = ls.getLastRow() + 1;
    const range = ls.getRange(row, 1, 1, LOG_HEADERS.length);
    range.setNumberFormat("@");   // เก็บเป็นข้อความ จะได้ตรงกับรูปแบบเดิมและลบตามได้ตอนยกเลิก
    range.setValues([[logStamp(r.time || new Date().toISOString()), String(r.name || ""), r.status === "สาย" ? "สาย" : "มา"]]);
  }
  return {};
}

function undo(req) {
  const date = String(req.date || "");
  const d = data("Checkins");
  for (let i = d.vals.length - 1; i >= 0; i--) {
    if (asDate(d.vals[i][0]) === date && String(d.vals[i][1]) === String(req.studentId)) {
      removeLog(String(d.vals[i][4]), String(d.vals[i][3]));
      const row = i + 2;
      if (d.sh.getMaxRows() > 2) d.sh.deleteRow(row);
      else d.sh.getRange(row, 1, 1, SHEETS.Checkins.length).clearContent();
    }
  }
  return {};
}

// ลบแถวที่ตรงกันในชีตแรก เมื่อผู้สอนยกเลิกการเช็คชื่อ
function removeLog(iso, name) {
  const ls = logSheet();
  if (!ls || !iso) return;
  const last = ls.getLastRow();
  if (last < 2) return;
  const stamp = logStamp(iso);
  const vals = ls.getRange(2, 1, last - 1, 2).getDisplayValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] === stamp && vals[i][1] === name) {
      if (ls.getMaxRows() > 2) ls.deleteRow(i + 2);
      else ls.getRange(i + 2, 1, 1, LOG_HEADERS.length).clearContent();
      return;
    }
  }
}

function addStudents(req) {
  const d = data("Students");
  const live = d.vals.filter(function (r) { return r[0] !== ""; });
  const names = {}, ids = {};
  let order = 0;
  live.forEach(function (r) { names[String(r[2]).trim()] = true; ids[String(r[0])] = true; order = Math.max(order, Number(r[3]) || 0); });

  const rows = [];
  let added = 0, skipped = 0;
  (req.people || []).forEach(function (p) {
    const name = String(p.name || "").trim();
    if (!name || names[name]) { skipped++; return; }
    let id = String(p.code || "").trim().replace(/[^A-Za-z0-9_\-.~:@+]/g, "").slice(0, 60);
    if (!id || ids[id]) id = "s" + Utilities.getUuid().replace(/-/g, "").slice(0, 10);
    order++;
    rows.push([id, String(p.code || ""), name, String(order)]);
    names[name] = true; ids[id] = true; added++;
  });

  if (rows.length) d.sh.getRange(d.sh.getLastRow() + 1, 1, rows.length, SHEETS.Students.length).setValues(rows);
  return { added: added, skipped: skipped };
}

function clearStudents() {
  const sh = sheet("Students");
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, SHEETS.Students.length).clearContent();
  return {};
}

function getSettings() {
  const s = { start: "09:00", grace: 15 };
  data("Settings").vals.forEach(function (r) {
    if (r[0] === "start") s.start = asTime(r[1]);
    if (r[0] === "grace") s.grace = Number(r[1]) || 0;
  });
  return s;
}

function saveSettings(req) {
  const sh = sheet("Settings");
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 2).clearContent();
  sh.getRange(2, 1, 2, 2).setValues([
    ["start", String(req.start || "")],
    ["grace", String(Math.max(0, Number(req.grace) || 0))]
  ]);
  return {};
}
