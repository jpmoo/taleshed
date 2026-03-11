# LLM call rundown (turn + backfill)

Order of operations and what each call looks like. `[bracketed]` = per-turn or per-term context inserted at runtime. All YES/NO calls expect a short answer (e.g. `YES`, `NO`, or JSON like `{"answer": "NO"}`).

---

## 1. Turn (main game step)

**When:** Every turn.  
**Label:** `turn`  
**Count:** 1 per turn.

**Role:** Game master: interpret player command, update world, produce narrative and `node_impacts` (including `adjectives_old` / `adjectives_new` per node).

**Mockup:**

```
You are a game master for a text-based interactive fiction engine.
Your job is to determine what happens in the world when the player takes an action.
You must return ONLY valid JSON. No prose outside the JSON structure.
You must return exactly the fields described below and nothing else.

AUTHORITATIVE SOURCE: [rules about MCP data, entity list, exits, vocabulary, etc.]

VOCABULARY (adjectives and their rules):
[<array of {adjective, rule_description} for current vocab>]

You MUST apply each adjective's rule_description when deciding what happens. …

CURRENT SCENE:
Location: [<location node_id>] — [<location name>]
Description: [<location description>]
Location adjectives: [<location adjectives>]

ENTITIES PRESENT: [<exhaustive list: location, NPCs, objects with node_id, location_id, adjectives, descriptions; DARK SCENE note if applicable>]

PLAYER:
- node_id: player | location_id: [<current location_id>] | adjectives: [<player adjectives>]
  Inventory (location_id: player): [<inventory node_ids or empty>]
  Recent history: [<recent ledger prose_impact lines>]

EXITS FROM THIS LOCATION: [<label [direction] -> target per exit>]

RECENT NARRATION: [<last few exchanges for tone/consistency>]

Check: does the recent narration describe anything inconsistent with the current world state above? …

PLAYER ACTION: [<exact player command>]
[<optional blocks: DESCRIBE-ONLY / MOVEMENT — DO NOT REVERSE / DESTINATION / CONTAINMENT / etc.>]

CRITICAL — node_impacts: You MUST include exactly one entry for each of these node_ids: [<required node_ids>]. …

Return ONLY this JSON structure:
{
  "narrative_prose": "<string: …>",
  "action_result": "<success | failure | partial>",
  "node_impacts": [ { "node_id", "prose_impact", "adjectives_old", "adjectives_new", "new_location_id"? } ],
  "reconciliation_notes": "<string | null>"
}
```

**Response:** Single JSON object with `narrative_prose`, `action_result`, `node_impacts`, `reconciliation_notes`. Optional `new_adjectives` elsewhere in pipeline.

---

## 2. Resolve (map candidates to existing vocab)

**When:** Only if there is at least one adjective in `node_impacts` that is not in vocabulary (`candidatesNotInVocab.size > 0`).  
**Label:** `resolve redundant adjectives`  
**Count:** 0 or 1 per turn.

**Role:** Map candidate phrases to existing vocabulary when they are true synonyms; leave others unchanged.

**Mockup:**

```
You are normalizing game-state adjectives for a text adventure.

EXISTING VOCABULARY (use these exact spellings when replacing):
- [<adjective 1>]
- [<adjective 2>]
- …

CANDIDATE TERMS (these are not in the vocabulary yet; some may be true synonyms of existing terms):
[<term1>, <term2>, …]

For each candidate: if it has the SAME meaning as an existing vocabulary term (true synonym), respond with that term exactly as listed; otherwise respond with the candidate unchanged. Only map when the two mean the same thing (e.g. "mad" -> "hostile"). Do NOT map when: (1) the candidate is a negation, opposite, or lessening … (2) object/location state vs NPC disposition. …

CRITICAL: Return a JSON object with one key per candidate. Keys must be the candidate terms exactly as written above. Values must be EITHER (1) an existing vocabulary term—exact spelling—only when it is a true synonym, OR (2) the candidate itself unchanged. …

Return ONLY the JSON object. No other text.
```

**Response:** JSON object: `{ "<candidate>": "<vocab term or candidate>", … }`.

---

## 3. Reject non–substantive / location-only (by term, before definitions)

