// Probe: does `codex app-server` give the built-in image_gen tool? With "--generate" it makes one image.
// Run: node tools/codex-probe.js <work dir> [model] [--generate]
const fs = require('fs');
const path = require('path');
const { CodexAppServer } = require('../src/codex-appserver');

const cwd = path.resolve(process.argv[2] || '.');
const model = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
const generate = process.argv.includes('--generate');
fs.mkdirSync(cwd, { recursive: true });

const text = generate
  ? 'Generate exactly one image with your built-in image_gen tool (not Canva, not any MCP/app connector, not any CLI/API script): a tiny round orange robot mascot, full body, centered, on a flat pure magenta #FF00FF background. Copy the generated PNG into the current folder as smoke.png. Then print SMOKE_RESULT=OK FILE=<absolute path>, or SMOKE_RESULT=NOTOOL if the built-in tool is not available.'
  : 'Do not generate anything. Is a built-in tool named image_gen (image generation) available to you right now? Print TOOL=YES or TOOL=NO, then list every image-related tool name you have.';

(async () => {
  const types = new Map();
  const cs = new CodexAppServer({
    onLog: l => console.log(l),
    onEvent: m => types.set(m.method, (types.get(m.method) || 0) + 1),
  });
  const t0 = Date.now();
  try {
    await cs.init();
    const r = await cs.runTurn({ cwd, model, text, timeoutMs: 8 * 60e3 });
    const kinds = r.items.map(i => i.type);
    console.log('turn status:', r.turn && r.turn.status, '| item types:', [...new Set(kinds)].join(', '));
    for (const it of r.items) {
      if (it.type === 'agentMessage') console.log('AGENT:', String(it.text || '').slice(0, 600));
      if (/image/i.test(it.type)) console.log('IMAGE ITEM:', JSON.stringify(it).slice(0, 600));
    }
    console.log('events:', JSON.stringify(Object.fromEntries(types)));
  } catch (e) {
    console.error('PROBE FAILED:', e.message);
  } finally {
    console.log('took', Math.round((Date.now() - t0) / 1000) + 's');
    cs.stop();
    setTimeout(() => process.exit(0), 500);
  }
})();
