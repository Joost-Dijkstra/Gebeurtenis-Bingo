create or replace function public.get_game_snapshot(
  p_game_id uuid,
  p_player_id uuid,
  p_session_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_snapshot jsonb;
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  select jsonb_build_object(
    'game', to_jsonb(g),
    'players', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.joined_at, p.id)
      from public.players p
      where p.game_id = p_game_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
      from public.events e
      where e.game_id = p_game_id
    ), '[]'::jsonb),
    'card_entries', coalesce((
      select jsonb_agg(to_jsonb(pce) order by pce.player_id, pce.position_index, pce.id)
      from public.player_card_entries pce
      where pce.game_id = p_game_id
    ), '[]'::jsonb),
    'awards', coalesce((
      select jsonb_agg(to_jsonb(pa) order by pa.achievement_type, pa.placement, pa.id)
      from public.player_awards pa
      where pa.game_id = p_game_id
    ), '[]'::jsonb)
  )
  into v_snapshot
  from public.games g
  where g.id = p_game_id;

  if v_snapshot is null then
    raise exception 'Spel niet gevonden.';
  end if;

  return v_snapshot;
end;
$$;

create or replace function public.join_game_with_code(p_code text, p_name text)
returns table (
  game_id uuid,
  code text,
  player_id uuid,
  player_name text,
  session_token text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games;
  v_player_id uuid;
  v_session_token text;
  v_name text := public.clean_text(p_name, 24);
begin
  if v_name = '' then
    raise exception 'Voer eerst een naam in.';
  end if;

  select g.*
  into v_game
  from public.games as g
  where g.code = upper(public.clean_text(p_code, 6));

  if not found then
    raise exception 'Spelcode niet gevonden.';
  end if;

  if v_game.status in ('playing', 'finished') then
    raise exception 'Je kunt niet meer joinen: het spel is al begonnen of afgerond.';
  end if;

  if (
    select count(*)
    from public.players p
    where p.game_id = v_game.id
  ) >= 24 then
    raise exception 'Deze lobby zit vol.';
  end if;

  begin
    insert into public.players (game_id, name)
    values (v_game.id, v_name)
    returning id, name into v_player_id, player_name;
  exception
    when unique_violation then
      raise exception 'Deze naam is al in gebruik in dit spel.';
  end;

  v_session_token := md5(random()::text || clock_timestamp()::text || v_player_id::text);

  insert into public.player_sessions (player_id, session_token)
  values (v_player_id, v_session_token);

  return query
  select v_game.id, v_game.code, v_player_id, player_name, v_session_token;
end;
$$;

create or replace function public.add_event(
  p_game_id uuid,
  p_player_id uuid,
  p_session_token text,
  p_text text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_event_id uuid;
  v_text text := public.clean_text(p_text, 60);
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  if v_text = '' then
    raise exception 'Voeg eerst een gebeurtenis toe.';
  end if;

  if not exists (
    select 1
    from public.games
    where id = p_game_id
      and status = 'collecting_events'
  ) then
    raise exception 'De gebeurtenissenfase is al gesloten.';
  end if;

  if (
    select count(*)
    from public.events e
    where e.game_id = p_game_id
      and e.merged_into_event_id is null
  ) >= 64 then
    raise exception 'De lijst zit vol.';
  end if;

  begin
    insert into public.events (game_id, text, created_by_player_id)
    values (p_game_id, v_text, p_player_id)
    returning id into v_event_id;
  exception
    when unique_violation then
      raise exception 'Deze gebeurtenis staat al in de lijst.';
  end;

  return v_event_id;
end;
$$;

drop policy if exists "public read games" on public.games;
drop policy if exists "public read players" on public.players;
drop policy if exists "public read events" on public.events;
drop policy if exists "public read player_card_entries" on public.player_card_entries;
drop policy if exists "public read player_awards" on public.player_awards;

revoke select on public.games, public.players, public.events, public.player_card_entries, public.player_awards from anon, authenticated;
grant execute on function public.get_game_snapshot(uuid, uuid, text) to anon, authenticated;
