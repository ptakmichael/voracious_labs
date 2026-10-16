/**
 * The Lego build sound for the 3D model flying together. The file is 1.4 s of silence, building clicks until
 * ~3.8 s, then the minikit jingle from 3.90 s. Starting it 1.10 s in puts the clicks under the pieces landing and
 * the jingle exactly on "built" (BUILD_SECS = 2.8 s after the build starts).
 */
import { BUILD_SECS } from './timing'

const JINGLE_AT = 3.9
const START_AT = JINGLE_AT - BUILD_SECS

const url = `${import.meta.env.BASE_URL}sfx/lego-build.mp3`
let el: HTMLAudioElement | null = null
const audio = () => {
  if (!el) { el = new Audio(url); el.preload = 'auto'; el.volume = 0.9 }
  return el
}

/** Start loading early, so it's ready by the time the build begins. */
export function preloadBuildSound() { audio().load() }

/** `late` = seconds since the build started, in case a frame or two passed. */
export function playBuildSound(late = 0) {
  const a = audio()
  try {
    a.currentTime = START_AT + Math.max(0, late)
    void a.play().catch(() => {})
  } catch { /* not loaded yet or blocked: the demo carries on silently */ }
}

export function stopBuildSound() { if (el) { el.pause() } held = false }

let held = false
/** Stop / Resume: hold the sound where it is and pick it up again. */
export function holdBuildSound() { if (el && !el.paused) { el.pause(); held = true } }
export function releaseBuildSound() { if (el && held) { void el.play().catch(() => {}) } held = false }
