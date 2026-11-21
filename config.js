/**
 * ตั้งค่าเว็บเช็คชื่อ (Supabase)
 *
 * SUPABASE_URL       : URL ของโปรเจกต์ Supabase
 * SUPABASE_ANON_KEY  : คีย์สาธารณะ (anon / publishable) ใส่ในเว็บได้ ปลอดภัยเพราะสิทธิ์คุมด้วย Row Level Security
 *                      ห้ามใส่ service_role key ลงในไฟล์นี้เด็ดขาด
 * ADMIN_EMAIL_HINT   : อีเมลผู้สอนที่เติมไว้ให้ในหน้าล็อกอิน
 *                      (สิทธิ์จริงกำหนดในตาราง admins ของฐานข้อมูล)
 * TIMEZONE           : เขตเวลาของคลาส
 */
window.ATTENDANCE_CONFIG = {
  SUPABASE_URL: "https://qyiqokpgftazgdxohwxq.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5aXFva3BnZnRhemdkeG9od3hxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyMjcyNjIsImV4cCI6MjExMDgwMzI2Mn0.jcQxay25_6r7dX1uocyvWPnfuSDI3K9VVUmfYblaL0k",
  ADMIN_EMAIL_HINT: "rd@foodlenoodle.com",
  TIMEZONE: "Asia/Bangkok"
};
