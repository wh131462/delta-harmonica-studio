const fs = require('fs');
const path = process.env.APPDATA + '/三角洲口琴工坊/settings.json';
const settings = JSON.parse(fs.readFileSync(path, 'utf8'));
settings.disclaimerAccepted = true;
settings.disclaimerAcceptedAt = new Date().toISOString();
settings.input.targetWindowHandle = null;
settings.input.targetWindowTitle = null;
fs.writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8');
console.log('settings updated');
