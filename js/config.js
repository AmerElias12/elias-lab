/* ============================================================
   Elias Lab Notebook — configuration
   ------------------------------------------------------------
   To turn on the SHARED backend (data syncs across devices and
   is backed up), create a free Supabase project and paste its
   Project URL + anon/public key below. See DEPLOY.md for steps.

   While these are blank, the notebook runs in LOCAL MODE:
   data is stored only in this browser (localStorage), exactly
   like the original version. A banner reminds you it isn't shared.

   The anon key is SAFE to commit / ship publicly — Row-Level
   Security on the database is what actually protects your data.

   SCIENCE_API_URL is the origin of the small Python service that
   runs the restriction-cloning and primer-design calculations
   (backend/app/science.py) — the two things no browser and no
   Supabase Edge Function can do, because they need pydna and
   Biopython. Leave it BLANK until that service has a host: blank
   means "not configured", and the molecular tools then do exactly
   what they did before it existed, in the browser, with a line
   saying the server panels are off. No URL is committed here.
   ============================================================ */
window.ELIAS_CONFIG = {
  SUPABASE_URL: 'https://obegyesekombhzadaipj.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_bCZaXq04N_huJCF2hUdF6A_4_p2KgRH',  // publishable (public) key
  ADMIN_EMAIL: 'amere@braude.ac.il',
  SCIENCE_API_URL: ''  // e.g. 'https://tools.eliaslab.org' — blank = off
};
