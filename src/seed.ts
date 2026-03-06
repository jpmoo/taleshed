/**
 * Seed script: creates DB tables (if needed), starter vocabulary, and a minimal sample world.
 * Run after npm run build: node dist/seed.js
 * Or: npm run db:init then npm run seed
 */

import { initDatabase, getDbPath } from "./db/schema.js";
import { insertVocabulary } from "./db/database.js";

const dbPath = getDbPath();
const db = initDatabase(dbPath);

const STARTER_VOCABULARY: [string, string][] = [
  ["locked", "Blocks passage or interaction. Requires a key, tool, or specific action to remove."],
  ["broken", "Object cannot perform its primary function. May still be used as raw material or weapon."],
  ["lit", "Object is actively burning or glowing. Provides light in dark locations."],
  ["waterlogged", "Cannot be lit. Dries slowly over time or with deliberate effort."],
  ["guarded", "NPC is cautious with strangers. Requires trust-building before sharing information or assistance."],
  ["hostile", "NPC will not cooperate and may attack if approached. Requires significant intervention to change."],
  ["sacred", "Location or object carries religious or spiritual significance. Disrespectful actions may have consequences."],
  ["dark", "Location has no light source. Actions requiring sight may fail unless the player carries a lit object."],
  ["sealed", "Passage or container is physically blocked and cannot be opened by normal means."],
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

  const scriptoriumExits = JSON.stringify([{ label: "battered door", target: "kitchen" }]);
  const kitchenExits = JSON.stringify([{ label: "battered door", target: "scriptorium" }]);
  db.exec(`
    INSERT INTO world_graph (node_id, node_type, name, base_description, adjectives, location_id, is_active, meta, exits)
    VALUES
      ('scriptorium', 'location', 'The Scriptorium', 'A dim scriptorium. Parchment and ink line the desks. A torch bracket on the wall. A battered door leads out.', '["dark"]', NULL, 1, NULL, '${scriptoriumExits.replace(/'/g, "''")}'),
      ('kitchen', 'location', 'The Kitchen', 'A cramped kitchen. A fire burns in the hearth, casting flickering light.', '[]', NULL, 1, NULL, '${kitchenExits.replace(/'/g, "''")}'),
      ('torch_01', 'object', 'The Torch', 'An unlit torch in the wall bracket. It can be taken.', '[]', 'scriptorium', 1, NULL, '[]'),
      ('ciaran', 'npc', 'Brother Ciarán', 'A monk at a desk, copying a manuscript.', '["guarded"]', 'scriptorium', 1, NULL, '[]'),
      ('player', 'player', 'Player', 'You.', '[]', 'scriptorium', 1, NULL, '[]');
  `);
  console.log("Inserted sample world: scriptorium (exit to kitchen), kitchen (fire), torch_01 (takeable), ciaran, player.");
}

seedVocabulary();
seedWorld();
db.close();
console.log("Seed complete. Database:", dbPath);
