// Writes src/build-info.json (version + build time) so the running app can show which build it is.
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const builtAt = `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'build-info.json'), JSON.stringify({ version: pkg.version, builtAt }) + '\n');
console.log('build stamp', pkg.version, builtAt);
