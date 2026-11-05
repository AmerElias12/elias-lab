/* Checks the lab-life gallery: the public page, the upload page, and above
 * all the wall between the two buckets.
 *
 *     node scripts/check-gallery.mjs
 *
 * Everything else in this project is private lab data behind a login. The
 * gallery is the one thing deliberately readable by the whole internet, which
 * makes it the one place where a mistake is published rather than merely
 * wrong. So most of these checks are about the separation: that lab-photos is
 * public and lab-files is not, that nothing writes an attachment into the
 * public bucket, and that the people uploading are told in plain words what
 * "public" means before they do it.
 *
 * The rest check that the public page degrades to nothing. A visitor to the
 * lab's front door should never see a stack trace because a table has not
 * been created yet.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const gallery = read('js', 'gallery.js');
const data = read('js', 'data.js');
const notebookJs = read('js', 'notebook.js');
const notebookHtml = read('notebook.html');
const indexHtml = read('index.html');
const sql = read('supabase', 'schema.sql');

let pass = 0;
const check = (what, fn) => {
  try { fn(); } catch (err) {
    console.log(`  FAIL  ${what}\n          ${err.message}`);
    process.exitCode = 1;
    return;
  }
  pass++;
  console.log(`  ok    ${what}`);
};

console.log('The wall between private files and public photos');

check('the private bucket stays private and the public one stays public', () => {
  assert.match(sql, /values \('lab-files','lab-files', false\)[\s\S]*?set public = false/,
    'lab-files must be created private AND forced private on a re-run');
  assert.match(sql, /values \('lab-photos','lab-photos', true\)[\s\S]*?set public = true/);
});

check('only lab-photos is readable without a login', () => {
  // Storage: the read policy for lab-files names authenticated only.
  assert.match(sql, /create policy lab_files_read on storage\.objects\s*\n\s*for select to authenticated/);
  assert.match(sql, /create policy lab_photos_obj_read on storage\.objects\s*\n\s*for select to anon, authenticated/);
  // And an anonymous reader must not be able to reach lab-files through it.
  const anonPolicies = sql.match(/to anon[^;]*/g) || [];
  anonPolicies.forEach((p) => {
    assert.doesNotMatch(p, /lab-files/, 'an anon policy mentions lab-files');
  });
});

check('writing to the public bucket still needs an approved member', () => {
  assert.match(sql, /lab_photos_obj_write[\s\S]*?for insert to authenticated with check \(bucket_id = 'lab-photos' and public\.is_approved\(\)\)/);
  assert.match(sql, /lab_photos_obj_delete[\s\S]*?for delete to authenticated using \(bucket_id = 'lab-photos' and public\.is_approved\(\)\)/);
  assert.match(sql, /lab_photos_write[\s\S]*?for insert to authenticated with check \(public\.is_approved\(\)\)/);
});

check('the captions table is readable by anyone — that is what the page renders', () => {
  assert.match(sql, /create policy lab_photos_read on public\.lab_photos\s*\n\s*for select to anon, authenticated using \(true\)/);
});

check('no other table was opened up to anonymous readers', () => {
  // The notebook's own tables are revoked from anon and granted only to
  // signed-in users. Adding the gallery must not have loosened that.
  assert.match(sql, /revoke all on public\.profiles, public\.protocols, public\.notebooks,\s*\n\s*public\.presentations, public\.inventory_items from anon/);
  // lab_photos is the one table anon may touch, and only to read it.
  // Statements only: the word "grant" turns up in the comments too.
  const bare = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const anonGrants = (bare.match(/grant[^;]*to anon[^;]*/gi) || []).map((g) => g.replace(/\s+/g, ' ').trim());
  assert.deepEqual(anonGrants, ['grant select on public.lab_photos to anon'],
    'something else is granted to anon: ' + anonGrants.join(' | '));
});

check('lab_photos is granted at all — a policy alone is not access', () => {
  // Postgres checks the grant before the policy, so a table with policies
  // and no grant answers "permission denied for table lab_photos". It did,
  // to everyone, until this line existed.
  assert.match(sql, /grant select, insert, update, delete on public\.lab_photos to authenticated/);
  assert.match(sql, /grant select on public\.lab_photos to anon/);
});

check('attachments and photos never share a path in the app', () => {
  // The two helpers must address different buckets; a single wrong string
  // here is how an unpublished figure ends up on the open web.
  const fileOps = data.match(/storage\.from\('lab-files'\)/g) || [];
  const photoOps = data.match(/storage\.from\('lab-photos'\)/g) || [];
  assert.ok(fileOps.length >= 2, 'the attachment helpers stopped using lab-files');
  assert.ok(photoOps.length >= 3, 'the photo helpers stopped using lab-photos');
  // addPhoto/removePhoto/photoUrl must not touch lab-files at all.
  const photoBlock = data.slice(data.indexOf('listPhotos:'), data.indexOf('photoUrl:') + 400);
  assert.doesNotMatch(photoBlock, /lab-files/, 'a photo helper reaches into the private bucket');
});

