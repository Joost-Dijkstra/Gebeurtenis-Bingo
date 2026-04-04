-- Party Bingo MVP schema for Supabase
-- Run this file in the Supabase SQL editor before opening the frontend.

create extension if not exists pgcrypto;

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text,
  host_player_id uuid,
  board_size smallint,
  status text not null default 'collecting_events',
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  constraint games_code_format check (code ~ '^[A-Z0-9]{5,6}$'),
  constraint games_board_size_check check (board_size in (3, 4) or board_size is null),
  constraint games_status_check check (
    status in (
      'collecting_events',
      'choosing_board_size',
      'building_cards',
      'playing',
      'finished'
    )
  )
);

alter table public.games
  add column if not exists name text;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  name text not null,
  joined_at timestamptz not null default timezone('utc', now()),
  constraint players_name_length check (char_length(name) between 1 and 24),
  constraint players_game_id_unique unique (id, game_id)
);

create table if not exists public.player_sessions (
  player_id uuid primary key references public.players(id) on delete cascade,
  session_token text not null unique,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  text text not null,
  created_by_player_id uuid not null references public.players(id) on delete cascade,
  triggered boolean not null default false,
  triggered_by_player_id uuid references public.players(id) on delete set null,
  triggered_at timestamptz,
  merged_into_event_id uuid references public.events(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint events_text_length check (char_length(text) between 1 and 60),
  constraint events_not_merged_into_self check (merged_into_event_id is null or merged_into_event_id <> id),
  constraint events_game_id_unique unique (id, game_id)
);

create table if not exists public.player_card_entries (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null,
  game_id uuid not null,
  event_id uuid not null,
  position_index smallint not null,
  checked boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  constraint player_card_entries_position_check check (position_index between 0 and 15),
  constraint player_card_entries_player_slot_unique unique (player_id, position_index),
  constraint player_card_entries_player_event_unique unique (player_id, event_id),
  constraint player_card_entries_player_game_fkey foreign key (player_id, game_id)
    references public.players(id, game_id) on delete cascade,
  constraint player_card_entries_event_game_fkey foreign key (event_id, game_id)
    references public.events(id, game_id) on delete cascade
);

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

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'games_host_player_id_fkey'
  ) then
    alter table public.games
      add constraint games_host_player_id_fkey
      foreign key (host_player_id) references public.players(id) on delete set null;
  end if;
end;
$$;

create unique index if not exists players_game_name_key
  on public.players (game_id, lower(name));

create unique index if not exists events_game_active_text_key
  on public.events (game_id, lower(regexp_replace(trim(text), '\s+', ' ', 'g')))
  where merged_into_event_id is null;

create or replace function public.clean_text(input_text text, max_length integer)
returns text
language sql
immutable
as $$
  select left(trim(regexp_replace(coalesce(input_text, ''), '\s+', ' ', 'g')), max_length);
$$;

create or replace function public.generate_game_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  characters constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  idx integer;
begin
  loop
    candidate := '';

    for idx in 1..5 loop
      candidate := candidate || substr(characters, floor(random() * length(characters) + 1)::integer, 1);
    end loop;

    exit when not exists (
      select 1
      from public.games
      where code = candidate
    );
  end loop;

  return candidate;
end;
$$;

create or replace function public.players_before_write()
returns trigger
language plpgsql
as $$
begin
  new.name := public.clean_text(new.name, 24);
  return new;
end;
$$;

drop trigger if exists players_before_write_trigger on public.players;
create trigger players_before_write_trigger
before insert or update on public.players
for each row
execute function public.players_before_write();

create or replace function public.events_before_write()
returns trigger
language plpgsql
as $$
begin
  new.text := public.clean_text(new.text, 60);
  return new;
end;
$$;

drop trigger if exists events_before_write_trigger on public.events;
create trigger events_before_write_trigger
before insert or update on public.events
for each row
execute function public.events_before_write();

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

drop trigger if exists games_before_write_trigger on public.games;
create trigger games_before_write_trigger
before insert or update on public.games
for each row
execute function public.games_before_write();

create or replace function public.get_session_player(p_player_id uuid, p_session_token text)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
begin
  select p.*
  into v_player
  from public.players p
  join public.player_sessions ps
    on ps.player_id = p.id
  where p.id = p_player_id
    and ps.session_token = p_session_token;

  if not found then
    raise exception 'Ongeldige spelerssessie.';
  end if;

  return v_player;
end;
$$;

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

  v_session_token := md5(random()::text || clock_timestamp()::text || v_player_id::text);

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

