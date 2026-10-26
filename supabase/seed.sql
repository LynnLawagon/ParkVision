-- Run in SQL Editor AFTER the initial schema migration.
-- Safe to rerun on the OLD 48-space seed: no tables or history are deleted.
-- Default: 15 active spaces (A1-A5, B1-B5, C1-C5).
-- Change v_total_spaces below to 12, 13, 14, or 15 before running.
-- This configures ONLY the LUZANO lot; other lots are untouched.
begin;

do $$
declare
  v_total_spaces integer := 15; -- Set your confirmed capacity here (12..15).
  v_lot_id uuid;
  v_zone_id uuid;
  v_space_id uuid;
  v_camera_id uuid;
  v_zone_code text;
  v_zone_codes text[] := array['A', 'B', 'C'];
  v_target_space_ids uuid[] := array[]::uuid[];
  v_zone_index integer;
  v_zone_spaces integer;
  v_number integer;
begin
  if v_total_spaces is null or v_total_spaces not between 12 and 15 then
    raise exception 'Choose a total capacity between 12 and 15 spaces.';
  end if;

  insert into public.parking_lots (code, name)
  values ('LUZANO', 'Luzano Compound')
  on conflict (code) do update set is_active = true
  returning id into v_lot_id;

  for v_zone_index in 1..3 loop
    v_zone_code := v_zone_codes[v_zone_index];
    -- 12 => 4/4/4; 13 => 5/4/4; 14 => 5/5/4; 15 => 5/5/5.
    v_zone_spaces := v_total_spaces / 3
      + case when v_zone_index <= v_total_spaces % 3 then 1 else 0 end;

    insert into public.zones (parking_lot_id, code)
    values (v_lot_id, v_zone_code)
    on conflict (parking_lot_id, code) do update set is_active = true
    returning id into v_zone_id;

    for v_number in 1..v_zone_spaces loop
      insert into public.parking_spaces (zone_id, code)
      values (v_zone_id, v_zone_code || v_number::text)
      on conflict (zone_id, code) do update set is_active = true
      returning id into v_space_id;
      v_target_space_ids := array_append(v_target_space_ids, v_space_id);
    end loop;
  end loop;

  -- Retire surplus spaces in this lot; preserve their UUIDs and detection history.
  update public.parking_spaces s set is_active = false
  from public.zones z
  where z.id = s.zone_id and z.parking_lot_id = v_lot_id
    and s.id <> all(v_target_space_ids) and s.is_active;

  -- Prevent detection ingestion into regions belonging to retired spaces.
  -- The normal audit trigger records these changes.
  update public.parking_regions r set is_active = false
  from public.parking_spaces s, public.zones z
  where r.parking_space_id = s.id and s.zone_id = z.id
    and z.parking_lot_id = v_lot_id and not s.is_active and r.is_active;

  insert into public.cameras (parking_lot_id, code, name)
  values (v_lot_id, 'CAM-04', 'Zone A and B camera')
  on conflict (parking_lot_id, code) do update set is_active = true
  returning id into v_camera_id;

  -- Keep existing calibration; add only missing SAMPLE rectangles for A1/A2.
  -- These use the existing 480x280 preview, not measured real-camera geometry.
  insert into public.parking_regions (parking_space_id, camera_id, x, y, width, height)
  select s.id, v_camera_id,
    case s.code when 'A1' then 40.0 / 480 else 120.0 / 480 end,
    30.0 / 280, 70.0 / 480, 100.0 / 280
  from public.parking_spaces s join public.zones z on z.id = s.zone_id
  where z.parking_lot_id = v_lot_id and z.code = 'A'
    and s.code in ('A1', 'A2') and s.is_active
    and not exists (
      select 1 from public.parking_regions r
      where r.parking_space_id = s.id and r.is_active
    );
end;
$$;

-- SQL Editor should show total = 15 (or your chosen capacity).
-- Archived rows may still appear in Table Editor; parking_status excludes them.
select l.code as lot, summary.*
from public.parking_summary summary
join public.parking_lots l on l.id = summary.parking_lot_id
where l.code = 'LUZANO';

commit;
