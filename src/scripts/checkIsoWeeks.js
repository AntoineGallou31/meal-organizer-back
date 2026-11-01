// Verifie getWeekDays (routes/mealPlan.js) sur des semaines ISO limites, et que
// chaque jour renvoye retombe bien sur la meme semaine via toIsoWeek.
// Aucun appel a Supabase : des valeurs factices suffisent pour charger les modules.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'placeholder';

const { getWeekDays } = require('../routes/mealPlan');
const { toIsoWeek } = require('../services/recipeRecommendation');

const CASES = [
  { week: '2026-W53', from: '2026-12-28', to: '2027-01-03' },
  { week: '2027-W01', from: '2027-01-04', to: '2027-01-10' },
  { week: '2027-W02', from: '2027-01-11', to: '2027-01-17' },
  { week: '2020-W53', from: '2020-12-28', to: '2021-01-03' },
];

// toIsoWeek lit les composantes locales de la date.
const toLocalDate = (dateString) => {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day);
};

let failures = 0;

for (const { week, from, to } of CASES) {
  const days = getWeekDays(week);
  const roundTrip = days.filter((date) => toIsoWeek(toLocalDate(date)) !== week);
  const ok = days.length === 7 && days[0] === from && days[6] === to && roundTrip.length === 0;

  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${week} : ${days[0]} -> ${days[6]} (attendu ${from} -> ${to})`);
  if (roundTrip.length) {
    console.log(`     toIsoWeek incoherent pour : ${roundTrip.join(', ')}`);
  }
}

console.log(failures ? `\n${failures} cas en echec.` : '\nTous les cas passent.');
process.exit(failures ? 1 : 0);
