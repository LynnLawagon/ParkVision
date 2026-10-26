-- Run as database owner AFTER the migration, preferably in development.
-- Minimal auth.users fixtures have no passwords/sessions. Everything rolls back.
begin;

create function pg_temp.assert_true(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_message; end if;
end;
$$;
create function pg_temp.expect_error(p_sql text, p_state text, p_message text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then return; end if;
    raise exception 'FAIL: %; expected SQLSTATE %, got %: %', p_message, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: %; expected rejection', p_message;
end;
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'pv-test-admin@example.invalid', '{}'),
  ('00000000-0000-0000-0000-000000000002', 'pv-test-security@example.invalid', '{}'),
  ('00000000-0000-0000-0000-000000000003', 'pv-test-parking@example.invalid', '{}'),
  ('00000000-0000-0000-0000-000000000004', 'pv-test-unapproved@example.invalid',
   '{"role_code":"parking_administrator","display_name":"Test visitor"}');
update public.profiles set role_code = 'parking_administrator' where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set role_code = 'security_personnel' where id = '00000000-0000-0000-0000-000000000002';
update public.profiles set role_code = 'parking_personnel' where id = '00000000-0000-0000-0000-000000000003';
select pg_temp.assert_true((select role_code is null from public.profiles where id = '00000000-0000-0000-0000-000000000004'), 'signup metadata cannot assign roles');

insert into public.parking_lots (id, code, name) values
  ('10000000-0000-0000-0000-000000000001', 'PV-TEST-ONE', 'Test lot'),
  ('10000000-0000-0000-0000-000000000002', 'PV-TEST-TWO', 'Other test lot');
insert into public.zones (id, parking_lot_id, code) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'A'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Z');
insert into public.parking_spaces (id, zone_id, code) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'A1'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'A2'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'Z1');
insert into public.cameras (id, parking_lot_id, code, name) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'CAM-1', 'Test camera'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'CAM-2', 'Alternate camera'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'CAM-3', 'Other lot camera');

-- Administrator configuration, validation and historical audit snapshots.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
insert into public.parking_regions (id, parking_space_id, camera_id, x, y, width, height)
values ('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001', 0.1, 0.1, 0.2, 0.2);
update public.parking_regions set x = 0.2, width = 0.3 where id = '50000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select new_values ->> 'x' = '0.1' and changed_by = '00000000-0000-0000-0000-000000000001'
  from public.region_change_log where region_id = '50000000-0000-0000-0000-000000000001' and action = 'INSERT'), 'creation snapshot and actor are preserved');
select pg_temp.assert_true((select old_values ->> 'x' = '0.1' and new_values ->> 'x' = '0.2'
  from public.region_change_log where region_id = '50000000-0000-0000-0000-000000000001' and action = 'UPDATE'), 'update snapshots are independent');
select pg_temp.expect_error($q$update public.parking_regions set width = -1 where id = '50000000-0000-0000-0000-000000000001'$q$, '23514', 'negative dimensions');
select pg_temp.expect_error($q$update public.parking_regions set x = 0.9 where id = '50000000-0000-0000-0000-000000000001'$q$, '23514', 'out-of-frame rectangle');
select pg_temp.expect_error($q$update public.parking_regions set camera_id = '40000000-0000-0000-0000-000000000002' where id = '50000000-0000-0000-0000-000000000001'$q$, 'P0001', 'region parent cannot change');
select pg_temp.expect_error($q$insert into public.parking_regions(parking_space_id,camera_id,x,y,width,height) values ('30000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000003',0,0,0.2,0.2)$q$, 'P0001', 'cross-lot region');
select pg_temp.expect_error($q$insert into public.parking_regions(parking_space_id,camera_id,x,y,width,height) values ('30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',0,0,0.2,0.2)$q$, '23505', 'duplicate active region');
select pg_temp.expect_error($q$update public.cameras set parking_lot_id = '10000000-0000-0000-0000-000000000002' where id = '40000000-0000-0000-0000-000000000001'$q$, 'P0001', 'camera lot cannot change');
select pg_temp.expect_error($q$update public.region_change_log set action = 'DELETE'$q$, '42501', 'administrator cannot rewrite audit');
insert into public.parking_regions (id, parking_space_id, camera_id, x, y, width, height)
values ('50000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002',
  '40000000-0000-0000-0000-000000000001', 0, 0, 0.2, 0.2);
