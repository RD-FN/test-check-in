/**
 * ตั้งค่าเว็บเช็คชื่อ แก้เฉพาะไฟล์นี้ไฟล์เดียว
 *
 * SHEETS_URL   : URL ของ Google Apps Script Web App (ลงท้ายด้วย /exec)
 *                ถ้าเว้นว่าง ข้อมูลจะเก็บในเบราว์เซอร์ของเครื่องนั้นเครื่องเดียว
 * CLASS_NAME   : ชื่อคลาสที่แสดงบนหัวเว็บ
 * POLL_SECONDS : ดึงข้อมูลใหม่จาก Google Sheets ทุกกี่วินาที
 * LOCAL_PIN    : PIN ผู้สอน ใช้เฉพาะตอนไม่ได้เชื่อม Google Sheets
 *                (ตอนเชื่อม Google Sheets ใช้ PIN ที่ตั้งใน Apps Script แทน)
 */
window.ATTENDANCE_CONFIG = {
  SHEETS_URL: "",
  CLASS_NAME: "Claude AI",
  POLL_SECONDS: 8,
  LOCAL_PIN: "1234"
};
