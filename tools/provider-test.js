// Live test of an image provider on jobs of a prepared hatch-pet run (default: base + idle row with FAL).
// Run: node tools/provider-test.js <run dir prepared by prepare_pet_run.py> <file holding the API key> [--provider fal|venice] [--jobs base,idle]
const fs = require('fs');
const path = require('path');
const { PetBuilder } = require('../src/builder');

const runDir = path.resolve(process.argv[2]);
const key = fs.readFileSync(process.argv[3], 'utf8').trim();
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const provider = arg('--provider') || 'fal';
const ids = (arg('--jobs') || 'base,idle').split(',');
const b = new PetBuilder({ runsDir: runDir, getKey: () => key, getSettings: () => ({ pythonCmd: 'py' }) });
b.on('update', () => {});

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'imagegen-jobs.json'), 'utf8'));
  for (const id of ids) {
    const job = manifest.jobs.find(j => j.id === id);
    const t0 = Date.now();
    try {
      const bytes = await b.generateJob(runDir, job, provider, job.prompt_file);
      const out = path.join(runDir, job.output_path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, bytes);
      if (id === 'base') {
        fs.mkdirSync(path.join(runDir, 'references'), { recursive: true });
        fs.copyFileSync(out, path.join(runDir, 'references', 'canonical-base.png'));
      }
      console.log(`${provider} ${id}: OK ${bytes.length} bytes in ${Math.round((Date.now() - t0) / 1000)}s -> ${out}`);
    } catch (e) {
      console.log(`${id}: FAILED ${e.message}`);
      console.log(b.state.log.slice(-6).join('\n'));
      process.exit(1);
    }
  }
})();
