create or replace function public.create_game_with_host(p_host_name text)
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
  v_game_id uuid;
  v_code text;
  v_player_id uuid;
  v_session_token text;
  v_host_name text := public.clean_text(p_host_name, 24);
begin
  if v_host_name = '' then
    raise exception 'Voer eerst een naam in.';
  end if;

  insert into public.games as g (code, status)
  values (public.generate_game_code(), 'collecting_events')
  returning g.id, g.code into v_game_id, v_code;

  insert into public.players (game_id, name)
  values (v_game_id, v_host_name)
  returning id, name into v_player_id, player_name;

  v_session_token := encode(gen_random_bytes(18), 'hex');

  insert into public.player_sessions (player_id, session_token)
  values (v_player_id, v_session_token);

  update public.games
  set host_player_id = v_player_id
  where id = v_game_id;

  return query
  select v_game_id, v_code, v_player_id, player_name, v_session_token;
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

  begin
    insert into public.players (game_id, name)
    values (v_game.id, v_name)
    returning id, name into v_player_id, player_name;
  exception
    when unique_violation then
      raise exception 'Deze naam is al in gebruik in dit spel.';
  end;

  v_session_token := encode(gen_random_bytes(18), 'hex');

  insert into public.player_sessions (player_id, session_token)
  values (v_player_id, v_session_token);

  return query
  select v_game.id, v_game.code, v_player_id, player_name, v_session_token;
end;
$$;
