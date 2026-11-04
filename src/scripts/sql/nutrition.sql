-- Nutrition et régimes : couche « analysée » à côté de recipes.ingredients.
-- recipes.ingredients (texte d'origine) n'est pas modifié.
--
-- À exécuter dans l'éditeur SQL Supabase : prod, puis démo.
-- Idempotent : peut être relancé sans dégât.
-- Prérequis : extension pg_trgm installée.

begin;

-- ─────────────────────────────────────────────────────────────
-- 1. Référentiel des aliments (Ciqual + ajouts manuels)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.foods (
  id uuid primary key default gen_random_uuid(),
  ciqual_code text unique,              -- null pour un aliment ajouté à la main
  name text not null,
  -- Nom normalisé pour la recherche : minuscules, sans accents, œ → oe,
  -- ponctuation → espaces. Même forme que les noms d'ingrédients analysés.
  name_search text generated always as (
    btrim(regexp_replace(
      replace(replace(replace(replace(
        lower(translate(
          name,
          'ÀÁÂÃÄÅĀÇĆÈÉÊËĒÌÍÎÏĪÑÒÓÔÕÖŌØÙÚÛÜŪÝŸàáâãäåāçćèéêëēìíîïīñòóôõöōøùúûüūýÿ',
          'AAAAAAACCEEEEEIIIIINOOOOOOOUUUUUYYaaaaaaacceeeeeiiiiinooooooouuuuuyy'
        )),
        'œ', 'oe'), 'Œ', 'oe'), 'æ', 'ae'), 'Æ', 'ae'),
      '[^a-z0-9]+', ' ', 'g'
    ))
  ) stored,
  group_name text,
  subgroup_name text,

  -- Valeurs pour 100 g, null si inconnues
  energy_kcal numeric,
  proteins_g numeric,
  carbs_g numeric,
  sugars_g numeric,
  fat_g numeric,
  fibers_g numeric,
  salt_g numeric,

  -- Indicateurs de régime
  is_meat boolean not null default false,           -- la gélatine compte comme viande
  is_fish boolean not null default false,           -- poissons et fruits de mer
  is_egg boolean not null default false,
  is_dairy boolean not null default false,
  is_other_animal boolean not null default false,   -- miel...
  is_plant_protein boolean not null default false,  -- légumineuses, tofu, tempeh, seitan...
  has_gluten boolean not null default false,        -- l'avoine compte, par prudence

  -- Grammes par unité, ex. {"unite": 55} pour l'œuf, {"gousse": 5} pour l'ail
  unit_weights jsonb not null default '{}'::jsonb,
  -- g/ml, 1 si null
  density numeric
);

-- Index trigram (pg_trgm peut être dans le schéma « extensions » sur Supabase)
do $$
declare
  trgm_schema text;
begin
  select n.nspname into trgm_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';

  if trgm_schema is null then
    raise exception 'Extension pg_trgm introuvable';
  end if;

  execute format(
    'create index if not exists foods_name_trgm_idx on public.foods using gin (name %I.gin_trgm_ops)',
    trgm_schema
  );
  execute format(
    'create index if not exists foods_name_search_trgm_idx on public.foods using gin (name_search %I.gin_trgm_ops)',
    trgm_schema
  );
end $$;

-- ─────────────────────────────────────────────────────────────
-- 2. Alias : nom d'ingrédient normalisé → aliment
-- ─────────────────────────────────────────────────────────────
create table if not exists public.food_aliases (
  alias text primary key,               -- nom normalisé
  food_id uuid not null references public.foods (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists food_aliases_food_id_idx on public.food_aliases (food_id);

-- ─────────────────────────────────────────────────────────────
-- 3. Lignes d'ingrédients analysées (recalculables)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  position int not null,
  raw_text text not null,
  quantity numeric,
  unit text,
  name text,                            -- normalisé
  food_id uuid references public.foods (id) on delete set null,  -- null = non reconnu
  match_score numeric,
  grams numeric,
  status text not null default 'auto' check (status in ('auto', 'checked', 'ignored')),
  unique (recipe_id, position)
);

create index if not exists recipe_ingredients_food_id_idx on public.recipe_ingredients (food_id);
-- Pour retrouver les autres recettes où un même nom n'était pas reconnu
create index if not exists recipe_ingredients_name_idx on public.recipe_ingredients (name);

-- ─────────────────────────────────────────────────────────────
-- 4. Colonnes calculées sur recipes
-- ─────────────────────────────────────────────────────────────
alter table public.recipes add column if not exists nutrition jsonb;
alter table public.recipes add column if not exists diet_tags text[] not null default '{}';
alter table public.recipes add column if not exists main_protein text
  check (main_protein in ('animale', 'oeufs-laitiers', 'vegetale'));

create index if not exists recipes_diet_tags_idx on public.recipes using gin (diet_tags);

-- ─────────────────────────────────────────────────────────────
-- 5. match_food(p_name) : 5 meilleurs candidats par similarité trigram
--    p_name est attendu déjà normalisé (minuscules, sans accents).
--    Score = moyenne de :
--      - strict_word_similarity : les mots cherchés sont-ils présents ?
--      - similarity : pénalise les noms beaucoup plus longs.
--    Un alias et le nom de l'aliment comptent tous deux ; on garde le meilleur.
-- ─────────────────────────────────────────────────────────────
create or replace function public.match_food(p_name text)
returns table (food_id uuid, name text, score numeric)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  with q as (
    select btrim(lower(coalesce(p_name, ''))) as needle
  ),
  candidates as (
    select f.id as food_id,
           (strict_word_similarity(q.needle, f.name_search) + similarity(q.needle, f.name_search)) / 2 as score
    from public.foods f, q
    where q.needle <> ''
    union all
    select a.food_id,
           (strict_word_similarity(q.needle, a.alias) + similarity(q.needle, a.alias)) / 2 as score
    from public.food_aliases a, q
    where q.needle <> ''
  ),
  best as (
    select c.food_id, max(c.score) as score
    from candidates c
    group by c.food_id
  )
  select b.food_id, f.name, round(b.score::numeric, 3) as score
  from best b
  join public.foods f on f.id = b.food_id
  where b.score > 0
  order by b.score desc, length(f.name) asc
  limit 5;
$$;

-- ─────────────────────────────────────────────────────────────
-- 6. Sécurité : recopie RLS et policies depuis les tables existantes
--      foods, food_aliases  ← categories (données de référence)
--      recipe_ingredients   ← recipes    (données de recette)
--    Les policies des tables cibles sont d'abord supprimées, puis recopiées :
--    relancer le script réaligne sur l'état actuel des sources.
--    Si une policy ne peut pas être recopiée (colonne absente de la cible...) :
--      - permissive : sautée avec un warning, la cible reste plus fermée ;
--      - restrictive : erreur et rien n'est appliqué, car la sauter ouvrirait
--        la cible davantage que la source.
-- ─────────────────────────────────────────────────────────────
do $$
declare
  pair record;
  pol record;
  src_rls boolean;
  src_force boolean;
  roles_sql text;
  stmt text;
begin
  for pair in
    select * from (values
      ('categories', 'foods'),
      ('categories', 'food_aliases'),
      ('recipes', 'recipe_ingredients')
    ) as t (source_table, target_table)
  loop
    select c.relrowsecurity, c.relforcerowsecurity
      into src_rls, src_force
    from pg_class c
    where c.oid = format('public.%I', pair.source_table)::regclass;

    execute format('alter table public.%I %s row level security',
      pair.target_table, case when src_rls then 'enable' else 'disable' end);
    execute format('alter table public.%I %s row level security',
      pair.target_table, case when src_force then 'force' else 'no force' end);

    for pol in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = pair.target_table
    loop
      execute format('drop policy %I on public.%I', pol.policyname, pair.target_table);
    end loop;

    for pol in
      select * from pg_policies
      where schemaname = 'public' and tablename = pair.source_table
    loop
      select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ')
        into roles_sql
      from unnest(pol.roles) as r;

      stmt := format('create policy %I on public.%I as %s for %s to %s',
        pol.policyname, pair.target_table, pol.permissive, pol.cmd, roles_sql);
      if pol.qual is not null then
        stmt := stmt || format(' using (%s)', pol.qual);
      end if;
      if pol.with_check is not null then
        stmt := stmt || format(' with check (%s)', pol.with_check);
      end if;

      begin
        execute stmt;
      exception when others then
        if pol.permissive = 'RESTRICTIVE' then
          raise exception 'Policy restrictive % non recopiable sur % : %',
            pol.policyname, pair.target_table, sqlerrm;
        end if;
        raise warning 'Policy % non recopiée sur % : %', pol.policyname, pair.target_table, sqlerrm;
      end;
    end loop;
  end loop;
end $$;

commit;

-- ─────────────────────────────────────────────────────────────
-- Vérification : RLS et policies, sources et cibles côte à côte
-- ─────────────────────────────────────────────────────────────
select c.relname as table_name,
       c.relrowsecurity as rls,
       c.relforcerowsecurity as rls_force,
       coalesce((
         select string_agg(
           format('%s [%s, %s, %s]', p.policyname, p.cmd, p.permissive, array_to_string(p.roles, ',')),
           '; ' order by p.policyname)
         from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname
       ), '(aucune)') as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('categories', 'foods', 'food_aliases', 'recipes', 'recipe_ingredients')
order by c.relname;
