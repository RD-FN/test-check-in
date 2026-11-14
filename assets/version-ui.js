/* แสดงเลขเวอร์ชันบนหัวเว็บและท้ายหน้า และหน้าต่าง "มีอะไรใหม่" (ข้อมูลอยู่ใน version.js) */
(function(){
  "use strict";
  const V = Object.assign({version:"", released:"", repo:"", changes:[]}, window.APP_VERSION || {});
  if(!V.version) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function fmtDay(str){
    const [y,m,d] = String(str).split("-").map(Number);
    return y ? new Date(y, m-1, d).toLocaleDateString("th-TH", {day:"numeric", month:"short", year:"numeric"}) : "";
  }

  // ป้ายบนหัวเว็บ
  const small = document.querySelector("#title small");
  if(small && !$("verBtn")){
    const b = document.createElement("button");
    b.className = "ver"; b.id = "verBtn"; b.type = "button"; b.title = "ดูว่ามีอะไรใหม่";
    b.textContent = "v" + V.version;
    small.appendChild(b);
  }
  // ข้อความท้ายหน้า
  if($("verText")) $("verText").textContent = "เวอร์ชัน " + V.version + (V.released ? " อัปเดต " + fmtDay(V.released) : "");

  let open = false;
  function close(){ $("scrim").classList.remove("open"); $("modal").innerHTML = ""; open = false; }
  function openLog(){
    open = true;
    $("modal").innerHTML =
      '<div class="m-head"><div><p class="sub" style="margin:0">มีอะไรใหม่</p><h2 class="m-name" id="mName">เวอร์ชัน ' + esc(V.version) + '</h2></div></div>' +
      '<div class="log">' + (V.changes || []).map(c =>
        '<section><h3>v' + esc(c.version) + '<span>' + esc(fmtDay(c.date)) + '</span></h3><ul>' +
        (c.items || []).map(i => '<li>' + esc(i) + '</li>').join("") + '</ul></section>').join("") + '</div>' +
      '<div class="m-actions">' +
      (V.repo ? '<a class="btn btn-ghost" href="' + esc(V.repo) + '" target="_blank" rel="noopener">ดูโค้ดบน GitHub</a>' : '<span></span>') +
      '<div class="right"><button class="btn btn-go" id="verClose">ปิด</button></div></div>';
    $("scrim").classList.add("open");
    $("verClose").onclick = close;
  }
  document.addEventListener("click", e => {
    if(e.target.closest("#verBtn, #verText")){ e.preventDefault(); openLog(); }
  });
  document.addEventListener("keydown", e => { if(open && e.key === "Escape") close(); });
  $("scrim").addEventListener("click", e => { if(open && e.target === $("scrim")) close(); });
})();
