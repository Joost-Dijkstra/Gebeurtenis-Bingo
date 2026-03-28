create or replace function public.rebuild_awards_for_game(
  p_game_id uuid,
  p_board_size integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
begin
  delete from public.player_awards
  where game_id = p_game_id;

  for v_event in
    select e.id
    from public.events e
    where e.game_id = p_game_id
      and e.triggered = true
      and e.merged_into_event_id is null
    order by e.triggered_at nulls last, e.created_at, e.id
  loop
    perform public.award_new_places(p_game_id, v_event.id, p_board_size);
  end loop;
end;
$$;

create or replace function public.untrigger_event(
  p_game_id uuid,
  p_event_id uuid,
  p_player_id uuid,
  p_session_token text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_board_size integer;
  v_triggered_by_player_id uuid;
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  select g.board_size, e.triggered_by_player_id
  into v_board_size, v_triggered_by_player_id
  from public.games g
  join public.events e
    on e.game_id = g.id
  where g.id = p_game_id
    and g.status in ('playing', 'finished')
    and e.id = p_event_id
    and e.merged_into_event_id is null
  for update of g, e;

  if v_board_size is null then
    raise exception 'Het spel is nu niet actief.';
  end if;

  if v_triggered_by_player_id is null then
    raise exception 'Deze gebeurtenis is nog niet gemarkeerd.';
  end if;

  if v_triggered_by_player_id <> p_player_id then
    raise exception 'Alleen de speler die deze gebeurtenis markeerde kan dit herstellen.';
  end if;

  update public.events
  set triggered = false,
      triggered_by_player_id = null,
      triggered_at = null
  where id = p_event_id
    and game_id = p_game_id
    and triggered = true;

  if not found then
    raise exception 'Deze gebeurtenis is al hersteld.';
  end if;

  update public.player_card_entries
  set checked = false
  where game_id = p_game_id
    and event_id = p_event_id;

  perform public.rebuild_awards_for_game(p_game_id, v_board_size);
end;
$$;

grant execute on function public.untrigger_event(uuid, uuid, uuid, text) to anon, authenticated;
