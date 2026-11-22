// Offline test of the API-fallback pipeline: hatch-pet prepare -> image jobs -> frame extraction ->
// atlas -> validation -> contact sheet -> packaging. The image step is replaced by simple synthetic
// strips (a drawn blob that bobs from frame to frame), so no API is called and nothing is spent.
// Run: node tools/pipeline-test.js [output dir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PetBuilder } = require('../src/builder');
const { defaultPython } = require('../src/platform');

const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 't3pet-pipe-')));
const stripsDir = path.join(out, 'fake-strips');
fs.mkdirSync(stripsDir, { recursive: true });

// Draw fake "generated" strips on magenta, one blob per frame slot, like an image model would.
const py = `
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
rows = {'idle':6,'running-right':8,'running-left':8,'waving':4,'jumping':5,'failed':8,'waiting':6,'running':6,'review':6}
def blob(d, cx, cy, s):
    d.ellipse([cx-60*s, cy-55*s, cx+60*s, cy+60*s], fill=(120,110,240))
    d.ellipse([cx-28*s, cy-15*s, cx-12*s, cy+5*s], fill=(20,20,40))
    d.ellipse([cx+12*s, cy-15*s, cx+28*s, cy+5*s], fill=(20,20,40))
for name, n in rows.items():
    strip = Image.new('RGB', (192*n, 208), (255,0,255))
    d = ImageDraw.Draw(strip)
    for i in range(n):
        blob(d, i*192+96, 110 - (i % 3) * 6, 1.0)
    strip.save(f'{out}/{name}.png')
base = Image.new('RGB', (1024,1024), (255,0,255))
blob(ImageDraw.Draw(base), 512, 540, 3.2)
base.save(f'{out}/base.png')
print('strips ok')
`;
const pyCmd = defaultPython();
const r = spawnSync(pyCmd, ['-c', py, stripsDir], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr || r.error); process.exit(1); }

const settings = { pythonCmd: pyCmd, apiConcurrency: 3 };
const b = new PetBuilder({ runsDir: path.join(out, 'runs'), petsDir: path.join(out, 'pets'), getKey: () => 'offline', getSettings: () => settings });
// Simulate a FAL outage on one pose: that pose must come from Venice, the rest from FAL.
b.generateJob = async (_runDir, job, provider) => {
  if (provider === 'fal' && job.id === 'waving') throw new Error('simulated FAL outage');
  return fs.readFileSync(path.join(stripsDir, job.id + '.png'));
};
b.on('update', () => {});
const t0 = Date.now();
b.buildWithApi({ name: 'Pipeline Test', description: 'Offline pipeline test pet.', notes: 'cat', style: 'auto' }, 'pipeline-test', ['fal', 'venice'])
  .then(res => {
    const v = JSON.parse(fs.readFileSync(path.join(res.runDir, 'final', 'validation.json'), 'utf8'));
    console.log('package:', res.petDir);
    console.log('files:', fs.readdirSync(res.petDir).join(', '));
    console.log('contact sheet:', res.contactSheet);
    console.log('validation ok:', v.ok, '| errors:', JSON.stringify(v.errors || []).slice(0, 300));
    const jobs = JSON.parse(fs.readFileSync(path.join(res.runDir, 'imagegen-jobs.json'), 'utf8')).jobs;
    console.log('sources:', jobs.map(j => j.source_path).join(', '));
    if (jobs.find(j => j.id === 'waving').source_path !== 'venice:waving') throw new Error('per-image fallback did not use Venice');
    console.log('took', Math.round((Date.now() - t0) / 1000) + 's');
  })
  .catch(e => { console.error('PIPELINE FAILED:', e.message); console.error(b.state.log.slice(-25).join('\n')); process.exit(1); });
