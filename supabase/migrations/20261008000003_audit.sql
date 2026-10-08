-- ESL Annual Clock: simple generic audit trigger.
-- Records who changed what and when, per clock. The actor is the signed-in user,
-- or (for trusted server writes such as email action links) the row's
-- updated_by/completed_by column.

create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  v_row jsonb := coalesce(v_new, v_old);
  v_clock uuid;
  v_actor uuid;
  v_diff jsonb := '{}';
  v_action text := lower(tg_op);
  k text;
begin
  if tg_table_name = 'clocks' then
    v_clock := (v_row ->> 'id')::uuid;
  elsif tg_table_name in ('activity_occurrences_state', 'activity_assignees') then
    select a.clock_id into v_clock from public.activities a where a.id = (v_row ->> 'activity_id')::uuid;
  else
    v_clock := (v_row ->> 'clock_id')::uuid;
  end if;

  v_actor := coalesce(
    app.current_user_id(),
    nullif(v_new ->> 'updated_by', '')::uuid,
    nullif(v_new ->> 'completed_by', '')::uuid);

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if k not in ('updated_at') and (v_new -> k) is distinct from (v_old -> k) then
        v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k));
      end if;
    end loop;
    if v_diff = '{}' then
      return new;
    end if;
    if tg_table_name = 'activities' and (v_new ->> 'deleted_at') is not null and (v_old ->> 'deleted_at') is null then
      v_action := 'soft_delete';
    end if;
  elsif tg_op = 'INSERT' then
    v_diff := v_new;
  else
    v_diff := v_old;
  end if;

  insert into public.audit_log (clock_id, actor_id, entity, entity_id, action, diff)
  values (v_clock, v_actor, tg_table_name,
          coalesce(nullif(v_row ->> 'id', '')::uuid, nullif(v_row ->> 'activity_id', '')::uuid),
          v_action, v_diff);
  return coalesce(new, old);
end $$;

create trigger audit after insert or update or delete on public.clocks
  for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.clock_members
  for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.rings
  for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.activities
  for each row execute function app.audit_row();
create trigger audit after insert or delete on public.activity_assignees
  for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.activity_occurrences_state
  for each row execute function app.audit_row();
