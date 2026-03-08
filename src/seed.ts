/**
 * Seed script: creates DB tables (if needed), starter vocabulary, and a minimal sample world.
 * Run after npm run build: node dist/seed.js
 * Or: npm run db:init then npm run seed
 */

import { initDatabase, getDbPath } from "./db/schema.js";
import { insertVocabulary } from "./db/database.js";

const dbPath = getDbPath();
const db = initDatabase(dbPath);

function clearHistoryLedger(): void {
  db.prepare("DELETE FROM history_ledger").run();
  console.log("Cleared history_ledger.");
}

const STARTER_VOCABULARY: [string, string][] = [
  ["locked", "Blocks passage or interaction. Requires a key, tool, or specific action to remove."],
  ["broken", "Object cannot perform its primary function. May still be used as raw material or weapon."],
  ["lit", "Object is actively burning or glowing. Provides light in dark locations."],
  ["guarded", "NPC is cautious with strangers. Requires trust-building before sharing information or assistance."],
  ["hostile", "NPC will not cooperate and may attack if approached. Requires significant intervention to change."],
  ["sacred", "Location or object carries religious or spiritual significance. Disrespectful actions may have consequences."],
  ["dark", "Location has no light source. Actions requiring sight may fail unless the player carries a lit object."],
  ["sealed", "Passage or container is physically blocked and cannot be opened by normal means."],
  ["open", "Object is open, with items inside visible."],
  ["closed", "Object is closed; items inside are not visible."],
];

function seedVocabulary(): void {
  for (const [adj, rule] of STARTER_VOCABULARY) {
    insertVocabulary(db, adj, rule, 1);
  }
  console.log(`Inserted ${STARTER_VOCABULARY.length} starter vocabulary terms.`);
}

function seedWorld(): void {
  const existing = db.prepare("SELECT 1 FROM world_graph WHERE node_id = 'player'").get();
  if (existing) {
    console.log("World already has data; skipping world seed. Delete taleshed.db to re-seed.");
    return;
  }

  const scriptoriumExits = JSON.stringify([{ label: "battered door", target: "kitchen", direction: "east" }]);
  const kitchenExits = JSON.stringify([{ label: "battered door", target: "scriptorium", direction: "west" }]);
  db.exec(`
    INSERT INTO world_graph (node_id, node_type, name, base_description, adjectives, location_id, is_active, meta, exits, grid_x, grid_y)
    VALUES
      ('scriptorium', 'location', 'The Scriptorium', 'Against the near wall, a torch bracket. Without a lit torch the room depends on the grey light pressing weakly through the small windows. Parchment and ink line the desks. A battered door leads out.', '["dark"]', NULL, 1, NULL, '${scriptoriumExits.replace(/'/g, "''")}', 0, 0),
      ('kitchen', 'location', 'The Kitchen', 'A cramped kitchen. A battered door leads out.', '[]', NULL, 1, NULL, '${kitchenExits.replace(/'/g, "''")}', 1, 0),
      ('bracket_01', 'object', 'The Torch Bracket', 'A wrought-iron bracket on the wall, made to hold a torch.', '["open"]', 'scriptorium', 1, NULL, '[]', NULL, NULL),
      ('torch_01', 'object', 'The Torch', 'An unlit torch: dry tow wrapped tight around a wooden handle, waiting for a spark. It can be taken or lit.', '[]', 'bracket_01', 1, NULL, '[]', NULL, NULL),
      ('hearth_fire', 'object', 'Fire in the Hearth', 'A fire burns in the hearth, casting flickering light. It can be used to light a torch or taper.', '["lit"]', 'kitchen', 1, NULL, '[]', NULL, NULL),
      ('ciaran', 'npc', 'Brother Ciarán', 'A monk at a desk, copying a manuscript.', '["guarded"]', 'scriptorium', 1, NULL, '[]', NULL, NULL),
      ('player', 'player', 'Player', 'You.', '[]', 'scriptorium', 1, NULL, '[]', NULL, NULL);
  `);
  console.log("Inserted sample world: scriptorium (exit to kitchen), kitchen, bracket_01, torch_01 (in bracket), hearth_fire (in kitchen), ciaran, player.");
}

clearHistoryLedger();
seedVocabulary();
seedWorld();
db.close();
console.log("Seed complete. Database:", dbPath);
