-- Run AFTER creating the email/password account in Supabase Authentication.
-- Replace the email below. This does not create accounts or store passwords.
do $$
declare
  v_email text := 'you@example.com';
begin
  if v_email = 'you@example.com' then
    raise exception 'Replace you@example.com with the account email before running.';
  end if;
  update public.profiles
  set role_code = 'parking_administrator', display_name = 'Parking Administrator'
  where id = (select id from auth.users where email = v_email);
  if not found then
    raise exception 'No profile found. Create the Auth account using this email first.';
  end if;
end;
$$;

select id, display_name, role_code from public.profiles;