**When:** Only for terms still not in vocab after resolve (`stillNotInVocab`). Each such term is checked twice (transient, then location-only if not transient). Results are cached by term (lowercase) for the process.  
**Labels:** `transient-by-term check`, `location-only-by-term check`  
**Count:** 0–2 per unique candidate term (1 transient + optionally 1 location-only); cache avoids repeat calls for same term.

### 3a. Transient by term

**Mockup:**

```
Answer with only YES or NO.

Does the following phrase describe ONLY a momentary action, one-off observation, or something with NO substantive impact on game state or flow (e.g. "copying a manuscript", "looking up", "noticed", "currently observing")? Substantive impact = persistent disposition (guarded, hostile), object/location state (lit, closed, locked), or other qualities that last and affect future turns. If the phrase is just an activity or fleeting moment with no lasting game effect, answer YES.

Phrase: [<candidate term, e.g. "copying a manuscript">]

Answer:
```

**Response:** YES or NO (or JSON with answer/Answer/Yes/yes).

### 3b. Location-only by term

**When:** Only if transient-by-term returned false for that term (so we still consider it).  
**Mockup:**

```
Answer with only YES or NO.

Does the following phrase describe ONLY where something is located or placed (e.g. "in cellar", "in kitchen", "in inventory", "on table", "in the scriptorium")? The game engine tracks location and containment; such phrases must NOT be used as adjectives. If the phrase is purely a location or placement, answer YES.

Phrase: [<same candidate term>]

Answer:
```

**Response:** YES or NO (or JSON).

---

## 4. Single definition fetch (impact path)

**When:** Only if, after reject-by-term, there is still at least one term not in vocab (`stillNotInVocab.size > 0`).  
**Label:** `vocabulary definitions (turn)`  
**Count:** 1 batch call; if the model returns fewer definitions than requested or different adjectives, 1 extra call per missing term (fallback one-by-one).

**Role:** Get one `{ adjective, rule_description }` per requested term; model may return a shorter canonical adjective (e.g. "copied" for "copying a manuscript").

**Mockup:**

```
You are defining game-state adjectives for a text adventure. These definitions are generic and transportable: they apply to any node (location, object, NPC). Do not refer to specific characters, places, or objects.

EXISTING VOCABULARY (use these to define new terms in relation when appropriate, e.g. "less guarded" from "guarded"):
- [<adjective>: <rule_description>]
- …

Define each NEW term below. For each term, provide exactly one sentence (rule_description) describing what this state means for the game. …

Prefer copying the term word-for-word in the "adjective" field. If a term is verbose or action-like (e.g. "copying a manuscript"), you MAY return a shorter canonical adjective (e.g. "copied") that best captures the persistent state; the engine will use your adjective.

CRITICAL: You MUST return one object for EVERY term. There are [<N>] terms below. Your response must be a JSON array containing exactly [<N>] objects—one per term. …

NEW TERMS TO DEFINE: [<term1>, <term2>, …]

Return ONLY a JSON array with one object per term. No other text. Example format: [{"adjective": "dim", "rule_description": "…"}, {"adjective": "tense", "rule_description": "…"}]
```

**Response:** JSON array of `{ "adjective": string, "rule_description": string }`. Adjective may be the requested term or a canonical variant.

---

## 5. Reject / normalize (per definition from impact path)

**When:** For each definition returned in step 4 we run two YES/NO checks. Both are cached by adjective (lowercase) for the process.  
**Labels:** `engine-covered check`, `transient-adjective check`  
**Count:** Up to 2 per distinct definition (engine-covered, then transient); cache reused across turns for same adjective.

### 5a. Engine-covered by definition

**Mockup:**

```
Answer with only YES or NO.

Does the following adjective and its rule describe ONLY (1) where something is located, (2) who possesses or holds it, or (3) whether a container has contents or is empty? The game engine already handles (1)–(3) via location_id and containment, so such adjectives must not be used. Do NOT treat "open" or "closed" as engine-covered—those are valid state adjectives (container open vs closed), not descriptions of whether the container has contents.

Adjective: [<e.g. "copied" or "open">]
Rule: [<rule_description for that adjective>]

Answer:
```

**Response:** YES or NO (or JSON).

### 5b. Transient by definition

**Mockup:**

