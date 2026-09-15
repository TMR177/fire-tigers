/* Fire Tigers — project config.
 *
 * The publishable key belongs here in the open. It identifies the project; it
 * does not grant access. Every table has row-level security, so this key reads
 * nothing at all until a team member is signed in. The secret key is the one
 * that bypasses all of that, and it is not in this repo and never will be.
 */
window.FT_CONFIG = {
  supabaseUrl: 'https://dnjgijqkzwhkvgkrqrrj.supabase.co',
  publishableKey: 'sb_publishable_M5HUQJGza0Ly9MyikEdsEA_EKa2I9Tl',
  teamId: '11111111-1111-1111-1111-111111111111',

  // Filled in once the share link is generated. Parents open
  // <site>/view.html#<token> — no account, read-only, revocable.
  parentViewPath: 'view.html'
};
