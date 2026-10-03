// ABOUTME: Starts every part of the page. Each part starts on its own, so one that fails (an old browser, a missing
// ABOUTME: element) leaves the rest working; a failure goes to the console.

import { startEggs } from "./eggs";
import { startEyes } from "./eyes";
import { startCopy, startJsFlag, startLevelCard, startNav, startReveal, startSoundSwitch, startSpotlight, startTicker, startTilt } from "./fx";
import { startKnocks } from "./knock";
import { startOperator } from "./operator";
import { startStage } from "./stage";
import { startWire } from "./wire";
import { startXp } from "./xp";

const parts: [string, () => void][] = [
  ["js flag", startJsFlag],
  ["reveal", startReveal],
  ["nav", startNav],
  ["xp", startXp],
  ["eyes", startEyes],
  ["wire", startWire],
  ["stage", startStage],
  ["tilt", startTilt],
  ["ticker", startTicker],
  ["spotlight", startSpotlight],
  ["operator", startOperator],
  ["knocks", startKnocks],
  ["copy", startCopy],
  ["sound", startSoundSwitch],
  ["level card", startLevelCard],
  ["eggs", startEggs],
];

for (const [name, start] of parts) {
  try {
    start();
  } catch (e) {
    console.error(`soopdoop: ${name} did not start`, e);
  }
}