```
Answer with only YES or NO.

Does the following adjective and its rule describe ONLY a momentary action, one-off observation, or transient state (e.g. "looked up", "noticed", "currently observing", "observed doing X") that does NOT persistently affect how the node interacts with the player or the world? Persistent game state = disposition (guarded, hostile), object state (lit, closed, locked), or other qualities that last and affect future turns. If the term is only a fleeting moment or observation, answer YES—such terms must not be used as adjectives; put them in prose_impact only.

Adjective: [<same adjective>]
Rule: [<same rule_description>]

Answer:
```

**Response:** YES or NO (or JSON).

---

## 6. One filter run per distinct adjective set

**When:** After reject/normalize, for each **unique** set of adjectives (per node) we run two filters once and reuse the result for all nodes with that set.  
**Labels:** (same as 5) `engine-covered check`, `transient-adjective check` — invoked inside `filterEngineCoveredAdjectives` and `filterTransientAdjectives`.  
**Count:** For each **distinct** sorted adjective list: filter engine-covered (one call per adjective that is in vocabulary), then filter transient (one call per adjective that is in vocabulary). Cached by adjective.

**Role:** Strip adjectives that are in vocabulary but whose rule is engine-covered or transient. Terms not in vocabulary are left in (they were already gated by definition fetch + reject above).

**Mockup (per adjective in vocab, inside the two filters):**  
Same prompts as in **5a** and **5b**, with:

- **Adjective:** [<vocab term from the node’s adjective list>]
- **Rule:** [<that term’s rule_description from vocabulary>]

So the **shape** of the call is identical to step 5; the **source** of (adjective, rule) is the existing vocabulary for the node’s adjectives, not the definitions we just fetched.

---

## 7. Backfill: fetch only for terms not already defined in impact path

**When:** After ledger/DB updates. We collect all adjectives that appear in `impactByNode.adjectives_new` and remove those already in vocabulary. For the remaining **missing** terms we reuse definitions from the impact path when possible; we call the definition LLM only for terms we did **not** already get a definition for in step 4.  
**Label:** `vocabulary definitions` (no call source, or from caller if provided)  
**Count:** 0 or 1 batch (and if needed, one-by-one fallback for any term the batch didn’t satisfy). Often 0 because impact path already fetched.

**Mockup:** Same as **step 4**, but:

- **NEW TERMS TO DEFINE:** [<only terms in `needToFetch` — i.e. missing terms whose canonical form is not in `definitionsFromImpact`>]
- **EXISTING VOCABULARY:** [<vocabulary after any inserts this turn>]

If `needToFetch` is empty, this call is skipped.

---

## 8. Backfill: engine-covered and transient checks for insert

**When:** For each definition we consider for insertion (reused from impact path + any newly fetched in step 7) we run the same two checks as in step 5.  
**Labels:** `engine-covered check`, `transient-adjective check`  
**Count:** Up to 2 per definition (cached by adjective).

**Mockup:** Identical to **5a** and **5b**, with:

- **Adjective:** [<definition’s adjective>]
- **Rule:** [<definition’s rule_description>]

Only definitions that pass both (not engine-covered, not transient) are inserted into the vocabulary DB.

---

## Summary table (per turn)

| Step | Call type | When | Max count (uncached) |
|------|-----------|------|------------------------|
| 1 | Turn | Always | 1 |
| 2 | Resolve | candidatesNotInVocab > 0 | 0 or 1 |
| 3a | Transient-by-term | per term in stillNotInVocab | 1 per term (cached) |
| 3b | Location-only-by-term | per term in stillNotInVocab (if 3a false) | 1 per term (cached) |
| 4 | Fetch definitions | stillNotInVocab > 0 | 1 batch + 0..N one-by-one |
| 5a | Engine-covered (defn) | per definition from 4 | 1 per def (cached) |
| 5b | Transient (defn) | per definition from 4 | 1 per def (cached) |
| 6 | Engine-covered + Transient (filter) | per unique adjective set, per vocab term in that set | 1 per (set, adjective) (cached) |
| 7 | Fetch definitions (backfill) | needToFetch.length > 0 | 0 or 1 batch + fallback |
| 8 | Engine-covered + Transient (backfill insert) | per definition in backfill pool | 1 per def (cached) |

Caches (by term or adjective, lowercase) persist for the process, so repeated turns or repeated nodes with the same adjectives reuse previous YES/NO and definition results.
