// Builds a Codex-compatible pet.
// 1. "codex": runs `codex exec` with the hatch-pet skill (GPT image generation through Codex's built-in $imagegen).
// 2. "fal" / "venice": fallback. Uses hatch-pet's own prepare + processing scripts and swaps only the
//    image-generation step for the FAL or Venice HTTP API (GPT Image edit models, reference-grounded).
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CODEX_HOME, CODEX_PETS, readPet } = require('./pets');
const { CodexAppServer } = require('./codex-appserver');
const { killTree, defaultPython } = require('./platform');

const HATCH_DIR = path.join(CODEX_HOME, 'skills', 'hatch-pet');
const SCRIPTS = path.join(HATCH_DIR, 'scripts');
const QUOTA_RE = /usage limit|quota|rate.?limit|insufficient|too many requests|\b429\b|exceeded|out of credits|billing/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => String(s || 'pet').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pet';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
}
function dataUrl(p) {
  return `data:${mimeOf(p)};base64,${fs.readFileSync(p).toString('base64')}`;
}
function isPng(buf) {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

class PetBuilder extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.runsDir      where run folders go
   * @param {(name:string)=>string|null} o.getKey  returns a decrypted API key ('fal' | 'venice') or null
   * @param {()=>object} o.getSettings
   */
  constructor({ runsDir, getKey, getSettings, petsDir }) {
    super();
    this.runsDir = runsDir;
    this.petsDir = petsDir || CODEX_PETS;
    this.getKey = getKey;
    this.getSettings = getSettings;
    this.state = { active: false, log: [] };
    this.child = null;
    this.abort = null;
  }

  status() {
    return { ...this.state, log: this.state.log.slice(-200) };
  }

  log(line) {
    const l = `[${new Date().toLocaleTimeString()}] ${String(line).trimEnd()}`;
    this.state.log.push(l);
    if (this.state.log.length > 1000) this.state.log.splice(0, this.state.log.length - 1000);
    this.emit('update', this.status());
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit('update', this.status());
  }

  cancel() {
    this.cancelled = true;
    if (this.child) killTree(this.child);
    if (this.abort) this.abort.abort();
    if (this.codexSession) this.codexSession.stop();
    this.log('Cancel requested.');
  }

  /** Run a command; stream output to the log; resolve {code, out}. */
  run(cmd, args, { cwd, input, shell = false } = {}) {
    return new Promise((resolve, reject) => {
      const quoted = shell ? args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
      const child = spawn(cmd, quoted, { cwd, shell, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      this.child = child;
      let out = '';
      const onData = d => {
        const s = d.toString('utf8');
        out += s;
        if (out.length > 2e6) out = out.slice(-1e6);
        for (const line of s.split(/\r?\n/)) if (line.trim()) this.log(line);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', code => { this.child = null; resolve({ code, out }); });
      if (input != null) { child.stdin.write(input); }
      child.stdin.end();
    });
  }

  async py(script, args, cwd) {
    const s = this.getSettings();
    const [cmd, ...pre] = (s.pythonCmd || defaultPython()).split(' ');
    const r = await this.run(cmd, [...pre, path.join(SCRIPTS, script), ...args], { cwd });
    if (r.code !== 0) throw new Error(`${script} exited with code ${r.code}`);
    return r.out;
  }

  /**
   * @param {object} req {name, description, notes, style, reference, provider: 'auto'|'codex'|'fal'|'venice'}
   */
  async build(req) {
    if (this.state.active) throw new Error('A pet is already being built.');
    if (!fs.existsSync(path.join(SCRIPTS, 'prepare_pet_run.py'))) {
      throw new Error(`The hatch-pet skill was not found at ${HATCH_DIR}. Install it in Codex first.`);
    }
    this.cancelled = false;
    const settings = this.getSettings();
    const petId = slug(req.name);
    const order = req.provider && req.provider !== 'auto'
      ? [req.provider]
      : ['codex', ...(settings.autoFallback ? (settings.fallbackOrder || ['fal', 'venice']) : [])];

    this.state = { active: true, petId, provider: null, step: 'Starting', jobsDone: 0, jobsTotal: 0, log: [], result: null, startedAt: Date.now() };
    this.emit('update', this.status());
    let lastError = null;

    // Codex runs on its own. API providers (FAL, Venice) share one run: each image tries them in order,
    // so a FAL failure on one pose falls back to Venice for that pose without redoing finished images.
    const apiProviders = order.filter(p => p !== 'codex').filter(p => {
      if (this.getKey(p)) return true;
      this.log(`Skipping ${p}: no API key saved in Settings.`);
      return false;
    });
    const attempts = [...(order.includes('codex') ? ['codex'] : []), ...(apiProviders.length ? [apiProviders] : [])];

    for (const attempt of attempts) {
      if (this.cancelled) break;
      const provider = Array.isArray(attempt) ? attempt.join(' → ') : attempt;
      this.set({ provider, step: `Building with ${provider}` });
      this.log(`=== Trying ${provider} ===`);
      try {
        const result = attempt === 'codex'
          ? await this.buildWithCodex(req, petId)
          : await this.buildWithApi(req, petId, attempt);
        this.set({ active: false, step: 'Done', result: { ok: true, provider, ...result } });
        this.emit('done', this.state.result);
        return this.state.result;
      } catch (e) {
        lastError = e;
        this.log(`${provider} failed: ${e.message}`);
        if (this.cancelled) break;
      }
    }
    const error = this.cancelled ? 'Cancelled.' : (lastError ? lastError.message : 'No provider could run.');
    this.set({ active: false, step: 'Failed', result: { ok: false, error } });
    this.emit('done', this.state.result);
    return this.state.result;
  }

  // ---------- Codex (primary) ----------
  async buildWithCodex(req, petId) {
    const runDir = path.join(this.runsDir, `${stamp()}-${petId}-codex`);
    fs.mkdirSync(runDir, { recursive: true });
    const started = Date.now();
    const lastMsg = path.join(runDir, 'last-message.txt');
    const prompt = [
      'Use $hatch-pet to create a Codex-compatible animated pet. Run fully non-interactively: no user is available, so do not ask questions; make sensible choices and continue.',
      `Pet name: ${req.name}`,
      `Pet id (folder name): ${petId}`,
      req.description ? `Description: ${req.description}` : '',
      req.notes ? `Appearance notes: ${req.notes}` : '',
      `Style preset: ${req.style || 'auto'}`,
      req.reference ? `Reference image (absolute path): ${req.reference}` : 'No reference image: generate the base pet from text.',
      `Use this run folder: ${path.join(runDir, 'run')}`,
      'You are authorized to use lightweight subagents exactly as the skill describes.',
      'Use only the built-in $imagegen path. Do not use any CLI or API fallback that needs confirmation.',
      'If built-in image generation is unavailable, rate limited or out of quota, stop immediately and print the single line HATCH_PET_RESULT=QUOTA.',
      `Package the finished pet into ${path.join(CODEX_PETS, petId)} (pet.json + spritesheet.webp). Keep the qa folder (contact sheet, previews).`,
      `When finished print one line: HATCH_PET_RESULT=OK PET_DIR=<absolute pet dir> CONTACT_SHEET=<absolute contact sheet path>`,
    ].filter(Boolean).join('\n');

    // Drive Codex through `codex app-server`: the built-in image_gen tool is not offered to `codex exec`.
    const s = this.getSettings();
    const cs = new CodexAppServer({
      codexCmd: s.codexCmd || 'codex',
      onLog: l => this.log(l),
      onEvent: m => {
        if (m.method === 'item/completed' && m.params && m.params.item) {
          const it = m.params.item;
          if (it.type === 'agentMessage' && it.text) this.log('codex: ' + String(it.text).slice(0, 400));
          else if (it.type !== 'userMessage' && it.type !== 'reasoning') this.log(`codex: ${it.type} done`);
        }
      },
    });
    this.codexSession = cs;
    try {
      await cs.init();
      // Cheap check first, so an account without image generation falls back in seconds.
      this.set({ step: 'Checking Codex image generation' });
      const probe = await cs.runTurn({
        cwd: runDir, model: s.codexModel || undefined, timeoutMs: 5 * 60e3,
        text: 'Do not generate anything. Is your built-in image_gen (image generation) tool available right now? Answer with exactly TOOL=YES or TOOL=NO.',
      });
      const probeText = probe.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n');
      if (!/TOOL=YES/.test(probeText)) {
        throw new Error('Codex has no built-in image generation on this account right now (it said: ' + probeText.trim().slice(0, 80) + ').');
      }
      this.set({ step: 'Codex is hatching the pet (hatch-pet skill)' });
      const r = await cs.runTurn({ cwd: runDir, model: s.codexModel || undefined, text: prompt, timeoutMs: 90 * 60e3 });
      const text = r.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n');
      fs.writeFileSync(lastMsg, text);
      const pet = readPet(path.join(CODEX_PETS, petId));
      if (pet && pet.mtime >= started && /HATCH_PET_RESULT=OK/.test(text)) {
        const csPath = (text.match(/CONTACT_SHEET=(\S+)/) || [])[1] || null;
        return { petId, petDir: pet.dir, contactSheet: csPath && fs.existsSync(csPath) ? csPath : null };
      }
      if (/HATCH_PET_RESULT=QUOTA/.test(text) || QUOTA_RE.test(text.slice(-4000))) {
        throw new Error('Codex image generation looks out of quota or rate limited.');
      }
      throw new Error(`Codex did not produce a finished pet (turn ${r.turn && r.turn.status}).`);
    } finally {
      cs.stop();
      this.codexSession = null;
    }
  }

  // ---------- FAL / Venice (fallback) ----------
  async buildWithApi(req, petId, providers) {
    providers = Array.isArray(providers) ? providers : [providers];
    const runDir = path.join(this.runsDir, `${stamp()}-${petId}-${providers.join("-")}`);
    fs.mkdirSync(runDir, { recursive: true });
    this.set({ step: 'Preparing the pet run (hatch-pet prepare_pet_run.py)' });
    const prepArgs = ['--pet-name', req.name, '--pet-id', petId, '--output-dir', runDir, '--style-preset', req.style || 'auto', '--force'];
    if (req.description) prepArgs.push('--description', req.description);
    if (req.notes) prepArgs.push('--pet-notes', req.notes);
    if (req.reference) prepArgs.push('--reference', req.reference);
    await this.py('prepare_pet_run.py', prepArgs, runDir);

    const manifestPath = path.join(runDir, 'imagegen-jobs.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const saveManifest = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const done = id => manifest.jobs.find(j => j.id === id)?.status === 'complete';
    this.set({ jobsTotal: manifest.jobs.length, jobsDone: manifest.jobs.filter(j => j.status === 'complete').length });

    // Try each provider in order for this one image: prompt, then the retry prompt, then the next provider.
    const runJob = async job => {
      let bytes = null;
      let used = null;
      const errors = [];
      for (const p of providers) {
        for (const promptFile of [job.prompt_file, job.retry_prompt_file].filter(Boolean)) {
          if (this.cancelled) throw new Error('Cancelled.');
          this.log(`Generating ${job.id} with ${p}${promptFile === job.retry_prompt_file ? ' (retry prompt)' : ''}…`);
          try {
            bytes = await this.generateJob(runDir, job, p, promptFile);
            used = p;
            break;
          } catch (e) {
            errors.push(`${p}: ${e.message}`);
            this.log(`${job.id} failed on ${p}: ${e.message}`);
          }
        }
        if (bytes) break;
      }
      if (!bytes) throw new Error(`Could not generate ${job.id}. ${errors.join(' | ').slice(0, 400)}`);
      const provider = used;
      const out = path.join(runDir, job.output_path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, bytes);
      if (!isPng(bytes)) await this.toPng(out);
      if (job.id === 'base') {
        fs.mkdirSync(path.join(runDir, 'references'), { recursive: true });
        fs.copyFileSync(out, path.join(runDir, 'references', 'canonical-base.png'));
      }
      Object.assign(job, { status: 'complete', source_path: `${provider}:${job.id}`, completed_at: new Date().toISOString() });
      saveManifest();
      this.set({ jobsDone: manifest.jobs.filter(j => j.status === 'complete').length });
      this.log(`${job.id} done.`);
    };

    const concurrency = Math.max(1, Math.min(4, this.getSettings().apiConcurrency || 3));
    while (!manifest.jobs.every(j => j.status === 'complete')) {
      if (this.cancelled) throw new Error('Cancelled.');
      const ready = manifest.jobs.filter(j => j.status !== 'complete' && (j.depends_on || []).every(done));
      if (!ready.length) throw new Error('No image job is ready; the manifest has an unmet dependency.');
      this.set({ step: `Generating images (${manifest.jobs.filter(j => j.status === 'complete').length}/${manifest.jobs.length})` });
      for (let i = 0; i < ready.length; i += concurrency) {
        await Promise.all(ready.slice(i, i + concurrency).map(runJob));
      }
    }

    this.set({ step: 'Cutting frames and assembling the sprite sheet' });
    for (const d of ['final', 'qa']) fs.mkdirSync(path.join(runDir, d), { recursive: true });
    await this.py('extract_strip_frames.py', ['--decoded-dir', path.join(runDir, 'decoded'), '--output-dir', path.join(runDir, 'frames'), '--states', 'all', '--method', 'auto'], runDir);
    try {
      await this.py('inspect_frames.py', ['--frames-root', path.join(runDir, 'frames'), '--json-out', path.join(runDir, 'qa', 'review.json'), '--require-components'], runDir);
    } catch (e) {
      this.log(`Frame inspection reported problems (${e.message}). Continuing; check the contact sheet.`);
    }
    await this.py('compose_atlas.py', ['--frames-root', path.join(runDir, 'frames'), '--output', path.join(runDir, 'final', 'spritesheet.png'), '--webp-output', path.join(runDir, 'final', 'spritesheet.webp')], runDir);
    await this.py('validate_atlas.py', [path.join(runDir, 'final', 'spritesheet.webp'), '--json-out', path.join(runDir, 'final', 'validation.json')], runDir);
    const contactSheet = path.join(runDir, 'qa', 'contact-sheet.png');
    await this.py('make_contact_sheet.py', [path.join(runDir, 'final', 'spritesheet.webp'), '--output', contactSheet], runDir);
    try {
      await this.py('render_animation_previews.py', ['--frames-root', path.join(runDir, 'frames'), '--output-dir', path.join(runDir, 'qa', 'previews')], runDir);
    } catch (e) { this.log('Preview GIFs skipped: ' + e.message); }

    this.set({ step: 'Packaging the pet' });
    const request = JSON.parse(fs.readFileSync(path.join(runDir, 'pet_request.json'), 'utf8'));
    const petDir = path.join(this.petsDir, request.pet_id || petId);
    fs.mkdirSync(petDir, { recursive: true });
    fs.copyFileSync(path.join(runDir, 'final', 'spritesheet.webp'), path.join(petDir, 'spritesheet.webp'));
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
      id: request.pet_id || petId,
      displayName: request.display_name || req.name,
      description: request.description || req.description || '',
      spritesheetPath: 'spritesheet.webp',
    }, null, 2));
    fs.writeFileSync(path.join(runDir, 'qa', 'run-summary.json'), JSON.stringify({ ok: true, providers, run_dir: runDir, package: petDir, contact_sheet: contactSheet }, null, 2));
    return { petId: request.pet_id || petId, petDir, contactSheet, runDir };
  }

  async toPng(file) {
    const s = this.getSettings();
    const [cmd, ...pre] = (s.pythonCmd || defaultPython()).split(' ');
    const r = await this.run(cmd, [...pre, '-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGBA").save(sys.argv[1],"PNG")', file]);
    if (r.code !== 0) throw new Error('Could not convert the generated image to PNG.');
  }

  /** Make a plain chroma-key canvas for providers whose edit endpoint needs an input image. */
  async blankCanvas(runDir, color) {
    const p = path.join(runDir, 'references', 'blank-canvas.png');
    if (fs.existsSync(p)) return p;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const s = this.getSettings();
    const [cmd, ...pre] = (s.pythonCmd || defaultPython()).split(' ');
    const r = await this.run(cmd, [...pre, '-c', 'import sys;from PIL import Image;Image.new("RGB",(1024,1024),sys.argv[2]).save(sys.argv[1])', p, color]);
    if (r.code !== 0) throw new Error('Could not create a blank canvas image.');
    return p;
  }

  async generateJob(runDir, job, provider, promptFile) {
    const prompt = fs.readFileSync(path.join(runDir, promptFile), 'utf8');
    // Identity reference first, then layout guide: edit endpoints treat the first image as the main one.
    let images = (job.input_images || [])
      .map(i => ({ path: path.resolve(runDir, i.path), role: i.role }))
      .filter(i => fs.existsSync(i.path))
      .sort((a, b) => (/identity|reference/i.test(b.role) ? 1 : 0) - (/identity|reference/i.test(a.role) ? 1 : 0));
    const chroma = (prompt.match(/#[0-9A-Fa-f]{6}/) || ['#FF00FF'])[0];
    const header = images.length
      ? images.map((im, i) => `Input image ${i + 1}: ${im.role}.`).join('\n') + '\n\n'
      : '';
    if (provider === 'fal') {
      if (!images.length) {
        images = [{ path: await this.blankCanvas(runDir, chroma), role: 'blank background canvas' }];
        return this.falEdit(`Input image 1: a blank canvas in the background colour ${chroma}. Draw the pet on it.\n\n${prompt}`, images);
      }
      return this.falEdit(header + prompt, images);
    }
    if (provider === 'venice') {
      if (!images.length) return this.veniceGenerate(prompt);
      // Venice multi-edit edits the FIRST image and layers the rest onto it. Give it a blank chroma
      // canvas to draw on and pass the pet only as an identity reference (no layout guide).
      const identity = images.filter(i => /identity|reference/i.test(i.role));
      const vImages = [{ path: await this.blankCanvas(runDir, chroma), role: `blank ${chroma} canvas` }, ...(identity.length ? identity : images.slice(0, 1))];
      const vHeader = `Image 1 is an empty ${chroma} canvas: draw the whole result on it, replacing it completely. ` +
        `Image 2 is only an identity reference for the pet's look: do not copy its pose, size or position, and do not keep it in the output.\n\n`;
      return this.veniceEdit(vHeader + prompt, vImages);
    }
    throw new Error('Unknown provider ' + provider);
  }

  async http(url, opts = {}, timeoutMs = 300000) {
    this.abort = new AbortController();
    const t = setTimeout(() => this.abort.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: this.abort.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async falUpload(file, key) {
    // fal storage upload (same flow the official fal client uses). Falls back to a data URI if it fails.
    try {
      const init = await this.http('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
        method: 'POST',
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_type: mimeOf(file), file_name: path.basename(file) }),
      }, 60000);
      if (!init.ok) throw new Error(`initiate ${init.status}`);
      const { upload_url, file_url } = await init.json();
      const put = await this.http(upload_url, { method: 'PUT', headers: { 'Content-Type': mimeOf(file) }, body: fs.readFileSync(file) }, 120000);
      if (!put.ok) throw new Error(`upload ${put.status}`);
      return file_url;
    } catch (e) {
      this.log(`FAL upload failed (${e.message}); sending the image inline instead.`);
      return dataUrl(file);
    }
  }

  async falEdit(prompt, images) {
    const key = this.getKey('fal');
    const model = this.getSettings().falModel || 'openai/gpt-image-2.6/sunburst/edit';
    const image_urls = [];
    for (const im of images) image_urls.push(await this.falUpload(im.path, key));
    const sub = await this.http(`https://queue.fal.run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image_urls, quality: 'high', output_format: 'png', background: 'opaque', num_images: 1 }),
    }, 60000);
    if (!sub.ok) throw new Error(`FAL submit ${sub.status}: ${(await sub.text()).slice(0, 300)}`);
    const { status_url, response_url } = await sub.json();
    const deadline = Date.now() + 15 * 60e3;
    for (;;) {
      if (this.cancelled) throw new Error('Cancelled.');
      if (Date.now() > deadline) throw new Error('FAL timed out after 15 minutes.');
      await sleep(3000);
      const st = await this.http(status_url, { headers: { Authorization: `Key ${key}` } }, 60000);
      if (!st.ok) throw new Error(`FAL status ${st.status}`);
      const sj = await st.json();
      if (sj.status === 'COMPLETED') break;
      if (sj.error) throw new Error('FAL error: ' + JSON.stringify(sj.error).slice(0, 300));
    }
    const res = await this.http(response_url, { headers: { Authorization: `Key ${key}` } }, 60000);
    const rj = await res.json();
    if (!res.ok) throw new Error(`FAL result ${res.status}: ${JSON.stringify(rj).slice(0, 300)}`);
    const url = rj.images && rj.images[0] && rj.images[0].url;
    if (!url) throw new Error('FAL returned no image: ' + JSON.stringify(rj).slice(0, 300));
    if (url.startsWith('data:')) return Buffer.from(url.split(',')[1], 'base64');
    const img = await this.http(url, {}, 120000);
    return Buffer.from(await img.arrayBuffer());
  }

  async veniceEdit(prompt, images) {
    const key = this.getKey('venice');
    const modelId = this.getSettings().veniceEditModel || 'gpt-image-2-6-sunburst-edit';
    const res = await this.http('https://api.venice.ai/api/v1/image/multi-edit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, prompt, images: images.map(i => dataUrl(i.path)), quality: 'high', output_format: 'png' }),
    }, 600000);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.startsWith('image/')) throw new Error(`Venice multi-edit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async veniceGenerate(prompt) {
    const key = this.getKey('venice');
    const model = this.getSettings().veniceModel || 'gpt-image-2-6-sunburst';
    const res = await this.http('https://api.venice.ai/api/v1/image/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, format: 'png', return_binary: true, quality: 'high', aspect_ratio: '1:1' }),
    }, 600000);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.startsWith('image/')) throw new Error(`Venice generate ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

module.exports = { PetBuilder, slug, HATCH_DIR };