check('attachments are still handed out as signed, expiring links', () => {
  assert.match(data, /createSignedUrl/, 'private files must not become public URLs');
  const publicUrls = data.match(/getPublicUrl\([^)]*\)/g) || [];
  assert.equal(publicUrls.length, 1, 'getPublicUrl should appear once, for photos only');
  const around = data.slice(data.indexOf('getPublicUrl') - 200, data.indexOf('getPublicUrl'));
  assert.match(around, /lab-photos/);
});

console.log('\nTelling people it is public before they upload');

check('the upload page says it plainly, not in passing', () => {
  const page = notebookJs.slice(notebookJs.indexOf('async function renderPhotos'),
    notebookJs.indexOf('function openPhotoModal'));
  assert.match(page, /public/i);
  assert.match(page, /anyone with the link/i);
  assert.match(page, /not behind the notebook/i,
    'people assume the notebook login protects everything in it');
});

check('the upload dialog repeats it where the choice is actually made', () => {
  const modal = notebookJs.slice(notebookJs.indexOf('function openPhotoModal'),
    notebookJs.indexOf('async function savePhotos'));
  assert.match(modal, /public/i);
  assert.match(modal, /readable by anyone/i);
});

check('schema.sql warns too, for whoever runs it', () => {
  assert.match(sql, /PUBLIC means public/);
});

console.log('\nUploading');

