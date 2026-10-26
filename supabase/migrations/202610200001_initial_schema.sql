-- ParkVision: run once in a new Supabase project's SQL Editor.
-- Existing tables are never dropped. This migration is intentionally not rerunnable.
begin;

create schema if not exists parkvision_private;
revoke all on schema parkvision_private from public, anon, authenticated;
grant usage on schema parkvision_private to authenticated, service_role;

create type public.parking_status_code as enum ('vacant', 'occupied', 'blocked');

create table public.roles (
  code text primary key,
  name text not null unique
);
insert into public.roles (code, name) values
  ('parking_administrator', 'Parking Administrator'),
  ('security_personnel', 'Security Personnel'),
  ('parking_personnel', 'Parking Personnel');

-- Passwords/email/session tokens belong to Supabase Auth, not these tables.
-- NULL role means a registered account has no personnel privileges yet.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 120),
  role_code text references public.roles(code),
  created_at timestamptz not null default now()
);

create table public.parking_lots (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(btrim(code)) between 1 and 40),
  name text not null check (length(btrim(name)) between 1 and 160),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  parking_lot_id uuid not null references public.parking_lots(id),
  code text not null check (length(btrim(code)) between 1 and 40),
  is_active boolean not null default true,
  unique (parking_lot_id, code)
);

create table public.parking_spaces (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid not null references public.zones(id),
  code text not null check (length(btrim(code)) between 1 and 40),
  is_active boolean not null default true,
  unique (zone_id, code)
);

create table public.cameras (
  id uuid primary key default gen_random_uuid(),
  parking_lot_id uuid not null references public.parking_lots(id),
  code text not null check (length(btrim(code)) between 1 and 40),
  name text not null check (length(btrim(name)) between 1 and 160),
  is_active boolean not null default true,
  unique (parking_lot_id, code)
);

-- Coordinates are fractions of frame dimensions, not pixels (0..1).
-- One active camera region is authoritative for a parking space at a time.
create table public.parking_regions (
  id uuid primary key default gen_random_uuid(),
  parking_space_id uuid not null references public.parking_spaces(id),
  camera_id uuid not null references public.cameras(id),
  x numeric not null check (x >= 0 and x < 1),
  y numeric not null check (y >= 0 and y < 1),
  width numeric not null check (width > 0 and width <= 1),
  height numeric not null check (height > 0 and height <= 1),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (x + width <= 1 and y + height <= 1)
);
create unique index one_active_region_per_space
  on public.parking_regions(parking_space_id) where is_active;

create table public.camera_frames (
  id uuid primary key default gen_random_uuid(),
  camera_id uuid not null references public.cameras(id),
  captured_at timestamptz not null,
  -- Optional object key inside a PRIVATE Storage bucket, never a public URL.
  storage_object_path text,
  unique (camera_id, captured_at)
);

-- Append-only classifications. Space and camera are derived through FKs.
-- Confidence is a probability (0..1), not a percentage.
create table public.space_observations (
  id uuid primary key default gen_random_uuid(),
  parking_region_id uuid not null references public.parking_regions(id),
  camera_frame_id uuid not null references public.camera_frames(id),
  status public.parking_status_code not null,
  confidence numeric check (confidence >= 0 and confidence <= 1),
  processed_at timestamptz not null default clock_timestamp(),
  unique (camera_frame_id, parking_region_id)
);

-- One event per continuous obstruction. A later obstruction gets a NEW event.
-- Timestamps/space are derived from the referenced observations.
create table public.obstruction_alerts (
  id uuid primary key default gen_random_uuid(),
  opening_observation_id uuid not null unique references public.space_observations(id),
  resolution_observation_id uuid unique references public.space_observations(id),
  check (opening_observation_id is distinct from resolution_observation_id)
);

-- The first acknowledgement wins; it belongs to the event, not the space.
create table public.alert_acknowledgements (
  alert_id uuid primary key references public.obstruction_alerts(id),
  acknowledged_by uuid references public.profiles(id) on delete set null,
  acknowledged_at timestamptz not null default clock_timestamp()
);

