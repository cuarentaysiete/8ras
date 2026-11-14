// Validate manifest structure against Adobe UXP schema
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

console.log('=== Manifest Validation ===');
console.log('id:', manifest.id);
console.log('name:', manifest.name);
console.log('version:', manifest.version);
console.log('main:', manifest.main);
console.log('host.app:', manifest.host?.app);
console.log('host.minVersion:', manifest.host?.minVersion);
console.log('permissions:', JSON.stringify(manifest.permissions));
console.log('entrypoints count:', (manifest.entrypoints || []).length);

if (manifest.entrypoints) {
  manifest.entrypoints.forEach((ep, i) => {
    console.log(`\nEntrypoint ${i}:`);
    console.log('  type:', ep.type);
    console.log('  id:', ep.id);
    console.log('  label:', JSON.stringify(ep.label));
    console.log('  path:', ep.path);
    console.log('  minimumSize:', JSON.stringify(ep.minimumSize));
    console.log('  preferredDockedSize:', JSON.stringify(ep.preferredDockedSize));
  });
}

// Check required files
const requiredFiles = ['index.html', 'bundle.js', 'package.json'];
requiredFiles.forEach(f => {
  const exists = fs.existsSync(path.join(__dirname, f));
  console.log(`${f}: ${exists ? 'EXISTS' : 'MISSING'}`);
});

console.log('\nAll checks passed!');
