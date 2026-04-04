alter table public.games
  add column if not exists name text;

create or replace function public.games_before_write()
returns trigger
language plpgsql
as $$
begin
  new.code := upper(public.clean_text(new.code, 6));
  new.name := nullif(public.clean_text(new.name, 48), '');
  return new;
end;
$$;

create or replace function public.update_game_name(
  p_game_id uuid,
  p_player_id uuid,
  p_session_token text,
  p_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_name text := nullif(public.clean_text(p_name, 48), '');
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  if not exists (
    select 1
    from public.games
    where id = p_game_id
      and host_player_id = p_player_id
  ) then
    raise exception 'Alleen de host mag de spelnaam aanpassen.';
  end if;

  update public.games
  set name = v_name
  where id = p_game_id;
end;
$$;

create or replace function public.kick_player_from_game(
  p_game_id uuid,
  p_player_id uuid,
  p_session_token text,
  p_target_player_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  if p_target_player_id = p_player_id then
    raise exception 'De host kan zichzelf niet verwijderen.';
  end if;

  if not exists (
    select 1
    from public.games
    where id = p_game_id
      and host_player_id = p_player_id
      and status in ('collecting_events', 'choosing_board_size', 'building_cards')
  ) then
    raise exception 'Alleen de host mag nu spelers verwijderen.';
  end if;

  if not exists (
    select 1
    from public.players
    where id = p_target_player_id
      and game_id = p_game_id
  ) then
    raise exception 'Speler niet gevonden.';
  end if;

  delete from public.players
  where id = p_target_player_id
    and game_id = p_game_id;
end;
$$;