-- Immutable historical snapshots intentionally use JSONB.
-- region_id has no FK so deleting an unused region preserves its audit trail.
create table public.region_change_log (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null,
  changed_by uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_values jsonb,
  new_values jsonb,
  changed_at timestamptz not null default clock_timestamp()
);

create index profiles_role_idx on public.profiles(role_code);
create index spaces_zone_idx on public.parking_spaces(zone_id);
create index regions_space_idx on public.parking_regions(parking_space_id);
create index regions_camera_idx on public.parking_regions(camera_id);
create index frames_latest_idx on public.camera_frames(camera_id, captured_at desc);
create index observations_region_idx on public.space_observations(parking_region_id, processed_at desc);
create index alerts_resolution_idx on public.obstruction_alerts(resolution_observation_id);
create index acknowledgements_user_idx on public.alert_acknowledgements(acknowledged_by);
create index region_log_region_idx on public.region_change_log(region_id, changed_at desc);
create index region_log_user_idx on public.region_change_log(changed_by);

create function parkvision_private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role_code = 'parking_administrator'
  );
$$;

create function parkvision_private.is_monitor()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and role_code in ('parking_administrator', 'security_personnel', 'parking_personnel')
  );
$$;

create function parkvision_private.create_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 120));
  -- Never copy roles from user-editable signup metadata.
  return new;
end;
$$;
create trigger parkvision_auth_user_created after insert on auth.users
  for each row execute function parkvision_private.create_profile();
-- Also support accounts created before the migration.
insert into public.profiles (id, display_name)
select id, left(coalesce(raw_user_meta_data ->> 'display_name', ''), 120)
from auth.users on conflict (id) do nothing;

create function parkvision_private.validate_region()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.parking_space_id <> old.parking_space_id or new.camera_id <> old.camera_id then
      raise exception 'Archive the old region and create a new region to change its space or camera.';
    end if;
  end if;
  if not exists (
    select 1 from public.parking_spaces s
    join public.zones z on z.id = s.zone_id
    join public.cameras c on c.parking_lot_id = z.parking_lot_id
    where s.id = new.parking_space_id and c.id = new.camera_id
  ) then
    raise exception 'Region camera and parking space must belong to the same parking lot.';
  end if;
  return new;
end;
$$;
create trigger validate_parking_region before insert or update on public.parking_regions
  for each row execute function parkvision_private.validate_region();

-- Parent links stay fixed; labels and active flags remain editable.
create function parkvision_private.keep_parent_link()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) -> tg_argv[0]) is distinct from (to_jsonb(old) -> tg_argv[0]) then
    raise exception 'Parent links cannot change; archive this record and create another.';
  end if;
  return new;
end;
$$;
create trigger zone_parent_fixed before update on public.zones
  for each row execute function parkvision_private.keep_parent_link('parking_lot_id');
create trigger space_parent_fixed before update on public.parking_spaces
  for each row execute function parkvision_private.keep_parent_link('zone_id');
create trigger camera_parent_fixed before update on public.cameras
  for each row execute function parkvision_private.keep_parent_link('parking_lot_id');

