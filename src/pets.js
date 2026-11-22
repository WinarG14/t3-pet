// Finds Codex-compatible pets (pet.json + 8x9 spritesheet) in ~/.codex/pets and the app's own pets folder.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_PETS = path.join(CODEX_HOME, 'pets');

// Codex pet atlas contract (from the hatch-pet skill: references/animation-rows.md).
const ATLAS = {
  columns: 8, rows: 9, cellWidth: 192, cellHeight: 208, width: 1536, height: 1872,
  states: {
    idle:            { row: 0, durations: [280, 110, 110, 140, 140, 320] },
    'running-right': { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
    'running-left':  { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
    waving:          { row: 3, durations: [140, 140, 140, 280] },
    jumping:         { row: 4, durations: [140, 140, 140, 140, 280] },
    failed:          { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
    waiting:         { row: 6, durations: [150, 150, 150, 150, 150, 260] },
    running:         { row: 7, durations: [120, 120, 120, 120, 120, 220] },
    review:          { row: 8, durations: [150, 150, 150, 150, 150, 280] },
  },
};

function readPet(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'));
    const sheet = path.join(dir, manifest.spritesheetPath || 'spritesheet.webp');
    if (!fs.existsSync(sheet)) return null;
    return {
      id: manifest.id || path.basename(dir),
      displayName: manifest.displayName || manifest.id || path.basename(dir),
      description: manifest.description || '',
      dir,
      spritesheet: sheet,
      mtime: fs.statSync(sheet).mtimeMs,
    };
  } catch {
    return null;
  }
}

function listPets(extraDirs = []) {
  const roots = [CODEX_PETS, ...extraDirs];
  const seen = new Map();
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pet = readPet(path.join(root, e.name));
      if (pet && !seen.has(pet.id)) seen.set(pet.id, pet);
    }
  }
  return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

module.exports = { listPets, readPet, ATLAS, CODEX_HOME, CODEX_PETS };