create or replace function public.close_event_collection(
  p_game_id uuid,
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
  v_active_count integer;
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
      and status = 'collecting_events'
  ) then
    raise exception 'Alleen de host kan deze fase sluiten.';
  end if;

  select count(*)
  into v_active_count
  from public.events
  where game_id = p_game_id
    and merged_into_event_id is null;

  if v_active_count < 9 then
    raise exception 'Je hebt minimaal 9 gebeurtenissen nodig om door te gaan.';
  end if;

  update public.games
  set status = 'choosing_board_size'
  where id = p_game_id;
end;
$$;

create or replace function public.set_board_size(
  p_game_id uuid,
  p_player_id uuid,
  p_session_token text,
  p_board_size integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_active_count integer;
  v_required integer;
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  if p_board_size not in (3, 4) then
    raise exception 'Kies een kaart van 3x3 of 4x4.';
  end if;

  if not exists (
    select 1
    from public.games
    where id = p_game_id
      and host_player_id = p_player_id
      and status = 'choosing_board_size'
  ) then
    raise exception 'Alleen de host kan nu het kaartformaat kiezen.';
  end if;

  v_required := p_board_size * p_board_size;

  select count(*)
  into v_active_count
  from public.events
  where game_id = p_game_id
    and merged_into_event_id is null;

  if v_active_count < v_required then
    raise exception 'Er zijn niet genoeg gebeurtenissen voor dit formaat.';
  end if;

  update public.games
  set board_size = p_board_size,
      status = 'building_cards'
  where id = p_game_id;
end;
$$;

create or replace function public.save_player_card(
  p_game_id uuid,
  p_player_id uuid,
  p_session_token text,
  p_event_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_board_size integer;
  v_required integer;
  v_event_count integer;
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  select board_size
  into v_board_size
  from public.games
  where id = p_game_id
    and status = 'building_cards';

  if v_board_size is null then
    raise exception 'Je kunt nu geen kaart opslaan.';
  end if;

  v_required := v_board_size * v_board_size;

  if coalesce(array_length(p_event_ids, 1), 0) <> v_required then
    raise exception 'Kies exact % gebeurtenissen.', v_required;
  end if;

  if (
    select count(distinct picked.event_id)
    from unnest(p_event_ids) as picked(event_id)
  )
  <> v_required then
    raise exception 'Elke gebeurtenis mag maar een keer op je kaart staan.';
  end if;

  select count(*)
  into v_event_count
  from public.events
  where game_id = p_game_id
    and id = any(p_event_ids)
    and merged_into_event_id is null;

  if v_event_count <> v_required then
    raise exception 'Je selectie bevat ongeldige of samengevoegde gebeurtenissen.';
  end if;

  delete from public.player_card_entries
  where player_id = p_player_id
    and game_id = p_game_id;

  insert into public.player_card_entries (
    player_id,
    game_id,
    event_id,
    position_index,
    checked
  )
  select
    p_player_id,
    p_game_id,
    picked.event_id,
    picked.ordinality - 1,
    e.triggered
  from unnest(p_event_ids) with ordinality as picked(event_id, ordinality)
  join public.events e
    on e.id = picked.event_id
   and e.game_id = p_game_id
   and e.merged_into_event_id is null;
end;
$$;

create or replace function public.start_game(
  p_game_id uuid,
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
    and host_player_id = p_player_id
    and status = 'building_cards';

  if v_board_size is null then
    raise exception 'Alleen de host kan het spel nu starten.';
  end if;

  v_required := v_board_size * v_board_size;

  if exists (
    select 1
    from public.players p
    where p.game_id = p_game_id
      and (
        select count(*)
        from public.player_card_entries pce
        where pce.player_id = p.id
          and pce.game_id = p_game_id
      ) <> v_required
  ) then
    raise exception 'Niet alle spelers hebben een complete kaart opgeslagen.';
  end if;

  update public.games
  set status = 'playing',
      started_at = coalesce(started_at, timezone('utc', now()))
  where id = p_game_id;
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
  v_required integer;
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

create or replace function public.edit_event_text(
  p_game_id uuid,
  p_event_id uuid,
  p_player_id uuid,
  p_session_token text,
  p_new_text text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_text text := public.clean_text(p_new_text, 60);
begin
  v_player := public.get_session_player(p_player_id, p_session_token);

  if v_player.game_id <> p_game_id then
    raise exception 'Speler hoort niet bij dit spel.';
  end if;

  if v_text = '' then
    raise exception 'Gebeurtenistekst mag niet leeg zijn.';
  end if;

  if not exists (
    select 1
    from public.games
    where id = p_game_id
      and host_player_id = p_player_id
      and status in ('collecting_events', 'choosing_board_size', 'building_cards')
  ) then
    raise exception 'Alleen de host mag nu tekst aanpassen.';
  end if;

  begin
    update public.events
    set text = v_text
    where id = p_event_id
      and game_id = p_game_id
      and merged_into_event_id is null;
  exception
    when unique_violation then
      raise exception 'Deze tekst bestaat al als actieve gebeurtenis.';
  end;

  if not found then
    raise exception 'Gebeurtenis niet gevonden.';
  end if;
end;
$$;

create or replace function public.merge_events(
  p_game_id uuid,
  p_source_event_id uuid,
  p_target_event_id uuid,
  p_player_id uuid,
  p_session_token text,
  p_target_text text default null
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

  if p_source_event_id = p_target_event_id then
    raise exception 'Bron en doel mogen niet gelijk zijn.';
  end if;

  if not exists (
    select 1
    from public.games
    where id = p_game_id
      and host_player_id = p_player_id
      and status in ('collecting_events', 'choosing_board_size', 'building_cards')
  ) then
    raise exception 'Alleen de host mag nu gebeurtenissen samenvoegen.';
  end if;

  if not exists (
    select 1
    from public.events
    where id = p_source_event_id
      and game_id = p_game_id
      and merged_into_event_id is null
  ) or not exists (
    select 1
    from public.events
    where id = p_target_event_id
      and game_id = p_game_id
      and merged_into_event_id is null
  ) then
    raise exception 'Kies twee actieve gebeurtenissen uit hetzelfde spel.';
  end if;

  delete from public.player_card_entries source_entry
  using public.player_card_entries target_entry
  where source_entry.player_id = target_entry.player_id
    and source_entry.game_id = p_game_id
    and target_entry.game_id = p_game_id
    and source_entry.event_id = p_source_event_id
    and target_entry.event_id = p_target_event_id;

  update public.player_card_entries
  set event_id = p_target_event_id,
      checked = false
  where game_id = p_game_id
    and event_id = p_source_event_id;

  update public.events
  set merged_into_event_id = p_target_event_id
  where id = p_source_event_id;

  if p_target_text is not null and public.clean_text(p_target_text, 60) <> '' then
    begin
      update public.events
      set text = public.clean_text(p_target_text, 60)
      where id = p_target_event_id;
    exception
      when unique_violation then
        raise exception 'De nieuwe tekst botst met een andere actieve gebeurtenis.';
    end;
  end if;
end;
$$;

alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.player_sessions enable row level security;
alter table public.events enable row level security;
alter table public.player_card_entries enable row level security;
alter table public.player_awards enable row level security;

drop policy if exists "public read games" on public.games;

drop policy if exists "public read players" on public.players;

drop policy if exists "public read events" on public.events;

drop policy if exists "public read player_card_entries" on public.player_card_entries;

drop policy if exists "public read player_awards" on public.player_awards;
revoke select on public.games, public.players, public.events, public.player_card_entries, public.player_awards from anon, authenticated;
revoke all on public.player_sessions from anon, authenticated;
revoke insert, update, delete on public.games, public.players, public.events, public.player_card_entries, public.player_awards from anon, authenticated;

grant execute on function public.create_game_with_host(text) to anon, authenticated;
grant execute on function public.join_game_with_code(text, text) to anon, authenticated;
grant execute on function public.get_game_snapshot(uuid, uuid, text) to anon, authenticated;
grant execute on function public.add_event(uuid, uuid, text, text) to anon, authenticated;
grant execute on function public.close_event_collection(uuid, uuid, text) to anon, authenticated;
grant execute on function public.set_board_size(uuid, uuid, text, integer) to anon, authenticated;
grant execute on function public.save_player_card(uuid, uuid, text, uuid[]) to anon, authenticated;
grant execute on function public.start_game(uuid, uuid, text) to anon, authenticated;
grant execute on function public.trigger_event(uuid, uuid, uuid, text) to anon, authenticated;
grant execute on function public.untrigger_event(uuid, uuid, uuid, text) to anon, authenticated;
grant execute on function public.edit_event_text(uuid, uuid, uuid, text, text) to anon, authenticated;
grant execute on function public.merge_events(uuid, uuid, uuid, uuid, text, text) to anon, authenticated;

alter table public.games replica identity full;
alter table public.players replica identity full;
alter table public.events replica identity full;
alter table public.player_card_entries replica identity full;
alter table public.player_awards replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'player_card_entries'
  ) then
    alter publication supabase_realtime add table public.player_card_entries;
  end if;

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