create function parkvision_private.audit_region()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new is not distinct from old then return new; end if;
  insert into public.region_change_log (region_id, changed_by, action, old_values, new_values)
  values (
    case when tg_op = 'DELETE' then old.id else new.id end,
    auth.uid(), tg_op,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger audit_parking_region after insert or update or delete on public.parking_regions
  for each row execute function parkvision_private.audit_region();

create function parkvision_private.validate_observation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_space_id uuid;
begin
  -- Serializes observations for a space, including observations from new regions.
  select s.id into v_space_id
  from public.parking_regions r
  join public.parking_spaces s on s.id = r.parking_space_id
  join public.zones z on z.id = s.zone_id
  join public.parking_lots l on l.id = z.parking_lot_id
  join public.cameras c on c.id = r.camera_id
  join public.camera_frames f on f.camera_id = c.id
  where r.id = new.parking_region_id and f.id = new.camera_frame_id
    and r.is_active and s.is_active and z.is_active and l.is_active and c.is_active
  for update of s;
  if v_space_id is null then
    raise exception 'Observation needs an active region/space/camera and a frame from the matching camera.';
  end if;
  return new;
end;
$$;
create trigger validate_space_observation before insert on public.space_observations
  for each row execute function parkvision_private.validate_observation();

create function parkvision_private.sync_obstruction_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_space_id uuid; v_latest_id uuid; v_alert_id uuid;
begin
  select parking_space_id into v_space_id from public.parking_regions
  where id = new.parking_region_id;
  -- Captured time determines freshness; a late old frame must not reopen an alert.
  select o.id into v_latest_id from public.space_observations o
  join public.parking_regions r on r.id = o.parking_region_id
  join public.camera_frames f on f.id = o.camera_frame_id
  where r.parking_space_id = v_space_id
  order by f.captured_at desc, o.processed_at desc, o.id desc limit 1;
  if v_latest_id <> new.id then return new; end if;

  select a.id into v_alert_id from public.obstruction_alerts a
  join public.space_observations o on o.id = a.opening_observation_id
  join public.parking_regions r on r.id = o.parking_region_id
  where r.parking_space_id = v_space_id and a.resolution_observation_id is null;

  if new.status = 'blocked' and v_alert_id is null then
    insert into public.obstruction_alerts (opening_observation_id) values (new.id);
  elsif new.status <> 'blocked' and v_alert_id is not null then
    update public.obstruction_alerts set resolution_observation_id = new.id where id = v_alert_id;
  end if;
  return new;
end;
$$;
create trigger sync_space_obstruction after insert on public.space_observations
  for each row execute function parkvision_private.sync_obstruction_alert();

-- Deliberately narrow public projection. Raw frames, regions, and history stay private.
-- This definer function is the ONLY anonymous path into detection history.
create function public.get_parking_status()
returns table (
  id uuid, code text, zone_id uuid, zone text, parking_lot_id uuid,
  status text, confidence numeric, observed_at timestamptz,
  updated_at timestamptz, is_stale boolean
)
language sql stable security definer set search_path = '' as $$
  select s.id, s.code, z.id, z.code, l.id,
    coalesce(latest.status::text, 'unknown'), latest.confidence,
    latest.captured_at, latest.processed_at,
    coalesce(latest.captured_at < now() - interval '10 seconds', true)
  from public.parking_spaces s
  join public.zones z on z.id = s.zone_id
  join public.parking_lots l on l.id = z.parking_lot_id
  left join lateral (
    select o.status, o.confidence, o.processed_at, f.captured_at
    from public.space_observations o
    join public.parking_regions r on r.id = o.parking_region_id
    join public.camera_frames f on f.id = o.camera_frame_id
    where r.parking_space_id = s.id
    order by f.captured_at desc, o.processed_at desc, o.id desc limit 1
  ) latest on true
  where s.is_active and z.is_active and l.is_active;
$$;

create view public.parking_status with (security_invoker = true) as
select * from public.get_parking_status();

-- Counts are derived, never stored separately. Unknown is excluded from vacant.
create view public.parking_summary with (security_invoker = true) as
select parking_lot_id, count(*) as total,
  count(*) filter (where status = 'vacant') as vacant,
  count(*) filter (where status = 'occupied') as occupied,
  count(*) filter (where status = 'blocked') as blocked,
  count(*) filter (where status = 'unknown') as unknown,
  count(*) filter (where is_stale) as stale
from public.parking_status group by parking_lot_id;

create function public.acknowledge_alert(p_alert_id uuid)
returns public.alert_acknowledgements
language plpgsql security definer set search_path = '' as $$
declare v_result public.alert_acknowledgements;
begin
  if not parkvision_private.is_monitor() then
    raise exception 'Authorized monitoring personnel required.' using errcode = '42501';
  end if;
  perform 1 from public.obstruction_alerts
  where id = p_alert_id and resolution_observation_id is null for update;
  if not found then raise exception 'Active alert not found.'; end if;
  insert into public.alert_acknowledgements (alert_id, acknowledged_by)
  values (p_alert_id, auth.uid()) on conflict (alert_id) do nothing;
  select * into v_result from public.alert_acknowledgements where alert_id = p_alert_id;
  return v_result;
end;
$$;

-- Service-only ingestion; triggers validate the result and manage alert episodes.
create function public.record_observation(
  p_region_id uuid, p_frame_id uuid, p_status public.parking_status_code,
  p_confidence numeric default null
)
returns public.space_observations
language sql security invoker set search_path = '' as $$
  insert into public.space_observations (parking_region_id, camera_frame_id, status, confidence)
  values (p_region_id, p_frame_id, p_status, p_confidence) returning *;
$$;

-- Explicit grants avoid relying on project-specific default privileges.
do $$
declare t text;
begin
  foreach t in array array['roles', 'profiles', 'parking_lots', 'zones', 'parking_spaces',
    'cameras', 'parking_regions', 'camera_frames', 'space_observations',
    'obstruction_alerts', 'alert_acknowledgements', 'region_change_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on type public.parking_status_code to anon, authenticated, service_role;
grant select on public.parking_lots, public.zones, public.parking_spaces to anon, authenticated;
grant select on public.roles, public.profiles, public.cameras, public.parking_regions,
  public.camera_frames, public.space_observations, public.obstruction_alerts,
  public.alert_acknowledgements, public.region_change_log to authenticated;
grant insert, update, delete on public.parking_lots, public.zones, public.parking_spaces,
  public.cameras, public.parking_regions to authenticated;
grant insert, update on public.profiles to authenticated;

grant select, insert, update, delete on public.roles, public.profiles,
  public.parking_lots, public.zones, public.parking_spaces,
  public.cameras, public.parking_regions to service_role;
grant select, insert on public.camera_frames, public.space_observations to service_role;
grant select on public.obstruction_alerts, public.alert_acknowledgements,
  public.region_change_log to service_role;

create policy roles_read on public.roles for select to authenticated using (true);
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select parkvision_private.is_admin()));
create policy profiles_admin_insert on public.profiles for insert to authenticated
  with check ((select parkvision_private.is_admin()));