delete from public.parking_regions where id = '50000000-0000-0000-0000-000000000002';
select pg_temp.assert_true(exists(select 1 from public.region_change_log where region_id = '50000000-0000-0000-0000-000000000002' and action = 'DELETE' and old_values is not null and new_values is null), 'audit survives region deletion');

-- Public reads go through the safe projection, not underlying detection tables.
reset role;
set local request.jwt.claim.sub = '';
set local role anon;
select pg_temp.assert_true((select count(*) = 3 from public.parking_status where parking_lot_id in ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002')), 'anonymous status access');
select pg_temp.assert_true((select status = 'unknown' and is_stale from public.parking_status where id = '30000000-0000-0000-0000-000000000001'), 'unobserved space is unknown');
select pg_temp.assert_true((select total = 2 and unknown = 2 and vacant = 0 from public.parking_summary where parking_lot_id = '10000000-0000-0000-0000-000000000001'), 'unknown is not vacant');
select pg_temp.expect_error('select * from public.camera_frames', '42501', 'anonymous frame access denied');
select pg_temp.expect_error('select * from public.space_observations', '42501', 'anonymous raw history denied');
select pg_temp.expect_error('select * from public.parking_regions', '42501', 'anonymous geometry denied');
select pg_temp.expect_error($q$select public.acknowledge_alert('90000000-0000-0000-0000-000000000001')$q$, '42501', 'anonymous acknowledgement denied');

-- A signed-in account is not automatically personnel and cannot promote itself.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004';
update public.profiles set role_code = 'parking_administrator' where id = '00000000-0000-0000-0000-000000000004';
select pg_temp.assert_true((select role_code is null from public.profiles where id = '00000000-0000-0000-0000-000000000004'), 'self-promotion is blocked');
select pg_temp.assert_true((select count(*) = 0 from public.parking_regions), 'unapproved account sees no regions');
select pg_temp.expect_error($q$select public.acknowledge_alert('90000000-0000-0000-0000-000000000001')$q$, '42501', 'unapproved account cannot acknowledge alerts');
select pg_temp.expect_error($q$insert into public.parking_regions(parking_space_id,camera_id,x,y,width,height) values ('30000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001',0,0,0.2,0.2)$q$, '42501', 'unapproved configuration denied');

-- Personnel can monitor but cannot edit regions or ingest model results.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
select pg_temp.assert_true(exists(select 1 from public.parking_regions where id = '50000000-0000-0000-0000-000000000001'), 'security personnel can read regions');
select pg_temp.expect_error($q$insert into public.parking_regions(parking_space_id,camera_id,x,y,width,height) values ('30000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001',0,0,0.2,0.2)$q$, '42501', 'security personnel cannot edit regions');
select pg_temp.expect_error($q$select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','blocked',0.9)$q$, '42501', 'personnel cannot ingest detections');
select pg_temp.assert_true((select count(*) = 0 from public.region_change_log), 'audit is administrator-only');
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select pg_temp.assert_true(exists(select 1 from public.parking_regions where id = '50000000-0000-0000-0000-000000000001'), 'parking personnel can monitor');

-- CV ingestion, stale frames, event grouping, resolution and new acknowledgements.
reset role;
set local request.jwt.claim.sub = '';
set local role service_role;
insert into public.camera_frames (id, camera_id, captured_at, storage_object_path) values
  ('60000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','2026-01-01 00:00:01+00','private/test-1.jpg'),
  ('60000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001','2026-01-01 00:00:02+00',null),
  ('60000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000001','2026-01-01 00:00:03+00',null),
  ('60000000-0000-0000-0000-000000000004','40000000-0000-0000-0000-000000000001','2026-01-01 00:00:04+00',null),
  ('60000000-0000-0000-0000-000000000005','40000000-0000-0000-0000-000000000001','2026-01-01 00:00:05+00',null),
  ('60000000-0000-0000-0000-000000000006','40000000-0000-0000-0000-000000000001','2026-01-01 00:00:00+00',null),
  ('60000000-0000-0000-0000-000000000007','40000000-0000-0000-0000-000000000002','2026-01-01 00:00:06+00',null),
  ('60000000-0000-0000-0000-000000000008','40000000-0000-0000-0000-000000000001','2026-01-01 00:00:07+00',null);
select pg_temp.expect_error($q$select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000007','blocked',0.9)$q$, 'P0001', 'frame must match region camera');
select pg_temp.expect_error($q$select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','blocked',1.5)$q$, '23514', 'invalid confidence');
select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','blocked',0.94);
select pg_temp.expect_error($q$select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','blocked',0.94)$q$, '23505', 'duplicate frame result');
select pg_temp.assert_true((select count(*) = 1 from public.obstruction_alerts a join public.space_observations o on o.id = a.opening_observation_id where o.parking_region_id = '50000000-0000-0000-0000-000000000001'), 'blocked creates one alert');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
select public.acknowledge_alert(a.id) from public.obstruction_alerts a
join public.space_observations o on o.id = a.opening_observation_id where o.parking_region_id = '50000000-0000-0000-0000-000000000001';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select public.acknowledge_alert(a.id) from public.obstruction_alerts a
join public.space_observations o on o.id = a.opening_observation_id where o.parking_region_id = '50000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select ack.acknowledged_by = '00000000-0000-0000-0000-000000000002' from public.alert_acknowledgements ack join public.obstruction_alerts a on a.id = ack.alert_id join public.space_observations o on o.id = a.opening_observation_id where o.parking_region_id = '50000000-0000-0000-0000-000000000001'), 'first acknowledgement is immutable');
select pg_temp.expect_error('update public.alert_acknowledgements set acknowledged_at = now()', '42501', 'direct acknowledgement rewrite denied');
select pg_temp.expect_error('update public.obstruction_alerts set resolution_observation_id = opening_observation_id', '42501', 'personnel cannot edit alert state');

reset role;
set local request.jwt.claim.sub = '';
set local role service_role;
select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','blocked',0.92);
select pg_temp.assert_true((select count(*) = 1 from public.obstruction_alerts a join public.space_observations o on o.id = a.opening_observation_id where o.parking_region_id = '50000000-0000-0000-0000-000000000001'), 'repeated blocked frames share an alert');
select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000003','vacant',0.98);
select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000004','blocked',0.95);
select pg_temp.assert_true((select count(*) = 2 from public.obstruction_alerts a join public.space_observations o on o.id = a.opening_observation_id where o.parking_region_id = '50000000-0000-0000-0000-000000000001'), 'new obstruction creates a separate alert');
select pg_temp.assert_true((select count(*) = 1 from public.obstruction_alerts a join public.space_observations o on o.id = a.opening_observation_id left join public.alert_acknowledgements ack on ack.alert_id = a.id where o.parking_region_id = '50000000-0000-0000-0000-000000000001' and a.resolution_observation_id is null and ack.alert_id is null), 'new alert has no old acknowledgement');
select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000005','occupied',0.96);
select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000006','blocked',0.91);
select pg_temp.assert_true((select count(*) = 0 from public.obstruction_alerts a join public.space_observations o on o.id = a.opening_observation_id where o.parking_region_id = '50000000-0000-0000-0000-000000000001' and a.resolution_observation_id is null), 'late old frame cannot reopen alert');
select pg_temp.expect_error('update public.space_observations set confidence = 0', '42501', 'observation history cannot be overwritten');

reset role;
set local role anon;
select pg_temp.assert_true((select status = 'occupied' and confidence = 0.96 and observed_at = '2026-01-01 00:00:05+00'::timestamptz from public.parking_status where id = '30000000-0000-0000-0000-000000000001'), 'capture order determines current status');
select pg_temp.assert_true((select total = vacant + occupied + blocked + unknown and occupied = 1 and unknown = 1 from public.parking_summary where parking_lot_id = '10000000-0000-0000-0000-000000000001'), 'derived totals remain consistent');
select pg_temp.expect_error('select storage_object_path from public.parking_status', '42703', 'public projection has no frame path');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
select pg_temp.expect_error($q$delete from public.parking_regions where id = '50000000-0000-0000-0000-000000000001'$q$, '23503', 'history prevents region deletion');
update public.parking_regions set is_active = false where id = '50000000-0000-0000-0000-000000000001';
reset role;
set local request.jwt.claim.sub = '';
set local role service_role;
select pg_temp.expect_error($q$select public.record_observation('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000008','blocked',0.9)$q$, 'P0001', 'archived region cannot ingest');
reset role;

select 'All ParkVision schema checks passed; fixtures rolled back.' as result;
rollback;
