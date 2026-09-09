-- A executer une fois dans l'editeur SQL Supabase pour activer la
-- persistance des suggestions de la semaine (voir services/recipeRecommendation.js).
create table if not exists weekly_suggestions (
  week text primary key,             -- format ISO "YYYY-Www", ex: "2026-W37"
  recipe_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