create policy profiles_admin_update on public.profiles for update to authenticated
  using ((select parkvision_private.is_admin())) with check ((select parkvision_private.is_admin()));

do $$
declare t text;
begin
  foreach t in array array['parking_lots', 'zones', 'parking_spaces'] loop
    execute format('create policy public_read on public.%I for select to anon, authenticated using (true)', t);
  end loop;
  foreach t in array array['cameras', 'parking_regions', 'camera_frames',
    'space_observations', 'obstruction_alerts', 'alert_acknowledgements'] loop
    execute format('create policy monitor_read on public.%I for select to authenticated using ((select parkvision_private.is_monitor()))', t);
  end loop;
  foreach t in array array['parking_lots', 'zones', 'parking_spaces', 'cameras', 'parking_regions'] loop
    execute format('create policy admin_insert on public.%I for insert to authenticated with check ((select parkvision_private.is_admin()))', t);
    execute format('create policy admin_update on public.%I for update to authenticated using ((select parkvision_private.is_admin())) with check ((select parkvision_private.is_admin()))', t);
    execute format('create policy admin_delete on public.%I for delete to authenticated using ((select parkvision_private.is_admin()))', t);
  end loop;
end;
$$;
create policy region_log_admin_read on public.region_change_log for select to authenticated
  using ((select parkvision_private.is_admin()));

-- Trigger helpers cannot be called through the public API.
revoke all on all functions in schema parkvision_private from public, anon, authenticated, service_role;
grant execute on function parkvision_private.is_admin(), parkvision_private.is_monitor()
  to authenticated, service_role;
revoke all on function public.get_parking_status() from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_alert(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_observation(uuid, uuid, public.parking_status_code, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.get_parking_status() to anon, authenticated, service_role;
grant execute on function public.acknowledge_alert(uuid) to authenticated;
grant execute on function public.record_observation(uuid, uuid, public.parking_status_code, numeric) to service_role;
revoke all on public.parking_status, public.parking_summary from public, anon, authenticated, service_role;
grant select on public.parking_status, public.parking_summary to anon, authenticated, service_role;

commit;
