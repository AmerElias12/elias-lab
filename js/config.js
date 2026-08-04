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
   ============================================================ */
window.ELIAS_CONFIG = {
  SUPABASE_URL: '',        // e.g. 'https://abcdxyz.supabase.co'
  SUPABASE_ANON_KEY: '',   // e.g. 'eyJhbGciOi...'
  ADMIN_EMAIL: 'amere@braude.ac.il'
};
