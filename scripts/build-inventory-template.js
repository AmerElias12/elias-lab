#!/usr/bin/env node
/* Rebuild assets/elias-lab-inventory-template.xlsx, the bulk upload template
   the Lab Notebook offers for download.

   The columns come from INV_CONFIG in js/notebook.js, so run this after
   adding or renaming an inventory column:

     node scripts/build-inventory-template.js

   No npm install needed: it uses the SheetJS copy in vendor/. */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.join(__dirname, '..');
var XLSX = require(path.join(root, 'vendor', 'xlsx.full.min.js'));

// Run notebook.js with just enough of a browser around it to define its
// functions; nothing in it runs until the page fires events, which never come.
var noop = function () {};
var sandbox = {
  document: { addEventListener: noop, getElementById: function () { return null; }, visibilityState: 'hidden' },
  addEventListener: noop,
  setInterval: noop,
  console: console
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js', 'notebook.js'), 'utf8'), sandbox, { filename: 'notebook.js' });

var out = path.join(root, sandbox.BULK_TEMPLATE_URL);
// The browser build of SheetJS can't touch the file system, so write the bytes here.
fs.writeFileSync(out, XLSX.write(sandbox.buildInventoryTemplate(XLSX), { bookType: 'xlsx', type: 'buffer', compression: true }));
console.log('Wrote ' + path.relative(root, out));
