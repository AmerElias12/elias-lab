/* ------------------------------------------------------------
   TEMPLATE — copy this file to  js/config.js  and fill in the
   two values from your Supabase project (Settings → API).
   The anon/public key is safe to commit; Row-Level Security
   protects the data. Leave blank to run in local-only mode.

   SCIENCE_API_URL is where the molecular tools service
   (backend/app/science.py) is reachable. Leave it blank unless
   you are running one: blank means the two molecular tools do
   their own arithmetic in the browser, as they always have.
   Whatever you set here must be listed in that service's
   ELN_CORS_ORIGINS, or the browser discards every answer.
   ------------------------------------------------------------ */
window.ELIAS_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-ref.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-PUBLIC-KEY',
  ADMIN_EMAIL: 'amere@braude.ac.il',
  SCIENCE_API_URL: ''  // e.g. 'https://tools.example.org' — blank = off
};
