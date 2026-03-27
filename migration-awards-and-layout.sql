create table if not exists public.player_awards (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  achievement_type text not null,
  placement integer not null,
  event_id uuid references public.events(id) on delete set null,
  earned_at timestamptz not null default timezone('utc', now()),
  constraint player_awards_type_check check (achievement_type in ('line', 'full_card')),
  constraint player_awards_player_type_unique unique (game_id, player_id, achievement_type),
  constraint player_awards_placement_unique unique (game_id, achievement_type, placement)
);

create or replace function public.award_new_places(
  p_game_id uuid,
  p_event_id uuid,
  p_board_size integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required integer := p_board_size * p_board_size;
begin
  with affected_players as (
    select distinct pce.player_id, p.joined_at
    from public.player_card_entries pce
    join public.players p
      on p.id = pce.player_id
    where pce.game_id = p_game_id
      and pce.event_id = p_event_id
  ),
  line_candidates as (
    select ap.player_id, ap.joined_at
    from affected_players ap
    where exists (
      select 1
      from generate_series(0, p_board_size - 1) as row_index
      where not exists (
        select 1
        from public.player_card_entries pce
        where pce.game_id = p_game_id
          and pce.player_id = ap.player_id
          and pce.position_index between row_index * p_board_size and row_index * p_board_size + (p_board_size - 1)
          and pce.checked = false
      )
    )
    or exists (
      select 1
      from generate_series(0, p_board_size - 1) as column_index
      where not exists (
        select 1
        from public.player_card_entries pce
        where pce.game_id = p_game_id
          and pce.player_id = ap.player_id
          and (pce.position_index % p_board_size) = column_index
          and pce.checked = false
      )
    )
    or not exists (
      select 1
      from public.player_card_entries pce
      where pce.game_id = p_game_id
        and pce.player_id = ap.player_id
        and (pce.position_index % p_board_size) = (pce.position_index / p_board_size)
        and pce.checked = false
    )
    or not exists (
      select 1
      from public.player_card_entries pce
      where pce.game_id = p_game_id
        and pce.player_id = ap.player_id
        and ((pce.position_index % p_board_size) + (pce.position_index / p_board_size)) = (p_board_size - 1)
        and pce.checked = false
    )
  ),
  new_line_candidates as (
    select lc.player_id, row_number() over (order by lc.joined_at, lc.player_id) as seq
    from line_candidates lc
    where not exists (
      select 1
      from public.player_awards pa
      where pa.game_id = p_game_id
        and pa.player_id = lc.player_id
        and pa.achievement_type = 'line'
    )
  ),
  line_offset as (
    select coalesce(max(pa.placement), 0) as max_placement
    from public.player_awards pa
    where pa.game_id = p_game_id
      and pa.achievement_type = 'line'
  )
  insert into public.player_awards (game_id, player_id, achievement_type, placement, event_id)
  select p_game_id, nlc.player_id, 'line', lo.max_placement + nlc.seq, p_event_id
  from new_line_candidates nlc
  cross join line_offset lo;

  with affected_players as (
    select distinct pce.player_id, p.joined_at
    from public.player_card_entries pce
    join public.players p
      on p.id = pce.player_id
    where pce.game_id = p_game_id
      and pce.event_id = p_event_id
  ),
  full_card_candidates as (
    select ap.player_id, ap.joined_at
    from affected_players ap
    where (
      select count(*)
      from public.player_card_entries pce
      where pce.game_id = p_game_id
        and pce.player_id = ap.player_id
        and pce.checked = true
    ) = v_required
  ),
  new_full_card_candidates as (
    select fc.player_id, row_number() over (order by fc.joined_at, fc.player_id) as seq
    from full_card_candidates fc
    where not exists (
      select 1
      from public.player_awards pa
      where pa.game_id = p_game_id
        and pa.player_id = fc.player_id
        and pa.achievement_type = 'full_card'
    )
  ),
  full_card_offset as (
    select coalesce(max(pa.placement), 0) as max_placement
    from public.player_awards pa
    where pa.game_id = p_game_id
      and pa.achievement_type = 'full_card'
  )
  insert into public.player_awards (game_id, player_id, achievement_type, placement, event_id)
  select p_game_id, nfc.player_id, 'full_card', fco.max_placement + nfc.seq, p_event_id
  from new_full_card_candidates nfc
  cross join full_card_offset fco;
end;
$$;

create or replace function public.trigger_event(
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
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  select board_size
  into v_board_size
  from public.games
  where id = p_game_id
    and status = 'playing'
  for update;

  if v_board_size is null then
    raise exception 'Het spel is nog niet bezig.';
  end if;

  perform 1
  from public.events
  where id = p_event_id
    and game_id = p_game_id
    and merged_into_event_id is null
  for update;

  if not found then
    raise exception 'Gebeurtenis niet gevonden.';
  end if;

  update public.events
  set triggered = true,
      triggered_by_player_id = p_player_id,
      triggered_at = timezone('utc', now())
  where id = p_event_id
    and triggered = false;

  if not found then
    raise exception 'Deze gebeurtenis was al gemarkeerd.';
  end if;

  update public.player_card_entries
  set checked = true
  where game_id = p_game_id
    and event_id = p_event_id;

  perform public.award_new_places(p_game_id, p_event_id, v_board_size);
end;
$$;

alter table public.player_awards enable row level security;

drop policy if exists "public read player_awards" on public.player_awards;
create policy "public read player_awards"
on public.player_awards
for select
using (true);

grant select on public.player_awards to anon, authenticated;
revoke insert, update, delete on public.player_awards from anon, authenticated;

alter table public.player_awards replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'player_awards'
  ) then
    alter publication supabase_realtime add table public.player_awards;
  end if;
end;
$$;
