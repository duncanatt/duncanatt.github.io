# UFO Tank Shooter

A browser arcade game inspired by the GPT-5.5 coding-demo style: a real WebGL 3D desert tank fights UFO waves, aggressive red raiders, motherships, dodgeable red and green projectiles, pickups, screen shake, explosions, destructible and regrowing trees, bushes, rocks, hilly height-shaded terrain, and constellations.

Open `index.html` in a browser to play. It uses only plain HTML, CSS, and raw WebGL, with no external libraries.

## Controls

- Move: `W` / `A` / `S` / `D` or arrow keys
- Lock target: `Q` or `Tab`; clear target with `Esc`
- Aim: mouse or touch
- Fire: click, tap, or `Space`
- iPhone/touch: use the left on-screen stick to drive, then use `Lock` and `Fire`

Trees and bushes block the tank. Tank and UFO bullets can destroy them, but stumps eventually grow back into obstacles.

## Stats

The HUD tracks score, best score, wave, current-wave UFOs destroyed as `x/y`, accuracy, and hull. Best score is stored in `localStorage`.

## Files

- `index.html` wires the game shell and HUD.
- `styles.css` handles the responsive arcade frame and overlays.
- `main.js` contains the raw WebGL renderer, mesh generation, input handling, wave spawning, collision logic, scoring, statistics, and game state.
