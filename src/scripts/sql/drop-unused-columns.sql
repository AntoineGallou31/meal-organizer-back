-- Supprime recipes.seasons et recipes.confidence, inutilisées.
-- Vérifié : aucun code du back ni du front ne lit ou n'écrit ces colonnes
-- (le payload des routes est construit champ par champ).
--
-- À exécuter dans l'éditeur SQL Supabase : prod, puis démo.
-- Idempotent. Les données de ces deux colonnes sont perdues définitivement.

begin;

-- Garde-fou : les fonctions SQL/plpgsql ne déclarent pas leurs dépendances aux
-- colonnes, donc Postgres laisserait supprimer une colonne qu'elles lisent.
-- On arrête tout si une fonction ou une vue du schéma public les mentionne.
do $$
declare
  offenders text;
begin
  select string_agg(obj, ', ') into offenders
  from (
    select 'fonction ' || p.proname as obj
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ~* '\m(seasons|confidence)\M'
    union all
    select 'vue ' || c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
      and pg_get_viewdef(c.oid) ~* '\m(seasons|confidence)\M'
  ) s;

  if offenders is not null then
    raise exception 'seasons/confidence encore mentionnées par : %', offenders;
  end if;
end $$;

alter table public.recipes drop column if exists seasons;
alter table public.recipes drop column if exists confidence;

commit;
