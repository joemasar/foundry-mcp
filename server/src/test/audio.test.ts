// Tests the name matching the Foundry module uses to find music (foundry-module/scripts/audio.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const a: any = await import(pathToFileURL(join(here, "..", "..", "..", "foundry-module", "scripts", "audio.js")).href);
const s: any = await import(pathToFileURL(join(here, "..", "..", "..", "foundry-module", "scripts", "sessions.js")).href);

const names = (list: any[]) => list.map((x) => x.name);

test("generic words like 'music' don't decide the match", () => {
  assert.deepEqual(a.keyWords("tavern music"), ["tavern"]);
  assert.deepEqual(a.keyWords("music"), ["music"]);
  const lists = [{ name: "Combat Music" }, { name: "Tavern Ambience" }, { name: "Overland Travel" }];
  assert.deepEqual(names(a.rankByName(lists, "tavern music")), ["Tavern Ambience"]);
});

test("exact names win, then names starting with the query, then shorter names", () => {
  const lists = [{ name: "Battle at the Old Mill" }, { name: "Battle" }, { name: "Big Battle" }, { name: "battle drums" }];
  assert.deepEqual(names(a.rankByName(lists, "battle drums")), ["battle drums", "Battle", "Big Battle", "Battle at the Old Mill"]);
  assert.deepEqual(names(a.rankByName(lists, "battle")).slice(0, 3), ["Battle", "battle drums", "Battle at the Old Mill"]);
});

test("words match the start of name words, so 'drum' finds 'Drums'", () => {
  assert.ok(a.nameScore("War Drums", "drum") > 0);
  assert.equal(a.nameScore("War Drums", "flute"), 0);
  assert.equal(a.nameScore("", "x"), 0);
});

test("a track can match on its playlist's name too", () => {
  const sounds = [
    { name: "Track 1", playlist: "Tavern" },
    { name: "Rain on Roof", playlist: "Weather" },
  ];
  const ranked = a.rankByName(sounds, "tavern", (x: any) => x.playlist);
  assert.deepEqual(names(ranked), ["Track 1"]);
  assert.deepEqual(names(a.rankByName(sounds, "rain")), ["Rain on Roof"]);
});

test("volume follows Foundry's slider curve", () => {
  assert.equal(a.volumeFromSlider(1), 1);
  assert.equal(a.volumeFromSlider(0), 0);
  assert.equal(a.volumeFromSlider(0.5), 0.354);
  assert.equal(a.volumeFromSlider(3), 1);
});

test("tracks added to the GM's playlists are tracked for cleanup", () => {
  assert.equal(s.EMBEDDED.Playlist.sounds, "PlaylistSound");
  const plan = s.planCleanup([{ uuid: "Playlist.p.PlaylistSound.x", type: "PlaylistSound", name: "Rain", parentUuid: "Playlist.p", parentName: "Weather", tag: {} }]);
  assert.equal(plan.embedded.length, 1);
});
