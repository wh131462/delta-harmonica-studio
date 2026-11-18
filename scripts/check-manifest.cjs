const fs = require('fs');
for (const p of ['release/win-unpacked/DeltaHarmonicaStudio.exe','release-a/win-unpacked/DeltaHarmonicaStudio.exe','release-c/win-unpacked/DeltaHarmonicaStudio.exe']) {
  try {
    const buf = fs.readFileSync(p);
    const text = buf.toString('latin1');
    const hits = ['requireAdministrator','asInvoker','highestAvailable'].filter(k => text.includes(k));
    console.log(p, 'size=', buf.length, 'manifestHits=', hits.join(','));
  } catch (e) { console.log(p, 'ERROR', e.message); }
}