check('only images, and only small ones, are accepted', () => {
  assert.match(data, /\/\^image\\\//, 'addPhoto must check the MIME type');
  assert.match(data, /10 \* 1024 \* 1024/);
  assert.match(notebookJs, /accept="image\/\*"/, 'the file picker should ask for images');
});

check('a failed row insert does not leave an orphaned public image', () => {
  const add = data.slice(data.indexOf('addPhoto:'), data.indexOf('removePhoto:'));
  assert.match(add, /if \(r\.error\)[\s\S]*?remove\(\[path\]\)/,
    'an image with no row is unreachable from the app but still public');
});

check('one bad file in a batch does not hide the ones that worked', () => {
  // Uploading ten photos and being told only "failed" would be worse than
  // useless: you cannot tell which to try again.
  const save = notebookJs.slice(notebookJs.indexOf('async function savePhotos'),
    notebookJs.indexOf('async function removePhoto'));
  assert.match(save, /failed/);
  assert.match(save, /done \+\+|done\+\+/);
  assert.match(save, /\+ ' uploaded\. '/, 'the count that succeeded has to be shown');
  assert.match(save, /renderPhotos\(\)/, 'the page must refresh either way');
});

check('removing a photo asks first', () => {
  const rm = notebookJs.slice(notebookJs.indexOf('async function removePhoto'));
  assert.match(rm.slice(0, 500), /confirm\(/);
});

check('local mode says why there is no gallery instead of failing', () => {
  assert.match(notebookJs, /DB\.mode !== 'supabase'[\s\S]{0,400}?no public site/i);
  assert.match(data, /The gallery needs the shared database/);
});

console.log('\nThe public page');

check('the gallery does not pull in the Supabase client', () => {
  // The front door should not download ~100 KB of library to read captions.
  assert.doesNotMatch(gallery, /supabase-js|createClient|window\.supabase/);
  assert.match(gallery, /fetch\(/);
  const tags = indexHtml.match(/<script[^>]*src="[^"]*"[^>]*>/g) || [];
  tags.forEach((t) => assert.doesNotMatch(t, /supabase/, 'index.html loads the Supabase SDK: ' + t));
});

check('index.html loads the gallery and the config it needs', () => {
  assert.match(indexHtml, /<script src="js\/config\.js/);
  assert.match(indexHtml, /<script src="js\/gallery\.js/);
  assert.ok(indexHtml.indexOf('js/config.js') < indexHtml.indexOf('js/gallery.js'),
    'config has to be in place before the gallery reads it');
});

check('the section lives under Team and starts hidden', () => {
  const at = indexHtml.indexOf('id="team"');
  assert.ok(at > 0, 'there is no Team section in index.html');
  const open = indexHtml.lastIndexOf('<section', at);
  const inside = indexHtml.slice(open, indexHtml.indexOf('</section>', open));
  assert.match(inside, /id="lab-gallery-section"/, 'the gallery must sit inside the Team section');
  assert.match(inside, /id="lab-gallery-section"[^>]*\shidden/,
    'it has to be hidden until there is something in it');
  assert.match(inside, /id="lab-gallery"/);
});

check('every failure leaves the section hidden rather than showing an error', () => {
  const load = gallery.slice(gallery.indexOf('async function load'));
  // Each guard returns before section.hidden = false.
  const firstUnhide = load.indexOf('section.hidden = false');
  assert.ok(firstUnhide > 0);
  const before = load.slice(0, firstUnhide);
  assert.match(before, /!cfg\.SUPABASE_URL \|\| !cfg\.SUPABASE_ANON_KEY/);
  assert.match(before, /if \(!r\.ok\) return;/);
  assert.match(before, /catch \(e\) \{\s*\n\s*return;/);
  assert.match(before, /if \(!photos\.length\) return;/);
  assert.doesNotMatch(gallery, /alert\(|console\.error|innerHTML\s*=\s*['"][^'"]*[Ee]rror/);
});

check('captions and paths are escaped on the way into the page', () => {
  assert.match(gallery, /function esc\(/);
  const render = gallery.slice(gallery.indexOf('function render'), gallery.indexOf('async function load'));
  const interpolations = render.match(/'\s*\+\s*([A-Za-z0-9_.()\[\]]+)/g) || [];
  // Every value put into HTML goes through esc(...) or is a literal.
  assert.doesNotMatch(render, /\+\s*p\.caption\s*\+/, 'a raw caption is concatenated into HTML');
  assert.doesNotMatch(render, /\+\s*p\.path\s*\+/, 'a raw path is concatenated into HTML');
  assert.ok(interpolations.length > 0);
});

console.log('\nCategories');

const cats = (() => {
  // Run the three category lists out of the shipped sources and compare them.
  const pick = (src, name) => {
    const start = src.indexOf('var ' + name);
    assert.ok(start >= 0, name + ' is missing');
    const end = src.indexOf('];', start) + 2;
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(src.slice(start, end), ctx);
    return ctx[name];
  };
  return { site: pick(gallery, 'CATEGORIES'), notebook: pick(notebookJs, 'PHOTO_CATS') };
})();

check('the three the lab asked for are all there', () => {
  const keys = cats.notebook.map((c) => c.key).join(',');
  assert.equal(keys, 'daily,occasions,conferences');
});

check('the public tabs match the upload categories, plus All', () => {
  const site = cats.site.map((c) => c.key).join(',');
  assert.equal(site, 'all,daily,occasions,conferences',
    'a category you can upload into but not browse would be invisible');
  const labelsMatch = cats.notebook.every((c) => {
    const twin = cats.site.filter((s) => s.key === c.key)[0];
    return twin && twin.label === c.label;
  });
  assert.ok(labelsMatch, 'the same category is labelled differently on the two pages');
});

check('the default category is one of the three', () => {
  assert.match(sql, /category text default 'daily'/);
  assert.ok(cats.notebook.some((c) => c.key === 'daily'));
  assert.match(data, /meta\.category \|\| 'daily'/);
  assert.match(gallery, /p\.category \|\| 'daily'/);
});

check('an empty category shows no tab rather than an empty grid', () => {
  const render = gallery.slice(gallery.indexOf('function render'));
  assert.match(render, /c\.key === 'all' \|\| have\[c\.key\]/);
});

console.log('\nWiring');

check('the notebook page, nav item and route all exist', () => {
  assert.match(notebookHtml, /onclick="lnShow\('photos'\)"/);
  assert.match(notebookHtml, /id="ln-photos"/);
  assert.match(notebookHtml, /id="ln-photos-body"/);
  assert.match(notebookHtml, /onclick="openPhotoModal\(\)"/);
  assert.match(notebookJs, /section === 'photos'\) renderPhotos\(\)/);
});

check('every function the page calls is defined', () => {
  ['renderPhotos', 'openPhotoModal', 'savePhotos', 'removePhoto'].forEach((fn) => {
    assert.match(notebookJs, new RegExp('function ' + fn + '\\('), fn + ' is referenced but not defined');
  });
  ['listPhotos', 'addPhoto', 'removePhoto', 'photoUrl'].forEach((fn) => {
    assert.match(data, new RegExp(fn + ':'), 'DB.' + fn + ' is missing');
  });
});

check('the cache-busting versions were bumped with the code', () => {
  assert.match(notebookHtml, /js\/notebook\.js\?v=(3[2-9]|[4-9]\d)/, 'notebook.js ?v= is stale');
  assert.match(notebookHtml, /css\/notebook\.css\?v=(2[8-9]|[3-9]\d)/, 'notebook.css ?v= is stale');
  assert.match(indexHtml, /js\/gallery\.js\?v=\d+/);
  assert.match(indexHtml, /css\/site\.css\?v=\d+/);
});

check('schema.sql is still safe to re-run with the gallery in it', () => {
  const creates = sql.match(/^\s*create table (?!if not exists)/gim) || [];
  assert.equal(creates.length, 0);
  const drops = (sql.match(/^\s*drop\s+(\w+)/gim) || []).map((d) => d.trim().split(/\s+/)[1].toLowerCase());
  drops.forEach((kind) => assert.ok(['policy', 'trigger'].indexOf(kind) >= 0,
    'schema.sql drops a ' + kind + ', which re-running would not be safe for'));
  assert.match(sql, /insert into storage\.buckets[\s\S]*?on conflict \(id\) do update/);
});

console.log(`\n${pass} checks passed`);
