-- โครงสร้างฐานข้อมูลเว็บเช็คชื่อ (ใช้กับโปรเจกต์ Supabase ใหม่ได้ โดยรันใน SQL Editor)

-- ผู้สอนที่มีสิทธิ์จัดการระบบ
create table public.admins (
  email text primary key
);
insert into public.admins (email) values ('rd@foodlenoodle.com');

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- รายชื่อผู้เรียน
create table public.students (
  id uuid primary key default gen_random_uuid(),
  code text not null default '',
  name text not null check (length(trim(name)) between 1 and 120),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint students_name_unique unique (name)
);

-- การตั้งค่าคลาส (มีแถวเดียว)
create table public.settings (
  id integer primary key default 1 check (id = 1),
  class_name text not null default 'Claude AI',
  start_time time not null default '09:00',
  grace_minutes integer not null default 15 check (grace_minutes between 0 and 240),
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- การเช็คชื่อ (เก็บชื่อไว้ด้วย ประวัติจึงไม่หายถ้าลบรายชื่อ)
create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references public.students(id) on delete set null,
  student_name text not null,
  student_code text not null default '',
  class_date date not null,
  checked_at timestamptz not null default now(),
  status text not null check (status in ('on_time', 'late')),
  late_minutes integer not null default 0,
  constraint checkins_once_per_day unique (student_id, class_date)
);
create index checkins_class_date_idx on public.checkins (class_date);

-- ลายเซ็น แยกตาราง ให้ผู้สอนดูได้คนเดียว
create table public.checkin_signatures (
  checkin_id uuid primary key references public.checkins(id) on delete cascade,
  signature text not null check (length(signature) <= 200000)
);

-- Row Level Security
alter table public.admins enable row level security;
alter table public.students enable row level security;
alter table public.settings enable row level security;
alter table public.checkins enable row level security;
alter table public.checkin_signatures enable row level security;

create policy "anyone can read students" on public.students for select to anon, authenticated using (true);
create policy "admins insert students" on public.students for insert to authenticated with check (public.is_admin());
create policy "admins update students" on public.students for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins delete students" on public.students for delete to authenticated using (public.is_admin());

create policy "anyone can read settings" on public.settings for select to anon, authenticated using (true);
create policy "admins update settings" on public.settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "anyone can read checkins" on public.checkins for select to anon, authenticated using (true);
create policy "admins delete checkins" on public.checkins for delete to authenticated using (public.is_admin());

create policy "admins read signatures" on public.checkin_signatures for select to authenticated using (public.is_admin());

-- เช็คชื่อผ่านฟังก์ชันนี้เท่านั้น เวลาและสถานะคิดที่เซิร์ฟเวอร์ (เวลาประเทศไทย)
create or replace function public.check_in(p_student_id uuid, p_signature text)
returns public.checkins
language plpgsql
security definer
set search_path = public
as $$
declare
  st public.students;
  cfg public.settings;
  local_now timestamp := now() at time zone 'Asia/Bangkok';
  today date := (now() at time zone 'Asia/Bangkok')::date;
  mins integer := 0;
  rec public.checkins;
begin
  select * into st from public.students where id = p_student_id;
  if not found then
    raise exception 'ไม่พบรายชื่อนี้';
  end if;
  if p_signature is null or p_signature not like 'data:image/png;base64,%' or length(p_signature) < 200 then
    raise exception 'กรุณาเซ็นชื่อก่อนยืนยัน';
  end if;
  if length(p_signature) > 200000 then
    raise exception 'ลายเซ็นใหญ่เกินไป ลองเซ็นใหม่อีกครั้ง';
  end if;

  select * into cfg from public.settings where id = 1;
  mins := greatest(0, floor(extract(epoch from (local_now - (today + cfg.start_time))) / 60)::integer);

  insert into public.checkins (student_id, student_name, student_code, class_date, status, late_minutes)
  values (
    st.id, st.name, st.code, today,
    case when mins > cfg.grace_minutes then 'late' else 'on_time' end,
    case when mins > cfg.grace_minutes then mins else 0 end
  )
  on conflict (student_id, class_date) do nothing
  returning * into rec;

  if rec.id is null then
    select * into rec from public.checkins where student_id = st.id and class_date = today;
    return rec;
  end if;

  insert into public.checkin_signatures (checkin_id, signature) values (rec.id, p_signature);
  return rec;
end;
$$;

revoke all on function public.check_in(uuid, text) from public;
grant execute on function public.check_in(uuid, text) to anon, authenticated;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- อัปเดตแบบเรียลไทม์
alter publication supabase_realtime add table public.students, public.checkins, public.settings;
